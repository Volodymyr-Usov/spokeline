using System.Text.Json.Nodes;
using NAudio.Wave;

namespace Spokeline;

/// SpokelineEars.exe
///   (no arguments)                         the tray app: listens and sends what you say to your Claude chat
///   --permission-hook                      Claude Code's PermissionRequest hook (reads JSON on stdin)
///   --say <text> --voice <name> --out <wav> [--lexicon <file>]   make speech with the natural voice
///   --say-system <text> [--stop-file <f>]  speak with the built-in Windows voice
///   --play <wav> [--stop-file <f>]         play a WAV file; stops early when the stop file appears
///   --sleep <ms>                           wait (used by the mod while waiting for a spoken yes/no)
///   --mkdir <folder>                       create a folder
///   --delete <file>                        delete a file (only inside .spokeline)
///   --copy-self <path>                     copy this program to <path> (for the permission hook)
///   --transcribe <wav>                     test: print what speech recognition hears in a 16 kHz WAV
///   --live-test <wav> [--hold]             test: play a 16 kHz WAV into the listener at normal speed, as if you
///                                          spoke it as a follow-up (with --hold: with the key held), and print
///                                          the unfinished text each time it changes, then what is sent
///   --record <wav> [--seconds <n>] [--echo]  test: record the default microphone (with --echo: through
///                                          Windows' echo removal) for n seconds (default 6) to a WAV
static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        string? Arg(string name) { var i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
        try
        {
            if (args.Contains("--permission-hook")) return PermissionHook.Run();
            if (Arg("--say") is { } text) return NaturalVoice.Say(text, Arg("--voice") ?? "heart", Arg("--out") ?? "out.wav", Arg("--lexicon") ?? "");
            if (Arg("--say-system") is { } sys) return SaySystem(sys, Arg("--stop-file"));
            if (Arg("--play") is { } wav) return Play(wav, Arg("--stop-file"));
            if (Arg("--sleep") is { } ms && int.TryParse(ms, out var m)) { Thread.Sleep(Math.Clamp(m, 0, 600_000)); return 0; }
            if (Arg("--mkdir") is { } dir) { Directory.CreateDirectory(dir); return 0; }
            if (Arg("--delete") is { } del) { if (del.Contains(".spokeline")) File.Delete(del); return 0; }
            if (Arg("--copy-self") is { } dest) { File.Copy(Environment.ProcessPath!, dest, true); return 0; }
            if (Arg("--transcribe") is { } test) return Transcribe(test);
            if (Arg("--live-test") is { } lt) return LiveTest(lt, args.Contains("--hold"));
            if (Arg("--record") is { } rec) return Record(rec, int.TryParse(Arg("--seconds"), out var sec) ? Math.Clamp(sec, 1, 60) : 6, args.Contains("--echo"));
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message);
            return 1;
        }

        // Only one tray app may run.
        using var single = new Mutex(true, "Spokeline.Ears", out var first);
        if (!first) return 0;
        Files.EnsureFolders();
        // Speech must not wait behind other programs when the PC is busy (a build, a virus scan): on a fully
        // busy PC one spoken sentence took 12 seconds to make.
        try { using var me = System.Diagnostics.Process.GetCurrentProcess(); me.PriorityClass = System.Diagnostics.ProcessPriorityClass.AboveNormal; } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        EarsStateFile.DeviceReader = Devices.Read;
        Application.Run(new TrayApp());
        return 0;
    }

    static int Play(string wav, string? stopFile)
    {
        using var reader = new AudioFileReader(wav);
        // The speakers chosen in the /spokeline menu, else the Windows default.
        var wanted = EarsConfig.Load().Speakers;
        using var output = new WaveOutEvent { DeviceNumber = DeviceList.WaveNumber(wanted, WaveOut.DeviceCount, i => WaveOut.GetCapabilities(i).ProductName) };
        output.Init(reader);
        output.Play();
        while (output.PlaybackState == PlaybackState.Playing)
        {
            if (stopFile != null && File.Exists(stopFile)) { output.Stop(); break; }
            Thread.Sleep(50);
        }
        return 0;
    }

    static int SaySystem(string text, string? stopFile)
    {
        using var synth = new System.Speech.Synthesis.SpeechSynthesizer();
        synth.SetOutputToDefaultAudioDevice();
        var prompt = synth.SpeakAsync(text);
        while (!prompt.IsCompleted)
        {
            if (stopFile != null && File.Exists(stopFile)) { synth.SpeakAsyncCancelAll(); break; }
            Thread.Sleep(50);
        }
        return 0;
    }

    static int Record(string wav, int seconds, bool echo)
    {
        using var writer = new WaveFileWriter(wav, new WaveFormat(16000, 16, 1));
        var gate = new object();
        void Write(byte[] b, int n) { lock (gate) writer.Write(b, 0, n); }
        if (echo)
        {
            using var mic = new EchoCapture();
            mic.DataAvailable += Write;
            if (!mic.Start()) return 1;
            Thread.Sleep(seconds * 1000);
        }
        else
        {
            using var mic = new WaveInEvent { WaveFormat = new WaveFormat(16000, 16, 1), BufferMilliseconds = 50 };
            mic.DataAvailable += (_, e) => Write(e.Buffer, e.BytesRecorded);
            mic.StartRecording();
            Thread.Sleep(seconds * 1000);
            mic.StopRecording();
        }
        return 0;
    }

    static int LiveTest(string wav, bool hold)
    {
        byte[] sound;
        using (var reader = new WaveFileReader(wav))
        {
            if (reader.WaveFormat.SampleRate != 16000 || reader.WaveFormat.Channels != 1 || reader.WaveFormat.BitsPerSample != 16)
            { Console.Error.WriteLine("needs a 16 kHz, 16-bit, one-channel WAV"); return 1; }
            sound = new byte[reader.Length];
            var got = 0;
            int n;
            while (got < sound.Length && (n = reader.Read(sound, got, sound.Length - got)) > 0) got += n;
        }
        var ui = new WindowsFormsSynchronizationContext();
        SynchronizationContext.SetSynchronizationContext(ui);
        using var listener = new Listener(ui) { HandsFree = !hold, FollowUpUntil = DateTime.MaxValue, InConversation = true };
        listener.StartFromFile();
        var start = DateTime.Now;
        string At() => $"{(DateTime.Now - start).TotalSeconds,5:0.0} s";
        var shown = "";
        var writes = 0;
        var poll = new System.Windows.Forms.Timer { Interval = 150 };   // as the tray app does
        poll.Tick += (_, _) =>
        {
            var now = listener.LiveText;
            if (now == shown) return;
            shown = now;
            writes++;
            Console.WriteLine($"{At()}  unfinished: {(now.Length == 0 ? "(empty)" : now)}");
        };
        poll.Start();
        listener.Utterance += said =>
        {
            Console.WriteLine($"{At()}  SENT: {said}");
            var done = new System.Windows.Forms.Timer { Interval = 500 };
            done.Tick += (_, _) => { Console.WriteLine($"{At()}  the unfinished text changed {writes} times"); Application.ExitThread(); };
            done.Start();
        };
        if (hold) listener.BeginHold();
        new Thread(() =>
        {
            const int chunk = 1600;   // 50 ms, as the microphone delivers it
            var quiet = new byte[chunk];
            var next = DateTime.Now;
            for (var i = 0; i < sound.Length + (hold ? 0 : 6 * 32000); i += chunk)
            {
                if (i < sound.Length) { var piece = new byte[chunk]; Array.Copy(sound, i, piece, 0, Math.Min(chunk, sound.Length - i)); listener.Feed(piece, chunk); }
                else listener.Feed(quiet, chunk);
                next = next.AddMilliseconds(50);
                var wait = next - DateTime.Now;
                if (wait > TimeSpan.Zero) Thread.Sleep(wait);
            }
            Console.WriteLine($"{At()}  (the sound ended)");
            if (hold) ui.Post(_ => listener.EndHold(), null);
        }) { IsBackground = true }.Start();
        Application.Run();
        return 0;
    }

    static int Transcribe(string wav)
    {
        using var reader = new AudioFileReader(wav);
        var all = new List<float>();
        var buf = new float[16000];
        int n;
        while ((n = reader.Read(buf, 0, buf.Length)) > 0) all.AddRange(buf.Take(n));
        using var r = new Recognizer();
        Console.WriteLine("heard: " + r.TranscribeLong(all.ToArray()));
        return 0;
    }
}

