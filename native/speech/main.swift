// snapsolve-speech (task 063): records the default microphone and transcribes it on-device. One JSON object per line on
// stdout: {"type":"ready"}, {"type":"level","level":0…1}, {"type":"partial","text":…}, then {"type":"final","text":…}
// after SIGINT or stdin closing; {"type":"error","kind":"micDenied"|"speechDenied"|"unavailable"|"failed",
// "message":…} and exit 1 on failure. No audio is written anywhere.
import AVFoundation
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

func authorizeSpeech() async -> SFSpeechRecognizerAuthorizationStatus {
  await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
}

@available(macOS 26.0, *)
func runAnalyzer(engine: AVAudioEngine) async throws {
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
  let input = engine.inputNode
  let micFormat = input.outputFormat(forBus: 0)
  guard let converter = AVAudioConverter(from: micFormat, to: format) else {
    fail("unavailable", "cannot convert the microphone's audio for speech recognition")
  }
  input.installTap(onBus: 0, bufferSize: 2048, format: micFormat) { buffer, _ in
    emit(["type": "level", "level": level(of: buffer)])
    if let converted = convert(buffer, with: converter, to: format) { builder.yield(AnalyzerInput(buffer: converted)) }
  }
  engine.prepare()
  try engine.start()
  emit(["type": "ready"])

  stop.onStop {
    engine.stop()
    input.removeTap(onBus: 0)
    builder.finish()
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
  emit(["type": "final", "text": text.trimmingCharacters(in: .whitespacesAndNewlines)])
}

func runRecognizer(engine: AVAudioEngine) async throws {
  guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(), recognizer.isAvailable,
    recognizer.supportsOnDeviceRecognition
  else { fail("unavailable", "on-device speech recognition is not available") }
  let request = SFSpeechAudioBufferRecognitionRequest()
  request.requiresOnDeviceRecognition = true
  request.shouldReportPartialResults = true
  let input = engine.inputNode
  input.installTap(onBus: 0, bufferSize: 2048, format: input.outputFormat(forBus: 0)) { buffer, _ in
    emit(["type": "level", "level": level(of: buffer)])
    request.append(buffer)
  }
  engine.prepare()
  try engine.start()
  emit(["type": "ready"])
  stop.onStop {
    engine.stop()
    input.removeTap(onBus: 0)
    request.endAudio()
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
  emit(["type": "final", "text": text.trimmingCharacters(in: .whitespacesAndNewlines)])
}

Task {
  guard await AVCaptureDevice.requestAccess(for: .audio) else { fail("micDenied", "microphone access is denied") }
  guard await authorizeSpeech() == .authorized else { fail("speechDenied", "speech recognition is denied") }
  let engine = AVAudioEngine()
  do {
    if #available(macOS 26.0, *), SpeechTranscriber.isAvailable {
      try await runAnalyzer(engine: engine)
    } else {
      try await runRecognizer(engine: engine)
    }
    exit(0)
  } catch {
    fail("failed", String(describing: error))
  }
}
dispatchMain()
