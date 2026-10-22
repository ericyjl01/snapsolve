// Third-party files the renderer loads from dist/renderer/: KaTeX's stylesheet with its fonts (the CSS refers to
// `fonts/…` relative to itself) and the highlight.js themes, github for light and github-dark for dark (076). Used by
// scripts/build.mjs.
import { cpSync } from "node:fs";
import path from "node:path";

/** Copies the renderer assets from `<root>/node_modules` into `outDir`. */
export function copyRendererAssets(root, outDir) {
  const modules = path.join(root, "node_modules");
  cpSync(path.join(modules, "katex", "dist", "katex.min.css"), path.join(outDir, "katex.min.css"));
  cpSync(path.join(modules, "katex", "dist", "fonts"), path.join(outDir, "fonts"), { recursive: true });
  cpSync(path.join(modules, "highlight.js", "styles", "github.min.css"), path.join(outDir, "hljs-theme.css"));
  cpSync(path.join(modules, "highlight.js", "styles", "github-dark.min.css"), path.join(outDir, "hljs-theme-dark.css"));
}
