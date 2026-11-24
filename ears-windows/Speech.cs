using System.Diagnostics;
using System.Text.Json.Nodes;
using SherpaOnnx;

namespace Spokeline;

/// Where the downloaded speech models live: %USERPROFILE%\.spokeline\voice
static class Models
{
    public static string Kokoro => Path.Combine(Files.Voice, "kokoro");
    public static string Asr => Path.Combine(Files.Voice, "asr");
    public static string Vad => Path.Combine(Files.Voice, "silero_vad.onnx");
    public static string Status => Path.Combine(Files.Voice, "status.json");
    public static string Request => Path.Combine(Files.Voice, "install.request");

    public static bool AsrReady => File.Exists(Path.Combine(Asr, "encode.int8.onnx")) && File.Exists(Vad);
    public static bool TtsReady => File.Exists(Path.Combine(Kokoro, "model.onnx"));
    public static bool Ready => AsrReady && TtsReady;
}

/// On-device speech-to-text: Moonshine (English) on sherpa-onnx, fed by the Silero voice-activity detector.
sealed class Recognizer : IDisposable
{
    readonly OfflineRecognizer recognizer;
    readonly object gate = new();

    public Recognizer()
    {
        var c = new OfflineRecognizerConfig();
        c.FeatConfig.SampleRate = 16000;
        c.FeatConfig.FeatureDim = 80;
        c.ModelConfig.Moonshine.Preprocessor = Path.Combine(Models.Asr, "preprocess.onnx");
        c.ModelConfig.Moonshine.Encoder = Path.Combine(Models.Asr, "encode.int8.onnx");
        c.ModelConfig.Moonshine.UncachedDecoder = Path.Combine(Models.Asr, "uncached_decode.int8.onnx");
        c.ModelConfig.Moonshine.CachedDecoder = Path.Combine(Models.Asr, "cached_decode.int8.onnx");
        c.ModelConfig.Tokens = Path.Combine(Models.Asr, "tokens.txt");
        c.ModelConfig.NumThreads = 2;
        c.ModelConfig.Provider = "cpu";
        c.DecodingMethod = "greedy_search";
        recognizer = new OfflineRecognizer(c);
    }

    public string Transcribe(float[] samples)
    {
        if (samples.Length < 1600) return "";
        lock (gate)
        {
            using var s = recognizer.CreateStream();
            s.AcceptWaveform(16000, samples);
            recognizer.Decode(s);
            return s.Result.Text.Trim();
        }
    }

    /// A recording of any length: the speech engine often returns nothing for more than a few seconds of sound
    /// (a 17.9 s push-to-talk recording of 23.11.2026 gave no text, its pieces gave every word), so a long one
    /// is recognised in pieces split at your pauses and the texts are joined. `cache` keeps the text of pieces
    /// already read (the live text reads the growing recording again and again).
    public string TranscribeLong(float[] samples, Dictionary<(int, int), string>? cache = null)
    {
        if (samples.Length <= 16000 * 8) return Transcribe(samples);
        var parts = new List<string>();
        foreach (var (a, b) in SoundPieces.Split(samples))
        {
            if (cache == null || !cache.TryGetValue((a, b), out var t))
            {
                t = Transcribe(samples[a..b]);
                // An empty reading may be a hiccup: it is tried again next time instead of being kept.
                if (cache != null && t.Length > 0) cache[(a, b)] = t;
            }
            if (t.Length > 0) parts.Add(t);
        }
        var text = string.Join(" ", parts);
        // Nothing from any piece: the finished recording is read whole once more. The live text does not do
        // that (a whole long recording every second would be slow); the text on screen stays as it was.
        return text.Length > 0 || cache != null ? text : Transcribe(samples);
    }

    public static VoiceActivityDetector MakeVad()
    {
        var v = new VadModelConfig();
        v.SileroVad.Model = Models.Vad;
        v.SileroVad.Threshold = 0.5f;
        v.SileroVad.MinSilenceDuration = 0.9f; // a pause after "Hey Claude," must not cut the sentence: a lone word is recognised badly
        v.SileroVad.MinSpeechDuration = 0.25f;
        v.SileroVad.MaxSpeechDuration = 25f;
        v.SileroVad.WindowSize = 512;
        v.SampleRate = 16000;
        v.NumThreads = 1;
        v.Provider = "cpu";
        return new VoiceActivityDetector(v, 60);
    }

    public void Dispose() => recognizer.Dispose();
}

