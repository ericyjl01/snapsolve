// Answer Markdown → sanitized HTML (SPEC §4.4): markdown-it without raw HTML, KaTeX math as HTML, highlight.js for
// known languages, then DOMPurify on the final HTML, so text injected via the screen cannot load, link to or run
// anything (no images, only http(s) links). KaTeX's own SVG (`svg` + `path`) survives (SPEC Amendment 1).
import markdownItKatex from "@vscode/markdown-it-katex";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import katex from "katex";
import MarkdownIt from "markdown-it";

const KATEX_OPTIONS = { output: "html", trust: false, throwOnError: false, maxExpand: 1000, maxSize: 50 } as const;

const SVG_NS = "http://www.w3.org/2000/svg";
/** The SVG elements KaTeX draws with and the attributes it writes on them, lowercased as DOMPurify reports them. */
const KATEX_SVG = new Map([
  ["svg", new Set(["xmlns", "width", "height", "viewbox", "preserveaspectratio", "style"])],
  ["path", new Set(["d", "style"])],
]);

const PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["img", "math", "iframe", "form", "input", "style"],
  ADD_TAGS: ["svg", "path"],
  ADD_ATTR: ["viewBox", "preserveAspectRatio", "d"],
  // Not URIs: without this, ALLOWED_URI_REGEXP strips KaTeX's geometry values.
  ADD_URI_SAFE_ATTR: ["width", "height", "viewBox", "preserveAspectRatio", "d"],
  ALLOWED_URI_REGEXP: /^https?:/,
};

const purify = DOMPurify();
// Any other SVG element goes with its content (an SVG <a> is otherwise allowed, and <use>/<foreignObject> would hoist theirs).
purify.addHook("uponSanitizeElement", (node) => {
  const el = node as Element;
  if (el.namespaceURI === SVG_NS && !KATEX_SVG.has(el.localName)) el.remove();
});
purify.addHook("uponSanitizeAttribute", (el, event) => {
  if (el.namespaceURI === SVG_NS && !KATEX_SVG.get(el.localName)?.has(event.attrName)) event.keepAttr = false;
});

const md = new MarkdownIt({ html: false, linkify: false, highlight });
md.use(markdownItKatex, { katex, ...KATEX_OPTIONS });

/** Safe to assign to `innerHTML`; tolerates partial (still streaming) input. */
export function renderAnswer(markdown: string): string {
  return sanitize(md.render(markdown));
}

/** The renderer's one sanitizer: SPEC §4.4 plus KaTeX's `svg`/`path` with only KaTeX's attributes. */
export function sanitize(html: string): string {
  return purify.sanitize(html, PURIFY);
}

/**
 * Highlighted `<pre><code>` for a language highlight.js knows; "" lets markdown-it escape the code as plain text.
 * Only a registered name or alias reaches the class attribute, so it needs no escaping.
 */
function highlight(code: string, lang: string): string {
  const language = lang.trim().toLowerCase();
  if (!language || !hljs.getLanguage(language)) return "";
  const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  return `<pre><code class="hljs language-${language}">${html}</code></pre>`;
}
