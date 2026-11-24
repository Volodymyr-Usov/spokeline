using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Spokeline;

/// Files shared with the Spokeline mod, in %USERPROFILE%\.spokeline (same layout as on macOS).
static class Files
{
    public static readonly string Base = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".spokeline");
    public static string Sessions => Path.Combine(Base, "sessions");
    public static string Inbox => Path.Combine(Base, "inbox");
    public static string Permission => Path.Combine(Base, "permission");
    public static string Voice => Path.Combine(Base, "voice");
    public static string Live => Path.Combine(Base, "live");
    public static string Config => Path.Combine(Base, "config.json");
    public static string LogFile => Path.Combine(Base, "ears.log");
    /// What the microphone is doing now, for the chats to show all the time (written about once a second).
    public static string EarsState => Path.Combine(Base, "ears.json");

    public static void EnsureFolders()
    {
        foreach (var d in new[] { Base, Sessions, Inbox, Permission, Voice, Live }) Directory.CreateDirectory(d);
    }

    /// Session ids come from file names we did not write ourselves: keep only safe characters.
    public static string SafeName(string s) => new string(s.Where(c => char.IsLetterOrDigit(c) || c == '-' || c == '_').ToArray());

    public static string InboxFile(string sessionId) => Path.Combine(Inbox, SafeName(sessionId) + ".jsonl");
    public static string LiveFile(string sessionId) => Path.Combine(Live, SafeName(sessionId) + ".json");

    public static void WriteAtomically(string path, string text)
    {
        var tmp = Path.Combine(Path.GetDirectoryName(path)!, "." + Path.GetFileName(path) + ".tmp");
        File.WriteAllText(tmp, text);
        File.Move(tmp, path, true);
    }

    public static JsonObject? ReadJson(string path)
    {
        try { return JsonNode.Parse(File.ReadAllText(path)) as JsonObject; } catch { return null; }
    }
}

static class Log
{
    static readonly object Gate = new();
    public static void Write(string s)
    {
        lock (Gate)
        {
            try
            {
                var f = new FileInfo(Files.LogFile);
                if (f.Exists && f.Length > 1_000_000) f.Delete();
                File.AppendAllText(Files.LogFile, DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ") + " " + s + Environment.NewLine);
            }
            catch { }
        }
    }
}

sealed class EarsConfig
{
    public string Mode = "hands_free";
    public string Hotkey = "ctrl+option+v";
    public string WakePhrase = "claude, hey claude, ok claude, anthropic, hey spokeline";
    public string Language = "";
    public string? TargetSessionId;
    public bool Debug;
    public double PauseSeconds = 3.0;
    public bool BargeIn = true;
    /// The microphone and speakers chosen in the /spokeline menu by name; "" = the Windows default.
    public string Microphone = "";
    public string Speakers = "";

    public static EarsConfig Load()
    {
        var c = new EarsConfig();
        var o = Files.ReadJson(Files.Config);
        if (o == null) return c;
        string? S(string k) => o[k] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
        if (S("mode") is { } m) c.Mode = m;
        if (S("hotkey") is { Length: > 0 } h) c.Hotkey = h;
        if (S("wakePhrase") is { Length: > 0 } w) c.WakePhrase = w;
        if (S("language") is { } l) c.Language = l;
        if (S("targetSessionId") is { Length: > 0 } t) c.TargetSessionId = t;
        if (o["debug"] is JsonValue dv && dv.TryGetValue<bool>(out var d)) c.Debug = d;
        if (o["pauseSeconds"] is JsonValue pv && pv.TryGetValue<double>(out var p)) c.PauseSeconds = Math.Clamp(p, 1, 8);
        if (o["bargeIn"] is JsonValue bv && bv.TryGetValue<bool>(out var b)) c.BargeIn = b;
        if (S("microphone") is { } mi) c.Microphone = mi;
        if (S("speakers") is { } sp) c.Speakers = sp;
        return c;
    }