/// The natural voice: Kokoro on sherpa-onnx. `SpokelineEars.exe --say ...` makes one sentence: it hands the
/// job to the running tray app (which keeps the voice model loaded, so each sentence takes a fraction of a
/// second) and makes it itself only when the tray app is not running.
static class NaturalVoice
{
    static readonly Dictionary<string, (int sid, string accent)> Voices = new()
    {
        ["heart"] = (3, "us"), ["bella"] = (2, "us"), ["nicole"] = (6, "us"), ["sarah"] = (9, "us"),
        ["michael"] = (16, "us"), ["adam"] = (11, "us"), ["puck"] = (18, "us"),
        ["emma"] = (21, "gb"), ["isabella"] = (22, "gb"), ["george"] = (26, "gb"), ["fable"] = (25, "gb"),
    };

    /// Writes `text` spoken by `voice` to a WAV file. Words the voice cannot read are reported on stderr as
    /// "OOV word skipped: 'word'" (as the sherpa-onnx engine does), which the mod reads to fix them.
    public static int Say(string text, string voice, string outFile, string extraLexicon)
    {
        if (!Models.TtsReady) { Console.Error.WriteLine("natural voice not installed"); return 2; }
        if (VoiceServer.Alive() && VoiceServer.Ask(text, voice, outFile, extraLexicon) is { } answer)
        {
            foreach (var w in answer.unknown) Console.Error.WriteLine($"OOV word skipped: '{w}'");
            return answer.ok ? 0 : 1;
        }
        var (ok, unknown) = Make(text, voice, outFile, extraLexicon);
        foreach (var w in unknown) Console.Error.WriteLine($"OOV word skipped: '{w}'");
        return ok ? 0 : 1;
    }

    // One loaded engine per accent and extra word list, kept while the tray app runs.
    static readonly Dictionary<string, OfflineTts> Engines = new();
    static readonly Dictionary<string, HashSet<string>> Known = new();

    public static (bool ok, List<string> unknown) Make(string text, string voice, string outFile, string extraLexicon)
    {
        var (sid, accent) = Voices.TryGetValue(voice, out var v) ? v : Voices["heart"];
        var lexicons = new List<string> { Path.Combine(Models.Kokoro, accent == "gb" ? "lexicon-gb-en.txt" : "lexicon-us-en.txt") };
        if (File.Exists(extraLexicon)) lexicons.Add(Path.GetFullPath(extraLexicon));
        var key = string.Join(",", lexicons);
        if (!Engines.TryGetValue(key, out var tts))
        {
            // Keep one loaded voice model only (each takes about 350 MB of memory).
            foreach (var old in Engines.Values) old.Dispose();
            Engines.Clear();
            Known.Clear();
            var c = new OfflineTtsConfig();
            c.Model.Kokoro.Model = Path.Combine(Models.Kokoro, "model.onnx");
            c.Model.Kokoro.Voices = Path.Combine(Models.Kokoro, "voices.bin");
            c.Model.Kokoro.Tokens = Path.Combine(Models.Kokoro, "tokens.txt");
            c.Model.Kokoro.Lexicon = key;
            c.Model.Kokoro.LengthScale = 1.0f;
            c.Model.NumThreads = 4;
            c.Model.Provider = "cpu";
            c.MaxNumSentences = 1;
            tts = new OfflineTts(c);
            Engines[key] = tts;
            Known[key] = LoadWords(lexicons);
        }
        var audio = tts.Generate(text, 1.0f, sid);
        return (audio.SaveToWaveFile(outFile), UnknownWords(text, Known[key]));
    }

    static HashSet<string> LoadWords(IEnumerable<string> files)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        foreach (var f in files)
            foreach (var line in File.ReadLines(f))
            {
                var i = line.IndexOfAny(new[] { ' ', '\t' });
                if (i > 0) set.Add(line[..i].ToLowerInvariant());
            }
        return set;
    }

    static List<string> UnknownWords(string text, HashSet<string> known) => Words.Unknown(text, known);
}

/// Inside the tray app: makes speech for `--say` requests with the voice model kept in memory.
/// A request is a file voice\requests\<id>.json; the answer is <id>.done next to it.
sealed class VoiceServer : IDisposable
{
    static string Folder => Path.Combine(Files.Voice, "requests");
    static string AliveFile => Path.Combine(Folder, "server.json");
    volatile bool running = true;
    readonly Thread thread;

    public VoiceServer()
    {
        thread = new Thread(Run) { IsBackground = true, Name = "voice server", Priority = ThreadPriority.AboveNormal };
        thread.Start();
    }

    /// True when a tray app has answered for itself in the last few seconds.
    public static bool Alive()
    {
        try { return File.Exists(AliveFile) && DateTime.UtcNow - File.GetLastWriteTimeUtc(AliveFile) < TimeSpan.FromSeconds(5); }
        catch { return false; }
    }

