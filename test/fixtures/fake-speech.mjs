// A stand-in for native/speech (task 063), run by Electron as node in e2e (SNAPSOLVE_TEST_SPEECH). It speaks the
// helper's protocol: JSON lines on stdout; SIGINT (sent only after "ready") or stdin closing stops it, printing the
// final text.
//   FAKE_SPEECH_SCENARIO  ok (default): ready, then one word per 80 ms as partials with a level
//                         empty: ready, no words; the final text is ""
//                         denied: an error line, kind micDenied, exit 1
//                         crash: ready, then exit 3 after 200 ms with no final line
//   FAKE_SPEECH_TEXT      the words (default "why the product rule?")
const scenario = process.env.FAKE_SPEECH_SCENARIO ?? "ok";
const words = (process.env.FAKE_SPEECH_TEXT ?? "why the product rule?").split(" ");

const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

if (scenario === "denied") {
  say({ type: "error", kind: "micDenied", message: "microphone access is denied" });
  process.exit(1);
}

if (scenario === "crash") {
  say({ type: "ready" });
  setTimeout(() => process.exit(3), 200);
}

let heard = [];
let stopped = false;
function stop() {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  say({ type: "final", text: scenario === "empty" ? "" : words.join(" ") });
  process.exit(0);
}

if (scenario !== "crash") say({ type: "ready" });
const timer = setInterval(() => {
  if (scenario === "empty" || heard.length === words.length) {
    say({ type: "level", level: 0.05 });
    return;
  }
  heard = words.slice(0, heard.length + 1);
  say({ type: "level", level: 0.6 });
  say({ type: "partial", text: heard.join(" ") });
}, 80);

process.on("SIGINT", stop);
process.on("SIGTERM", () => process.exit(143));
process.stdin.on("end", stop);
process.stdin.resume();
