// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import katex from "katex";
import { describe, expect, it } from "vitest";
import { copyRendererAssets } from "../../scripts/renderer-assets.mjs";
import { renderAnswer, sanitize } from "../../src/renderer/render";
import { repoRoot } from "../paths";

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_ATTRS = ["xmlns", "width", "height", "viewBox", "preserveAspectRatio", "style"];
/** Every KaTeX command family that draws with SVG (measured on KaTeX 0.19 in task 017). */
const SVG_COMMANDS = String.raw`\sqrt{2}|\sqrt[3]{x}|\overrightarrow{AB}|\overleftarrow{AB}|\overleftrightarrow{AB}|\Overrightarrow{AB}|\overleftharpoon{AB}|\xrightarrow{f}|\xleftarrow[a]{b}|\xRightarrow{x}|\xhookrightarrow{x}|\xtofrom{x}|\widehat{xyz}|\widetilde{xyz}|\widecheck{xyz}|\utilde{AB}|\overbrace{abc}^{n}|\underbrace{abc}_{n}|\overgroup{AB}|\undergroup{AB}|\overlinesegment{AB}|\underlinesegment{AB}|\vec{v}|\phase{x}`.split("|");

/** KaTeX's own SVG for `tex`, unsanitized, as the reference for what the renderer must keep. */
function katexSvgs(tex: string): Element[] {
  const raw = document.createElement("div");
  raw.innerHTML = katex.renderToString(tex, { output: "html", trust: false, throwOnError: false, maxExpand: 1000, maxSize: 50 });
  return [...raw.querySelectorAll("svg")];
}

function attrs(el: Element): Record<string, string> {
  return Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
}

function dom(markdown: string): HTMLDivElement {
  const el = document.createElement("div");
  el.innerHTML = renderAnswer(markdown);
  return el;
}

/** Every `<n>em` length inside a style attribute. */
function emLengths(el: Element): number[] {
  return [...el.querySelectorAll("[style]")].flatMap((n) =>
    [...(n.getAttribute("style") ?? "").matchAll(/(-?\d+(?:\.\d+)?)em/g)].map((m) => Math.abs(Number(m[1]))),
  );
}

