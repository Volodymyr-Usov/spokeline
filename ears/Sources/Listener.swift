import AVFoundation
import Foundation
import Speech

/// Microphone + on-device speech recognition (Apple's Speech framework, no network).
///
/// Two ways to listen:
///  - push to talk: `beginHold()` when the key goes down, `endHold()` when it comes up
///  - hands free: `startHandsFree()` keeps listening for the wake phrase, then for the request after it
final class Listener {
    enum Phase: String { case idle, holding, waitingForWake, capturing, paused, error }

    var onUtterance: ((String) -> Void)?
    var onWake: (() -> Void)?
    var onPhase: ((Phase) -> Void)?
    var onProblem: ((String) -> Void)?

    private(set) var phase: Phase = .idle {
        didSet { if oldValue != phase { Log.write("phase \(oldValue.rawValue) -> \(phase.rawValue)"); onPhase?(phase) } }
    }
    /// How loud the microphone is right now: 0 = silence, 1 = loud speech. 0 while the microphone is not running.
    /// The moving bars in the menu bar read this.
    var level: Float {
        guard engine.isRunning else { return 0 }
        feedLock.lock(); defer { feedLock.unlock() }
        return levelNow
    }
    private var levelNow: Float = 0
    /// Sound quieter than this (in decibels) counts as silence; `loudDb` and above fills the bars.
    private static let quietDb: Float = -45
    private static let loudDb: Float = -15

    // For the microphone row in the chat (ears.json). All under feedLock: the tap writes them on the audio thread.
    /// The loudest sound of about the last quarter second (0 to 1), and when it was heard.
    private var shownPeak: Float = 0
    private var shownPeakAt = Date.distantPast
    /// The last time the sound was louder than your speech threshold.
    private var lastLoudAt = Date.distantPast
    /// The loudest moment of the request being spoken now (key hold, or after the wake phrase).
    private var requestPeak: Float = 0
    /// How loud your voice usually is at this microphone (0 to 1), learned from requests that were sent.
    private var usualLevel: Float = 0.1
    /// The last time the recognizer gave new words (so a noise alone does not count as you speaking).
    private var lastWordsAt = Date.distantPast

    /// True while the microphone hears you speaking (not Spokeline's own voice): the green light on the
    /// microphone sign in the chat. Push to talk: the sound is loud enough. Hands free: loud enough, and
    /// Apple's recognizer is getting words.
    var hearing: Bool {
        guard engine.isRunning else { return false }
        feedLock.lock(); let loud = Date().timeIntervalSince(lastLoudAt) < 0.4; feedLock.unlock()
        switch phase {
        case .holding: return !finishing && loud
        case .waitingForWake, .capturing: return loud && !othersSpeaking && Date().timeIntervalSince(lastWordsAt) < 1.5
        default: return false
        }
    }

    /// 0 to 3 lit bars next to the microphone sign in the chat.
    var bars: Int {
        feedLock.lock()
        let peak = Date().timeIntervalSince(shownPeakAt) < 0.4 ? shownPeak : 0
        let usual = usualLevel
        feedLock.unlock()
        return Loudness.bars(hearing: hearing, peak: peak, usual: usual)
    }

    /// A request was sent: learn how loud your voice is on this microphone.
    private func learnLevel() {
        feedLock.lock()
        if requestPeak > 0 && !othersSpeaking { usualLevel = min(max(0.7 * usualLevel + 0.3 * requestPeak, 0.05), 0.5) }
        requestPeak = 0
        feedLock.unlock()
    }

    private func startRequestPeak() { feedLock.lock(); requestPeak = 0; feedLock.unlock() }

    /// The state name the chats know (the same names as the Windows helper writes).
    var stateName: String {
        switch phase {
        case .holding: return finishing ? "recognizing" : "recording"
        case .waitingForWake: return "listening"
        case .capturing: return "capturing"
        // Paused while Spokeline speaks: the microphone opens again right after.
        case .paused: return handsFree ? "listening" : "idle"
        case .error: return "error"
        case .idle: return "idle"
        }
    }

    /// When true, what the recognizer hears is written to the log (for fixing problems).
    var debug = false
    private var lastLoggedText = ""

    private var engine = AVAudioEngine()
    private var tapInstalled = false
    /// The microphone chosen in the /spokeline menu, by exact name; "" = the Mac default.
    var microphone = "" { didSet { if microphone != oldValue { failedMicrophone = "" } } }
    private var engineObserver: NSObjectProtocol?
    /// The sound format the tap listens in.
    private var tapFormat: AVAudioFormat?
    /// The microphone this engine was made for.
    private var openedFor: AudioDeviceID?
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let feedLock = NSLock()
    private var feeding = false

    private var text = ""
    private var lastChange = Date()
    private var taskStarted = Date()
    private var holdStarted = Date()
    private var wakeRegexes: [NSRegularExpression] = []
    /// Word timings of the current text, to tell whether a wake phrase starts after a pause.
    private var segments: [(range: NSRange, start: TimeInterval, end: TimeInterval)] = []
    private var wakeHeardAt: Date?
    private var handsFree = false
    private var resumeHandsFreeAfterHold = false
    private var followUpStartedText = false
    /// While you speak a request, the recognizer may start over after a pause and forget what it had.
    /// What you said before that is kept here so the whole request is sent.
    private var carried = ""
    private func carryRequest() {
        guard wakeHeardAt != nil else { return }
        let so = currentRequest()
        if !so.isEmpty { carried = (carried + " " + so).trimmingCharacters(in: .whitespaces) }
        if debug { Log.write("kept so far: \(carried)") }
    }
    private var finishing = false
    private var generation = 0
    private var timer: Timer?
    private(set) var language = ""
    private var contextWords: [String] = []

