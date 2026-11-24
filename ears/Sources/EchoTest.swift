import AVFoundation
import Speech

/// Test mode: `open -n SpokelineEars.app --args --echo-test <wav>` plays the WAV out loud while listening,
/// three ways, and writes what speech recognition heard to ~/.spokeline/echo-test.txt.
/// If echo removal works, the recognizer should hear (almost) nothing of the played voice.
enum EchoTest {
    static var out = ""
    static func say(_ s: String) {
        out += s + "\n"
        try? out.write(to: Files.base.appendingPathComponent("echo-test.txt"), atomically: true, encoding: .utf8)
    }

    static func run(wav: String) {
        say("echo test \(Date())")
        let rec = SFSpeechRecognizer(locale: Locale(identifier: "en_US"))!
        rec.queue = OperationQueue()
        for mode in ["no echo removal, afplay", "echo removal, afplay"] {
            let heard = once(mode: mode, wav: wav, rec: rec)
            say("[\(mode)] heard: \(heard)")
        }
        say("done")
        exit(0)
    }

    static func once(mode: String, wav: String, rec: SFSpeechRecognizer) -> String {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let vp = mode.hasPrefix("echo removal")
        if vp {
            do {
                try input.setVoiceProcessingEnabled(true)
                if #available(macOS 14.0, *) {
                    input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
                }
            } catch { return "could not turn on echo removal: \(error.localizedDescription)" }
        }
        let inFormat = input.outputFormat(forBus: 0)
        say("  microphone format: \(inFormat.channelCount) channels, \(Int(inFormat.sampleRate)) Hz")
        let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inFormat.sampleRate, channels: 1, interleaved: false)!
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.requiresOnDeviceRecognition = true
        var level: Float = 0
        input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { buffer, _ in
            // Keep only the first channel: that is the cleaned microphone signal.
            guard let m = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength),
                  let src = buffer.floatChannelData, let dst = m.floatChannelData else { return }
            m.frameLength = buffer.frameLength
            for i in 0..<Int(buffer.frameLength) { dst[0][i] = src[0][i]; level = max(level, abs(src[0][i])) }
            req.append(m)
        }
        var player: AVAudioPlayerNode? = nil
        var file: AVAudioFile? = nil
        if mode.hasSuffix("helper") {
            file = try? AVAudioFile(forReading: URL(fileURLWithPath: wav))
            let p = AVAudioPlayerNode()
            engine.attach(p)
            engine.connect(p, to: engine.mainMixerNode, format: file?.processingFormat)
            player = p
        }
        engine.prepare()
        do { try engine.start() } catch { return "engine did not start: \(error.localizedDescription)" }
        var text = ""
        let task = rec.recognitionTask(with: req) { r, _ in if let r = r { text = r.bestTranscription.formattedString } }
        var afplay: Process? = nil
        if let p = player, let f = file { p.scheduleFile(f, at: nil); p.play() }
        else {
            let pr = Process(); pr.executableURL = URL(fileURLWithPath: "/usr/bin/afplay"); pr.arguments = [wav]
            try? pr.run(); afplay = pr
        }
        RunLoop.main.run(until: Date().addingTimeInterval(9))
        afplay?.terminate()
        player?.stop()
        req.endAudio()
        RunLoop.main.run(until: Date().addingTimeInterval(1.5))
        task.cancel()
        engine.stop()
        input.removeTap(onBus: 0)
        if vp { try? input.setVoiceProcessingEnabled(false) }
        say("  loudest microphone level: \(level)")
        return text.isEmpty ? "(nothing)" : text
    }
}
