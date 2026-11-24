import Foundation

/// Files shared with the Spokeline mod. Everything lives in ~/.spokeline and is readable only by the user.
enum Files {
    static let base: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".spokeline", isDirectory: true)
    static var sessions: URL { base.appendingPathComponent("sessions", isDirectory: true) }
    static var inbox: URL { base.appendingPathComponent("inbox", isDirectory: true) }
    static var config: URL { base.appendingPathComponent("config.json") }
    static var log: URL { base.appendingPathComponent("ears.log") }
    static var permission: URL { base.appendingPathComponent("permission", isDirectory: true) }
    static var live: URL { base.appendingPathComponent("live", isDirectory: true) }
    /// What the microphone is doing now, for the chats to show all the time (see EarsStateFile).
    static var earsState: URL { base.appendingPathComponent("ears.json") }

    static func ensureFolders() {
        let fm = FileManager.default
        for dir in [base, sessions, inbox, permission, live] {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
    }

    static func inboxFile(_ sessionId: String) -> URL {
        inbox.appendingPathComponent(safeName(sessionId) + ".jsonl")
    }

    static func liveFile(_ sessionId: String) -> URL {
        live.appendingPathComponent(safeName(sessionId) + ".json")
    }

    /// Session ids come from file names we did not write ourselves: keep only safe characters.
    static func safeName(_ s: String) -> String {
        String(s.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" })
    }
}

struct EarsConfig {
    var mode: String = "push_to_talk"          // off | push_to_talk | hands_free
    var hotkey: String = "ctrl+option+v"
    var wakePhrase: String = "claude, hey claude, ok claude, anthropic, hey spokeline"
    var language: String = ""
    var targetSessionId: String? = nil
    var debug: Bool = false
    var pauseSeconds: Double = 3.0
    var bargeIn: Bool = true
    /// The microphone and speakers chosen in the /spokeline menu, by name; "" = the Mac default.
    var microphone: String = ""
    var speakers: String = ""

    static func load() -> (EarsConfig, [String: Any]) {
        var c = EarsConfig()
        guard let data = try? Data(contentsOf: Files.config),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return (c, [:]) }
        if let v = obj["mode"] as? String { c.mode = v }
        if let v = obj["hotkey"] as? String, !v.isEmpty { c.hotkey = v }
        if let v = obj["wakePhrase"] as? String, !v.isEmpty { c.wakePhrase = v }
        if let v = obj["language"] as? String { c.language = v }
        if let v = obj["targetSessionId"] as? String, !v.isEmpty { c.targetSessionId = v }
        if let v = obj["debug"] as? Bool { c.debug = v }
        if let v = obj["pauseSeconds"] as? Double { c.pauseSeconds = min(8, max(1, v)) }
        if let v = obj["bargeIn"] as? Bool { c.bargeIn = v }
        if let v = obj["microphone"] as? String { c.microphone = v }
        if let v = obj["speakers"] as? String { c.speakers = v }
        return (c, obj)
    }

    /// Change some keys and keep the rest of the file as it is.
    static func update(_ changes: [String: Any?]) {
        var (_, obj) = load()
        for (k, v) in changes {
            if let v = v { obj[k] = v } else { obj.removeValue(forKey: k) }
        }
        obj["updatedAt"] = Int(Date().timeIntervalSince1970 * 1000)
        if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) {
            writeAtomically(data, to: Files.config)
        }
    }
}

struct ChatSession {
    let id: String
    let title: String
    let cwd: String
    let lastActive: Double
    let heartbeat: Double
    let busy: Bool
    let speaking: Bool
    let awaitingAnswer: Bool
    let ackSeq: Double
    let speakingText: String

    var isAlive: Bool { Date().timeIntervalSince1970 * 1000 - heartbeat < 8000 }

    /// The plugin cannot write its status file in one step, so a read can catch it half-written.
    /// Then we use the last complete reading of that file instead of treating the chat as gone.
    private static var lastGood: [String: [String: Any]] = [:]
    private static let lastGoodLock = NSLock()