    /// Change some keys and keep the rest of the file as it is.
    public static void Update(Dictionary<string, object?> changes)
    {
        var o = Files.ReadJson(Files.Config) ?? new JsonObject();
        foreach (var (k, v) in changes)
        {
            if (v == null) o.Remove(k); else o[k] = JsonValue.Create(v);
        }
        o["updatedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Files.WriteAtomically(Files.Config, o.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }
}

sealed record ChatSession(string Id, string Title, double LastActive, double Heartbeat, bool Busy, bool Speaking,
    bool AwaitingAnswer, double AckSeq, string SpeakingText)
{
    public bool IsAlive => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - Heartbeat < 8000;

    // The plugin cannot write its status file in one step: keep the last complete reading.
    static readonly Dictionary<string, JsonObject> LastGood = new();

    public static List<ChatSession> All()
    {
        var list = new List<ChatSession>();
        if (!Directory.Exists(Files.Sessions)) return list;
        foreach (var path in Directory.GetFiles(Files.Sessions, "*.json"))
        {
            var o = Files.ReadJson(path);
            lock (LastGood) { if (o != null) LastGood[path] = o; else LastGood.TryGetValue(path, out o); }
            if (o == null) continue;
            string S(string k) => o[k] is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";
            double D(string k) => o[k] is JsonValue v && v.TryGetValue<double>(out var x) ? x : 0;
            bool B(string k) => o[k] is JsonValue v && v.TryGetValue<bool>(out var x) && x;
            var id = S("sessionId");
            if (id.Length == 0) continue;
            list.Add(new ChatSession(id, S("title") is { Length: > 0 } t ? t : "Claude", D("lastActive"), D("heartbeat"),
                B("busy"), B("speaking"), B("awaitingAnswer"), D("ackSeq"), S("speakingText")));
        }
        return list;
    }

    public static List<ChatSession> Alive() => All().Where(s => s.IsAlive).ToList();

    /// Which chat gets what you said: the one you named, else the one you used last.
    public static ChatSession? ChooseTarget(EarsConfig config)
    {
        var alive = Alive();
        if (config.TargetSessionId is { } t && alive.FirstOrDefault(s => s.Id == t) is { } named) return named;
        return alive.OrderByDescending(s => s.LastActive).FirstOrDefault();
    }
}

sealed class Inbox
{
    double last;

    /// Sequence numbers only ever go up, even across restarts.
    double NextSeq()
    {
        var candidate = Math.Floor((double)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) * 1000;
        last = Math.Max(candidate, last + 1);
        return last;
    }

    public void Send(string sessionId, string type, string? text = null, string? command = null)
    {
        var msg = new JsonObject { ["seq"] = NextSeq(), ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), ["type"] = type };
        if (text != null) msg["text"] = text;
        if (command != null) msg["command"] = command;
        File.AppendAllText(Files.InboxFile(sessionId), msg.ToJsonString() + "\n");
        Log.Write($"sent {type} to {sessionId[..Math.Min(8, sessionId.Length)]}: {text ?? command}");
    }

    /// Empty inbox files the mod has fully read, and remove files of chats that ended long ago.
    public void Tidy()
    {
        var sessions = ChatSession.All().ToDictionary(s => Files.SafeName(s.Id));
        LiveText.Tidy(sessions.Keys);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (Directory.Exists(Files.Inbox))
        {
            foreach (var path in Directory.GetFiles(Files.Inbox, "*.jsonl"))
            {
                var id = Path.GetFileNameWithoutExtension(path);
                if (!sessions.TryGetValue(id, out var s)) { TryDelete(path); continue; }
                string text;
                try { text = File.ReadAllText(path); } catch { continue; }
                if (text.Length == 0) continue;
                double max = 0;
                foreach (var line in text.Split('\n', StringSplitOptions.RemoveEmptyEntries))
                    if (JsonNode.Parse(line)?["seq"] is JsonValue v && v.TryGetValue<double>(out var n)) max = Math.Max(max, n);
                if (s.AckSeq >= max) { try { File.WriteAllText(path, ""); } catch { } }
            }
        }
        foreach (var s in sessions.Values.Where(s => now - s.Heartbeat > 3_600_000))
        {
            TryDelete(Path.Combine(Files.Sessions, Files.SafeName(s.Id) + ".json"));
            TryDelete(Files.InboxFile(s.Id));
        }
    }

    static void TryDelete(string p) { try { File.Delete(p); } catch { } }
}

/// The unfinished text, while you are still speaking: live\<chat id>.json = { "text", "ts" } for the chat
/// that will get the request. Written when the text changes (looked at several times a second), and once a
/// second while it stays the same, so a reader can tell fresh text from old. Empty text: nothing is being said.
/// The finished request still arrives through the inbox, as before.
sealed class LiveText
{
    string lastId = "";
    string lastText = "";
    DateTime lastWrite = DateTime.MinValue;

