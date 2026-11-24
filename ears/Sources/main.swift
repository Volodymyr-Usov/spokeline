import AppKit
import Speech

// Test mode: `SpokelineEars --transcribe <audio file> [wake phrase]` prints what on-device recognition
// hears in the file and whether the wake phrase is found. Used to check recognition without a microphone.
let args = CommandLine.arguments
if args.contains("--permission-hook") { PermissionHook.run() }
// `--play <file> [--stop-file <f>]`: play Spokeline's voice on the speakers chosen in the /spokeline menu.
if let i = args.firstIndex(of: "--play"), i + 1 < args.count {
    let stop = args.firstIndex(of: "--stop-file").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
    exit(Devices.play(args[i + 1], stopFile: stop))
}
// `--devices`: print the microphones and speakers the /spokeline menu offers.
if args.contains("--devices") { Devices.printList(); exit(0) }
if let i = args.firstIndex(of: "--echo-test"), i + 1 < args.count {
    DispatchQueue.main.async { EchoTest.run(wav: args[i + 1]) }
    RunLoop.main.run()
}
if let i = args.firstIndex(of: "--transcribe"), i + 1 < args.count {
    let url = URL(fileURLWithPath: args[i + 1])
    let wake = i + 2 < args.count ? args[i + 2] : "hey spokeline"
    let rec = SFSpeechRecognizer(locale: Locale.current)
    print("locale:", Locale.current.identifier, "| available:", rec?.isAvailable ?? false, "| on-device:", rec?.supportsOnDeviceRecognition ?? false)
    print("authorization:", SFSpeechRecognizer.authorizationStatus().rawValue, "(3 = allowed)")
    let req = SFSpeechURLRecognitionRequest(url: url)
    req.requiresOnDeviceRecognition = rec?.supportsOnDeviceRecognition ?? false
    var done = false
    rec?.recognitionTask(with: req) { result, error in
        if let r = result, r.isFinal {
            let t = r.bestTranscription.formattedString
            print("heard:", t)
            let ns = t as NSString
            var found = false
            for re in Listener.makeWakeRegexes(wake) {
                if let m = re.matches(in: t, range: NSRange(location: 0, length: ns.length)).last {
                    print("wake phrase found; request after it:", ns.substring(from: m.range.location + m.range.length)); found = true; break
                }
            }
            if !found { print("wake phrase NOT found") }
            done = true
        }
        if let e = error { print("error:", e.localizedDescription); done = true }
    }
    let until = Date().addingTimeInterval(30)
    while !done && Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.1)) }
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // menu-bar only, no Dock icon
app.run()
