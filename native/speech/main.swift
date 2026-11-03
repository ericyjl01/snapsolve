// snapsolve-speech (task 063): records the default microphone and transcribes it on-device. One JSON object per line on
// stdout: {"type":"ready"}, {"type":"level","level":0…1}, {"type":"partial","text":…}, then {"type":"final","text":…}
// after SIGINT or stdin closing; {"type":"error","kind":"micDenied"|"speechDenied"|"unavailable"|"failed",
// "message":…} and exit 1 on failure. No audio is written anywhere.
// `--hold control,option` (task 096, hold to talk): from the start, before any permission prompt, it also watches those
// modifier keys and prints {"type":"released"} once, as soon as one of them is no longer down. It reads only the
// modifier flags (CGEventSource.flagsState), no key events (no event tap, so no Input Monitoring prompt is expected;
// confirmed by hand on the Mac, checklist 032).
// `--source system` (task 098, listen to the Mac): transcribes what the Mac plays instead of the microphone, through a
// Core Audio process tap of every process's output (macOS 14.2+) on a private aggregate device; no Microphone request,
// macOS asks for System Audio Recording instead. A refused grant gives silence, not an error, so the final line then
// carries "silent":true when every sample was zero.
import AVFoundation
import CoreAudio
import CoreGraphics
import Foundation
import Speech

let out = FileHandle.standardOutput
let outLock = NSLock()

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  outLock.lock()
  out.write(data)
  out.write("\n".data(using: .utf8)!)
  outLock.unlock()
}

func fail(_ kind: String, _ message: String) -> Never {
  emit(["type": "error", "kind": kind, "message": message])
  exit(1)
}

/** RMS of the first channel mapped onto 0…1 (about -50 dB … 0 dB). */
func level(of buffer: AVAudioPCMBuffer) -> Double {
  guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
  var sum: Float = 0
  for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
  let rms = sqrt(sum / Float(buffer.frameLength))
  let db = 20 * log10(max(rms, 1e-7))
  return Double(min(max((db + 50) / 50, 0), 1))
}

/** Ends the recording once: SIGINT or stdin closing (main's two ways of saying "send"). */
final class StopSignal: @unchecked Sendable {
  private let lock = NSLock()
  private var handlers: [() -> Void] = []
  private var fired = false
  func onStop(_ handler: @escaping () -> Void) {
    lock.lock(); defer { lock.unlock() }
    if fired { handler() } else { handlers.append(handler) }
  }
  func fire() {
    lock.lock()
    if fired { lock.unlock(); return }
    fired = true
    let run = handlers
    handlers = []
    lock.unlock()
    for h in run { h() }
  }
}

/** The `--hold` modifiers as event flags; nil without the option (or with no name it knows). */
func holdFlags(_ arguments: [String]) -> CGEventFlags? {
  guard let i = arguments.firstIndex(of: "--hold"), i + 1 < arguments.count else { return nil }
  var flags: CGEventFlags = []
  for name in arguments[i + 1].split(separator: ",") {
    switch name {
    case "control": flags.insert(.maskControl)
    case "option": flags.insert(.maskAlternate)
    case "shift": flags.insert(.maskShift)
    case "command": flags.insert(.maskCommand)
    default: break
    }
  }
  return flags.isEmpty ? nil : flags
}

/** Polls the held modifiers every 20 ms; the first poll that finds one up prints "released" and ends the watch. */
let holdWatch: DispatchSourceTimer? = holdFlags(CommandLine.arguments).map { held in
  let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
  timer.schedule(deadline: .now(), repeating: .milliseconds(20))
  timer.setEventHandler { [weak timer] in
    if CGEventSource.flagsState(.combinedSessionState).isSuperset(of: held) { return }
    emit(["type": "released"])
    timer?.cancel()
  }
  timer.resume()
  return timer
}

let stop = StopSignal()
signal(SIGINT, SIG_IGN)
let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigint.setEventHandler { stop.fire() }
sigint.resume()
DispatchQueue.global().async {
  while true {
    let chunk = FileHandle.standardInput.availableData
    if chunk.isEmpty { stop.fire(); return }
  }
}

/** One microphone buffer in the analyzer's format; nil when it cannot be converted (that buffer is dropped). */
func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
  let ratio = format.sampleRate / buffer.format.sampleRate
  let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
  guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
  var consumed = false
  var error: NSError?
  let status = converter.convert(to: output, error: &error) { _, inputStatus in
    if consumed {
      inputStatus.pointee = .noDataNow
      return nil
    }
    consumed = true
    inputStatus.pointee = .haveData
    return buffer
  }
  return status == .error || output.frameLength == 0 ? nil : output
}

/** `--source system` (098): listen to what the Mac plays. */
let listensToMac: Bool = {
  guard let i = CommandLine.arguments.firstIndex(of: "--source"), i + 1 < CommandLine.arguments.count else { return false }
  return CommandLine.arguments[i + 1] == "system"
}()

