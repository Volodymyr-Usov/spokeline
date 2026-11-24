import Foundation

/// Downloads the natural voice (the open-source sherpa-onnx speech engine and the Kokoro voice model)
/// into ~/.spokeline/voice, once, when the Spokeline mod asks for it by writing `install.request`.
/// Progress and errors go to `status.json`, which the mod reads to tell the person.
final class VoiceInstaller {
    static let engineVersion = "2.0.1"
    #if arch(arm64)
    static let engineName = "sherpa-onnx-v\(engineVersion)-osx-arm64-shared"
    #else
    static let engineName = "sherpa-onnx-v\(engineVersion)-osx-x64-shared"
    #endif
    static let engineURL = URL(string: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v\(engineVersion)/\(engineName).tar.bz2")!
    static let modelName = "kokoro-multi-lang-v1_0"
    static let modelURL = URL(string: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/\(modelName).tar.bz2")!

    static var dir: URL { Files.base.appendingPathComponent("voice", isDirectory: true) }
    static var requestFile: URL { dir.appendingPathComponent("install.request") }
    static var statusFile: URL { dir.appendingPathComponent("status.json") }
    static var engineBinary: URL { dir.appendingPathComponent("engine/bin/sherpa-onnx-offline-tts") }
    static var modelFile: URL { dir.appendingPathComponent("kokoro/model.onnx") }

    static var isReady: Bool {
        FileManager.default.isExecutableFile(atPath: engineBinary.path) && FileManager.default.fileExists(atPath: modelFile.path)
    }

    private var busy = false
    private var progressTimer: Timer?

    /// Called from the app's main loop.
    func check() {
        guard !busy, FileManager.default.fileExists(atPath: VoiceInstaller.requestFile.path) else { return }
        try? FileManager.default.removeItem(at: VoiceInstaller.requestFile)
        if VoiceInstaller.isReady { writeStatus("ready", step: "installed", progress: 1); return }
        busy = true
        Log.write("natural voice: download started")
        DispatchQueue.global(qos: .utility).async { [weak self] in
            self?.install()
            DispatchQueue.main.async { self?.busy = false }
        }
    }

    private func install() {
        let fm = FileManager.default
        let d = VoiceInstaller.dir
        let tmp = d.appendingPathComponent("tmp-install", isDirectory: true)
        do {
            try? fm.removeItem(at: tmp)
            try fm.createDirectory(at: tmp, withIntermediateDirectories: true)

            let engineArchive = try download(VoiceInstaller.engineURL, step: "speech engine", weight: (0.0, 0.07), into: tmp)
            try extract(engineArchive, into: tmp)
            let modelArchive = try download(VoiceInstaller.modelURL, step: "voice", weight: (0.07, 0.95), into: tmp)
            writeStatus("downloading", step: "unpacking", progress: 0.96)
            try extract(modelArchive, into: tmp)

            // Move into place.
            let engine = d.appendingPathComponent("engine"), kokoro = d.appendingPathComponent("kokoro")
            try? fm.removeItem(at: engine); try? fm.removeItem(at: kokoro)
            try fm.moveItem(at: tmp.appendingPathComponent(VoiceInstaller.engineName), to: engine)
            try fm.moveItem(at: tmp.appendingPathComponent(VoiceInstaller.modelName), to: kokoro)
            // Keep only what English speech needs.
            for extra in ["espeak-ng-data", "dict", "lexicon-zh.txt", "date-zh.fst", "number-zh.fst", "phone-zh.fst"] {
                try? fm.removeItem(at: kokoro.appendingPathComponent(extra))
            }
            if let bins = try? fm.contentsOfDirectory(atPath: engine.appendingPathComponent("bin").path) {
                for b in bins where b != "sherpa-onnx-offline-tts" { try? fm.removeItem(at: engine.appendingPathComponent("bin/" + b)) }
            }
            try? fm.removeItem(at: engine.appendingPathComponent("include"))
            try? fm.removeItem(at: tmp)
            guard VoiceInstaller.isReady else { throw err("the files were not where expected after unpacking") }
            writeStatus("ready", step: "installed", progress: 1)
            Log.write("natural voice: ready")
        } catch {
            try? fm.removeItem(at: tmp)
            writeStatus("error", step: "failed", progress: 0, error: error.localizedDescription)
            Log.write("natural voice: failed: \(error.localizedDescription)")
        }
    }

    private func download(_ url: URL, step: String, weight: (Double, Double), into folder: URL) throws -> URL {
        let sem = DispatchSemaphore(value: 0)
        var result: URL?
        var failure: Error?
        let target = folder.appendingPathComponent(url.lastPathComponent)
        let task = URLSession.shared.downloadTask(with: url) { file, response, error in
            if let error = error { failure = error }
            else if let http = response as? HTTPURLResponse, http.statusCode != 200 { failure = self.err("download failed (HTTP \(http.statusCode))") }
            else if let file = file {
                do { try? FileManager.default.removeItem(at: target); try FileManager.default.moveItem(at: file, to: target); result = target }
                catch { failure = error }
            }
            sem.signal()
        }
        let observer = task.progress.observe(\.fractionCompleted) { [weak self] p, _ in
            let now = Date()
            if now.timeIntervalSince(self?.lastWrite ?? .distantPast) > 0.8 {
                self?.lastWrite = now
                self?.writeStatus("downloading", step: step, progress: weight.0 + (weight.1 - weight.0) * p.fractionCompleted)
            }
        }
        task.resume()
        sem.wait()
        observer.invalidate()
        if let f = failure { throw f }
        guard let r = result else { throw err("download failed") }
        return r
    }
    private var lastWrite = Date.distantPast

    private func extract(_ archive: URL, into folder: URL) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        p.arguments = ["-xjf", archive.path, "-C", folder.path]
        try p.run()
        p.waitUntilExit()
        try? FileManager.default.removeItem(at: archive)
        guard p.terminationStatus == 0 else { throw err("could not unpack \(archive.lastPathComponent)") }
    }

    private func writeStatus(_ state: String, step: String, progress: Double, error: String? = nil) {
        try? FileManager.default.createDirectory(at: VoiceInstaller.dir, withIntermediateDirectories: true)
        var o: [String: Any] = ["state": state, "step": step, "progress": (progress * 100).rounded() / 100,
                                "updatedAt": Int(Date().timeIntervalSince1970 * 1000)]
        if let e = error { o["error"] = e }
        if let d = try? JSONSerialization.data(withJSONObject: o) { writeAtomically(d, to: VoiceInstaller.statusFile) }
    }

    private func err(_ s: String) -> NSError { NSError(domain: "Spokeline", code: 1, userInfo: [NSLocalizedDescriptionKey: s]) }
}