    /// True when the file must be written now.
    public static bool Due(string text, string id, string lastText, string lastId, double secondsSinceWrite) =>
        id != lastId || text != lastText || (text.Length > 0 && secondsSinceWrite >= 1.0);

    public static string Json(string text) =>
        new JsonObject { ["text"] = text, ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }.ToJsonString();

    public void Update(string? sessionId, string text)
    {
        var id = sessionId ?? "";
        if (id.Length == 0) text = "";
        if (!Due(text, id, lastText, lastId, (DateTime.Now - lastWrite).TotalSeconds)) return;
        // The chat you talk to changed in the middle: the old chat must not keep showing your words.
        if (lastId.Length > 0 && lastId != id && lastText.Length > 0) Write(lastId, "");
        if (id.Length > 0 && (text.Length > 0 || (lastId == id && lastText.Length > 0))) Write(id, text);
        lastId = id;
        lastText = text;
        lastWrite = DateTime.Now;
    }

    public void Clear() => Update(lastId, "");

    static void Write(string id, string text)
    {
        try { Directory.CreateDirectory(Files.Live); Files.WriteAtomically(Files.LiveFile(id), Json(text)); } catch { }
    }

    /// Remove the files of chats that are gone.
    public static void Tidy(IEnumerable<string> safeSessionNames)
    {
        try
        {
            var keep = safeSessionNames.ToHashSet();
            if (!Directory.Exists(Files.Live)) return;
            foreach (var path in Directory.GetFiles(Files.Live, "*.json"))
                if (!keep.Contains(Path.GetFileNameWithoutExtension(path))) File.Delete(path);
        }
        catch { }
    }
}

/// The wake phrases, as on macOS: several phrases, common mishearings, optional greeting word.
static class WakePhrases
{
    public static List<Regex> Build(string phrases) =>
        phrases.Split(',').Select(p => p.Trim()).Where(p => p.Length > 0).Select(One).Where(r => r != null).Cast<Regex>().ToList();

    static Regex? One(string phrase)
    {
        var words = Regex.Split(phrase.ToLowerInvariant(), "[^\\p{L}\\p{N}]+").Where(w => w.Length > 0).ToList();
        if (words.Count == 0) return null;
        var parts = new List<string>();
        for (var i = 0; i < words.Count; i++)
        {
            var w = words[i];
            var p = string.Join("\\s?", w.Select(ch => Regex.Escape(ch.ToString())));
            if (w == "spokeline") p = "(?:" + p + "s?|spokane|spoke\\s?lane|spoken\\s?line|spock\\s?line|poco\\s?line|(?:face|case|ace)\\s?book\\s?(?:a\\s?)?(?:line|lane|align|lign)s?" +
                // Looser mishearings ("Book a line.", "I spoke a lot.", "Procholine.") count only when said as a phrase
                // of their own, followed by a pause mark: "Notebook line two is wrong" is an ordinary sentence.
                "|(?:i\\s?spoke\\s?a\\s?lot|(?:(?:in\\s)?a\\s)?(?:[a-z]{0,4}\\s?book|spook|spoke)\\s?(?:a\\s?)?(?:line|lane|align|lign)s?|(?:s?p|b|pr)[a-z]{0,3}[ck]h?[a-z]?\\s?(?:a\\s)?line)(?=\\s*[.,!?]|\\s*$))";
            if (w == "claude") p = "(?:claude|cloud|clawed|claudia|clod|clyde|claud|clawd|klaud|cloth|clothe|lord)";
            if (w == "anthropic") p = "(?:anthropi[ck]|anthro\\s?pick|and\\s?throw\\s?pick|[a-z]{0,5}\\s?tropi[ck]s?|(?:and|an|in|her\\s+and)\\s?traffic)";
            if (i == 0 && (w is "hey" or "hi" or "ok" or "okay")) p = "(?:hey|hi|hay|a|ok|okay|her|hate|hello)";
            parts.Add(p);
        }
        var pattern = string.Join("[\\s,.!?]+", parts);
        if (words.Count > 1 && words[0] is "hey" or "hi" or "ok" or "okay")
            // The greeting is often misheard as some other short word or a number ("12. Claude, what is ..."
            // on a real Windows PC), so one short word that ends with a full stop or comma, or a number, also counts.
            pattern = "(?:" + parts[0] + "[\\s,.!?]+|[\\p{L}\\p{N}]{1,6}[,.!?]+\\s*|\\d+\\s+)?" + string.Join("[\\s,.!?]+", parts.Skip(1));
        return new Regex("^\\W*(?:um\\W+|uh\\W+)?" + pattern + "\\b[\\s,.!?:]*", RegexOptions.IgnoreCase);
    }

