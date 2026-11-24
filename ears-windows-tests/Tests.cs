namespace Spokeline;

static class Tests
{
    static int failed, passed;

    static void Check(string name, bool ok)
    {
        if (ok) passed++; else { failed++; Console.WriteLine("FAIL: " + name); }
    }

    static int Main()
    {
        var wake = WakePhrases.Build("claude, hey claude, ok claude, anthropic, hey spokeline");

        // Wake phrases: the request after them, including common mishearings.
        Check("Claude, run the tests", WakePhrases.After(wake, "Claude, run the tests") == "run the tests");
        Check("hey cloud ...", WakePhrases.After(wake, "Hey cloud what time is it") == "what time is it");
        Check("ok claude", WakePhrases.After(wake, "OK Claude, stop") == "stop");
        Check("anthropic misheard as pantropic", WakePhrases.After(wake, "Pantropic, open the log") == "open the log");
        Check("her and traffic", WakePhrases.After(wake, "her and traffic show me the diff") == "show me the diff");
        Check("hey spokeline", WakePhrases.After(wake, "hey spokeline list the files") == "list the files");
        Check("wake phrase alone", WakePhrases.After(wake, "Claude.") == "");
        Check("claude misheard as cloth (heard on a real Windows PC)", WakePhrases.After(wake, "Cloth") == "");
        Check("claude misheard as lord", WakePhrases.After(wake, "Lord, what is two plus two?") == "what is two plus two?");
        Check("hey misheard as a number", WakePhrases.After(wake, "12. Claude, what is 2 plus") == "what is 2 plus");
        Check("a word without a pause before claude", WakePhrases.After(wake, "Ask Claude about it") == null);
        Check("spokeline heard as procholine", WakePhrases.After(wake, "Procholine.") == "");
        Check("spokeline heard as poco line", WakePhrases.After(wake, "Poco line can you hear me") == "can you hear me");
        Check("spokeline heard as book a line", WakePhrases.After(wake, "Book a line. Here are me") == "Here are me");
        // Heard on a real Windows PC on 23.11.2026 when "Hey Spokeline" was said.
        Check("spokeline heard as facebook align", WakePhrases.After(wake, "Facebook align.") == "");
        Check("spokeline heard as acebook align", WakePhrases.After(wake, "Acebook align. This green microphone is still too bad.") == "This green microphone is still too bad.");
        Check("spokeline heard as casebook align", WakePhrases.After(wake, "Casebook align.") == "");
        Check("hey spokeline heard as in a spoke line", WakePhrases.After(wake, "In a spoke line.") == "");
        Check("spokeline heard as i spoke a lot", WakePhrases.After(wake, "I spoke a lot. Can I possibly hear me?") == "Can I possibly hear me?");
        Check("a sentence about speaking is not spokeline", WakePhrases.After(wake, "I spoke to him yesterday") == null);
        Check("a book is not spokeline", WakePhrases.After(wake, "Book a table for two") == null);
        foreach (var plain in new[] { "I spoke a lot about this yesterday", "Notebook line two is wrong", "Textbook line one", "Cookbook lane closed today",
                     "Break line before the brace", "Block line comment", "Black line on the chart", "Bank line of credit",
                     "Back line of defence", "Price line is too high", "Spec line missing", "Pick a line number", "Spark line chart" })
            Check("an ordinary sentence is not spokeline: " + plain, WakePhrases.After(wake, plain) == null);
        Check("loudness: silent is no bars", Loudness.Bars(false, 0.9f) == 0);
        Check("loudness at a normal distance (fifine, usual 0.1): quiet, normal, loud", Loudness.Bars(true, 0.02f, 0.1f) == 1 && Loudness.Bars(true, 0.04f, 0.1f) == 2 && Loudness.Bars(true, 0.09f, 0.1f) == 3);
        Check("loudness right at the lips (usual 0.5): normal speech two bars", Loudness.Bars(true, 0.2f, 0.5f) == 2 && Loudness.Bars(true, 0.45f, 0.5f) == 3);
        {
            // 3 s of speech, 1 s of quiet, 4 s of speech, 1 s quiet, 3 s speech: three pieces at the pauses.
            var x = new List<float>();
            void Part(double s, float a) { var r = new Random(1); for (var i = 0; i < (int)(s * 16000); i++) x.Add((float)((r.NextDouble() * 2 - 1) * a)); }
            Part(3, 0.05f); Part(1, 0.002f); Part(4, 0.05f); Part(1, 0.002f); Part(3, 0.05f);
            var p = SoundPieces.Split(x.ToArray());
            Check("a long recording is split at its pauses", p.Count == 3 && p[0].Start == 0 && p[2].End == x.Count);
            x.Clear(); Part(40, 0.05f);
            var q = SoundPieces.Split(x.ToArray());
            Check("40 s without a pause is cut into pieces of at most 15 s", q.Count >= 3 && q.All(r => r.End - r.Start <= 16000 * 16));
            Check("the shown live text is not wiped by an empty reading", !SoundPieces.KeepsWords("so now I will be talking", "") && SoundPieces.KeepsWords("so now", "so now I will"));
        }
        Check("a pipeline is not spokeline", WakePhrases.After(wake, "Pipeline failed again") == null);
        Check("an online word is not spokeline", WakePhrases.After(wake, "Online shops are open") == null);
        Check("not at the start", WakePhrases.After(wake, "I asked Claude yesterday") == null);
        Check("no wake phrase", WakePhrases.After(wake, "what a nice day") == null);

        // Conversation phrases.
        Check("let's talk", ConversationPhrase.Of("Let's talk.") == ConversationPhrase.Kind.Start);
        Check("that's all (curly quote)", ConversationPhrase.Of("That’s all, thanks") == ConversationPhrase.Kind.End);
        Check("goodbye", ConversationPhrase.Of("Okay goodbye") == ConversationPhrase.Kind.End);
        Check("an ordinary sentence", ConversationPhrase.Of("let's talk about the build") == ConversationPhrase.Kind.None);

        // Own voice: what the microphone heard compared with what Spokeline is saying.
        var saying = "Open PowerShell and run the first command. The first tells Claude Code where the Spokeline folder is.";
        Check("own voice, misheard name", OwnVoice.IsOwnVoice("claude costa where the spokeline folder is", saying));
        Check("you, saying claude stop", !OwnVoice.IsOwnVoice("claude stop", saying));
        Check("mostly its own words", OwnVoice.IsMostlySpoken("run the first command the first tells", saying));
        Check("your own words", !OwnVoice.IsMostlySpoken("wait I want something else entirely", saying));
        Check("nothing being said", !OwnVoice.IsMostlySpoken("anything at all", ""));

        Check("yes is an answer", OwnVoice.IsAnswerWord("Yes."));
        Check("go ahead is an answer", OwnVoice.IsAnswerWord("Go ahead!"));
        Check("a sentence is not", !OwnVoice.IsAnswerWord("yes but change the name"));

        // The unfinished text file: written when something changed, and once a second while you speak.
        Check("new text is written", LiveText.Due("run the", "a", "run", "a", 0.2));
        Check("the same text is not written again at once", !LiveText.Due("run the", "a", "run the", "a", 0.2));
        Check("the same text is written again after a second", LiveText.Due("run the", "a", "run the", "a", 1.1));
        Check("silence is not written again and again", !LiveText.Due("", "a", "", "a", 60));
        Check("the end of speaking is written", LiveText.Due("", "a", "run the tests", "a", 0.2));
        Check("another chat is written", LiveText.Due("run", "b", "run", "a", 0.2));
        Check("the file holds the text", System.Text.Json.Nodes.JsonNode.Parse(LiveText.Json("say \"hi\""))?["text"]?.GetValue<string>() == "say \"hi\"");

        var liveFile = Files.LiveFile("ears-test-chat");
        var live = new LiveText();
        live.Update("ears-test-chat", "run the");
        Check("the unfinished text is in the chat's file", Files.ReadJson(liveFile)?["text"]?.GetValue<string>() == "run the");
        live.Update("ears-test-chat", "");
        Check("the file is emptied when you stop speaking", Files.ReadJson(liveFile)?["text"]?.GetValue<string>() == "");
        live.Update("ears-test-chat", "again");
        live.Update(null, "again");
        Check("the file is emptied when the chat is gone", Files.ReadJson(liveFile)?["text"]?.GetValue<string>() == "");
        try { File.Delete(liveFile); } catch { }

        // The microphone state the chats show all the time.
        var es = System.Text.Json.Nodes.JsonNode.Parse(EarsStateFile.Json("listening", "hands_free", true, "abc", "Ctrl+Alt+V", "claude", true));
        Check("the state file says when it hears you", System.Text.Json.Nodes.JsonNode.Parse(EarsStateFile.Json("capturing", "hands_free", false, "", "", "", true, hearing: true))?["hearing"]?.GetValue<bool>() == true);
        Check("the state file holds the state", es?["state"]?.GetValue<string>() == "listening" && es?["conversation"]?.GetValue<bool>() == true && es?["target"]?.GetValue<string>() == "abc");

        var names = new[] { "Microphone (USBAudio1.0)", "Headset Microphone (Poly Savi " };
        Check("a chosen device is found by its cut name", DeviceList.WaveNumber("Headset Microphone (Poly Savi 8200 Office)", 2, i => names[i]) == 1);
        Check("no choice is the Windows default", DeviceList.WaveNumber("", 2, i => names[i]) == -1);
        Check("an unplugged device is the Windows default", DeviceList.WaveNumber("Old USB Mic", 2, i => names[i]) == -1);
        var twins = new[] { "Speakers (Realtek(R) Audio) 2", "Speakers (Realtek(R) Audio)", "Headset Microphone (USB Headset", "Headset Microphone (USB Headset" };
        Check("the exact name wins over a longer one", DeviceList.WaveNumber("Speakers (Realtek(R) Audio)", 4, i => twins[i]) == 1);
        Check("two devices with the same cut name: the Windows default", DeviceList.WaveNumber("Headset Microphone (USB Headset H1)", 4, i => twins[i]) == -1);

        // Words the voice cannot read.
        var known = new HashSet<string> { "run", "the", "tests", "don't" };
        var unknown = Words.Unknown("Run the tests, don't skip Kubernetes!", known);
        Check("unknown words found", unknown.SequenceEqual(new[] { "skip", "kubernetes" }));

        Console.WriteLine($"{passed} passed, {failed} failed");
        return failed == 0 ? 0 : 1;
    }
}
