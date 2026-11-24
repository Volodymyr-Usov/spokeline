import AppKit
import Foundation

/// Spokeline Ears: a small menu-bar app. It listens (push to talk or hands free), turns speech into
/// text on this Mac, and writes it into the inbox of the Claude chat you are talking to.
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let inbox = Inbox()
    private let live = LiveText()
    private let earsState = EarsStateFile()
    private let listener = Listener()
    private let hotkey = HotKey()
    private let voiceInstaller = VoiceInstaller()
    private var config = EarsConfig()
    private var configStamp: Date?
    private var ticker: Timer?
    private var permissionsOK = false
    private var askedPermissions = false
    private var problem: String?
    private var lastProblemShown = Date.distantPast
    private var speakingUntil = Date.distantPast
    private var noChatsSince: Date?
    private var lastTidy = Date.distantPast
    private var lastSent = ""
    private var wasSpeaking = false
    /// Conversation mode ("let's talk" ... "that's all"): no wake phrase needed until it ends.
    private var conversationUntil = Date.distantPast
    private var inConversation: Bool { Date() < conversationUntil }
    private let conversationQuiet: TimeInterval = 120

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Only one Ears may run.
        let me = ProcessInfo.processInfo.processIdentifier
        if let id = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: id).contains(where: { $0.processIdentifier != me }) {
            NSApp.terminate(nil)
            return
        }
        Files.ensureFolders()
        Log.write("Ears started (pid \(me))")

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        listener.onUtterance = { [weak self] said in self?.deliver(said) }
        listener.onWake = { NSSound(named: "Tink")?.play() }
        listener.onBargeIn = { [weak self] in
            guard let self = self else { return }
            for c in ChatSession.alive() where c.speaking { self.inbox.send(to: c.id, type: "command", command: "stop") }
        }
        listener.onPhase = { [weak self] _ in self?.refreshIcon() }
        listener.onProblem = { [weak self] msg in self?.report(msg) }

        hotkey.onDown = { [weak self] in self?.keyDown() }
        hotkey.onUp = { [weak self] in self?.keyUp() }

        reloadConfig(force: true)
        ticker = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in self?.tick() }
        refreshIcon()
    }

    func applicationWillTerminate(_ notification: Notification) {
        live.clear()
        EarsStateFile.closed(mode: config.mode)
    }

    // MARK: config

    private func reloadConfig(force: Bool = false) {
        let stamp = (try? FileManager.default.attributesOfItem(atPath: Files.config.path))?[.modificationDate] as? Date
        if !force && stamp == configStamp { return }
        configStamp = stamp
        let old = config
        config = EarsConfig.load().0
        listener.configure(language: config.language, wakePhrase: config.wakePhrase)
        listener.debug = config.debug
        listener.pauseSeconds = config.pauseSeconds
        listener.microphone = config.microphone
        // Another microphone or speakers chosen in the /spokeline menu. The speakers are used by the next sentence
        // Spokeline says (see `--play`); the microphone is opened again at once.
        if !force && (old.microphone != config.microphone || old.speakers != config.speakers) {
            Log.write("devices chosen: microphone " + (config.microphone.isEmpty ? "Mac default" : config.microphone) +
                      "; speakers " + (config.speakers.isEmpty ? "Mac default" : config.speakers))
            if old.microphone != config.microphone { listener.restartMicrophone("another microphone was chosen") }
        }
        if force || old.hotkey != config.hotkey || old.mode != config.mode {
            if config.mode == "off" {
                hotkey.set("")
            } else if !hotkey.set(config.hotkey) {
                report("The push-to-talk key \"\(config.hotkey)\" could not be used (unknown, or taken by another app). Change it in /config > Spokeline.")
            } else {
                Log.write("push-to-talk key: \(hotkey.display)")
            }
        }
        if old.mode != config.mode || force {
            Log.write("mode \(config.mode), hotkey \(hotkey.display), language \(listener.language)")
            if config.mode != "hands_free" { listener.stopHandsFree() }
            if config.mode != "off" { ensurePermissions() }
        }
        refreshIcon()
    }

    private func ensurePermissions(_ then: (() -> Void)? = nil) {
        if permissionsOK { then?(); return }
        if askedPermissions { return }
        askedPermissions = true
        Listener.requestPermissions { [weak self] ok, message in
            guard let self = self else { return }
            self.askedPermissions = false
            self.permissionsOK = ok
            Log.write("permissions: " + (ok ? "allowed" : "not allowed"))
            if let m = message { self.report(m) } else { self.problem = nil }
            if ok { then?() }
            self.refreshIcon()
        }
    }

    // MARK: main loop

    private func tick() {
        reloadConfig()
        let chats = ChatSession.alive()

        // Pause the microphone while any chat is speaking, and a little after.
        if chats.contains(where: { $0.speaking }) { speakingUntil = Date().addingTimeInterval(0.6) }
        let speakingNow = Date() < speakingUntil
        // When Claude has just finished talking, you can answer without the wake phrase for a few seconds.
        if wasSpeaking && !speakingNow {
            listener.discardHeard()
            listener.followUpUntil = Date().addingTimeInterval(8)
        }
        wasSpeaking = speakingNow
        listener.inConversation = inConversation
        // Conversation mode: while Claude works or speaks, the 2 minutes of quiet do not run down.
        if inConversation {
            if speakingNow || chats.contains(where: { $0.busy }) { conversationUntil = Date().addingTimeInterval(conversationQuiet) }
            if !speakingNow && listener.followUpUntil < conversationUntil { listener.followUpUntil = conversationUntil }
        } else if conversationUntil != .distantPast {
            conversationUntil = .distantPast
            listener.followUpUntil = .distantPast
            Log.write("conversation ended (2 minutes of quiet)")
            NSSound(named: "Bottle")?.play()
            refreshIcon()
        }
        // Interrupting by voice: in hands-free mode keep listening while a chat speaks.
        let bargeIn = config.mode == "hands_free" && config.bargeIn
        listener.othersSpeaking = speakingNow
        listener.spokenText = chats.first(where: { $0.speaking })?.speakingText ?? ""
        if speakingNow && !bargeIn { listener.pause() } else { listener.resume() }

        // While the chat you talk to waits for a yes/no (or send/cancel), a bare answer needs no wake phrase.
        let target = chooseTarget(config: config)
        listener.acceptWithoutWake = target?.awaitingAnswer ?? false
        // What you are saying right now, unfinished, for the chat that will get it.
        live.update(sessionId: target?.id, text: listener.steadyLiveText)
        // What the microphone is doing, for the row above the prompt in every chat.
        var s = EarsStateFile.State()
        s.state = config.mode == "off" ? "off" : listener.stateName
        s.mode = config.mode
        s.conversation = inConversation
        s.target = target?.id ?? ""
        s.hotkey = hotkey.display.isEmpty ? config.hotkey : hotkey.display
        s.wake = config.wakePhrase.split(separator: ",").first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        s.microphone = config.microphone
        s.speakers = config.speakers
        s.hearing = listener.hearing
        s.level = listener.bars
        earsState.update(s)

        // Hands free: listen only while at least one chat is open.
        if listener.phase == .error && config.mode == "hands_free" && Date().timeIntervalSince(lastProblemShown) > 15 {
            listener.clearError()
        }
        if config.mode == "hands_free" && permissionsOK && !chats.isEmpty && (!speakingNow || bargeIn) && listener.phase == .idle {
            listener.startHandsFree()
        }
        if chats.isEmpty && config.mode == "hands_free" { listener.stopHandsFree() }

        // Quit after 30 minutes with no chats; the plugin starts Ears again when needed.
        if chats.isEmpty {
            if noChatsSince == nil { noChatsSince = Date() }
            if let since = noChatsSince, Date().timeIntervalSince(since) > 1800 { NSApp.terminate(nil) }
        } else {
            noChatsSince = nil
        }

        if Date().timeIntervalSince(lastTidy) > 5 { lastTidy = Date(); inbox.tidy() }
        voiceInstaller.check()
    }

    // MARK: push to talk

    private func keyDown() {
        Log.write("key down")
        guard config.mode != "off" else { return }
        guard permissionsOK else { ensurePermissions(); return }
        // Talking over Claude's voice stops it, then we listen.
        let chats = ChatSession.alive()
        for c in chats where c.speaking { inbox.send(to: c.id, type: "command", command: "stop") }
        speakingUntil = .distantPast
        listener.resume()
        listener.keyPressed()
        if listener.phase == .holding { NSSound(named: "Tink")?.play() }
    }

    private func keyUp() {
        listener.endHold()
    }

    // MARK: delivering what you said

    private func deliver(_ raw: String) {
        let said = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else { NSSound(named: "Basso")?.play(); return }

        switch ConversationPhrase.of(said) {
        case .start:
            conversationUntil = Date().addingTimeInterval(conversationQuiet)
            Log.write("conversation started")
            NSSound(named: "Hero")?.play()
            refreshIcon()
            return
        case .end:
            // "That's all" ends the conversation and closes the microphone: the chat sets listening to off
            // (it owns that setting in config.json), and Ears follows when the file changes.
            conversationUntil = .distantPast
            listener.followUpUntil = .distantPast
            if let chat = chooseTarget(config: config) { inbox.send(to: chat.id, type: "command", command: "listen_off") }
            Log.write("conversation ended; microphone off")
            NSSound(named: "Bottle")?.play()
            refreshIcon()
            return
        default: break
        }
        // Anything you say starts (or keeps going) a conversation: no wake phrase needed until it ends.
        if !inConversation { Log.write("conversation started") }
        conversationUntil = Date().addingTimeInterval(conversationQuiet)
        refreshIcon()

        // "Switch to photobook" is handled by the chat (the add-on): it matches misheard names, says
        // which chat you are talking to now, and brings a VS Code window forward. Ears only delivers it.
        guard let target = chooseTarget(config: config) else {
            NSSound(named: "Basso")?.play()
            report("No Claude chat with Spokeline is open, so nothing was sent.")
            return
        }
        inbox.send(to: target.id, type: "say", text: said)
        lastSent = said
        NSSound(named: "Pop")?.play()
        refreshIcon()
    }

    // MARK: problems and the menu-bar icon

    private func report(_ message: String) {
        problem = message
        Log.write("problem: \(message)")
        refreshIcon()
        if Date().timeIntervalSince(lastProblemShown) > 20 {
            lastProblemShown = Date()
            let alert = NSAlert()
            alert.messageText = "Spokeline Ears"
            alert.informativeText = message
            if message.contains("System Settings") { alert.addButton(withTitle: "Open System Settings"); alert.addButton(withTitle: "OK") }
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertFirstButtonReturn, message.contains("System Settings") { openSettings(message) }
        }
    }

    private func openSettings(_ message: String) {
        let pane: String
        if message.contains("Microphone") { pane = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone" }
        else if message.contains("Speech Recognition") { pane = "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition" }
        else { pane = "x-apple.systempreferences:com.apple.Keyboard-Settings.extension" }
        if let url = URL(string: pane) { NSWorkspace.shared.open(url) }
    }

    private func refreshIcon() {
        guard let button = statusItem?.button else { return }
        button.toolTip = "Spokeline Ears: " + modeText
        // The microphone pictures are gone: the icon is four glowing green bars that move while the
        // microphone hears speech and sit still in silence. Grey and still when the microphone is off.
        // A problem and "Spokeline is speaking" keep their own pictures.
        let symbol: String
        switch (config.mode, listener.phase) {
        case ("off", _): showBars(live: false); return
        case (_, .error): symbol = "exclamationmark.triangle"
        case (_, .paused): symbol = "speaker.wave.2"
        default: showBars(live: true); return
        }
        barsTimer?.invalidate(); barsTimer = nil
        barsDrawn = []
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Spokeline")
        button.image?.isTemplate = true
    }

    // MARK: the moving bars

    private var barsTimer: Timer?
    private var barsLevel: CGFloat = 0
    private var barsDrawn: [Int] = []

    /// `live`: green, redrawn 15 times a second from the microphone's loudness. Not live: grey, drawn once.
    private func showBars(live: Bool) {
        if live {
            if barsTimer == nil {
                let t = Timer(timeInterval: 1.0 / 15, repeats: true) { [weak self] _ in self?.drawBars(live: true) }
                RunLoop.main.add(t, forMode: .common) // keeps moving while the menu is open
                barsTimer = t
            }
        } else {
            barsTimer?.invalidate(); barsTimer = nil
            barsLevel = 0
        }
        drawBars(live: live)
    }

    private func drawBars(live: Bool) {
        guard let button = statusItem?.button else { return }
        // Rise at once with the voice, fall back gently, so the bars do not flicker between words.
        let heard = live ? CGFloat(listener.level) : 0
        barsLevel = heard > barsLevel ? heard : barsLevel * 0.7 + heard * 0.3
        let loud = barsLevel < 0.1 ? 0 : barsLevel // silence: all four bars at their smallest, not moving
        let now = Date().timeIntervalSinceReferenceDate
        let share: [CGFloat] = [0.6, 1.0, 0.8, 0.5]
        var heights: [Int] = [] // in half points
        for i in 0..<4 {
            let wave = CGFloat(0.65 + 0.35 * sin(now * (9 + Double(i) * 2.3) + Double(i) * 1.7))
            heights.append(Int(((3 + loud * share[i] * wave * 11) * 2).rounded()))
        }
        let key = heights + [live ? 1 : 0]
        guard key != barsDrawn else { return } // nothing changed (silence): leave the picture alone
        barsDrawn = key
        let image = NSImage(size: NSSize(width: 18, height: 16), flipped: false) { rect in
            let green = NSColor(srgbRed: 0.19, green: 0.82, blue: 0.35, alpha: 1)
            let width: CGFloat = 3, gap: CGFloat = 1.25, depth: CGFloat = 0.75
            var x = (rect.width - (4 * width + 3 * gap + depth)) / 2
            for h2 in heights {
                let h = CGFloat(h2) / 2
                let front = NSRect(x: x, y: (rect.height - h) / 2 + depth / 2, width: width, height: h)
                let frontPath = NSBezierPath(roundedRect: front, xRadius: width / 2, yRadius: width / 2)
                x += width + gap
                guard live else { NSColor(white: 0.55, alpha: 0.9).setFill(); frontPath.fill(); continue }
                // A 3-D look (asked 2026-11-23: "somewhat 3-D, not flat"): each bar is a small rounded rod.
                // 1. Its dark side, a little to the right and below — this is also what casts the green glow.
                NSGraphicsContext.saveGraphicsState()
                let glow = NSShadow()
                glow.shadowColor = green.withAlphaComponent(0.9)
                glow.shadowBlurRadius = 2.5
                glow.shadowOffset = .zero
                glow.set()
                NSColor(srgbRed: 0.03, green: 0.38, blue: 0.14, alpha: 1).setFill()
                NSBezierPath(roundedRect: front.offsetBy(dx: depth, dy: -depth), xRadius: width / 2, yRadius: width / 2).fill()
                NSGraphicsContext.restoreGraphicsState()
                // 2. Its front, lit from the left: light green fading to deep green across the bar.
                NSGradient(colors: [NSColor(srgbRed: 0.72, green: 1.0, blue: 0.78, alpha: 1), green,
                                    NSColor(srgbRed: 0.08, green: 0.58, blue: 0.24, alpha: 1)],
                           atLocations: [0, 0.45, 1], colorSpace: .sRGB)?.draw(in: frontPath, angle: 0)
                // 3. A thin bright line near the left edge, like light on a rounded surface.
                if h > 4 {
                    NSColor(white: 1, alpha: 0.55).setFill()
                    NSBezierPath(roundedRect: NSRect(x: front.minX + 0.6, y: front.minY + 1.2, width: 0.7, height: h - 2.4),
                                 xRadius: 0.35, yRadius: 0.35).fill()
                }
            }
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = live ? "Spokeline: listening" : "Spokeline: microphone off"
        button.image = image
    }

    private var modeText: String {
        switch config.mode {
        case "off": return "microphone off"
        case "hands_free": return inConversation ? "in a conversation (say \"that's all\" to end)" : "hands free, say \"\(config.wakePhrase)\""
        default: return "hold \(hotkey.display.isEmpty ? config.hotkey : hotkey.display) and speak"
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.addItem(withTitle: "Spokeline Ears: " + modeText, action: nil, keyEquivalent: "")
        if let p = problem { menu.addItem(withTitle: "⚠ " + (p.count > 90 ? String(p.prefix(90)) + "…" : p), action: nil, keyEquivalent: "") }
        menu.addItem(.separator())

        for (title, value) in [("Off", "off"), ("Push to talk", "push_to_talk"), ("Hands free", "hands_free")] {
            let item = NSMenuItem(title: title, action: #selector(setMode(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = value
            item.state = config.mode == value ? .on : .off
            menu.addItem(item)
        }
        menu.addItem(.separator())

        let chats = ChatSession.alive().sorted { $0.lastActive > $1.lastActive }
        let current = chooseTarget(config: config)?.id
        menu.addItem(withTitle: chats.isEmpty ? "No Claude chats open" : "Talking to:", action: nil, keyEquivalent: "")
        for c in chats {
            let item = NSMenuItem(title: "   " + c.title + (c.busy ? "  (working)" : ""), action: #selector(pickChat(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = c.id
            item.state = c.id == current ? .on : .off
            menu.addItem(item)
        }
        if config.targetSessionId != nil {
            let item = NSMenuItem(title: "   Follow the chat I used last", action: #selector(clearTarget), keyEquivalent: "")
            item.target = self
            menu.addItem(item)
        }
        if !lastSent.isEmpty {
            menu.addItem(.separator())
            menu.addItem(withTitle: "Last heard: " + (lastSent.count > 60 ? String(lastSent.prefix(60)) + "…" : lastSent), action: nil, keyEquivalent: "")
        }
        menu.addItem(.separator())
        let log = NSMenuItem(title: "Show log", action: #selector(showLog), keyEquivalent: "")
        log.target = self
        menu.addItem(log)
        let quit = NSMenuItem(title: "Quit Spokeline Ears", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    @objc private func setMode(_ sender: NSMenuItem) {
        guard let v = sender.representedObject as? String else { return }
        problem = nil
        listener.clearError()
        EarsConfig.update(["mode": v])
        reloadConfig(force: true)
    }

    @objc private func pickChat(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        EarsConfig.update(["targetSessionId": id])
        reloadConfig(force: true)
    }

    @objc private func clearTarget() {
        EarsConfig.update(["targetSessionId": nil])
        reloadConfig(force: true)
    }

    @objc private func showLog() { NSWorkspace.shared.open(Files.log) }
    @objc private func quit() { NSApp.terminate(nil) }
}
