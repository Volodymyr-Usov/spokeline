using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using NAudio.Wave;
using SherpaOnnx;

namespace Spokeline;

/// Microphone + voice-activity detection + on-device recognition, and the hands-free rules:
/// a request starts with a wake phrase after a pause, and ends after `PauseSeconds` of silence.
/// Push to talk records while the key is held. All events are raised on the UI thread.
sealed class Listener : IDisposable
{
    public event Action<string>? Utterance;
    public event Action? Wake;
    public event Action? BargeIn;
    public event Action<string>? StateChanged;
    public event Action<string>? Problem;

    // Settings and live state set by the app every tick.
    public bool HandsFree;
    public bool OthersSpeaking;
    public bool BargeInEnabled = true;
    public string SpokenText = "";
    public bool AcceptWithoutWake;
    public double PauseSeconds = 3.0;
    public bool Debug;
    public DateTime FollowUpUntil = DateTime.MinValue;
    /// Conversation mode is on: even a one-word answer ("yes", "goodbye") is sent without the wake phrase.
    public bool InConversation;
    List<Regex> wake = WakePhrases.Build("claude, anthropic");

    readonly SynchronizationContext ui;
    readonly BlockingCollection<(float[] samples, bool ptt, DateTime at, int no)> work = new();
    DateTime ignoreBefore = DateTime.MinValue;
    Recognizer? recognizer;
    VoiceActivityDetector? vad;
    WaveInEvent? mic;
    EchoCapture? echoMic;
    /// Use Windows' echo removal for the microphone (falls back to the plain microphone if refused).
    public bool EchoRemoval = true;
    readonly List<DateTime> echoFailures = new();
    /// How loud your voice usually is at the microphone (0 to 1), learned from requests that were accepted.
    float yourLevel = 0.1f;
    float lastPeak;
    float[]? shortBefore;
    DateTime shortAt;
    bool MicOn => mic != null || echoMic != null || fromFile;
    bool fromFile;   // test only (--live-test): the sound comes from a WAV file, not from a microphone

    /// Test only: load the models and take sound from `Feed` as if it came from the microphone.
    public void StartFromFile()
    {
        recognizer ??= new Recognizer();
        vad ??= Recognizer.MakeVad();
        fromFile = true;
        SetState(HandsFree ? "listening" : "idle");
    }

    public void Feed(byte[] buffer, int bytes) => OnAudio(buffer, bytes);
    readonly object audioGate = new();

    // push to talk
    bool holding;
    DateTime holdStarted;
    readonly List<float> holdBuffer = new();

    // hands free
    bool capturing;
    string captured = "";
    DateTime lastSpeech = DateTime.MinValue;
    DateTime wakeAt = DateTime.MinValue;
    bool speechActive;
    DateTime lastLoudAt = DateTime.MinValue;

    /// True while the microphone hears you speaking (not Spokeline's own voice): for the green light on the
    /// microphone sign in the chat. Hands free: the speech detector; push to talk: the sound is loud enough.
    public bool Hearing => holding ? (DateTime.Now - lastLoudAt).TotalSeconds < 0.4 : speechActive && !OthersSpeaking && MicOn;

    // The loudest sound of the last quarter second, for the bars next to the microphone sign.
    float shownPeak;
    DateTime shownPeakAt = DateTime.MinValue;
    public int Level => Loudness.Bars(Hearing, (DateTime.Now - shownPeakAt).TotalSeconds < 0.4 ? shownPeak : 0f, yourLevel);

    // The unfinished text while you speak: the sound of the piece being spoken (or of the key hold) is
    // recognised again about once a second, only to be shown. What is sent is decided as before, from the
    // finished pieces. `pieceNo` and `holdNo` tell a late reading of an old piece from a fresh one.
    readonly List<float> liveAudio = new();   // the piece being spoken now (audio thread, under audioGate)
    readonly List<float> recent = new();      // the last half second before it, so its first word is not cut
    bool wasActive;
    int pieceNo, holdNo;
    DateTime nextPartialAt = DateTime.MinValue;
    int partialLength = -1, partialNo = -1;
    bool partialHold;
    string pieceText = "";     // UI thread from here on
    int pieceTextNo = -1, pieceDone = -1;
    string holdText = "";
    bool holdLive;

