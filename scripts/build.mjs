// Build: bundle main, preload and renderer with esbuild into dist/, copy static renderer files, type-check.
// Usage: node scripts/build.mjs
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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

const tsc = spawnSync("npx tsc --noEmit -p tsconfig.json", { cwd: root, stdio: "inherit", shell: true });
if (tsc.status !== 0) {
  console.error("build: type-check failed");
  process.exit(1);
}
console.log(`build: ok (${pkg.name} ${pkg.version})`);