    /// If the text starts with a wake phrase, returns what comes after it ("" when nothing yet).
    public static string? After(List<Regex> wake, string text)
    {
        foreach (var re in wake)
        {
            var m = re.Match(text);
            if (m.Success) return text[(m.Index + m.Length)..].Trim();
        }
        return null;
    }
}

/// "let's talk" starts conversation mode; "that's all" ends it. Only the whole sentence counts.
static class ConversationPhrase
{
    public enum Kind { None, Start, End }
    static readonly string[] Starts = { "let's talk", "lets talk", "let's chat", "lets chat", "let's have a conversation",
        "conversation mode", "start conversation", "start a conversation", "let's keep talking" };
    static readonly string[] Ends = { "that's all", "thats all", "that is all", "that's it", "goodbye", "good bye", "bye",
        "stop listening", "end conversation", "end the conversation", "we're done", "were done" };

    public static Kind Of(string said)
    {
        var t = said.ToLowerInvariant().Replace('\u2019', '\'').Trim(' ', '.', ',', '!', '?');
        foreach (var w in new[] { "ok ", "okay ", "so ", "now ", "alright ", "all right " }) if (t.StartsWith(w)) t = t[w.Length..];
        foreach (var w in new[] { " for now", " claude", " thanks", " thank you" }) if (t.EndsWith(w)) t = t[..^w.Length];
        t = t.Trim(' ', '.', ',', '!', '?');
        if (Starts.Contains(t)) return Kind.Start;
        if (Ends.Contains(t)) return Kind.End;
        return Kind.None;
    }
}

/// Is what the microphone heard Spokeline's own voice? (Compared with what it is saying right now.)
static class OwnVoice
{
    static readonly HashSet<string> Answers = new() { "yes", "yeah", "yep", "sure", "ok", "okay", "go", "go ahead", "do it", "start",
        "just start", "no", "nope", "not yet", "wait", "stop", "send", "cancel", "yes please", "yes go ahead" };

    /// "yes", "no", "go ahead", "do it"...: a short answer to a question Spokeline asked.
    public static bool IsAnswerWord(string text) =>
        Answers.Contains(Regex.Replace(text.ToLowerInvariant(), "[^a-z ]", "").Trim());

    /// True when most of the words heard are words the chat itself is saying right now (its own voice).
    public static bool IsMostlySpoken(string heard, string spokenText)
    {
        if (spokenText.Length == 0) return false;
        static string[] Norm(string s) => Regex.Replace(s.ToLowerInvariant(), "[^\\p{L}\\p{N} ]", " ").Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var words = Norm(heard).TakeLast(8).ToList();
        if (words.Count == 0) return false;
        var spoken = Norm(spokenText).ToHashSet();
        return words.Count(spoken.Contains) >= 0.6 * words.Count;
    }