    /// What you are saying right now, as far as it is recognised: only words that are meant for Claude
    /// (the key is held, a request is being collected, or a wake phrase or a follow-up has begun).
    public string LiveText
    {
        get
        {
            if (holdLive) return holdText;
            if (!MicOn) return "";
            if (capturing) return (captured + " " + pieceText).Trim();
            if (OthersSpeaking || pieceText.Length == 0) return "";
            if (WakePhrases.After(wake, pieceText) is { } after) return after;
            return DateTime.Now < FollowUpUntil ? pieceText : "";
        }
    }

    readonly System.Windows.Forms.Timer timer = new() { Interval = 200 };

    public string State { get; private set; } = "idle";

    public Listener(SynchronizationContext ui)
    {
        this.ui = ui;
        new Thread(Worker) { IsBackground = true, Name = "recognizer" }.Start();
        timer.Tick += (_, _) => Pulse();
        timer.Start();
    }

    public void SetWakePhrases(string phrases) => wake = WakePhrases.Build(phrases);

    /// Spokeline just stopped talking: forget what was heard while it talked (its own voice).
    public void DiscardHeard()
    {
        ignoreBefore = DateTime.Now.AddSeconds(0.3);
        if (capturing) return;
        lock (audioGate) { if (vad != null) while (!vad.IsEmpty()) vad.Pop(); }
    }

    void SetState(string s) { if (State != s) { State = s; Log.Write("state " + s); StateChanged?.Invoke(s); } }

    /// Opens the microphone and loads the models (once).
    public bool Start()
    {
        if (MicOn) return true;
        if (!Models.AsrReady) { Problem?.Invoke("The speech pack is not installed yet. Start a Claude chat with Spokeline: it offers the download."); return false; }
        try
        {
            recognizer ??= new Recognizer();
            vad ??= Recognizer.MakeVad();
            if (EchoRemoval)
            {
                var ec = new EchoCapture();
                ec.DataAvailable += (buf, n) => OnAudio(buf, n);
                // Echo removal stops when the speakers or the microphone change (a headset is plugged in, a call
                // starts). Start it again on the new devices after 2 seconds; only when it fails 3 times within
                // 2 minutes is the plain microphone used.
                ec.Failed += _ => Task.Delay(2000).ContinueWith(_ => ui.Post(_ =>
                {
                    var now = DateTime.Now;
                    echoFailures.RemoveAll(t => (now - t).TotalMinutes > 2);
                    echoFailures.Add(now);
                    var giveUp = echoFailures.Count >= 3;
                    Log.Write(giveUp ? "echo removal failed 3 times: using the plain microphone" : "echo removal: starting again");
                    var wasOn = MicOn;
                    Stop();
                    if (giveUp) EchoRemoval = false;
                    if (wasOn) Start();
                }, null));
                if (ec.Start()) echoMic = ec; else ec.Dispose();
            }
            if (echoMic == null)
            {
                var wantMic = EarsConfig.Load().Microphone;
                mic = new WaveInEvent { WaveFormat = new WaveFormat(16000, 16, 1), BufferMilliseconds = 50,
                    DeviceNumber = DeviceList.WaveNumber(wantMic, WaveInEvent.DeviceCount, i => WaveInEvent.GetCapabilities(i).ProductName) };
                mic.DataAvailable += (_, e) => OnAudio(e.Buffer, e.BytesRecorded);
                mic.StartRecording();
            }
            SetState(HandsFree ? "listening" : "idle");
            return true;
        }
        catch (Exception e)
        {
            mic = null;
            echoMic?.Dispose();
            echoMic = null;
            Problem?.Invoke("The microphone could not start: " + e.Message + ". Check Settings > Privacy & security > Microphone > Let desktop apps access your microphone.");
            return false;
        }
    }

    public void Stop()
    {
        try { mic?.StopRecording(); } catch { }
        mic?.Dispose();
        mic = null;
        echoMic?.Dispose();
        echoMic = null;
        capturing = false;
        lock (audioGate) { liveAudio.Clear(); liveGen++; recent.Clear(); wasActive = false; }
        pieceText = "";
        SetState("off");
    }