/** Where the audio comes from: the microphone, or (098) what the Mac plays. Buffers arrive in `format`. */
protocol AudioSource: AnyObject {
  var format: AVAudioFormat { get }
  func start(_ onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws
  func stop()
}

/** The default microphone through AVAudioEngine (063). */
final class MicSource: AudioSource {
  private let engine = AVAudioEngine()
  var format: AVAudioFormat { engine.inputNode.outputFormat(forBus: 0) }
  func start(_ onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws {
    engine.inputNode.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in onBuffer(buffer) }
    engine.prepare()
    try engine.start()
  }
  func stop() {
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
  }
}

struct CoreAudioError: Error, CustomStringConvertible {
  let step: String
  let status: OSStatus
  var description: String { "\(step) failed (OSStatus \(status))" }
}

func check(_ status: OSStatus, _ step: String) throws {
  if status != noErr { throw CoreAudioError(step: step, status: status) }
}

/** One global property of a Core Audio object. */
func audioProperty<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) throws -> T {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  try withUnsafeMutablePointer(to: &value) { try check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0), "reading property \(selector)") }
  return value
}

/**
 * What the Mac plays (098): a private, unmuted stereo tap of every process's output, on a private aggregate device
 * whose main sub-device is the default output (so the tap runs on its clock). Buffers are copied out of the callback,
 * downmixed to mono float at the tap's rate (a standard format both recognizers take). `heardSound` turns true at the
 * first sample that is not zero.
 */
@available(macOS 14.2, *)
final class SystemSource: AudioSource {
  let format: AVAudioFormat
  private let tapFormat: AVAudioFormat
  private let converter: AVAudioConverter
  private var tap = AudioObjectID(kAudioObjectUnknown)
  private var device = AudioObjectID(kAudioObjectUnknown)
  private var proc: AudioDeviceIOProcID?
  private let queue = DispatchQueue(label: "snapsolve.listen")
  private let lock = NSLock()
  private var sound = false
  var heardSound: Bool { lock.lock(); defer { lock.unlock() }; return sound }

  init() throws {
    let output: AudioDeviceID = try audioProperty(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioDeviceID(kAudioObjectUnknown))
    if output == kAudioObjectUnknown { throw CoreAudioError(step: "finding the sound output", status: kAudioHardwareBadDeviceError) }
    let outputUID: CFString = try audioProperty(output, kAudioDevicePropertyDeviceUID, "" as CFString)
    let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    description.uuid = UUID()
    description.name = "snapsolve listen"
    description.isPrivate = true
    description.muteBehavior = .unmuted
    try check(AudioHardwareCreateProcessTap(description, &tap), "creating the process tap")
    var stream: AudioStreamBasicDescription = try audioProperty(tap, kAudioTapPropertyFormat, AudioStreamBasicDescription())
    guard let tapFormat = AVAudioFormat(streamDescription: &stream),
      let mono = AVAudioFormat(standardFormatWithSampleRate: stream.mSampleRate, channels: 1),
      let converter = AVAudioConverter(from: tapFormat, to: mono)
    else { throw CoreAudioError(step: "reading the tap's format", status: kAudioHardwareUnsupportedOperationError) }
    converter.downmix = true
    self.tapFormat = tapFormat
    self.format = mono
    self.converter = converter
    let aggregate: [String: Any] = [
      kAudioAggregateDeviceNameKey: "snapsolve listen",
      kAudioAggregateDeviceUIDKey: UUID().uuidString,
      kAudioAggregateDeviceMainSubDeviceKey: outputUID as String,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID as String]],
      kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
    ]
    do {
      try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device), "creating the aggregate device")
    } catch {
      AudioHardwareDestroyProcessTap(tap)
      throw error
    }
  }

  func start(_ onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws {
    let tapFormat = self.tapFormat
    try check(
      AudioDeviceCreateIOProcIDWithBlock(&proc, device, queue) { [weak self] _, input, _, _, _ in
        guard let self, let raw = AVAudioPCMBuffer(pcmFormat: tapFormat, bufferListNoCopy: input, deallocator: nil),
          raw.frameLength > 0, let buffer = convert(raw, with: self.converter, to: self.format)
        else { return }
        if !self.heardSound, let samples = buffer.floatChannelData?[0],
          (0..<Int(buffer.frameLength)).contains(where: { samples[$0] != 0 })
        {
          self.lock.lock(); self.sound = true; self.lock.unlock()
        }
        onBuffer(buffer)
      }, "creating the audio callback")
    try check(AudioDeviceStart(device, proc), "starting the aggregate device")
  }

  func stop() {
    if let proc {
      AudioDeviceStop(device, proc)
      AudioDeviceDestroyIOProcID(device, proc)
      self.proc = nil
    }
    if device != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(device); device = AudioObjectID(kAudioObjectUnknown) }
    if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap); tap = AudioObjectID(kAudioObjectUnknown) }
  }
}

