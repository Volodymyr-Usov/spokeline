import Foundation

/// `SpokelineEars --permission-hook`: Claude Code's PermissionRequest hook, which runs only when a
/// permission box is about to be shown to the person.
///
/// If you are talking to that chat by voice, it hands the request to the Spokeline mod (which reads it
/// aloud) and waits a few seconds for your spoken yes or no. Otherwise, or with no answer in time, it
/// prints nothing and the normal permission box appears.
enum PermissionHook {
    static func run() -> Never {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        guard let obj = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
              let sessionId = obj["session_id"] as? String, !sessionId.isEmpty else { exit(0) }
        let tool = (obj["tool_name"] as? String) ?? ""
        let toolInput = obj["tool_input"] ?? [:]
        let sid = Files.safeName(sessionId)

        // Only while this chat is in a voice conversation.
        let sessionFile = Files.sessions.appendingPathComponent(sid + ".json")
        guard let data = try? Data(contentsOf: sessionFile),
              let s = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (s["voiceFlow"] as? Bool) == true,
              let beat = s["heartbeat"] as? Double,
              Date().timeIntervalSince1970 * 1000 - beat < 8000 else { exit(0) }
        let waitSeconds = min(120, max(5, (s["approvalWaitSeconds"] as? Double) ?? 20))

        Files.ensureFolders()
        let id = UUID().uuidString
        let requestFile = Files.permission.appendingPathComponent(sid + ".json")
        let answerFile = Files.permission.appendingPathComponent(sid + ".answer")
        try? FileManager.default.removeItem(at: answerFile)
        func writeRequest(_ state: String) {
            let req: [String: Any] = ["id": id, "tool": tool, "input": toolInput, "state": state,
                                      "ts": Int(Date().timeIntervalSince1970 * 1000)]
            if let d = try? JSONSerialization.data(withJSONObject: req) { writeAtomically(d, to: requestFile) }
        }
        writeRequest("waiting")
        Log.write("permission request for \(tool) in \(sid.prefix(8)), waiting \(Int(waitSeconds)) s for a spoken answer")

        // The mod needs time to read the request aloud before you can answer.
        let deadline = Date().addingTimeInterval(waitSeconds + 8)
        while Date() < deadline {
            if let d = try? Data(contentsOf: answerFile),
               let a = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
               (a["id"] as? String) == id, let answer = a["answer"] as? String {
                try? FileManager.default.removeItem(at: answerFile)
                writeRequest("answered")
                Log.write("permission answered by voice: \(answer)")
                let decision: [String: Any] = answer == "yes"
                    ? ["behavior": "allow"]
                    : ["behavior": "deny", "message": "The user said no by voice."]
                let out: [String: Any] = ["hookSpecificOutput": ["hookEventName": "PermissionRequest", "decision": decision]]
                if let o = try? JSONSerialization.data(withJSONObject: out) { FileHandle.standardOutput.write(o) }
                exit(0)
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        writeRequest("timeout")
        Log.write("no spoken answer, showing the permission box")
        exit(0)
    }
}
