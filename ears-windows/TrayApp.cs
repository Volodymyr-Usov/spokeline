using System.Drawing;
using System.Media;

namespace Spokeline;

/// The tray icon and main loop: watches the chats, pauses or keeps listening while a chat speaks,
/// and delivers what you said to the right chat's inbox.
sealed class TrayApp : ApplicationContext
{
    readonly NotifyIcon tray;
    readonly Inbox inbox = new();
    readonly LiveText live = new();
    readonly EarsStateFile earsState = new();
    readonly Listener listener;
    readonly HotKey hotkey;
    readonly VoiceInstaller installer = new();
    readonly VoiceServer voiceServer = new();
    readonly System.Windows.Forms.Timer ticker = new() { Interval = 150 };
    EarsConfig config = new();
    DateTime configStamp;
    DateTime speakingUntil = DateTime.MinValue;
    bool wasSpeaking;
    // Conversation mode ("let's talk" ... "that's all"): no wake phrase needed until it ends.
    DateTime conversationUntil = DateTime.MinValue;
    bool InConversation => DateTime.Now < conversationUntil;
    static readonly TimeSpan ConversationQuiet = TimeSpan.FromMinutes(2);
    DateTime noChatsSince = DateTime.MaxValue;
    DateTime lastTidy = DateTime.MinValue;
    DateTime lastProblem = DateTime.MinValue;
    string? problem;
    string lastSent = "";
    DateTime micRetryAt = DateTime.MinValue;   // after the microphone failed to open: try again at this time
    bool exiting;

    public TrayApp()
    {
        Log.Write($"Ears started (pid {Environment.ProcessId})");
        var ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        listener = new Listener(ui);
        hotkey = new HotKey(ui);
        tray = new NotifyIcon { Icon = IconFor("🎙"), Visible = true, Text = "Spokeline Ears", ContextMenuStrip = new ContextMenuStrip() };
        tray.ContextMenuStrip.Opening += (_, _) => BuildMenu();

        listener.Utterance += Deliver;
        listener.Wake += () => SystemSounds.Asterisk.Play();
        listener.StateChanged += _ => RefreshIcon();
        listener.Problem += Report;
        listener.BargeIn += () =>
        {
            foreach (var c in ChatSession.Alive().Where(c => c.Speaking)) inbox.Send(c.Id, "command", command: "stop");
        };
        hotkey.Down += KeyDown;
        hotkey.Up += () => listener.EndHold();

        ReloadConfig(force: true);
        ticker.Tick += (_, _) => Tick();
        ticker.Start();
    }

    // ------------------------------------------------------------ config and main loop

    void ReloadConfig(bool force = false)
    {
        var stamp = File.Exists(Files.Config) ? File.GetLastWriteTimeUtc(Files.Config) : DateTime.MinValue;
        if (!force && stamp == configStamp) return;
        configStamp = stamp;
        var old = config;
        config = EarsConfig.Load();
        listener.SetWakePhrases(config.WakePhrase);
        listener.Debug = config.Debug;
        listener.PauseSeconds = config.PauseSeconds;
        listener.BargeInEnabled = config.BargeIn;
        if (force || old.Hotkey != config.Hotkey || old.Mode != config.Mode)
        {
            if (config.Mode == "off") hotkey.Set("");
            else if (!hotkey.Set(config.Hotkey)) Report($"The push-to-talk key \"{config.Hotkey}\" could not be used. Change it in /config > Spokeline.");
            else Log.Write("push-to-talk key: " + hotkey.Display);
        }
        // Another microphone or speakers chosen in the /spokeline menu: open the microphone again on them.
        if (!force && (old.Microphone != config.Microphone || old.Speakers != config.Speakers))
        {
            Log.Write("devices chosen: microphone " + (config.Microphone.Length > 0 ? config.Microphone : "Windows default") +
                "; speakers " + (config.Speakers.Length > 0 ? config.Speakers : "Windows default"));
            var wasOn = listener.State is not ("off" or "idle") || config.Mode == "push_to_talk";
            if (wasOn) { listener.Stop(); if (config.Mode == "push_to_talk") listener.Start(); }
        }
        if (force || old.Mode != config.Mode)
        {
            Log.Write($"mode {config.Mode}, hotkey {hotkey.Display}");
            listener.HandsFree = config.Mode == "hands_free";
            if (config.Mode == "off") listener.Stop();
        }
        RefreshIcon();
    }

