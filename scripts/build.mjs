// Build: bundle main, preload and renderer with esbuild into dist/, copy static renderer files, compile the speech
// helper on macOS (task 063), type-check.
// Usage: node scripts/build.mjs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { copyRendererAssets } from "./renderer-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const define = {
  __APP_NAME__: JSON.stringify(pkg.name),
  __APP_VERSION__: JSON.stringify(pkg.version),
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(path.join(dist, "renderer"), { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: "warning", define };

await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(root, "src/main/main.ts")],
    outfile: path.join(dist, "main.js"),
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: [path.join(root, "src/preload/preload.ts")],
    outfile: path.join(dist, "preload.js"),
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: [path.join(root, "src/renderer/renderer.ts")],
    outfile: path.join(dist, "renderer", "renderer.js"),
    platform: "browser",
    format: "iife",
    target: "chrome140",
  }),
]);

for (const file of ["index.html", "styles.css"]) {
  cpSync(path.join(root, "src/renderer", file), path.join(dist, "renderer", file));
}
copyRendererAssets(root, path.join(dist, "renderer"));
buildSpeechHelper();

const tsc = spawnSync("npx tsc --noEmit -p tsconfig.json", { cwd: root, stdio: "inherit", shell: true });
if (tsc.status !== 0) {
  console.error("build: type-check failed");
  process.exit(1);
}
console.log(`build: ok (${pkg.name} ${pkg.version})`);

/**
 * native/speech → dist/native/snapsolve-speech (macOS, `swiftc` from the Command Line Tools), with its Info.plist linked
 * in. The binary is cached in node_modules/.cache by a hash of its sources, so an unchanged helper is not recompiled.
 * No swiftc: a warning, and voice says it is unavailable.
 */
function buildSpeechHelper() {
  if (process.platform !== "darwin") return;
  const src = path.join(root, "native", "speech");
  const sources = ["main.swift", "Info.plist"].map((f) => path.join(src, f));
  const hash = createHash("sha256");
  for (const f of sources) hash.update(readFileSync(f));
  const cached = path.join(root, "node_modules", ".cache", "snapsolve-speech", hash.digest("hex").slice(0, 16), "snapsolve-speech");
  if (!existsSync(cached)) {
    mkdirSync(path.dirname(cached), { recursive: true });
    const args = ["-O", "-swift-version", "5", sources[0], "-o", cached, "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT"];
    const swiftc = spawnSync("swiftc", [...args, "-Xlinker", "__info_plist", "-Xlinker", sources[1]], { stdio: "inherit" });
    if (swiftc.error || swiftc.status !== 0) {
      rmSync(cached, { force: true });
      console.warn(`build: speech helper not built (${swiftc.error?.code ?? `swiftc exit ${swiftc.status}`}); voice will be unavailable`);
      return;
    }
  }
  const out = path.join(dist, "native", "snapsolve-speech");
  mkdirSync(path.dirname(out), { recursive: true });
  cpSync(cached, out);
  chmodSync(out, 0o755);
}