    /// True when the words are part of what the chat itself is saying (its voice heard by the microphone).
    public static bool IsOwnVoice(string heard, string spokenText)
    {
        if (spokenText.Length == 0) return false;
        static string Norm(string s) => Regex.Replace(Regex.Replace(s.ToLowerInvariant(), "[^\\p{L}\\p{N} ]", " "), "\\s+", " ").Trim();
        var spoken = Norm(spokenText);
        var words = Norm(heard).Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (words.Length == 0) return false;
        if (spoken.Contains(string.Join(" ", words.Take(3)))) return true;
        var after = string.Join(" ", words.Skip(1).Take(2));
        if (words.Length >= 3 && spoken.Contains(after)) return true;
        // Most of the words after the wake word are words being spoken (the rest misheard).
        var rest = words.Skip(1).Take(6).ToList();
        if (rest.Count >= 2)
        {
            var spokenSet = spoken.Split(' ').ToHashSet();
            if (rest.Count(spokenSet.Contains) >= 0.6 * rest.Count) return true;
        }
        return false;
    }

}

static class Words
{
    /// The words of `text` that are in none of the voice's word lists (the voice would skip them silently).
    public static List<string> Unknown(string text, HashSet<string> known) =>
        Regex.Matches(text.ToLowerInvariant(), "[a-z]+(?:'[a-z]+)?").Select(m => m.Value).Where(w => !known.Contains(w)).Distinct().ToList();
}

/// The microphone's state for the chats: written when it changes, and every 2 seconds so a chat can tell
/// that the helper stopped (an old file).
sealed class EarsStateFile
{
    string last = "";
    DateTime lastWrite = DateTime.MinValue;

    /// Reads the sound devices (set by the tray app; the tests have none).
    public static Func<DeviceList?> DeviceReader = () => null;
    volatile DeviceList? devices;
    volatile bool devicesFresh;
    int lastLevel = -1;
    DateTime devicesAt = DateTime.MinValue;

    public static string Json(string state, string mode, bool conversation, string target, string hotkey, string wake, bool speechPack,
        DeviceList? devices = null, string microphone = "", string speakers = "", bool hearing = false, int level = 0)
    {
        var o = new JsonObject
        {
            ["state"] = state, ["hearing"] = hearing, ["level"] = level, ["mode"] = mode, ["conversation"] = conversation, ["target"] = target,
            ["hotkey"] = hotkey, ["wake"] = wake, ["speechPack"] = speechPack,
            ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        if (devices != null)
        {
            o["microphone"] = microphone;
            o["speakers"] = speakers;
            o["defaultMicrophone"] = devices.DefaultMicrophone;
            o["defaultSpeakers"] = devices.DefaultSpeakers;
            o["microphones"] = new JsonArray(devices.Microphones.Select(n => (JsonNode)JsonValue.Create(n)!).ToArray());
            o["speakersList"] = new JsonArray(devices.Speakers.Select(n => (JsonNode)JsonValue.Create(n)!).ToArray());
        }
        return o.ToJsonString();
    }

    public void Update(string state, string mode, bool conversation, string target, string hotkey, string wake, bool speechPack, string microphone, string speakers, bool hearing = false, int level = 0)
    {
        // The device lists change rarely (a headset plugged in): read them every 10 seconds, away from the tray's
        // own thread (a slow sound driver must not freeze the tray icon).
        if ((DateTime.Now - devicesAt).TotalSeconds >= 10)
        {
            devicesAt = DateTime.Now;
            Task.Run(() => { try { devices = DeviceReader(); devicesFresh = true; } catch { } });
        }
        var fresh = devicesFresh;
        var key = string.Join("|", state, hearing, mode, conversation, target, hotkey, wake, speechPack, microphone, speakers);
        var since = (DateTime.Now - lastWrite).TotalSeconds;
        // Only the loudness moved: at most about three writes a second.
        if (!fresh && key == last && (level == lastLevel ? since < 2 : since < 0.3)) return;
        devicesFresh = false;
        last = key;
        lastLevel = level;
        lastWrite = DateTime.Now;
        try { Files.WriteAtomically(Files.EarsState, Json(state, mode, conversation, target, hotkey, wake, speechPack, devices, microphone, speakers, hearing, level)); } catch { }
    }

    /// The tray app is closing: the chats show the microphone as off at once.
    public static void Closed(string mode)
    {
        try { Files.WriteAtomically(Files.EarsState, Json("closed", mode, false, "", "", "", false)); } catch { }
    }
}

/// How loud you are, as 0 to 3 lit bars next to the microphone sign in the chat: none while it does not
/// hear you speak, then measured against your own usual level on this microphone (learned from your
/// requests), so speaking at a normal distance shows two bars and only louder moments show three.
static class Loudness
{
    public static int Bars(bool hearing, float peak, float usual = 0.1f)
    {
        if (!hearing) return 0;
        var u = Math.Clamp(usual, 0.05f, 0.5f);
        return peak >= 0.8f * u ? 3 : peak >= 0.3f * u ? 2 : 1;
    }
}

/// Splits a long recording at your pauses (half a second clearly quieter than your speech) into pieces of
/// at most 15 seconds, as sample ranges with a little sound kept around each piece.
static class SoundPieces
{
    /// True when a new reading of the growing sound may replace the shown one: not when it lost most of it.
    public static bool KeepsWords(string shown, string fresh) => fresh.Length >= 0.4 * shown.Length;