    void OnAudio(byte[] buffer, int bytes)
    {
        var n = bytes / 2;
        var samples = new float[n];
        for (var i = 0; i < n; i++) samples[i] = BitConverter.ToInt16(buffer, i * 2) / 32768f;
        if (n > 0)
        {
            var pk = samples.Max(Math.Abs);
            var at = DateTime.Now;
            ui.Post(_ => { if (pk >= shownPeak || (at - shownPeakAt).TotalSeconds > 0.25) { shownPeak = pk; shownPeakAt = at; } }, null);
        }
        lock (audioGate)
        {
            if (holding)
            {
                if (holdBuffer.Count < 16000 * 60) holdBuffer.AddRange(samples);   // at most 60 s
                if (samples.Length > 0 && samples.Max(Math.Abs) > Math.Max(0.015f, 0.3f * yourLevel)) { var t = DateTime.Now; ui.Post(_ => lastLoudAt = t, null); }
                return;
            }
            if (!HandsFree || vad == null) return;
            // While a chat speaks: without voice interruption, ignore the microphone (it would hear the voice).
            if (OthersSpeaking && !BargeInEnabled) { while (!vad.IsEmpty()) vad.Pop(); liveAudio.Clear(); liveGen++; recent.Clear(); wasActive = false; return; }
            vad.AcceptWaveform(samples);
            var active = vad.IsSpeechDetected();
            if (active)
            {
                if (!wasActive) { liveAudio.Clear(); liveGen++; liveAudio.AddRange(recent); recent.Clear(); }
                if (liveAudio.Count < 16000 * 30) liveAudio.AddRange(samples);
            }
            else
            {
                recent.AddRange(samples);
                if (recent.Count > 8000) recent.RemoveRange(0, recent.Count - 8000);
            }
            wasActive = active;
            if (active) ui.Post(_ => { speechActive = true; lastSpeech = DateTime.Now; }, null);
            else ui.Post(_ => speechActive = false, null);
            while (!vad.IsEmpty())
            {
                var seg = vad.Front();
                work.Add((seg.Samples, false, DateTime.Now, pieceNo++));
                vad.Pop();
                liveAudio.Clear(); liveGen++;   // the piece is finished; what comes now belongs to the next one
            }
        }
    }

    void Worker()
    {
        while (!work.IsCompleted)
        {
            // Nothing finished to recognise: look at the piece that is still being spoken.
            if (!work.TryTake(out var item, 200))
            {
                try { Partial(); } catch (Exception e) { Log.Write("recognizer error (unfinished text): " + e.Message); }
                continue;
            }
            var (samples, ptt, at, no) = item;
            string text;
            try { text = recognizer?.TranscribeLong(samples) ?? ""; }
            catch (Exception e) { Log.Write("recognizer error: " + e.Message); continue; }
            if (Debug) SaveForDebug(samples, text);
            // A wake word said alone ("Hey Claude", pause, then the request) is one short piece of sound, and
            // a lone word is recognised badly ("Cloth", "Lord", "Four"). Heard together with the next piece
            // it is recognised well, so a short piece without a wake word is tried again joined to the next.
            if (!ptt)
            {
                var phrases = wake;
                if (shortBefore != null && (at - shortAt).TotalSeconds < 5 && WakePhrases.After(phrases, text) == null)
                {
                    var joined = new float[shortBefore.Length + 4000 + samples.Length];
                    shortBefore.CopyTo(joined, 0);
                    samples.CopyTo(joined, shortBefore.Length + 4000);
                    try
                    {
                        var both = recognizer?.Transcribe(joined) ?? "";
                        if (WakePhrases.After(phrases, both) != null) { Log.Write("wake phrase found by joining two pieces of sound: " + both); text = both; }
                        else if (Debug) Log.Write("two pieces of sound joined, still no wake phrase: " + both);
                    }
                    catch (Exception e) { Log.Write("recognizer error: " + e.Message); }
                }
                shortBefore = samples.Length < 24000 && WakePhrases.After(phrases, text) == null ? samples : null;
                shortAt = at;
            }
            var peak = samples.Length == 0 ? 0f : samples.Max(Math.Abs);
            ui.Post(_ =>
            {
                if (ptt) { FinishHold(text); return; }
                // This piece is finished: its unfinished text is no longer needed.
                pieceDone = no;
                if (pieceTextNo <= no) pieceText = "";
                // Echo removal leaves a faint rest of Spokeline's own voice, which was recognised as other
                // words and counted as an interruption. While Spokeline speaks, only sound about as loud as
                // your own voice counts (you are much closer to the microphone than the speakers' rest). The limit
                // follows your usual level, so a normal-distance voice on a quiet microphone still interrupts.
                if (OthersSpeaking && peak < Math.Max(0.04f, 0.4f * yourLevel))
                {
                    if (Debug) Log.Write($"ignored while speaking (too quiet to be you, {peak:0.00}): {text}");
                    return;
                }
                lastPeak = peak;
                // Heard while Spokeline was talking and finished before it stopped: its own voice.
                if (!capturing && at < ignoreBefore) { if (Debug) Log.Write("discarded (heard while speaking): " + text); return; }
                OnSegment(text);
            }, null);
        }
    }