    static func all() -> [ChatSession] {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: Files.sessions, includingPropertiesForKeys: nil) else { return [] }
        var out: [ChatSession] = []
        for url in files where url.pathExtension == "json" {
            var parsed: [String: Any]? = nil
            if let data = try? Data(contentsOf: url) { parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] }
            lastGoodLock.lock()
            if let p = parsed { lastGood[url.path] = p } else { parsed = lastGood[url.path] }
            lastGoodLock.unlock()
            guard let o = parsed, let id = o["sessionId"] as? String, !id.isEmpty else { continue }
            out.append(ChatSession(
                id: id,
                title: (o["title"] as? String) ?? "Claude",
                cwd: (o["cwd"] as? String) ?? "",
                lastActive: (o["lastActive"] as? Double) ?? 0,
                heartbeat: (o["heartbeat"] as? Double) ?? 0,
                busy: (o["busy"] as? Bool) ?? false,
                speaking: (o["speaking"] as? Bool) ?? false,
                awaitingAnswer: (o["awaitingAnswer"] as? Bool) ?? false,
                ackSeq: (o["ackSeq"] as? Double) ?? 0,
                speakingText: (o["speakingText"] as? String) ?? ""
            ))
        }
        return out
    }

    static func alive() -> [ChatSession] { all().filter { $0.isAlive } }
}

func writeAtomically(_ data: Data, to url: URL) {
    let tmp = url.deletingLastPathComponent().appendingPathComponent("." + url.lastPathComponent + ".tmp")
    do {
        try data.write(to: tmp, options: .atomic)
        _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
    } catch {
        try? data.write(to: url, options: .atomic)
    }
    chmod(url.path, 0o600)
}

/// The unfinished text, while you are still speaking: live/<chat id>.json = { "text", "ts" } for the chat
/// that will get the request. Written when the text changes (looked at several times a second), and once a
/// second while it stays the same, so a reader can tell fresh text from old. Empty text: nothing is being said.
/// The finished request still arrives through the inbox, as before.
final class LiveText {
    private var lastId = ""
    private var lastText = ""
    private var lastWrite = Date.distantPast

    func update(sessionId: String?, text: String) {
        let id = sessionId ?? ""
        let text = id.isEmpty ? "" : text
        let due = id != lastId || text != lastText || (!text.isEmpty && Date().timeIntervalSince(lastWrite) >= 1.0)
        guard due else { return }
        // The chat you talk to changed in the middle: the old chat must not keep showing your words.
        if !lastId.isEmpty && lastId != id && !lastText.isEmpty { write(lastId, "") }
        if !id.isEmpty && (!text.isEmpty || (lastId == id && !lastText.isEmpty)) { write(id, text) }
        lastId = id
        lastText = text
        lastWrite = Date()
    }

    func clear() { update(sessionId: lastId, text: "") }

    private func write(_ id: String, _ text: String) {
        let msg: [String: Any] = ["text": text, "ts": Int(Date().timeIntervalSince1970 * 1000)]
        guard let data = try? JSONSerialization.data(withJSONObject: msg) else { return }
        try? FileManager.default.createDirectory(at: Files.live, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        writeAtomically(data, to: Files.liveFile(id))
    }

    /// Remove the files of chats that are gone.
    static func tidy(keep: Set<String>) {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: Files.live, includingPropertiesForKeys: nil) else { return }
        for url in files where url.pathExtension == "json" && !keep.contains(url.deletingPathExtension().lastPathComponent) {
            try? fm.removeItem(at: url)
        }
    }
}

/// The microphone's state for the chats (~/.spokeline/ears.json), the same file the Windows helper writes:
/// written when something changes, when only the loudness changes at most about three times a second, and
/// otherwise every 2 seconds, so a chat can tell that the helper stopped (an old file).
final class EarsStateFile {
    struct State: Equatable {
        var state = "idle", mode = "", conversation = false, target = "", hotkey = "", wake = ""
        var microphone = "", speakers = "", hearing = false, level = 0
    }