    void Tick()
    {
        ReloadConfig();
        installer.Check();
        var chats = ChatSession.Alive();

        if (chats.Any(c => c.Speaking)) speakingUntil = DateTime.Now.AddSeconds(0.6);
        var speakingNow = DateTime.Now < speakingUntil;
        if (wasSpeaking && !speakingNow)
        {
            listener.DiscardHeard();
            listener.FollowUpUntil = DateTime.Now.AddSeconds(8);
        }
        wasSpeaking = speakingNow;
        listener.InConversation = InConversation;
        // Conversation mode: while Claude works or speaks, the 2 minutes of quiet do not run down.
        if (InConversation)
        {
            if (speakingNow || chats.Any(c => c.Busy)) conversationUntil = DateTime.Now + ConversationQuiet;
            if (!speakingNow && listener.FollowUpUntil < conversationUntil) listener.FollowUpUntil = conversationUntil;
        }
        else if (conversationUntil != DateTime.MinValue)
        {
            conversationUntil = DateTime.MinValue;
            listener.FollowUpUntil = DateTime.MinValue;
            Log.Write("conversation ended (2 minutes of quiet)");
            SystemSounds.Exclamation.Play();
            RefreshIcon();
        }
        listener.OthersSpeaking = speakingNow;
        listener.SpokenText = chats.FirstOrDefault(c => c.Speaking)?.SpeakingText ?? "";
        var target = ChatSession.ChooseTarget(config);
        listener.AcceptWithoutWake = target?.AwaitingAnswer ?? false;
        // What you are saying right now, unfinished, for the chat that will get it.
        live.Update(target?.Id, listener.LiveText);
        earsState.Update(listener.State, config.Mode, InConversation, target?.Id ?? "",
            hotkey.Display.Length > 0 ? hotkey.Display : config.Hotkey, config.WakePhrase.Split(',')[0].Trim(), Models.AsrReady, config.Microphone, config.Speakers, listener.Hearing, listener.Level);

        // Hands free: listen only while a chat is open and the speech pack is installed.
        var want = config.Mode == "hands_free" && chats.Count > 0 && Models.AsrReady;
        listener.HandsFree = config.Mode == "hands_free";
        // If the microphone cannot open (none, or blocked in Windows' privacy settings), try again every 15 s, not constantly.
        if (want && listener.State is "off" or "idle" && DateTime.Now >= micRetryAt && !listener.Start()) micRetryAt = DateTime.Now.AddSeconds(15);
        if (!want && config.Mode == "hands_free" && listener.State is "listening" or "capturing") listener.Stop();

        if (chats.Count == 0)
        {
            if (noChatsSince == DateTime.MaxValue) noChatsSince = DateTime.Now;
            if ((DateTime.Now - noChatsSince).TotalMinutes > 30) ExitThread();
        }
        else noChatsSince = DateTime.MaxValue;

        if ((DateTime.Now - lastTidy).TotalSeconds > 5) { lastTidy = DateTime.Now; inbox.Tidy(); }
    }

    // ------------------------------------------------------------ push to talk

    void KeyDown()
    {
        if (config.Mode == "off") return;
        foreach (var c in ChatSession.Alive().Where(c => c.Speaking)) inbox.Send(c.Id, "command", command: "stop");
        speakingUntil = DateTime.MinValue;
        listener.BeginHold();
        if (listener.State == "recording") SystemSounds.Asterisk.Play();
    }

    // ------------------------------------------------------------ delivering what you said

    void Deliver(string said)
    {
        said = said.Trim();
        if (said.Length == 0) { SystemSounds.Hand.Play(); return; }

        switch (ConversationPhrase.Of(said))
        {
            case ConversationPhrase.Kind.Start:
                conversationUntil = DateTime.Now + ConversationQuiet;
                Log.Write("conversation started");
                SystemSounds.Asterisk.Play();
                RefreshIcon();
                return;
            case ConversationPhrase.Kind.End:
                // "That's all" ends the conversation and closes the microphone: the chat sets listening to off
                // (it owns that setting in config.json), and Ears follows when the file changes.
                conversationUntil = DateTime.MinValue;
                listener.FollowUpUntil = DateTime.MinValue;
                if (ChatSession.ChooseTarget(config) is { } chat) inbox.Send(chat.Id, "command", command: "listen_off");
                Log.Write("conversation ended; microphone off");
                SystemSounds.Exclamation.Play();
                RefreshIcon();
                return;
        }
        // Anything you say starts (or keeps going) a conversation: no wake phrase needed until it ends.
        if (!InConversation) Log.Write("conversation started");
        conversationUntil = DateTime.Now + ConversationQuiet;
        RefreshIcon();

        // "Switch to photobook" is handled by the chat (the add-on): it matches misheard names, says
        // which chat you are talking to now, and brings a VS Code window forward. Ears only delivers it.
        var target = ChatSession.ChooseTarget(config);
        if (target == null) { SystemSounds.Hand.Play(); Report("No Claude chat with Spokeline is open, so nothing was sent."); return; }
        inbox.Send(target.Id, "say", text: said);
        lastSent = said;
        SystemSounds.Beep.Play();
    }

    // ------------------------------------------------------------ tray icon, menu, problems