    /// Recognises the unfinished sound once more, at most about once a second (less often when the computer
    /// needs longer than half a second for it), and only when new sound has arrived.
    void Partial()
    {
        if (DateTime.Now < nextPartialAt || recognizer == null) return;
        float[] samples;
        int no;
        bool hold;
        int gen;
        lock (audioGate)
        {
            hold = holding;
            no = hold ? holdNo : pieceNo;
            // While Spokeline itself speaks, the sound is mostly its own voice: nothing to show.
            if (!hold && OthersSpeaking && !capturing) return;
            samples = hold ? holdBuffer.ToArray() : liveAudio.ToArray();
            gen = liveGen;
        }
        if (samples.Length < 8000 || samples.Length > 16000 * 60) return;        // half a second to 60 seconds
        if (hold == partialHold && no == partialNo && samples.Length - partialLength < 4000) return;   // nothing new
        partialHold = hold; partialNo = no; partialLength = samples.Length;
        var started = DateTime.Now;
        if (no != cacheNo || hold != cacheHold || gen != cacheGen) { partialCache.Clear(); cacheNo = no; cacheHold = hold; cacheGen = gen; }
        var text = recognizer.TranscribeLong(samples, partialCache);
        var took = (DateTime.Now - started).TotalSeconds;
        nextPartialAt = started.AddSeconds(Math.Max(1.0, took + 0.5));
        ui.Post(_ =>
        {
            // A reading that lost most of the words (the engine sometimes returns nothing for a moment) does not
            // replace the text on screen: that made the first line appear and disappear while you spoke.
            if (hold) { if (holdLive && no == holdNo && SoundPieces.KeepsWords(holdText, text)) holdText = text; }
            else if (no > pieceDone && (no != pieceTextNo || SoundPieces.KeepsWords(pieceText, text))) { pieceText = text; pieceTextNo = no; }
        }, null);
    }

    readonly Dictionary<(int, int), string> partialCache = new();
    int cacheNo = -1, cacheGen = -1;
    int liveGen;   // counts each restart of the piece being spoken, so an old reading is never reused
    bool cacheHold;

    /// Only with "debug": true in config.json: keeps the last 30 pieces of sound that were recognised, as WAV
    /// files in .spokeline\debug, so a wrong recognition can be listened to. Nothing is saved otherwise.
    int debugCount;
    void SaveForDebug(float[] samples, string text)
    {
        try
        {
            var dir = Path.Combine(Files.Base, "debug");
            Directory.CreateDirectory(dir);
            var file = Path.Combine(dir, $"heard-{debugCount++ % 30:00}.wav");
            using (var w = new WaveFileWriter(file, new WaveFormat(16000, 16, 1))) w.WriteSamples(samples, 0, samples.Length);
            var peak = samples.Length == 0 ? 0 : samples.Max(Math.Abs);
            Log.Write($"debug: saved {Path.GetFileName(file)} ({samples.Length / 16000.0:0.0} s, loudest {peak:0.00} of 1): {text}");
        }
        catch (Exception e) { Log.Write("debug: could not save the sound: " + e.Message); }
    }