    init() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in self?.pulse() }
    }

    // MARK: settings

    func configure(language: String, wakePhrase: String) {
        let locale = language.isEmpty ? Locale.current : Locale(identifier: language)
        if recognizer?.locale.identifier != locale.identifier || recognizer == nil {
            recognizer = SFSpeechRecognizer(locale: locale)
            self.language = locale.identifier
        }
        wakeRegexes = Listener.makeWakeRegexes(wakePhrase)
        // Apple's recognizer listens harder for these exact words and phrases.
        let phrases = wakePhrase.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        contextWords = phrases + ["Claude", "Anthropic", "Hey Anthropic", "Spokeline", "stop", "repeat", "send", "cancel", "yes", "no"]
    }

    /// "hey claude, anthropic" -> one pattern per phrase.
    static func makeWakeRegexes(_ phrases: String) -> [NSRegularExpression] {
        phrases.split(separator: ",").compactMap { makeWakeRegex(String($0)) }
    }

    /// "hey spokeline" -> a pattern that also accepts "hey spoke line", "a spokeline", "spokane" and similar.
    static func makeWakeRegex(_ phrase: String) -> NSRegularExpression? {
        let words = phrase.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        guard !words.isEmpty else { return nil }
        var parts: [String] = []
        for (i, w) in words.enumerated() {
            var p = w.map { NSRegularExpression.escapedPattern(for: String($0)) }.joined(separator: "\\s?")
            if w == "spokeline" { p = "(?:" + p + "s?|spokane|spoke\\s?lane|spoken\\s?line|spock\\s?line|poco\\s?line|(?:face|case|ace)\\s?book\\s?(?:a\\s?)?(?:line|lane|align|lign)s?" +
                // Looser mishearings ("Book a line.", "I spoke a lot.", "Procholine.") count only when said as a phrase
                // of their own, followed by a pause mark: "Notebook line two is wrong" is an ordinary sentence.
                // Only a written pause mark counts, not the end of the text (as on Windows): Apple's recognizer
                // hands over unfinished text, and "Notebook line" ends there only because the rest is not heard
                // yet (QA 24.11.2026: it woke Spokeline). Apple writes the mark once you pause.
                "|(?:i\\s?spoke\\s?a\\s?lot|(?:(?:in\\s)?a\\s)?(?:[a-z]{0,4}\\s?book|spook|spoke)\\s?(?:a\\s?)?(?:line|lane|align|lign)s?|(?:s?p|b|pr)[a-z]{0,3}[ck]h?[a-z]?\\s?(?:a\\s)?line)(?=\\s*[.,!?]))" }
            if w == "claude" { p = "(?:claude|cloud|clawed|claudia|clod|clyde|claud)" }
            if w == "anthropic" {
                // Apple's recognizer hears "(hey) Anthropic" in many ways: pantropic, and tropic, entropic,
                // her and traffic, anthro pick... Any short word part before "tropic" or "traffic" counts.
                p = "(?:anthropi[ck]|anthro\\s?pick|and\\s?throw\\s?pick|[a-z]{0,5}\\s?tropi[ck]s?|(?:and|an|in|her\\s+and)\\s?traffic)"
            }
            if i == 0 && (w == "hey" || w == "hi" || w == "ok" || w == "okay") { p = "(?:hey|hi|hay|a|ok|okay|her|hate|hello)" }
            parts.append(p)
        }
        // The greeting word is optional: "spokeline, run the tests" works too.
        var pattern = parts.joined(separator: "[\\s,.!?]+")
        if words.count > 1, ["hey", "hi", "ok", "okay"].contains(words[0]) {
            pattern = "(?:" + parts[0] + "[\\s,.!?]+)?" + parts.dropFirst().joined(separator: "[\\s,.!?]+")
        }
        return try? NSRegularExpression(pattern: "\\b" + pattern + "\\b[\\s,.!?:]*", options: [.caseInsensitive])
    }

    // MARK: permissions

    static func requestPermissions(_ done: @escaping (Bool, String?) -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                DispatchQueue.main.async { done(false, "Speech recognition is not allowed. Open System Settings > Privacy & Security > Speech Recognition and turn on Spokeline Ears.") }
                return
            }
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                DispatchQueue.main.async {
                    done(ok, ok ? nil : "The microphone is not allowed. Open System Settings > Privacy & Security > Microphone and turn on Spokeline Ears.")
                }
            }
        }
    }

    // MARK: push to talk

    /// The push-to-talk key went down. A key press is not part of a restart loop: the count starts again.
    func keyPressed() {
        changesInARow = 0
        closedUntil = .distantPast // you are asking for the microphone: try again
        beginHold()
    }

    func beginHold() {
        if phase == .error { phase = .idle } // try again on every key press
        let wasHandsFree = handsFree
        handsFree = false
        resumeHandsFreeAfterHold = wasHandsFree
        // A request you were saying hands free is dropped: the key starts a new one (and new live words).
        wakeHeardAt = nil
        carried = ""
        stopTask()
        guard startEngine(), startTask() else { return }
        holdStarted = Date()
        startRequestPeak()
        setFeeding(true)
        phase = .holding
    }

    func endHold() {
        guard phase == .holding else { return }
        setFeeding(false)
        if Date().timeIntervalSince(holdStarted) < 0.25 { // a tap, not a hold
            stopTask(); stopEngineIfIdle(); phase = .idle; return
        }
        request?.endAudio()
        finishing = true
        let gen = generation
        // If the final result is slow, use what we have.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            guard let self = self, self.generation == gen, self.finishing else { return }
            self.finishHold()
        }
    }

    private func finishHold() {
        guard finishing else { return }
        finishing = false
        let said = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !said.isEmpty { learnLevel() }
        stopTask()
        stopEngineIfIdle()
        phase = .idle
        onUtterance?(said)
        if resumeHandsFreeAfterHold { resumeHandsFreeAfterHold = false; startHandsFree() }
    }

    // MARK: hands free

    func startHandsFree() {
        handsFree = true
        guard phase != .error, phase != .holding else { return }
        if task == nil {
            guard startEngine(), startTask() else { return }
            setFeeding(true)
            // Any request that was being said is gone now: its words must not stay on screen.
            if wakeHeardAt != nil { wakeHeardAt = nil; carried = ""; liveNo += 1 }
            phase = .waitingForWake
        }
    }

    func stopHandsFree() {
        handsFree = false
        if phase == .waitingForWake || phase == .capturing { stopTask(); stopEngineIfIdle(); phase = .idle }
    }

    /// Stop listening while Claude speaks, so the microphone does not hear Claude's own voice.
    func pause() {
        guard phase != .paused, phase != .holding, phase != .error else { return }
        stopTask()
        stopEngineIfIdle()
        phase = .paused
    }

    func resume() {
        guard phase == .paused else { return }
        phase = .idle
        if handsFree { startHandsFree() }
    }

    func clearError() { if phase == .error { phase = .idle } }

    /// Spokeline just stopped talking: forget everything heard while it talked (its own voice),
    /// so only words spoken from now on can count as your follow-up. A request you started with a
    /// wake phrase over its voice is kept.
    func discardHeard() {
        guard handsFree, phase == .waitingForWake else { return }
        if debug && !text.isEmpty { Log.write("discarded (heard while speaking): \(text)") }
        followUpStartedText = false
        restartHandsFree()
    }

    // MARK: recognition

    private func setFeeding(_ on: Bool) { feedLock.lock(); feeding = on; feedLock.unlock() }

    /// Throws the engine away and makes a new one, so the next start opens the microphone again with echo
    /// removal set up from the start. Only when another microphone is to be used: turning echo removal off and
    /// on switches Bluetooth earbuds into call mode and back, and other apps' sound goes up and down.
    private func freshEngine() {
        if engine.isRunning { engine.stop() }
        if tapInstalled { engine.inputNode.removeTap(onBus: 0) }
        if let o = engineObserver { NotificationCenter.default.removeObserver(o); engineObserver = nil }
        engine = AVAudioEngine()
        tapInstalled = false
        tapFormat = nil
        openedFor = nil
        onChosenMicrophone = false
        voiceProcessingSet = false
        openedLogged = false
        feedLock.lock(); levelNow = 0; shownPeak = 0; feedLock.unlock()
    }

    /// Opens the microphone again now, on the device chosen in config.json (or the Mac default).
    func restartMicrophone(_ why: String) {
        Log.write("microphone restarts: \(why)")
        // The key is already up and the last words are being worked out: send what was heard, don't listen again.
        // Hands free starts again only after the restart, so the microphone is not opened twice.
        let handsFreeAfter = sendWhatWasHeld()
        let was = phase
        stopTask()
        freshEngine()
        resumeAfter(was)
        if handsFreeAfter { startHandsFree() }
    }

    /// The key is up and the last words are being worked out, but the microphone must open again: send what
    /// was heard now. Returns true when hands-free listening should start again afterwards (the caller does it).
    private func sendWhatWasHeld() -> Bool {
        guard phase == .holding && finishing else { return false }
        let resume = resumeHandsFreeAfterHold
        resumeHandsFreeAfterHold = false
        finishHold()
        return resume
    }

    /// The device the microphone should be: the chosen one if it is connected (and its name is unique),
    /// else the Mac default.
    private func wantedMicrophone() -> AudioDeviceID? {
        chosenMicrophone() ?? Devices.defaultId(input: true)
    }

    /// macOS stopped the engine because the sound devices changed. This also happens when the microphone
    /// itself opens: Bluetooth earbuds switch into call mode and report a change. So the same engine is
    /// started again (echo removal stays on, the earbuds switch only once); only when another device is to
    /// be used does `startEngine` make a new one. A chosen microphone (no echo removal) gets a new engine,
    /// which is cheap there and avoids listening in an old sound format.
    ///
    /// If each reopening causes the next change (4 times in a row, each within 10 seconds of the reopening
    /// before), Spokeline steps back, as Windows does when its echo removal keeps failing: a chosen microphone
    /// is given up for the Mac default; then echo removal is turned off (the plain microphone); and if even that
    /// keeps changing, the microphone stays closed for 5 minutes with a message. A key press starts the count again.
    private func soundDevicesChanged() {
        // The key is already up and the last words are being worked out: send what was heard, don't listen again.
        if sendWhatWasHeld() {
            if onChosenMicrophone { freshEngine() } // as below: a chosen microphone gets a new engine
            startHandsFree()
            lastReopen = Date()
            return
        }
        let active = ([.holding, .waitingForWake, .capturing] as [Phase]).contains(phase)
        guard active, !engine.isRunning else { return }
        let now = Date()
        changesInARow = now.timeIntervalSince(lastReopen) < 10 ? changesInARow + 1 : 1
        if changesInARow > 3 {
            changesInARow = 0
            if onChosenMicrophone {
                failedMicrophone = microphone
                restartMicrophone("the sound devices keep changing on \"\(microphone)\": going back to the Mac default microphone")
            } else if echoCancellation && echoOffFor != openedFor {
                echoOffFor = openedFor
                restartMicrophone("the sound devices keep changing with echo removal on: using this microphone without it")
            } else {
                closedUntil = now.addingTimeInterval(300)
                fail("The sound devices keep changing each time Spokeline opens the microphone, so it stays closed for 5 minutes. " +
                     "Reconnect your headset, or choose another microphone in /spokeline.")
            }
            lastReopen = Date()
            return
        }
        Log.write("the sound devices changed: the microphone opens again")
        if onChosenMicrophone {
            restartMicrophone("the sound devices changed")
        } else {
            let was = phase
            stopTask()
            resumeAfter(was)
        }
        lastReopen = Date()
    }
    private var changesInARow = 0
    private var lastReopen = Date.distantPast
    /// Last step of the guard above: the microphone is not opened before this time (a key press tries again).
    private var closedUntil = Date.distantPast
    /// A microphone that kept changing with echo removal on: it is used without echo removal from then on.
    /// Another microphone gets echo removal as usual.
    private var echoOffFor: AudioDeviceID?

    /// Go back to listening as before the microphone was opened again.
    private func resumeAfter(_ was: Phase) {
        switch was {
        case .error, .waitingForWake, .capturing:
            phase = .idle
            if handsFree { startHandsFree() }
        case .holding:
            // The key is still held: go on listening on the new device (what was said before is lost).
            let resume = resumeHandsFreeAfterHold
            phase = .idle
            beginHold()
            resumeHandsFreeAfterHold = resume
        default: break
        }
    }

    /// The chosen microphone when it is connected, its name is unique, and it is not the Mac default anyway.
    /// Nil: use the Mac default.
    private func chosenMicrophone() -> AudioDeviceID? {
        guard !microphone.isEmpty, microphone != failedMicrophone,
              let id = Devices.find(microphone, input: true), id != Devices.defaultId(input: true) else { return nil }
        return id
    }
    /// A chosen microphone that gave no sound: the Mac default is used until another one is chosen.
    private var failedMicrophone = ""
    /// This engine listens on a chosen microphone, without echo removal (see `startEngine`).
    private var onChosenMicrophone = false
    /// Pieces of sound that arrived since the engine started (to check that a chosen microphone works).
    private var buffersArrived = 0
    /// The device actually opened is written to the log once per engine.
    private var openedLogged = false

    private func startEngine() -> Bool {
        if engine.isRunning { return true }
        if Date() < closedUntil { return false }
        // Another microphone than the one this engine was made for (a headset plugged in, the Mac default
        // switched): a new engine. We compare with what we opened, not with what macOS reports: with echo
        // removal on it reports the speaker side, and Bluetooth earbuds have a microphone and a speaker
        // device with the same name.
        let want = wantedMicrophone()
        if voiceProcessingSet || tapInstalled, let had = openedFor, let w = want, w != had, Devices.name(w) != Devices.name(had) {
            let old = Devices.name(had)
            Log.write("microphone changes from \(old.isEmpty ? "one that is no longer connected" : old) to \(Devices.name(w))")
            freshEngine()
        }
        if !voiceProcessingSet && !tapInstalled { openedFor = want }
        let input = engine.inputNode
        if engineObserver == nil {
            // macOS stops the engine when the sound devices change: open the microphone again.
            engineObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
                self?.soundDevicesChanged()
            }
        }
        // A microphone other than the Mac default: Apple's echo removal always uses the Mac default (tested
        // 24.11.2026: setting the device before it is turned on is undone, and setting it afterwards breaks the
        // start with error -10875). So a chosen microphone is opened plainly, without echo removal, as Windows
        // does when its echo removal cannot be used. `checkChosenMicrophone` falls back if it gives no sound.
        if !tapInstalled && !voiceProcessingSet && !onChosenMicrophone, let id = chosenMicrophone(), let unit = input.audioUnit {
            if Devices.use(id, on: unit) {
                onChosenMicrophone = true
                Log.write("microphone chosen: \(microphone), without echo removal (it works only with the Mac default microphone)")
            } else {
                failedMicrophone = microphone
                Log.write("microphone \"\(microphone)\" could not be chosen: using the Mac default")
            }
        }
        // macOS puts the Mac default back when the sound devices change (tested 24.11.2026): choose the device
        // again on every start.
        if onChosenMicrophone, let id = openedFor, let unit = input.audioUnit { Devices.use(id, on: unit) }
        if echoCancellation && !onChosenMicrophone && !voiceProcessingSet && !tapInstalled && (echoOffFor == nil || echoOffFor != openedFor) {
            voiceProcessingSet = true
            do {
                try input.setVoiceProcessingEnabled(true)
                if #available(macOS 14.0, *) {
                    // Don't make other sound (our own voice included) quieter while listening.
                    input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
                }
                Log.write("echo cancellation on")
            } catch {
                Log.write("echo cancellation not available: \(error.localizedDescription)")
            }
        }
        // After choosing a device, the format the input side reports can still be the old device's, and a tap
        // in the wrong format stops the whole app. The device's own format is the right one then.
        let format = onChosenMicrophone ? input.inputFormat(forBus: 0) : input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { fail("No microphone found."); return false }
        // The microphone's sound format changed (earbuds in call mode deliver a lower rate): listen in the new one.
        if tapInstalled, let f = tapFormat, f.sampleRate != format.sampleRate || f.channelCount != format.channelCount {
            input.removeTap(onBus: 0)
            tapInstalled = false
        }
        if !tapInstalled {
            tapFormat = format
            // With echo removal on, macOS delivers several channels; the first one is the cleaned microphone.
            // Speech recognition needs one channel, so keep only that one.
            let mono = format.channelCount > 1
                ? AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false)
                : nil
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                guard let self = self else { return }
                // Loudness of this piece of sound (first channel = the cleaned microphone), for the menu-bar bars,
                // and its loudest moment, for the microphone row in the chat.
                var loud: Float = 0
                var peak: Float = 0
                let count = Int(buffer.frameLength)
                if count > 0, let src = buffer.floatChannelData {
                    var sum: Float = 0
                    let p = src[0]
                    for i in 0..<count { sum += p[i] * p[i]; peak = max(peak, abs(p[i])) }
                    let db = 10 * log10(max(sum / Float(count), 1e-10))
                    loud = min(max((db - Listener.quietDb) / (Listener.loudDb - Listener.quietDb), 0), 1)
                }
                let now = Date()
                self.feedLock.lock()
                let on = self.feeding
                self.buffersArrived += 1
                self.levelNow = loud
                if peak >= self.shownPeak || now.timeIntervalSince(self.shownPeakAt) > 0.25 { self.shownPeak = peak; self.shownPeakAt = now }
                if peak > Loudness.speechThreshold(usual: self.usualLevel) { self.lastLoudAt = now }
                if on { self.requestPeak = max(self.requestPeak, peak) }
                self.feedLock.unlock()
                guard on else { return }
                if let mono = mono, let m = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength),
                   let src = buffer.floatChannelData, let dst = m.floatChannelData {
                    m.frameLength = buffer.frameLength
                    dst[0].update(from: src[0], count: Int(buffer.frameLength))
                    self.request?.append(m)
                } else {
                    self.request?.append(buffer)
                }
            }
            tapInstalled = true
        }
        engine.prepare()
        do { try engine.start() } catch {
            // A chosen microphone that cannot start: the Mac default instead, until another one is chosen.
            if onChosenMicrophone {
                Log.write("microphone \"\(microphone)\" could not start (\(error.localizedDescription)): using the Mac default")
                failedMicrophone = microphone
                freshEngine()
                return startEngine()
            }
            fail("The microphone could not start: \(error.localizedDescription)")
            return false
        }
        if !openedLogged, let id = openedFor {
            openedLogged = true
            Log.write("microphone in use: \(Devices.name(id))" + (onChosenMicrophone ? "" : " (Mac default)"))
        }
        startNo += 1
        if onChosenMicrophone {
            feedLock.lock(); buffersArrived = 0; feedLock.unlock()
            let mine = startNo
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.checkChosenMicrophone(mine) }
        }
        return true
    }
    /// Counts each start of the microphone, so a check meant for an earlier start is not applied to a later one.
    private var startNo = 0

    /// A chosen microphone that gives no sound within 3 seconds (switched off, a camera that is not
    /// streaming), or that macOS does not really use: go back to the Mac default, with echo removal, until
    /// another microphone is chosen.
    private func checkChosenMicrophone(_ checked: Int) {
        guard checked == startNo, onChosenMicrophone, engine.isRunning, let id = openedFor else { return }
        feedLock.lock(); let n = buffersArrived; feedLock.unlock()
        let inUse = Devices.isRunning(id)
        guard n == 0 || !inUse else { return }
        failedMicrophone = microphone
        restartMicrophone((inUse ? "no sound from \"\(microphone)\"" : "macOS did not use \"\(microphone)\"") +
                          ": going back to the Mac default microphone")
    }

    private func stopEngineIfIdle() {
        if engine.isRunning { engine.stop() }
    }

    private func startTask() -> Bool {
        guard let rec = recognizer else { fail("Speech recognition is not available for \(language)."); return false }
        guard rec.isAvailable else { fail("Speech recognition for \(language) is not ready yet. Try again in a moment."); return false }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.contextualStrings = contextWords
        if #available(macOS 13.0, *) { req.addsPunctuation = true }
        if rec.supportsOnDeviceRecognition {
            req.requiresOnDeviceRecognition = true
        } else {
            fail("On-device speech recognition for \(language) is not installed. Open System Settings > Keyboard > Dictation, turn Dictation on and choose this language, then try again.")
            return false
        }
        request = req
        carryRequest()
        // A new round of listening (not the middle of a request): loudness from before does not count.
        if wakeHeardAt == nil { startRequestPeak() }
        text = ""
        lastChange = Date()
        taskStarted = Date()
        finishing = false
        generation += 1
        let gen = generation
        task = rec.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self = self, self.generation == gen else { return }
                if let result = result {
                    let t = result.bestTranscription.formattedString
                    self.segments = result.bestTranscription.segments.map { ($0.substringRange, $0.timestamp, $0.timestamp + $0.duration) }
                    if t != self.text {
                        // The recognizer dropped what it had (a new sentence, not a correction): keep the old part.
                        if self.wakeHeardAt != nil && !self.text.isEmpty && !t.isEmpty && t.count < self.text.count
                            && t.lowercased().commonPrefix(with: self.text.lowercased()).count < min(8, self.text.count) {
                            self.carryRequest()
                        }
                        if self.text.isEmpty && !t.isEmpty && self.inFollowUp && !self.followUpStartedText {
                            // A follow-up without the wake phrase begins: measure its loudness from here, not noise from before.
                            self.followUpStartedText = true
                            self.startRequestPeak()
                        }
                        if !t.isEmpty { self.lastWordsAt = Date() }
                        self.text = t; self.lastChange = Date()
                    }
                    if self.debug && t != self.lastLoggedText && (result.isFinal || t.count - self.lastLoggedText.count > 12 || t.count < self.lastLoggedText.count) {
                        self.lastLoggedText = t
                        Log.write("heard\(result.isFinal ? " (final)" : ""): \(t)")
                    }
                    if result.isFinal {
                        if self.phase == .holding || self.finishing { self.finishHold() }
                        else if self.handsFree { self.handsFreeCheck(final: true) }
                    } else if self.handsFree {
                        self.handsFreeCheck(final: false)
                    }
                }
                if let error = error {
                    if self.debug { Log.write("recognizer stopped: \(error.localizedDescription)") }
                    let msg = error.localizedDescription.lowercased()
                    if msg.contains("dictation") && msg.contains("disabled") || msg.contains("siri") && msg.contains("disabled") {
                        self.fail("macOS Dictation is turned off, and Apple's on-device speech recognition needs it. Open System Settings > Keyboard > Dictation and turn Dictation on (you can set its shortcut to Off). Then Spokeline will start listening.")
                        return
                    }
                    if self.finishing { self.finishHold() }
                    else if self.handsFree && (self.phase == .waitingForWake || self.phase == .capturing) { self.restartHandsFree() }
                }
            }
        }
        return true
    }

    private func stopTask() {
        // Not in the middle of a request: what is shown as live text may be cleared now.
        if wakeHeardAt == nil { liveNo += 1 }
        generation += 1
        setFeeding(false)
        task?.cancel()
        task = nil
        request = nil
        text = ""
        segments = []
        finishing = false
    }

    private func restartHandsFree() {
        stopTask()
        if handsFree && phase != .paused && phase != .error {
            phase = .idle
            startHandsFree()
        }
    }

    /// The last wake phrase in the current text that starts what you say: it is the first thing heard,
    /// or comes after a pause of at least 0.45 s. "I asked Claude yesterday" does not count.
    private func lastWake() -> NSRange? {
        let ns = text as NSString
        var best: NSRange? = nil
        for re in wakeRegexes {
            for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) where othersSpeaking || startsUtterance(m.range.location) {
                if best == nil || m.range.location > best!.location { best = m.range }
            }
        }
        return best
    }

    private func startsUtterance(_ location: Int) -> Bool {
        if location == 0 || segments.isEmpty { return location == 0 || segments.isEmpty }
        guard let i = segments.firstIndex(where: { NSLocationInRange(location, $0.range) || $0.range.location >= location }) else { return false }
        if i == 0 { return true }
        return segments[i].start - segments[i - 1].end >= 0.45
    }

    /// The request so far: the text after the wake phrase. After a pause Apple's recognizer may start a
    /// fresh text that no longer contains the wake phrase; then the whole fresh text is the request.
    private func requestSoFar() -> String {
        (carried + " " + currentRequest()).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func currentRequest() -> String {
        let ns = text as NSString
        if let last = lastWake() {
            return ns.substring(from: last.location + last.length).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func hasWake() -> Bool { lastWake() != nil }

    /// What you are saying right now, as far as Apple's recognizer has it (its unfinished results): only
    /// words that are meant for Claude (the key is held, a request is being collected, or a follow-up has
    /// begun). Only to be shown; what is sent, and when, is decided as before.
    var liveText: String {
        switch phase {
        case .holding:
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        case .capturing:
            return requestSoFar()
        case .waitingForWake:
            if othersSpeaking || text.isEmpty { return "" }
            if hasWake() { return requestSoFar() }
            return (inFollowUp || followUpStartedText) ? text.trimmingCharacters(in: .whitespacesAndNewlines) : ""
        default:
            return ""
        }
    }

    /// The live text as shown in the chat: like `liveText`, but a partial result that comes back empty or much
    /// shorter does not wipe the words on screen. Cleared when a new request or key hold begins.
    var steadyLiveText: String {
        let fresh = liveText
        if liveNo != shownNo || LiveWords.keeps(shown: shownLive, fresh: fresh) {
            shownNo = liveNo
            shownLive = fresh
        }
        return shownLive
    }
    /// Counts each new request or key hold (and each time nothing is being said for Claude).
    private var liveNo = 0
    private var shownNo = -1
    private var shownLive = ""

    /// "yes", "no", "go ahead", "do it"...: a short answer to a question Spokeline asked.
    static func isAnswerWord(_ text: String) -> Bool {
        let t = text.lowercased().filter { $0.isLetter || $0 == " " }.trimmingCharacters(in: .whitespaces)
        let answers: Set<String> = ["yes", "yeah", "yep", "sure", "ok", "okay", "go", "go ahead", "do it", "start", "just start",
                                    "no", "nope", "not yet", "wait", "stop", "send", "cancel", "yes please", "yes go ahead"]
        return answers.contains(t)
    }

    /// True when most of the words heard are words the chat itself is saying right now (its own voice).
    private func isMostlySpoken(_ heard: String) -> Bool {
        let norm: (String) -> [Substring] = { $0.lowercased().filter { $0.isLetter || $0.isNumber || $0 == " " }.split(separator: " ") }
        let words = norm(heard).suffix(8)
        guard !words.isEmpty, !spokenText.isEmpty else { return false }
        let spoken = Set(norm(spokenText))
        return Double(words.filter { spoken.contains($0) }.count) / Double(words.count) >= 0.6
    }

    /// True when the words around the wake phrase are part of what the chat itself is saying.
    private func isOwnVoice() -> Bool {
        guard let w = lastWake(), !spokenText.isEmpty else { return false }
        let norm: (String) -> String = { $0.lowercased().filter { $0.isLetter || $0.isNumber || $0 == " " }.split(separator: " ").joined(separator: " ") }
        let ns = text as NSString
        let tail = norm(ns.substring(from: w.location))
        let spoken = norm(spokenText)
        let words = tail.split(separator: " ")
        // The wake word plus the next two words, found in what is being spoken: that is our own echo.
        let probe = words.prefix(3).joined(separator: " ")
        if probe.isEmpty { return false }
        if spoken.contains(probe) { return true }
        // The wake word itself may be misheard ("cloud" for "Claude"): compare the words after it too.
        let after = words.dropFirst().prefix(2).joined(separator: " ")
        if after.split(separator: " ").count == 2 && spoken.contains(after) { return true }
        if words.count >= 1, spoken.contains(String(words[0])) && words.count < 2 { return true } // too little heard yet: wait
        // The word just before the wake word is also the word before a wake word in what is being spoken
        // ("under Spokeline", "tells Claude"): it is our own voice saying the name.
        if let prev = norm(ns.substring(to: w.location)).split(separator: " ").last, prev.count >= 2 {
            let sns = spoken as NSString
            for re in wakeRegexes {
                for m in re.matches(in: spoken, range: NSRange(location: 0, length: sns.length)) {
                    if norm(sns.substring(to: m.range.location)).split(separator: " ").last == prev { return true }
                }
            }
        }
        // Most of the words after the wake word are words being spoken (the rest misheard).
        let rest = words.dropFirst().prefix(6)
        if rest.count >= 2 {
            let spokenSet = Set(spoken.split(separator: " "))
            let found = rest.filter { spokenSet.contains($0) }.count
            if Double(found) / Double(rest.count) >= 0.6 { return true }
        }
        return false
    }

    /// Look for the wake phrase; after it, collect the request until you stop talking.
    private func handsFreeCheck(final: Bool) {
        if wakeHeardAt == nil {
            if hasWake() {
                if othersSpeaking {
                    if isOwnVoice() { return }
                    Log.write("interrupted by wake phrase: \(text)")
                    onBargeIn?()
                }
                wakeHeardAt = Date(); carried = ""; liveNo += 1; startRequestPeak()
                phase = .capturing
                onWake?()
            } else {
                if othersSpeaking {
                    // Conversation mode: any words of yours interrupt the voice (no wake phrase needed).
                    let words = text.split(separator: " ").count
                    let shortAnswer = acceptWithoutWake && words <= 3 && Listener.isAnswerWord(text)
                    if inConversation && (shortAnswer || (words >= 2 && !isMostlySpoken(text))) {
                        Log.write("interrupted in conversation: \(text)")
                        onBargeIn?()
                        wakeHeardAt = Date(); carried = ""; liveNo += 1; startRequestPeak()
                        phase = .capturing
                        onWake?()
                    }
                    return
                }
                if final && acceptWithoutWake { deliverShortAnswer() }
                else if final && (inFollowUp || followUpStartedText), text.split(separator: " ").count >= (inConversation ? 1 : 2) {
                    Log.write("follow-up without wake phrase: \(text)")
                    deliverHandsFree(text.trimmingCharacters(in: .whitespacesAndNewlines))
                }
                return
            }
        }
        let request = requestSoFar()
        if final && !request.isEmpty { deliverHandsFree(request) }
    }

    /// A bare "yes", "no", "stop"... while a chat waits for an answer (no wake phrase needed).
    var acceptWithoutWake = false

    /// Interrupting: while a chat speaks we keep listening for a wake phrase (hands-free only).
    var othersSpeaking = false
    /// What the chat is saying right now, so its own words are not mistaken for a wake phrase.
    var spokenText = ""
    var onBargeIn: (() -> Void)?
    /// Apple's echo cancellation (as in FaceTime): removes the Mac's own sound from the microphone.
    var echoCancellation = true // the microphone arrives as 9 channels then: we keep the first (see the tap)
    private var voiceProcessingSet = false

    /// How long you must be quiet before what you said is sent.
    var pauseSeconds: Double = 3.0

    /// Conversation mode: until this time, talking without the wake phrase also counts
    /// (just after you spoke, and just after Claude finished its spoken answer).
    var followUpUntil = Date.distantPast
    /// Conversation mode is on: even a one-word answer ("yes", "goodbye") is sent without the wake phrase.
    var inConversation = false
    private var inFollowUp: Bool { Date() < followUpUntil }

    private func deliverShortAnswer() {
        let said = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let words = said.split(whereSeparator: { $0 == " " }).count
        guard !said.isEmpty, words <= 4 else { return }
        Log.write("short answer without wake phrase: \(said)")
        deliverHandsFree(said)
    }

    private func deliverHandsFree(_ said: String) {
        learnLevel()
        wakeHeardAt = nil
        carried = ""
        followUpStartedText = false
        followUpUntil = Date().addingTimeInterval(5) // keep talking: no wake phrase needed for a moment
        restartHandsFree()
        onUtterance?(said)
    }

    /// Every 5 seconds while the microphone is open: is another microphone to be used now (a headset plugged
    /// in, the Mac default switched, the chosen one connected)? macOS does not always say so. The device list
    /// is read on a background queue, so a slow sound driver cannot freeze the menu-bar icon.
    private func checkDevices() {
        guard engine.isRunning, !checkingDevices, Date().timeIntervalSince(lastDeviceCheck) >= 5 else { return }
        lastDeviceCheck = Date()
        checkingDevices = true
        let mic = microphone, failed = failedMicrophone, had = openedFor
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let def = Devices.defaultId(input: true)
            let chosen = mic.isEmpty || mic == failed ? nil : Devices.find(mic, input: true)
            let want = chosen.flatMap { $0 == def ? nil : $0 } ?? def
            let wantName = want.map(Devices.name) ?? "", hadName = had.map(Devices.name) ?? ""
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.checkingDevices = false
                guard self.engine.isRunning, self.openedFor == had, let w = want, let h = had, w != h, wantName != hadName else {
                    self.seenWant = nil
                    return
                }
                // Only when two checks in a row (5 seconds apart) give the same answer: while earbuds switch
                // into call mode, macOS can give a different answer for a moment.
                guard self.seenWant == w else { self.seenWant = w; return }
                self.seenWant = nil
                // And at most 3 such restarts in 2 minutes: each one switches Bluetooth earbuds again.
                let now = Date()
                self.checkRestarts = self.checkRestarts.filter { now.timeIntervalSince($0) < 120 }
                guard self.checkRestarts.count < 3 else {
                    if !self.checkRestartsLogged { self.checkRestartsLogged = true; Log.write("another microphone keeps being wanted: waiting before the next switch") }
                    return
                }
                self.checkRestartsLogged = false
                self.checkRestarts.append(now)
                self.restartMicrophone("another microphone is to be used now: \(wantName)")
            }
        }
    }
    private var checkingDevices = false
    private var lastDeviceCheck = Date.distantPast
    /// The other microphone the last check wanted (it must be wanted twice in a row).
    private var seenWant: AudioDeviceID?
    private var checkRestarts: [Date] = []
    private var checkRestartsLogged = false

    private func pulse() {
        checkDevices()
        guard handsFree, task != nil else { return }
        let quiet = Date().timeIntervalSince(lastChange)
        if phase == .capturing, let heard = wakeHeardAt {
            let request = requestSoFar()
            if !request.isEmpty && quiet > pauseSeconds { deliverHandsFree(request); return }
            if request.isEmpty && Date().timeIntervalSince(heard) > 10 && quiet > 4 { wakeHeardAt = nil; carried = ""; restartHandsFree(); return }
        } else if phase == .waitingForWake && !othersSpeaking && (inFollowUp || followUpStartedText) && !text.isEmpty && quiet > pauseSeconds && !hasWake() {
            followUpStartedText = false
            let said = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if said.split(separator: " ").count >= 2 || acceptWithoutWake || inConversation {
                Log.write("follow-up without wake phrase: \(said)")
                deliverHandsFree(said)
            } else { restartHandsFree() }
            return
        } else if phase == .waitingForWake && acceptWithoutWake && !text.isEmpty && quiet > 1.0 && !hasWake() {
            deliverShortAnswer()
            return
        } else if phase == .waitingForWake {
            // Start fresh now and then, so old speech does not pile up.
            if Date().timeIntervalSince(taskStarted) > 50 || (quiet > 4 && !text.isEmpty) {
                if debug && !text.isEmpty { Log.write("no wake phrase in: \(text)") }
                restartHandsFree()
            }
        }
    }

    private func fail(_ message: String) {
        stopTask()
        stopEngineIfIdle()
        phase = .error
        onProblem?(message)
    }
}