/// Claude Code's PermissionRequest hook: runs only when a permission box is about to be shown.
/// While you are talking to that chat by voice, it hands the request to the mod (which reads it aloud) and
/// waits a few seconds for your spoken yes or no. Otherwise, or with no answer in time, it prints nothing.
static class PermissionHook
{
    public static int Run()
    {
        var input = Console.In.ReadToEnd();
        if (JsonNode.Parse(input) is not JsonObject obj) return 0;
        var sessionId = obj["session_id"]?.GetValue<string>() ?? "";
        if (sessionId.Length == 0) return 0;
        var tool = obj["tool_name"]?.GetValue<string>() ?? "";
        var toolInput = obj["tool_input"]?.DeepClone() ?? new JsonObject();
        var sid = Files.SafeName(sessionId);

        var s = Files.ReadJson(Path.Combine(Files.Sessions, sid + ".json"));
        if (s == null) return 0;
        var voiceFlow = s["voiceFlow"] is JsonValue vf && vf.TryGetValue<bool>(out var b) && b;
        var beat = s["heartbeat"] is JsonValue hb && hb.TryGetValue<double>(out var h) ? h : 0;
        if (!voiceFlow || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - beat > 8000) return 0;
        var wait = s["approvalWaitSeconds"] is JsonValue aw && aw.TryGetValue<double>(out var w) ? Math.Clamp(w, 5, 120) : 20;

        Files.EnsureFolders();
        var id = Guid.NewGuid().ToString();
        var requestFile = Path.Combine(Files.Permission, sid + ".json");
        var answerFile = Path.Combine(Files.Permission, sid + ".answer");
        try { File.Delete(answerFile); } catch { }
        void WriteRequest(string state) => Files.WriteAtomically(requestFile, new JsonObject
        {
            ["id"] = id, ["tool"] = tool, ["input"] = toolInput.DeepClone(), ["state"] = state,
            ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        }.ToJsonString());
        WriteRequest("waiting");
        Log.Write($"permission request for {tool} in {sid[..Math.Min(8, sid.Length)]}, waiting {wait} s for a spoken answer");

        var deadline = DateTime.Now.AddSeconds(wait + 8);
        while (DateTime.Now < deadline)
        {
            if (Files.ReadJson(answerFile) is { } a && a["id"]?.GetValue<string>() == id && a["answer"]?.GetValue<string>() is { } answer)
            {
                try { File.Delete(answerFile); } catch { }
                WriteRequest("answered");
                Log.Write("permission answered by voice: " + answer);
                var decision = answer == "yes"
                    ? new JsonObject { ["behavior"] = "allow" }
                    : new JsonObject { ["behavior"] = "deny", ["message"] = "The user said no by voice." };
                Console.Out.Write(new JsonObject { ["hookSpecificOutput"] = new JsonObject { ["hookEventName"] = "PermissionRequest", ["decision"] = decision } }.ToJsonString());
                return 0;
            }
            Thread.Sleep(200);
        }
        WriteRequest("timeout");
        Log.Write("no spoken answer, showing the permission box");
        return 0;
    }
}
