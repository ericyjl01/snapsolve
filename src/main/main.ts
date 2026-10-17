import path from "node:path";
import { app } from "electron";

// `electron dist/main.js` does not read package.json, so name and version are injected at build time.
app.setName(__APP_NAME__);

const dataDirOverride = process.env.SNAPSOLVE_DATA_DIR;
if (dataDirOverride) {
  app.setPath("userData", path.join(dataDirOverride, "electron"));
}

if (process.argv.includes("--smoke")) {
  void app.whenReady().then(() => {
    process.stdout.write(`snapsolve smoke ok ${__APP_VERSION__}\n`);
    app.exit(0);
  });
} else {
  // Windows, tray and hotkeys are wired in later tasks; until then the app idles once ready.
  void app.whenReady();
}
