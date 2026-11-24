import Carbon.HIToolbox
import Foundation

/// A system-wide key combination that reports both press and release (hold to talk).
/// Uses Carbon's RegisterEventHotKey, which needs no Accessibility permission.
final class HotKey {
    var onDown: (() -> Void)?
    var onUp: (() -> Void)?
    private(set) var display = ""

    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?

    init() {
        var specs = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        let me = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData -> OSStatus in
            guard let event = event, let userData = userData else { return noErr }
            let hk = Unmanaged<HotKey>.fromOpaque(userData).takeUnretainedValue()
            if GetEventKind(event) == UInt32(kEventHotKeyPressed) { hk.onDown?() } else { hk.onUp?() }
            return noErr
        }, 2, &specs, me, &handler)
    }

    /// "ctrl+option+space" -> registers it. Returns false when the text can't be understood or the key is taken.
    @discardableResult
    func set(_ text: String) -> Bool {
        if let r = ref { UnregisterEventHotKey(r); ref = nil }
        guard let (code, mods, shown) = HotKey.parse(text) else { display = ""; return false }
        let id = EventHotKeyID(signature: OSType(0x53504B4C), id: 1) // "SPKL"
        let status = RegisterEventHotKey(code, mods, id, GetApplicationEventTarget(), 0, &ref)
        display = status == noErr ? shown : ""
        return status == noErr
    }

    static func parse(_ text: String) -> (UInt32, UInt32, String)? {
        var mods: UInt32 = 0
        var shown = ""
        var key: UInt32?
        var keyName = ""
        for raw in text.lowercased().split(whereSeparator: { $0 == "+" || $0 == "-" || $0 == " " }) {
            let t = String(raw)
            switch t {
            case "ctrl", "control", "⌃": mods |= UInt32(controlKey)
            case "opt", "option", "alt", "⌥": mods |= UInt32(optionKey)
            case "cmd", "command", "⌘": mods |= UInt32(cmdKey)
            case "shift", "⇧": mods |= UInt32(shiftKey)
            default:
                if let c = keyCodes[t] { key = c; keyName = t }
                else { return nil }
            }
        }
        guard let k = key, mods != 0 else { return nil }
        if mods & UInt32(controlKey) != 0 { shown += "⌃" }
        if mods & UInt32(optionKey) != 0 { shown += "⌥" }
        if mods & UInt32(shiftKey) != 0 { shown += "⇧" }
        if mods & UInt32(cmdKey) != 0 { shown += "⌘" }
        shown += keyName == "space" ? "Space" : keyName.uppercased()
        return (k, mods, shown)
    }

    private static let keyCodes: [String: UInt32] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
        "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
        "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40,
        "n": 45, "m": 46, "space": 49, "return": 36, "enter": 36, "escape": 53, "esc": 53, "`": 50,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
        "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    ]
}