    public static List<(int Start, int End)> Split(float[] x, int rate = 16000)
    {
        var result = new List<(int, int)>();
        var chunk = rate / 10;
        var n = x.Length / chunk;
        if (n < 10) { result.Add((0, x.Length)); return result; }
        var peaks = new float[n];
        for (var i = 0; i < n; i++)
        {
            float p = 0;
            for (var j = i * chunk; j < (i + 1) * chunk; j++) p = Math.Max(p, Math.Abs(x[j]));
            peaks[i] = p;
        }
        var loud = peaks.OrderBy(p => p).ElementAt((int)(n * 0.9));
        var quietBelow = Math.Max(0.006f, 0.25f * loud);
        var chunks = new List<(int, int)>();
        int start = -1, lastLoud = -1, quiet = 0;
        void Add(int a, int b) { if (b - a >= 2) chunks.Add((a, b)); }
        for (var i = 0; i < n; i++)
        {
            if (peaks[i] >= quietBelow) { if (start < 0) start = i; lastLoud = i; quiet = 0; }
            else if (start >= 0 && ++quiet >= 5) { Add(start, lastLoud + 1); start = -1; quiet = 0; }
            if (start >= 0 && i - start + 1 >= 150)
            {
                // 15 seconds without a pause: cut at the quietest moment of the last 5 seconds.
                var cut = i;
                for (var k = i - 50; k <= i; k++) if (peaks[k] < peaks[cut]) cut = k;
                Add(start, cut + 1);
                start = cut + 1 <= i ? cut + 1 : -1;
                quiet = 0;
            }
        }
        if (start >= 0) Add(start, Math.Max(start + 1, lastLoud + 1));
        foreach (var (a, b) in chunks)
            result.Add((Math.Max(0, a - 3) * chunk, b + 3 >= n ? x.Length : (b + 3) * chunk));
        if (result.Count == 0) result.Add((0, x.Length));
        return result;
    }
}

/// The sound devices Windows has switched on, by name, and which are the defaults.
sealed record DeviceList(string[] Microphones, string[] Speakers, string DefaultMicrophone, string DefaultSpeakers)
{
    /// The number of the old-style (wave) device for a chosen name: those names are cut to 31 letters.
    /// -1 is the Windows default.
    public static int WaveNumber(string chosen, int count, Func<int, string> nameOf)
    {
        if (string.IsNullOrEmpty(chosen)) return -1;
        var names = Enumerable.Range(0, count).Select(nameOf).ToList();
        // The exact name first; else a cut name only when exactly one device has it (two headsets whose names
        // differ only after letter 31 cannot be told apart: then the Windows default is used).
        var exact = names.FindIndex(n => string.Equals(n, chosen, StringComparison.OrdinalIgnoreCase));
        if (exact >= 0) return exact;
        var cut = chosen.Length > 31 ? chosen[..31] : chosen;
        var matches = Enumerable.Range(0, count).Where(i => names[i].Length > 0 && cut.StartsWith(names[i], StringComparison.OrdinalIgnoreCase)).ToList();
        return matches.Count == 1 ? matches[0] : -1;
    }
}
