// lost-audio — выбор устройства вывода звука в macOS (CoreAudio).
//   lost-audio list                  — все устройства вывода (JSON)
//   lost-audio get                   — текущее устройство вывода по умолчанию (JSON)
//   lost-audio set builtin           — встроенные динамики
//   lost-audio set display [имя]     — экран по HDMI/DisplayPort (при нескольких — тот, чьё имя содержит [имя])
//   lost-audio set <uid>             — конкретное устройство по UID
import CoreAudio
import Foundation

let sys = AudioObjectID(kAudioObjectSystemObject)
func addr(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}
func allDevices() -> [AudioDeviceID] {
    var a = addr(kAudioHardwarePropertyDevices), size: UInt32 = 0
    AudioObjectGetPropertyDataSize(sys, &a, 0, nil, &size)
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(sys, &a, 0, nil, &size, &ids)
    return ids
}
func string(_ id: AudioDeviceID, _ sel: AudioObjectPropertySelector) -> String {
    var a = addr(sel), size = UInt32(MemoryLayout<CFString>.size), v: CFString = "" as CFString
    let st = withUnsafeMutablePointer(to: &v) { AudioObjectGetPropertyData(id, &a, 0, nil, &size, $0) }
    return st == noErr ? (v as String) : ""
}
func transport(_ id: AudioDeviceID) -> UInt32 {
    var a = addr(kAudioDevicePropertyTransportType), size = UInt32(MemoryLayout<UInt32>.size), v: UInt32 = 0
    AudioObjectGetPropertyData(id, &a, 0, nil, &size, &v); return v
}
func hasOutput(_ id: AudioDeviceID) -> Bool {
    var a = addr(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput), size: UInt32 = 0
    AudioObjectGetPropertyDataSize(id, &a, 0, nil, &size); return size > 0
}
func kind(_ t: UInt32) -> String {
    switch t {
    case kAudioDeviceTransportTypeBuiltIn: return "builtin"
    case kAudioDeviceTransportTypeHDMI: return "hdmi"
    case kAudioDeviceTransportTypeDisplayPort: return "displayport"
    case kAudioDeviceTransportTypeUSB: return "usb"
    case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
    case kAudioDeviceTransportTypeVirtual: return "virtual"
    default: return "other"
    }
}
func defaultOutput() -> AudioDeviceID {
    var a = addr(kAudioHardwarePropertyDefaultOutputDevice), size = UInt32(MemoryLayout<AudioDeviceID>.size), v: AudioDeviceID = 0
    AudioObjectGetPropertyData(sys, &a, 0, nil, &size, &v); return v
}
func info(_ id: AudioDeviceID) -> [String: Any] {
    ["id": Int(id), "uid": string(id, kAudioDevicePropertyDeviceUID), "name": string(id, kAudioObjectPropertyName), "kind": kind(transport(id))]
}
func out(_ obj: Any) {
    let d = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    print(String(data: d, encoding: .utf8)!)
}
func setDefault(_ id: AudioDeviceID) -> Bool {
    var v = id, ok = true
    for sel in [kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDefaultSystemOutputDevice] {
        var a = addr(sel)
        if AudioObjectSetPropertyData(sys, &a, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &v) != noErr { ok = false }
    }
    return ok
}

let args = CommandLine.arguments
let outputs = allDevices().filter(hasOutput)
switch args.count > 1 ? args[1] : "" {
case "list":
    out(outputs.map(info))
case "get":
    out(info(defaultOutput()))
case "set":
    guard args.count > 2 else { FileHandle.standardError.write("нужен аргумент\n".data(using: .utf8)!); exit(2) }
    var target: AudioDeviceID?
    switch args[2] {
    case "builtin":
        target = outputs.first { transport($0) == kAudioDeviceTransportTypeBuiltIn }
    case "display":
        let screens = outputs.filter { [kAudioDeviceTransportTypeHDMI, kAudioDeviceTransportTypeDisplayPort].contains(transport($0)) }
        let wanted = args.count > 3 ? args[3].lowercased() : ""
        target = screens.first { !wanted.isEmpty && string($0, kAudioObjectPropertyName).lowercased().contains(wanted) } ?? screens.first
    default:
        target = outputs.first { string($0, kAudioDevicePropertyDeviceUID) == args[2] }
    }
    guard let t = target else { FileHandle.standardError.write("устройство не найдено\n".data(using: .utf8)!); exit(3) }
    if !setDefault(t) { FileHandle.standardError.write("не удалось переключить\n".data(using: .utf8)!); exit(4) }
    out(info(defaultOutput()))
default:
    FileHandle.standardError.write("использование: lost-audio list | get | set builtin|display [имя]|<uid>\n".data(using: .utf8)!); exit(1)
}
