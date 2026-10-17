import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { resolveDataDir } from "./paths";

// `electron dist/main.js` does not read package.json, so name and version are injected at build time.
app.setName(__APP_NAME__);

// Electron's own files (caches, Local State) live in <data>/electron, never in Roaming %APPDATA% (SPEC §5.1).
// Must run before `ready`. An unresolvable data dir keeps Electron's default; the app reports it once wired.
try {
  app.setPath("userData", path.join(resolveDataDir(process.platform, process.env, os.homedir()), "electron"));
} catch (e) {
  process.stderr.write(`snapsolve: ${e instanceof Error ? e.message : String(e)}\n`);
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