    /// Called by `--say`: hands the sentence to the tray app and waits for it. Null when it did not answer.
    public static (bool ok, List<string> unknown)? Ask(string text, string voice, string outFile, string extraLexicon)
    {
        var id = Guid.NewGuid().ToString("N");
        var req = Path.Combine(Folder, id + ".json");
        var done = Path.Combine(Folder, id + ".done");
        Files.WriteAtomically(req, new JsonObject { ["text"] = text, ["voice"] = voice, ["out"] = outFile, ["lexicon"] = extraLexicon }.ToJsonString());
        var start = DateTime.Now;
        while (DateTime.Now - start < TimeSpan.FromSeconds(60))
        {
            if (Files.ReadJson(done) is { } a)
            {
                try { File.Delete(done); } catch { }
                var unknown = a["unknown"] is JsonArray arr ? arr.Select(x => x?.GetValue<string>() ?? "").Where(x => x.Length > 0).ToList() : new List<string>();
                return (a["ok"]?.GetValue<bool>() == true, unknown);
            }
            // Not picked up within 2 s: the tray app is busy or gone; take the request back and make it here.
            // Taking it back is a rename: if that fails, the tray app took it just now, so keep waiting for it.
            if (DateTime.Now - start > TimeSpan.FromSeconds(2) && File.Exists(req))
            {
                try { File.Move(req, req + ".cancel"); } catch { Thread.Sleep(15); continue; }
                try { File.Delete(req + ".cancel"); } catch { }
                return null;
            }
            Thread.Sleep(15);
        }
        return null;
    }

    /// Loads the voice model when the tray app starts (about 5 seconds), so the first spoken sentence does
    /// not have to wait for it. Uses the plugin's own word list, which lies two folders above this program.
    static void WarmUp()
    {
        try
        {
            if (!Models.TtsReady) return;
            var words = Path.Combine(Path.GetDirectoryName(Environment.ProcessPath) ?? "", "..", "..", "voice", "extra-lexicon.txt");
            var wav = Path.Combine(Folder, "warm-up.wav");
            var watch = System.Diagnostics.Stopwatch.StartNew();
            NaturalVoice.Make("Ready.", "heart", wav, words);
            try { File.Delete(wav); } catch { }
            Log.Write($"voice loaded in {watch.Elapsed.TotalSeconds:0.0} s");
        }
        catch (Exception e) { Log.Write("voice server: could not load the voice: " + e.Message); }
    }

    void Run()
    {
        Directory.CreateDirectory(Folder);
        WarmUp();
        var lastBeat = DateTime.MinValue;
        while (running)
        {
            if (DateTime.Now - lastBeat > TimeSpan.FromSeconds(2))
            {
                lastBeat = DateTime.Now;
                try { File.WriteAllText(AliveFile, Environment.ProcessId.ToString()); } catch { }
                // Answers nobody collected (the asker gave up): remove them after 2 minutes.
                try { foreach (var d in Directory.GetFiles(Folder, "*.done")) if (DateTime.UtcNow - File.GetLastWriteTimeUtc(d) > TimeSpan.FromMinutes(2)) File.Delete(d); } catch { }
            }
            string[] files;
            try { files = Directory.GetFiles(Folder, "*.json"); } catch { files = Array.Empty<string>(); }
            foreach (var f in files)
            {
                if (Path.GetFileName(f) == "server.json" || Path.GetFileName(f).StartsWith(".")) continue;
                var taken = Path.ChangeExtension(f, ".taken");
                try { File.Move(f, taken); } catch { continue; } // someone else has it
                var o = Files.ReadJson(taken);
                var answer = new JsonObject { ["ok"] = false };
                try
                {
                    if (o != null && Models.TtsReady)
                    {
                        var (ok, unknown) = NaturalVoice.Make(o["text"]?.GetValue<string>() ?? "", o["voice"]?.GetValue<string>() ?? "heart",
                            o["out"]?.GetValue<string>() ?? "", o["lexicon"]?.GetValue<string>() ?? "");
                        answer["ok"] = ok;
                        answer["unknown"] = new JsonArray(unknown.Select(u => (JsonNode)JsonValue.Create(u)!).ToArray());
                    }
                }
                catch (Exception e) { Log.Write("voice server: " + e.Message); }
                try { File.Delete(taken); } catch { }
                try { Files.WriteAtomically(Path.ChangeExtension(f, ".done"), answer.ToJsonString()); } catch { }
            }
            Thread.Sleep(15);
        }
    }

    public void Dispose()
    {
        running = false;
        try { File.Delete(AliveFile); } catch { }
    }
}

/// Downloads the speech pack once (speech recognition + voice-activity detector + natural voice) when the
/// mod writes `install.request`. Progress goes to `status.json`, which the mod shows in the chat.
sealed class VoiceInstaller
{
    const string Base = "https://github.com/k2-fsa/sherpa-onnx/releases/download/";
    static readonly (string url, string step, string kind)[] Parts =
    {
        (Base + "asr-models/silero_vad_v5.onnx", "voice detector", "file"),
        (Base + "asr-models/sherpa-onnx-moonshine-base-en-int8.tar.bz2", "speech recognition", "asr"),
        (Base + "tts-models/kokoro-multi-lang-v1_0.tar.bz2", "voice", "tts"),
    };

