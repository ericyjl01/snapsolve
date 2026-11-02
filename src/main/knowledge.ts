// Answer mode (task 089, SPEC Amendment 25): an answer chat's system prompt is prompts/answer.md, the answer format (the
// user's <data>/answer-format.md, else prompts/answer-format.md) and every text file in the knowledge folder
// (config.json `knowledgeDir`, else <data>/knowledge). The runner builds it again for every turn, so edits to the
// folder or the format count from the next question. Nothing here is logged: the files are the user's own material.
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { SnapsolveError } from "../shared/errors";

/** Text read from the knowledge folder, at most: about 64k tokens, and well inside macOS's 1 MB argument limit. */
export const KNOWLEDGE_MAX_BYTES = 256 * 1024;
/** The file types read (case-insensitive). Anything else (PDF, Word, images) is listed as skipped. */
export const KNOWLEDGE_EXTENSIONS: readonly string[] = [".md", ".markdown", ".txt", ".toml", ".json", ".yaml", ".yml", ".csv", ".tsv"];
/** Folders below the knowledge folder that are still read. */
const MAX_DEPTH = 4;

export interface KnowledgeFile {
  /** Relative to the knowledge folder, with `/` separators. */
  path: string;
  text: string;
}

export interface Knowledge {
  dir: string;
  /** In path order. */
  files: KnowledgeFile[];
  /** Bytes on disk of the files read. */
  bytes: number;
  /** Files of other types, by relative path: not read. */
  skipped: string[];
}

/**
 * Every text file under `dir` (four folders down at most; hidden files and folders skipped). Rejects with
 * `knowledgeMissing` when there is no such folder, it cannot be read, or it holds no text file, and with
 * `knowledgeTooLarge` when the text files add up to more than `maxBytes`; either message names the folder.
 */
export async function readKnowledge(dir: string, options: { maxBytes?: number } = {}): Promise<Knowledge> {
  const maxBytes = options.maxBytes ?? KNOWLEDGE_MAX_BYTES;
  let top: Dirent[];
  try {
    top = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    const code = errorCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") throw new SnapsolveError("knowledgeMissing", missing(dir));
    throw new SnapsolveError(
      "knowledgeMissing",
      `Answer mode can't read the knowledge folder ${dir} (${code ?? "unknown error"}). Check its permissions, or point knowledgeDir in config.json at another folder.`,
    );
  }
  const found = { files: [] as { rel: string; size: number }[], skipped: [] as string[] };
  await walk(dir, "", top, 0, found);
  if (found.files.length === 0) throw new SnapsolveError("knowledgeMissing", missing(dir));
  found.files.sort((a, b) => compare(a.rel, b.rel));
  found.skipped.sort(compare);
  const bytes = found.files.reduce((sum, f) => sum + f.size, 0);
  if (bytes > maxBytes) {
    throw new SnapsolveError(
      "knowledgeTooLarge",
      `The knowledge folder ${dir} holds ${kb(bytes)} KB of text, over answer mode's ${kb(maxBytes)} KB limit. Remove some files, or point knowledgeDir in config.json at a smaller folder.`,
    );
  }
  const files: KnowledgeFile[] = [];
  for (const f of found.files) {
    files.push({ path: f.rel, text: withoutBom(await readFile(path.join(dir, ...f.rel.split("/")), "utf8")) });
  }
  return { dir, files, bytes, skipped: found.skipped };
}

async function walk(
  root: string,
  rel: string,
  entries: Dirent[],
  depth: number,
  found: { files: { rel: string; size: number }[]; skipped: string[] },
): Promise<void> {
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const full = path.join(root, ...childRel.split("/"));
    // stat follows symlinks; a broken one is skipped.
    const info = await stat(full).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      if (depth >= MAX_DEPTH) continue;
      const children = await readdir(full, { withFileTypes: true }).catch(() => null);
      if (children) await walk(root, childRel, children, depth + 1, found);
    } else if (info.isFile()) {
      if (KNOWLEDGE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) found.files.push({ rel: childRel, size: info.size });
      else found.skipped.push(childRel);
    }
  }
}

/** The answer chat's system prompt: the answer prompt, `## Answer format`, then `## Reference material` with each file. */
export function answerSystemPrompt(parts: { base: string; format: string; knowledge: Knowledge }): string {
  const files = parts.knowledge.files.map((f) => `<file path="${escapeAttribute(f.path)}">\n${f.text.trimEnd()}\n</file>`);
  return `${[parts.base.trimEnd(), `## Answer format\n\n${parts.format.trim()}`, `## Reference material\n\n${files.join("\n\n")}`].join("\n\n")}\n`;
}

/** The user's answer format when `userFile` exists and is not blank (a BOM dropped); otherwise `builtIn`. */
export async function readAnswerFormat(userFile: string, builtIn: string): Promise<string> {
  try {
    const text = withoutBom(await readFile(userFile, "utf8"));
    return text.trim() === "" ? builtIn : text;
  } catch {
    return builtIn;
  }
}

/** config.json `knowledgeDir` as a folder: null → `fallback` (<data>/knowledge); `~` and `~/…` → under `home`. */
export function knowledgeFolder(configured: string | null, fallback: string, home: string): string {
  if (configured === null) return fallback;
  if (configured === "~") return home;
  if (configured.startsWith("~/")) return path.join(home, ...configured.slice(2).split("/"));
  return configured;
}

function missing(dir: string): string {
  return `Answer mode has nothing to draw on: no .md, .txt, .toml, .json, .yaml or .csv files in ${dir}. Put your material there, or point knowledgeDir in config.json at your folder.`;
}

/** Whole KB, rounded up, so text just over the limit never reads as equal to it. */
function kb(bytes: number): number {
  return Math.ceil(bytes / 1024);
}

/** Code-unit order: the same on every machine, whatever its locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function withoutBom(text: string): string {
  return text.replace(/^﻿/, "");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function errorCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}