    void Report(string message)
    {
        problem = message;
        Log.Write("problem: " + message);
        if ((DateTime.Now - lastProblem).TotalSeconds > 20)
        {
            lastProblem = DateTime.Now;
            tray.ShowBalloonTip(8000, "Spokeline Ears", message, ToolTipIcon.Warning);
        }
    }

    string ModeText => config.Mode switch
    {
        "off" => "microphone off",
        "hands_free" when InConversation => "in a conversation (say \"that's all\" to end)",
        "hands_free" => Models.AsrReady ? "hands free: start with \"" + config.WakePhrase.Split(',')[0].Trim() + "\"" : "waiting for the speech pack",
        _ => "hold " + (hotkey.Display.Length > 0 ? hotkey.Display : config.Hotkey) + " and speak",
    };

    void RefreshIcon()
    {
        if (exiting) return;
        var glyph = config.Mode == "off" ? "🔇" : listener.State is "capturing" or "recording" ? "🔴" : "🎙";
        var icon = IconFor(glyph);
        if (tray.Icon != icon) tray.Icon = icon;
        var tip = "Spokeline Ears: " + ModeText;
        tray.Text = tip.Length > 63 ? tip[..63] : tip;
    }

    // Only three icons exist; each is made once and kept (an icon made from a bitmap is never freed by Windows,
    // so making a new one on every change would slowly use up the 10,000 the app may have).
    static readonly Dictionary<string, Icon> icons = new();
    static Icon IconFor(string glyph)
    {
        if (!icons.TryGetValue(glyph, out var icon)) icons[glyph] = icon = MakeIcon(glyph);
        return icon;
    }

    static Icon MakeIcon(string glyph)
    {
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.Transparent);
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
            using var f = new Font("Segoe UI Emoji", 18, GraphicsUnit.Pixel);
            g.DrawString(glyph, f, Brushes.White, 1, 3);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }

    void BuildMenu()
    {
        var m = tray.ContextMenuStrip!;
        m.Items.Clear();
        m.Items.Add(new ToolStripMenuItem("Spokeline Ears: " + ModeText) { Enabled = false });
        if (problem != null) m.Items.Add(new ToolStripMenuItem("⚠ " + (problem.Length > 90 ? problem[..90] + "…" : problem)) { Enabled = false });
        m.Items.Add(new ToolStripSeparator());
        foreach (var (title, value) in new[] { ("Off", "off"), ("Push to talk", "push_to_talk"), ("Hands free", "hands_free") })
        {
            var item = new ToolStripMenuItem(title) { Checked = config.Mode == value };
            item.Click += (_, _) => { problem = null; EarsConfig.Update(new() { ["mode"] = value }); ReloadConfig(force: true); };
            m.Items.Add(item);
        }
        m.Items.Add(new ToolStripSeparator());
        var chats = ChatSession.Alive().OrderByDescending(c => c.LastActive).ToList();
        var current = ChatSession.ChooseTarget(config)?.Id;
        m.Items.Add(new ToolStripMenuItem(chats.Count == 0 ? "No Claude chats open" : "Talking to:") { Enabled = false });
        foreach (var c in chats)
        {
            var item = new ToolStripMenuItem("   " + c.Title + (c.Busy ? "  (working)" : "")) { Checked = c.Id == current };
            item.Click += (_, _) => { EarsConfig.Update(new() { ["targetSessionId"] = c.Id }); ReloadConfig(force: true); };
            m.Items.Add(item);
        }
        if (config.TargetSessionId != null)
        {
            var item = new ToolStripMenuItem("   Follow the chat I used last");
            item.Click += (_, _) => { EarsConfig.Update(new() { ["targetSessionId"] = null }); ReloadConfig(force: true); };
            m.Items.Add(item);
        }
        if (lastSent.Length > 0)
        {
            m.Items.Add(new ToolStripSeparator());
            m.Items.Add(new ToolStripMenuItem("Last heard: " + (lastSent.Length > 60 ? lastSent[..60] + "…" : lastSent)) { Enabled = false });
        }
        m.Items.Add(new ToolStripSeparator());
        var log = new ToolStripMenuItem("Show log");
        log.Click += (_, _) => { try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Files.LogFile) { UseShellExecute = true }); } catch { } };
        m.Items.Add(log);
        var quit = new ToolStripMenuItem("Quit Spokeline Ears");
        quit.Click += (_, _) => ExitThread();
        m.Items.Add(quit);
    }

    protected override void ExitThreadCore()
    {
        // Stop everything first, the tray icon last: stopping the listener updates the icon, and an icon
        // that is already gone would crash with an error box (leaving a hidden copy running).
        exiting = true;
        ticker.Stop();
        hotkey.Dispose();
        listener.Dispose();
        live.Clear();
        EarsStateFile.Closed(config.Mode);
        voiceServer.Dispose();
        tray.Visible = false;
        tray.Dispose();
        base.ExitThreadCore();
    }
}
