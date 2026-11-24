import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

/// The Mac's microphones and speakers, by name, and which ones macOS uses by default.
struct DeviceList {
    let microphones: [String]
    let speakers: [String]
    let defaultMicrophone: String
    let defaultSpeakers: String
}

enum Devices {
    private static func address(_ selector: AudioObjectPropertySelector,
                                _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    private static func allIds() -> [AudioDeviceID] {
        var addr = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    static func name(_ id: AudioDeviceID) -> String {
        var addr = address(kAudioObjectPropertyName)
        var value: Unmanaged<CFString>? = nil
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr, let v = value else { return "" }
        return v.takeRetainedValue() as String
    }

    private static func channels(_ id: AudioDeviceID, input: Bool) -> Int {
        var addr = address(kAudioDevicePropertyStreamConfiguration, input ? kAudioDevicePropertyScopeInput : kAudioDevicePropertyScopeOutput)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    /// Devices macOS makes for itself (for example while echo removal runs) are not for people to choose.
    private static func isHidden(_ id: AudioDeviceID, _ name: String) -> Bool {
        if name.isEmpty || name.hasPrefix("VPAUAggregateAudioDevice") || name.hasPrefix("CADefaultDeviceAggregate") { return true }
        var addr = address(kAudioDevicePropertyIsHidden)
        var hidden: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &hidden) == noErr && hidden != 0
    }

    private static func devices(input: Bool) -> [(id: AudioDeviceID, name: String)] {
        allIds().compactMap { id in
            let n = name(id)
            return channels(id, input: input) > 0 && !isHidden(id, n) ? (id, n) : nil
        }
    }

    static func defaultId(input: Bool) -> AudioDeviceID? {
        var addr = address(input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice)
        var id: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id) == noErr, id != 0 else { return nil }
        return id
    }

    static func read() -> DeviceList {
        DeviceList(microphones: devices(input: true).map { $0.name },
                   speakers: devices(input: false).map { $0.name },
                   defaultMicrophone: defaultId(input: true).map(name) ?? "",
                   defaultSpeakers: defaultId(input: false).map(name) ?? "")
    }

    /// The device with exactly this name. Nil (use the Mac default) when the name is empty, when no device has
    /// it, or when two devices share it: then we cannot tell which one was meant, and we never guess.
    static func find(_ chosen: String, input: Bool) -> AudioDeviceID? {
        guard !chosen.isEmpty else { return nil }
        let matches = devices(input: input).filter { $0.name == chosen }
        return matches.count == 1 ? matches[0].id : nil
    }

    /// True while some app (Spokeline included) is using this device.
    static func isRunning(_ id: AudioDeviceID) -> Bool {
        var addr = address(kAudioDevicePropertyDeviceIsRunningSomewhere)
        var running: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &running) == noErr && running != 0
    }

    /// Makes an audio unit (the microphone or speaker side of an AVAudioEngine) use this device.
    @discardableResult
    static func use(_ id: AudioDeviceID, on unit: AudioUnit) -> Bool {
        var dev = id
        return AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                    &dev, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr
    }

    /// The device an audio unit uses now.
    static func current(on unit: AudioUnit) -> AudioDeviceID? {
        var dev: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, &size) == noErr, dev != 0 else { return nil }
        return dev
    }

    /// `SpokelineEars --play <file> [--stop-file <f>]`: plays a sound file on the speakers chosen in the
    /// /spokeline menu, else on the Mac default. Stops early when the stop file appears (or the process is ended).
    static func play(_ path: String, stopFile: String?) -> Int32 {
        guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)) else {
            FileHandle.standardError.write("could not open \(path)\n".data(using: .utf8)!)
            return 1
        }
        let engine = AVAudioEngine()
        let wanted = EarsConfig.load().0.speakers
        if let id = find(wanted, input: false), let unit = engine.outputNode.audioUnit { use(id, on: unit) }
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: file.processingFormat)
        do { try engine.start() } catch {
            FileHandle.standardError.write("could not start the speakers: \(error.localizedDescription)\n".data(using: .utf8)!)
            return 1
        }
        let done = DispatchSemaphore(value: 0)
        player.scheduleFile(file, at: nil, completionCallbackType: .dataPlayedBack) { _ in done.signal() }
        player.play()
        let seconds = Double(file.length) / max(file.processingFormat.sampleRate, 1)
        let until = Date().addingTimeInterval(seconds + 5)
        while done.wait(timeout: .now() + 0.05) == .timedOut {
            if let s = stopFile, FileManager.default.fileExists(atPath: s) { break }
            if Date() > until { break }
        }
        player.stop()
        engine.stop()
        return 0
    }

    /// `SpokelineEars --devices`: prints the lists that the /spokeline menu shows (a test).
    static func printList() {
        let d = read()
        print("microphones:", d.microphones.joined(separator: " | "))
        print("speakers:", d.speakers.joined(separator: " | "))
        print("default microphone:", d.defaultMicrophone, "| default speakers:", d.defaultSpeakers)
    }
}