    private var last: State?
    private var lastWrite = Date.distantPast
    // The device lists change rarely (a headset plugged in): read every 10 seconds on a background queue,
    // so a slow audio driver cannot freeze the menu-bar icon.
    private var devices: DeviceList?
    private var devicesFresh = false
    private var devicesAt = Date.distantPast
    private let lock = NSLock()

    func update(_ s: State) {
        if Date().timeIntervalSince(devicesAt) >= 10 {
            devicesAt = Date()
            DispatchQueue.global(qos: .utility).async { [weak self] in
                let d = Devices.read()
                guard let self = self else { return }
                self.lock.lock(); self.devices = d; self.devicesFresh = true; self.lock.unlock()
            }
        }
        lock.lock(); let fresh = devicesFresh; let list = devices; lock.unlock()
        var same = s; same.level = last?.level ?? -1
        let since = Date().timeIntervalSince(lastWrite)
        if !fresh, let l = last, l == same, since < (l.level == s.level ? 2 : 0.3) { return }
        lock.lock(); devicesFresh = false; lock.unlock()
        last = s
        lastWrite = Date()
        EarsStateFile.write(s, devices: list)
    }

    static func json(_ s: State, devices: DeviceList?) -> [String: Any] {
        var o: [String: Any] = [
            "state": s.state, "hearing": s.hearing, "level": s.level, "mode": s.mode, "conversation": s.conversation,
            "target": s.target, "hotkey": s.hotkey, "wake": s.wake,
            // The Mac uses Apple's own recognizer: there is no speech pack to wait for.
            "speechPack": true,
            "ts": Int(Date().timeIntervalSince1970 * 1000),
        ]
        if let d = devices {
            o["microphone"] = s.microphone
            o["speakers"] = s.speakers
            o["defaultMicrophone"] = d.defaultMicrophone
            o["defaultSpeakers"] = d.defaultSpeakers
            o["microphones"] = d.microphones
            o["speakersList"] = d.speakers
        }
        return o
    }

    private static func write(_ s: State, devices: DeviceList?) {
        guard let data = try? JSONSerialization.data(withJSONObject: json(s, devices: devices), options: [.sortedKeys]) else { return }
        writeAtomically(data, to: Files.earsState)
    }

    /// Ears is closing: the chats show the microphone helper as not running at once.
    static func closed(mode: String) {
        var s = State(); s.state = "closed"; s.mode = mode
        write(s, devices: nil)
    }
}

/// How loud you are, as 0 to 3 lit bars next to the microphone sign in the chat: none while it does not
/// hear you speak, then measured against your own usual level on this microphone (learned from your
/// requests), so speaking at a normal distance shows two bars and only louder moments show three.
enum Loudness {
    static func bars(hearing: Bool, peak: Float, usual: Float = 0.1) -> Int {
        guard hearing else { return 0 }
        let u = min(max(usual, 0.05), 0.5)
        return peak >= 0.8 * u ? 3 : peak >= 0.3 * u ? 2 : 1
    }

    /// Sound louder than this counts as you speaking (not a fixed level: it follows your usual level).
    static func speechThreshold(usual: Float) -> Float { max(0.015, 0.3 * min(usual, 0.5)) }
}

/// The live text on screen never jumps back: a new partial result that is empty, or under 40 % of the shown
/// length (Apple's recognizer sometimes returns much less for a moment), does not replace the shown words.
/// They are cleared only when a new request or key hold begins.
enum LiveWords {
    static func keeps(shown: String, fresh: String) -> Bool { Double(fresh.count) >= 0.4 * Double(shown.count) }
}

/// Sequence numbers only ever go up, even across restarts: milliseconds times 1000 plus a counter.
final class Sequence {
    private var last: Double = 0
    func next() -> Double {
        let candidate = (Date().timeIntervalSince1970 * 1000).rounded(.down) * 1000
        last = max(candidate, last + 1)
        return last
    }
}

final class Inbox {
    private let seq = Sequence()