describe("renderAnswer: math", () => {
  it("inline $x^2$ → a .katex element, HTML output only (no <math>)", () => {
    const el = dom("The square is $x^2$ here.");
    expect(el.querySelector(".katex")).not.toBeNull();
    expect(el.querySelector(".katex .msupsub")).not.toBeNull();
    expect(el.querySelector("math")).toBeNull();
    expect(el.querySelector(".katex-mathml")).toBeNull();
  });

  it("block $$\\frac{a}{b}$$ → display math with a fraction, no <math>", () => {
    const el = dom("$$\\frac{a}{b}$$");
    expect(el.querySelector(".katex-display .katex")).not.toBeNull();
    expect(el.querySelector(".mfrac")).not.toBeNull();
    expect(el.querySelector("math")).toBeNull();
  });

  it("TeX \\href{javascript:…}{x} and \\url{…} are not rendered as links (trust false)", () => {
    const html = renderAnswer("$\\href{javascript:alert(1)}{x}$ and $\\url{https://example.com}$");
    const el = document.createElement("div");
    el.innerHTML = html;
    expect(el.querySelector("a")).toBeNull();
    expect(html).not.toMatch(/href\s*=\s*["']?javascript:/i);
  });

  it("a macro bomb returns within 1 s with error styling, no throw", () => {
    const started = Date.now();
    const el = dom("$\\def\\a{\\a\\a}\\a$");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(el.querySelector(".katex-error")).not.toBeNull();
  });

  it("\\rule{1000em}{1000em} → sizes capped at 50em", () => {
    const el = dom("$\\rule{1000em}{1000em}$");
    expect(el.querySelector(".katex .katex-rule")).not.toBeNull();
    expect(el.querySelector(".katex-error")).toBeNull();
    const lengths = emLengths(el);
    expect(lengths.length).toBeGreaterThan(0);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(50);
  });
});

describe("renderAnswer: KaTeX SVG (SPEC Amendment 1)", () => {
  it("$\\sqrt{2}$ keeps its radical: svg > path with KaTeX's own width, height, viewBox, preserveAspectRatio and d", () => {
    const [ref] = katexSvgs("\\sqrt{2}");
    const svg = dom("$\\sqrt{2}$").querySelector(".katex svg");
    expect(svg).not.toBeNull();
    expect(svg?.namespaceURI).toBe(SVG_NS);
    for (const name of ["width", "height", "viewBox", "preserveAspectRatio"]) {
      expect(svg?.getAttribute(name), name).toBe(ref.getAttribute(name));
      expect(svg?.getAttribute(name), name).toBeTruthy();
    }
    const d = svg?.querySelector("path")?.getAttribute("d");
    expect(d).toBe(ref.querySelector("path")?.getAttribute("d"));
    expect(d?.length).toBeGreaterThan(20);
  });

  it.each(["\\overrightarrow{AB}", "\\xrightarrow{f}", "\\widehat{xyz}", "\\overbrace{abc}", "\\vec{v}"])("%s keeps an svg with its path", (tex) => {
    const paths = dom(`$${tex}$`).querySelectorAll(".katex svg > path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.length).toBe(katexSvgs(tex).flatMap((s) => [...s.querySelectorAll("path")]).length);
  });

  it("every SVG-drawing command: the same svg and path elements and attributes as KaTeX's output, nothing else", () => {
    const el = dom(SVG_COMMANDS.map((tex) => `$${tex}$`).join(" "));
    const ref = SVG_COMMANDS.flatMap(katexSvgs);
    const svgs = [...el.querySelectorAll("svg")];
    expect(svgs).toHaveLength(ref.length);
    svgs.forEach((svg, i) => {
      expect(attrs(svg)).toEqual(attrs(ref[i]));
      expect(Object.keys(attrs(svg)).every((name) => SVG_ATTRS.includes(name)), JSON.stringify(attrs(svg))).toBe(true);
      expect([...svg.querySelectorAll("*")].map((n) => n.localName)).toEqual([...ref[i].querySelectorAll("*")].map((n) => n.localName));
      for (const path of svg.querySelectorAll("path")) expect(Object.keys(attrs(path))).toEqual(["d"]);
    });
    const svgElements = [...el.querySelectorAll("*")].filter((n) => n.namespaceURI === SVG_NS);
    expect(new Set(svgElements.map((n) => n.localName))).toEqual(new Set(["svg", "path"]));
  });

  it("\\cancel{x} renders x without its strike: KaTeX's <line> stays out", () => {
    const el = dom("$\\cancel{x}$");
    expect(el.querySelector(".katex-error")).toBeNull();
    expect(el.querySelector(".katex")?.textContent).toContain("x");
    expect(katexSvgs("\\cancel{x}")[0]?.querySelector("line")).not.toBeNull();
    expect([...el.querySelectorAll("*")].some((n) => n.localName === "line")).toBe(false);
  });

  it("the sanitizer on hostile SVG keeps only svg and path with safe attributes", () => {
    const hostile =
      `<svg xmlns="${SVG_NS}" onload="alert(1)" width="1em" viewBox="0 0 10 10">` +
      '<path d="M0 0L10 10" onclick="alert(2)"/>' +
      "<script>alert(3)</script>" +
      '<use href="#x"/><use xlink:href="https://evil.example/s.svg#x"/>' +
      '<foreignObject><img src="https://evil.example/f.png"></foreignObject>' +
      '<animate attributeName="href" to="javascript:alert(4)"/>' +
      '<set attributeName="onmouseover" to="alert(5)"/>' +
      '<image href="https://evil.example/i.png"/>' +
      '<a href="javascript:alert(6)"><text>t</text></a>' +
      '<a href="https://evil.example/"><path d="M1 1"/></a>' +
      "<style>*{}</style>" +
      "</svg>";
    const html = sanitize(hostile);
    const el = document.createElement("div");
    el.innerHTML = html;
    expect([...el.querySelectorAll("*")].map((n) => n.localName)).toEqual(["svg", "path"]);
    const svg = el.querySelector("svg");
    expect(attrs(svg as Element)).toEqual({ xmlns: SVG_NS, width: "1em", viewBox: "0 0 10 10" });
    expect(attrs(el.querySelector("path") as Element)).toEqual({ d: "M0 0L10 10" });
    expect(html).not.toMatch(/javascript:|alert\(|evil\.example|on[a-z]+=/i);
  });

  it("the sanitizer keeps only KaTeX's attributes on svg and path (class, id, fill, transform dropped)", () => {
    const el = document.createElement("div");
    el.innerHTML = sanitize(
      `<svg xmlns="${SVG_NS}" class="x" id="y" fill="red" height="2em" preserveAspectRatio="none" style="width:1em">` +
        '<path d="M0 0" class="p" fill="red" transform="scale(9)" style="opacity:1"/></svg>' +
        '<span class="katex" style="top:1em">ok</span>',
    );
    expect(attrs(el.querySelector("svg") as Element)).toEqual({ xmlns: SVG_NS, height: "2em", preserveAspectRatio: "none", style: "width:1em" });
    expect(attrs(el.querySelector("path") as Element)).toEqual({ d: "M0 0", style: "opacity:1" });
    expect(attrs(el.querySelector("span") as Element)).toEqual({ class: "katex", style: "top:1em" });
  });
});

describe("renderAnswer: code", () => {
  it("a fenced python block → highlight.js classes", () => {
    const el = dom("```python\ndef f(x):\n    return x + 1\n```");
    const code = el.querySelector("pre code.hljs");
    expect(code).not.toBeNull();
    expect(code?.querySelector(".hljs-keyword")?.textContent).toBe("def");
  });

  it("an unknown language → escaped plain code, no highlighting, no throw", () => {
    const el = dom("```nosuchlang\n<b>bold?</b> & more\n```");
    const code = el.querySelector("pre code");
    expect(code?.textContent).toBe("<b>bold?</b> & more\n");
    expect(code?.querySelector("b")).toBeNull();
    expect(code?.querySelector("[class^='hljs-']")).toBeNull();
  });
});

describe("renderAnswer: injection from the screen", () => {
  it("an image → no <img> and no evil.example source", () => {
    const html = renderAnswer("![x](https://evil.example/?q=secret)");
    const el = document.createElement("div");
    el.innerHTML = html;
    expect(el.querySelector("img")).toBeNull();
    expect(html).not.toContain("evil.example");
  });

  it("raw <script> → escaped text, no script element", () => {
    const el = dom("before <script>alert(1)</script> after");
    expect(el.querySelector("script")).toBeNull();
    expect(el.textContent).toContain("<script>alert(1)</script>");
  });

  it("raw <iframe>, <svg> and <style> stay text", () => {
    const el = dom('<iframe src="https://x.example"></iframe><svg onload="alert(1)"></svg><style>*{}</style>');
    expect(el.querySelector("iframe, svg, style")).toBeNull();
  });

  it("[x](javascript:…) → no javascript: href; [ok](https://example.com) keeps its https anchor", () => {
    const el = dom("[x](javascript:alert(1)) and [ok](https://example.com)");
    const hrefs = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://example.com"]);
    expect(el.innerHTML).not.toMatch(/href="javascript:/i);
  });

  it("only http(s) links survive: data:, file:, mailto:, ftp: and relative hrefs are dropped", () => {
    const el = dom("[d](data:text/html,hi) [f](file:///C:/x) [m](mailto:x@example.com) [p](ftp://example.com/f) [r](/relative) [h](http://example.com/a)");
    expect([...el.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"))).toEqual(["http://example.com/a"]);
  });
});

describe("renderAnswer: partial streaming input", () => {
  it("an unclosed $$ renders without throwing", () => {
    expect(() => renderAnswer("Step 1:\n\n$$\\frac{1}{")).not.toThrow();
    expect(renderAnswer("Step 1:\n\n$$\\frac{1}{")).toContain("Step 1:");
  });

  it("an unclosed fence renders the code so far without throwing", () => {
    const el = dom("Here:\n\n```python\ndef f(");
    expect(el.querySelector("pre code")?.textContent).toContain("def f(");
  });

  it("an empty answer renders to an empty string", () => {
    expect(renderAnswer("")).toBe("");
  });
});

describe("renderer assets copied by the build", () => {
  it("copies the KaTeX CSS with its fonts and the highlight.js theme", async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), "snapsolve-assets-"));
    try {
      copyRendererAssets(repoRoot, out);
      const css = readFileSync(path.join(out, "katex.min.css"), "utf8");
      const fonts = readdirSync(path.join(out, "fonts"));
      expect(fonts.filter((f) => f.endsWith(".woff2")).length).toBeGreaterThan(10);
      for (const ref of css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)) {
        expect(existsSync(path.join(out, ref[1])), ref[1]).toBe(true);
      }
      expect(readFileSync(path.join(out, "hljs-theme.css"), "utf8")).toContain(".hljs");
      // 076: github-dark beside github light, for the dark theme's code blocks.
      expect(readFileSync(path.join(out, "hljs-theme-dark.css"), "utf8")).toContain("#0d1117");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