    bool busy;

    public void Check()
    {
        if (busy || !File.Exists(Models.Request)) return;
        try { File.Delete(Models.Request); } catch { }
        if (Models.Ready) { WriteStatus("ready", "installed", 1); return; }
        busy = true;
        Log.Write("speech pack: download started");
        Task.Run(async () => { try { await Install(); } finally { busy = false; } });
    }

    async Task Install()
    {
        var tmp = Path.Combine(Files.Voice, "tmp-install");
        try
        {
            if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
            Directory.CreateDirectory(tmp);
            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
            double[] weights = { 0.01, 0.42, 0.55 };
            double done = 0;
            for (var i = 0; i < Parts.Length; i++)
            {
                var (url, step, kind) = Parts[i];
                if (kind == "asr" && Models.AsrReady) { done += weights[i]; continue; }
                if (kind == "tts" && Models.TtsReady) { done += weights[i]; continue; }
                if (kind == "file" && File.Exists(Models.Vad)) { done += weights[i]; continue; }
                var file = Path.Combine(tmp, Path.GetFileName(new Uri(url).LocalPath));
                await Download(http, url, file, step, done, weights[i]);
                done += weights[i];
                if (kind == "file") { File.Move(file, Models.Vad, true); continue; }
                WriteStatus("downloading", "unpacking " + step, done);
                Extract(file, tmp);
                File.Delete(file);
                if (kind == "asr") Replace(Path.Combine(tmp, "sherpa-onnx-moonshine-base-en-int8"), Models.Asr);
                if (kind == "tts")
                {
                    Replace(Path.Combine(tmp, "kokoro-multi-lang-v1_0"), Models.Kokoro);
                    foreach (var extra in new[] { "espeak-ng-data", "dict" }) TryDeleteDir(Path.Combine(Models.Kokoro, extra));
                    foreach (var extra in new[] { "lexicon-zh.txt", "date-zh.fst", "number-zh.fst", "phone-zh.fst" }) TryDeleteFile(Path.Combine(Models.Kokoro, extra));
                }
            }
            TryDeleteDir(tmp);
            if (!Models.Ready) throw new Exception("the files were not where expected after unpacking");
            WriteStatus("ready", "installed", 1);
            Log.Write("speech pack: ready");
        }
        catch (Exception e)
        {
            TryDeleteDir(tmp);
            WriteStatus("error", "failed", 0, e.Message);
            Log.Write("speech pack: failed: " + e.Message);
        }
    }

    async Task Download(HttpClient http, string url, string file, string step, double start, double weight)
    {
        using var resp = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        resp.EnsureSuccessStatusCode();
        var total = resp.Content.Headers.ContentLength ?? 0;
        await using var src = await resp.Content.ReadAsStreamAsync();
        await using var dst = File.Create(file);
        var buf = new byte[1 << 16];
        long read = 0;
        var last = DateTime.MinValue;
        int n;
        while ((n = await src.ReadAsync(buf)) > 0)
        {
            await dst.WriteAsync(buf.AsMemory(0, n));
            read += n;
            if (DateTime.Now - last > TimeSpan.FromSeconds(0.8) && total > 0)
            {
                last = DateTime.Now;
                WriteStatus("downloading", step, start + weight * read / total);
            }
        }
    }

    static void Extract(string archive, string folder)
    {
        // Windows 10 and later include tar.exe, which unpacks .tar.bz2.
        var tar = Path.Combine(Environment.SystemDirectory, "tar.exe");
        var p = Process.Start(new ProcessStartInfo(tar, $"-xjf \"{archive}\" -C \"{folder}\"") { CreateNoWindow = true, UseShellExecute = false })!;
        p.WaitForExit();
        if (p.ExitCode != 0) throw new Exception("could not unpack " + Path.GetFileName(archive));
    }

    static void Replace(string from, string to)
    {
        TryDeleteDir(to);
        Directory.Move(from, to);
    }

    static void TryDeleteDir(string p) { try { if (Directory.Exists(p)) Directory.Delete(p, true); } catch { } }
    static void TryDeleteFile(string p) { try { File.Delete(p); } catch { } }

    static void WriteStatus(string state, string step, double progress, string? error = null)
    {
        Directory.CreateDirectory(Files.Voice);
        var o = new JsonObject { ["state"] = state, ["step"] = step, ["progress"] = Math.Round(progress, 2), ["updatedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
        if (error != null) o["error"] = error;
        try { Files.WriteAtomically(Models.Status, o.ToJsonString()); } catch { }
    }
}