    // ------------------------------------------------------------ push to talk

    public void BeginHold()
    {
        if (!Start()) return;
        lock (audioGate) { holding = true; holdBuffer.Clear(); holdNo++; liveAudio.Clear(); liveGen++; wasActive = false; }
        holdText = "";
        holdLive = true;
        holdStarted = DateTime.Now;
        SetState("recording");
    }

    public void EndHold()
    {
        float[] samples;
        lock (audioGate)
        {
            if (!holding) return;
            holding = false;
            samples = holdBuffer.ToArray();
            holdBuffer.Clear();
        }
        if ((DateTime.Now - holdStarted).TotalSeconds < 0.25) { holdLive = false; holdText = ""; SetState(HandsFree ? "listening" : "idle"); return; }
        SetState("recognizing");
        work.Add((samples, true, DateTime.Now, 0));
    }

    void FinishHold(string text)
    {
        holdLive = false;
        holdText = "";
        SetState(HandsFree ? "listening" : "idle");
        Utterance?.Invoke(text);
    }

    // ------------------------------------------------------------ hands free

    void OnSegment(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        if (Debug) Log.Write("heard: " + text);
        lastSpeech = DateTime.Now;
        if (capturing) { captured = (captured + " " + text).Trim(); return; }

        var after = WakePhrases.After(wake, text);
        if (OthersSpeaking)
        {
            // Conversation mode: any words of yours interrupt the voice (no wake phrase needed).
            var count = text.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
            var shortAnswer = AcceptWithoutWake && count <= 3 && OwnVoice.IsAnswerWord(text);
            if (after == null && InConversation && (shortAnswer || (count >= 2 && !IsMostlySpoken(text))))
            {
                Log.Write("interrupted in conversation: " + text);
                BargeIn?.Invoke();
                capturing = true;
                captured = text;
                wakeAt = DateTime.Now;
                SetState("capturing");
                Wake?.Invoke();
                return;
            }
            // Otherwise only a wake phrase interrupts, and never Spokeline's own words.
            if (after == null || IsOwnVoice(text)) return;
            Log.Write("interrupted by wake phrase: " + text);
            BargeIn?.Invoke();
        }
        if (after != null)
        {
            if (!OthersSpeaking && lastPeak > 0) yourLevel = 0.7f * yourLevel + 0.3f * lastPeak;
            capturing = true;
            captured = after;
            wakeAt = DateTime.Now;
            SetState("capturing");
            Wake?.Invoke();
            return;
        }
        var words = text.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
        if (AcceptWithoutWake && words <= 4) { Deliver(text); return; }
        if (DateTime.Now < FollowUpUntil && words >= (InConversation ? 1 : 2))
        {
            Log.Write("follow-up without wake phrase: " + text);
            capturing = true;
            captured = text;
            wakeAt = DateTime.Now;
            SetState("capturing");
            return;
        }
        if (Debug) Log.Write("no wake phrase in: " + text);
    }

    void Pulse()
    {
        // The key release was missed (it can happen): never stay recording for more than a minute.
        if (holding && (DateTime.Now - holdStarted).TotalSeconds > 60) { Log.Write("push to talk: no key release after 60 s, stopping"); EndHold(); }
        if (!capturing) return;
        var quiet = (DateTime.Now - lastSpeech).TotalSeconds;
        if (!speechActive && captured.Length > 0 && quiet > PauseSeconds) { Deliver(captured); return; }
        if (captured.Length == 0 && (DateTime.Now - wakeAt).TotalSeconds > 10 && quiet > 4) { capturing = false; SetState("listening"); }
    }

    void Deliver(string text)
    {
        capturing = false;
        captured = "";
        FollowUpUntil = DateTime.Now.AddSeconds(5);
        SetState("listening");
        Utterance?.Invoke(text.Trim());
    }

    bool IsMostlySpoken(string heard) => OwnVoice.IsMostlySpoken(heard, SpokenText);
    bool IsOwnVoice(string heard) => OwnVoice.IsOwnVoice(heard, SpokenText);

    public void Dispose()
    {
        Stop();
        work.CompleteAdding();
        recognizer?.Dispose();
    }
}