/** The final line; listening to the Mac adds "silent":true when every sample was zero (098). */
func emitFinal(_ text: String, source: AudioSource) {
  var line: [String: Any] = ["type": "final", "text": text.trimmingCharacters(in: .whitespacesAndNewlines)]
  if #available(macOS 14.2, *), let system = source as? SystemSource, !system.heardSound { line["silent"] = true }
  emit(line)
}

/**
 * Whether any audio reached the recognizer (098). With nothing playing, macOS runs no audio callback at all, and a
 * recognizer that was never given audio waits for ever after the end of input; a stop with none then ends at once.
 */
final class Delivery: @unchecked Sendable {
  private let lock = NSLock()
  private var any = false
  func mark() { lock.lock(); any = true; lock.unlock() }
  var none: Bool { lock.lock(); defer { lock.unlock() }; return !any }
}

/** On the stop: stop the source, then, when no audio ever arrived, the final line now (empty) and exit. */
func stopSource(_ source: AudioSource, delivery: Delivery, finish: () -> Void) {
  source.stop()
  if delivery.none {
    emitFinal("", source: source)
    exit(0)
  }
  finish()
}

func authorizeSpeech() async -> SFSpeechRecognizerAuthorizationStatus {
  await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
}

@available(macOS 26.0, *)
func runAnalyzer(source: AudioSource) async throws {
  guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current) else {
    fail("unavailable", "on-device speech recognition does not support \(Locale.current.identifier)")
  }
  let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
  if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
    try await request.downloadAndInstall()
  }
  guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
    fail("unavailable", "no audio format for on-device speech recognition")
  }
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let (inputs, builder) = AsyncStream.makeStream(of: AnalyzerInput.self)
  guard let converter = AVAudioConverter(from: source.format, to: format) else {
    fail("unavailable", "cannot convert the audio for speech recognition")
  }
  let delivery = Delivery()
  try source.start { buffer in
    emit(["type": "level", "level": level(of: buffer)])
    if let converted = convert(buffer, with: converter, to: format) {
      delivery.mark()
      builder.yield(AnalyzerInput(buffer: converted))
    }
  }
  emit(["type": "ready"])

  stop.onStop {
    stopSource(source, delivery: delivery) { builder.finish() }
  }

  let results = Task { () -> String in
    var finished = ""
    for try await result in transcriber.results {
      let text = String(result.text.characters)
      if result.isFinal {
        finished += text
        emit(["type": "partial", "text": finished])
      } else {
        emit(["type": "partial", "text": finished + text])
      }
    }
    return finished
  }
  try await analyzer.start(inputSequence: inputs)
  try await analyzer.finalizeAndFinishThroughEndOfInput()
  let text = try await results.value
  emitFinal(text, source: source)
}

func runRecognizer(source: AudioSource) async throws {
  guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(), recognizer.isAvailable,
    recognizer.supportsOnDeviceRecognition
  else { fail("unavailable", "on-device speech recognition is not available") }
  let request = SFSpeechAudioBufferRecognitionRequest()
  request.requiresOnDeviceRecognition = true
  request.shouldReportPartialResults = true
  let delivery = Delivery()
  try source.start { buffer in
    emit(["type": "level", "level": level(of: buffer)])
    delivery.mark()
    request.append(buffer)
  }
  emit(["type": "ready"])
  stop.onStop {
    stopSource(source, delivery: delivery) { request.endAudio() }
  }
  let text: String = try await withCheckedThrowingContinuation { c in
    var done = false
    var latest = ""
    _ = recognizer.recognitionTask(with: request) { result, error in
      if done { return }
      if let result {
        latest = result.bestTranscription.formattedString
        if result.isFinal {
          done = true
          c.resume(returning: latest)
          return
        }
        emit(["type": "partial", "text": latest])
      } else if let error {
        done = true
        // No speech at all ends with an error; that is an empty transcript, not a failure.
        if latest.isEmpty { c.resume(returning: "") } else { c.resume(throwing: error) }
      }
    }
  }
  emitFinal(text, source: source)
}

/** The source the arguments ask for (098: `--source system` → what the Mac plays, which needs macOS 14.2). */
func makeSource() -> AudioSource {
  guard listensToMac else { return MicSource() }
  guard #available(macOS 14.2, *) else { fail("unavailable", "listening to the Mac needs macOS 14.2 or later") }
  do {
    return try SystemSource()
  } catch {
    fail("failed", String(describing: error))
  }
}

Task {
  // Listening to the Mac (098) never asks for the microphone; macOS asks for System Audio Recording when the tap starts.
  if !listensToMac {
    guard await AVCaptureDevice.requestAccess(for: .audio) else { fail("micDenied", "microphone access is denied") }
  }
  guard await authorizeSpeech() == .authorized else { fail("speechDenied", "speech recognition is denied") }
  let source = makeSource()
  do {
    if #available(macOS 26.0, *), SpeechTranscriber.isAvailable {
      try await runAnalyzer(source: source)
    } else {
      try await runRecognizer(source: source)
    }
    exit(0)
  } catch {
    source.stop()
    fail("failed", String(describing: error))
  }
}
dispatchMain()