    /// Append one line for the mod in that chat.
    func send(to sessionId: String, type: String, text: String? = nil, command: String? = nil) {
        var msg: [String: Any] = ["seq": seq.next(), "ts": Int(Date().timeIntervalSince1970 * 1000), "type": type]
        if let text = text { msg["text"] = text }
        if let command = command { msg["command"] = command }
        guard var line = try? JSONSerialization.data(withJSONObject: msg) else { return }
        line.append(0x0A)
        let url = Files.inboxFile(sessionId)
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile()
            h.write(line)
            try? h.close()
        }
        Log.write("sent \(type) to \(sessionId.prefix(8)): \(text ?? command ?? "")")
    }

    /// Empty inbox files the mod has fully read, and remove files of chats that ended long ago.
    func tidy() {
        let fm = FileManager.default
        let sessions = ChatSession.all()
        let byId = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let now = Date().timeIntervalSince1970 * 1000
        LiveText.tidy(keep: Set(sessions.map { Files.safeName($0.id) }))
        guard let files = try? fm.contentsOfDirectory(at: Files.inbox, includingPropertiesForKeys: nil) else { return }
        for url in files where url.pathExtension == "jsonl" {
            let id = url.deletingPathExtension().lastPathComponent
            guard let s = byId[id] else { try? fm.removeItem(at: url); continue }
            guard let text = try? String(contentsOf: url, encoding: .utf8), !text.isEmpty else { continue }
            var maxSeq: Double = 0
            for line in text.split(separator: "\n") {
                if let d = line.data(using: .utf8),
                   let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                   let n = o["seq"] as? Double { maxSeq = max(maxSeq, n) }
            }
            if s.ackSeq >= maxSeq { try? Data().write(to: url) }
        }
        for s in sessions where now - s.heartbeat > 3_600_000 {
            try? fm.removeItem(at: Files.sessions.appendingPathComponent(Files.safeName(s.id) + ".json"))
            try? fm.removeItem(at: Files.inboxFile(s.id))
        }
    }
}

enum Log {
    static func write(_ s: String) {
        let line = ISO8601DateFormatter().string(from: Date()) + " " + s + "\n"
        guard let data = line.data(using: .utf8) else { return }
        let url = Files.log
        if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
           let size = attrs[.size] as? Int, size > 1_000_000 {
            try? FileManager.default.removeItem(at: url)
        }
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile(); h.write(data); try? h.close()
        }
    }
}

/// Which chat should get what you said: the one you named, else the one you used last.
func chooseTarget(config: EarsConfig) -> ChatSession? {
    let alive = ChatSession.alive()
    if let t = config.targetSessionId, let s = alive.first(where: { $0.id == t }) { return s }
    return alive.max(by: { $0.lastActive < $1.lastActive })
}

/// "let's talk" starts conversation mode; "that's all" ends it. Only the whole sentence counts.
enum ConversationPhrase {
    case start, end, none
    static let starts = ["let's talk", "lets talk", "let's chat", "lets chat", "let's have a conversation",
                         "conversation mode", "start conversation", "start a conversation", "let's keep talking"]
    static let ends = ["that's all", "thats all", "that is all", "that's it", "goodbye", "good bye", "bye",
                       "stop listening", "end conversation", "end the conversation", "we're done", "were done"]
    static func of(_ said: String) -> ConversationPhrase {
        var t = said.lowercased().replacingOccurrences(of: "\u{2019}", with: "'")
        t = t.trimmingCharacters(in: CharacterSet.punctuationCharacters.subtracting(CharacterSet(charactersIn: "'")).union(.whitespaces))
        for w in ["ok ", "okay ", "so ", "now ", "alright ", "all right "] where t.hasPrefix(w) { t = String(t.dropFirst(w.count)) }
        for w in [" for now", " claude", " thanks", " thank you"] where t.hasSuffix(w) { t = String(t.dropLast(w.count)) }
        t = t.trimmingCharacters(in: CharacterSet.punctuationCharacters.subtracting(CharacterSet(charactersIn: "'")).union(.whitespaces))
        if starts.contains(t) { return .start }
        if ends.contains(t) { return .end }
        return .none
    }
}
