// Answer mode (task 089, SPEC Amendments 25 and 26): an answer chat's system prompt is prompts/answer.md, the answer
// format (the user's <data>/answer-format.md, else prompts/answer-format.md) and every text file in the knowledge folder
// (config.json `knowledgeDir`, else <data>/knowledge), which may be missing or empty: the model answers from its own
// knowledge too. The runner builds it again for every turn, so edits to the folder or the format count from the next
// question. Nothing here is logged: the files are the user's own material.
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
 * Every text file under `dir` (four folders down at most; hidden files and folders skipped). No such folder (or a
 * file in its place) and a folder with no text file are empty knowledge, not an error (Amendment 26). Rejects with
 * `knowledgeUnreadable` naming the folder, file or subfolder that cannot be read, and with `knowledgeTooLarge` naming
 * the folder when the text files add up to more than `maxBytes`.
 */
export async function readKnowledge(dir: string, options: { maxBytes?: number } = {}): Promise<Knowledge> {
  const maxBytes = options.maxBytes ?? KNOWLEDGE_MAX_BYTES;
  let top: Dirent[];
  try {
    top = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    const code = errorCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") return { dir, files: [], bytes: 0, skipped: [] };
    throw new SnapsolveError(
      "knowledgeUnreadable",
      `Answer mode can't read the knowledge folder ${dir} (${code ?? "unknown error"}). Check its permissions, or point knowledgeDir in config.json at another folder.`,
    );
  }
  const found: Found = { files: [], skipped: [], bytes: 0, maxBytes };
  await walk(dir, "", top, 0, found);
  found.files.sort((a, b) => compare(a.rel, b.rel));
  found.skipped.sort(compare);
  const files: KnowledgeFile[] = [];
  for (const f of found.files) {
    const full = path.join(dir, ...f.rel.split("/"));
    let text: string;
    try {
      text = await readFile(full, "utf8");
    } catch (e) {
      throw unreadable(full, e);
    }
    files.push({ path: f.rel, text: withoutBom(text) });
  }
  return { dir, files, bytes: found.bytes, skipped: found.skipped };
}

interface Found {
  files: { rel: string; size: number }[];
  skipped: string[];
  bytes: number;
  maxBytes: number;
}

/**
 * Collects text files in name order. Stops with `knowledgeTooLarge` as soon as they pass the limit, so a huge folder
 * (`knowledgeDir: "~"`) costs no more than the limit's worth of walking; an unreadable subfolder stops it with
 * `knowledgeUnreadable` naming that folder.
 */
async function walk(root: string, rel: string, entries: Dirent[], depth: number, found: Found): Promise<void> {
  for (const entry of [...entries].sort((a, b) => compare(a.name, b.name))) {
    if (entry.name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const full = path.join(root, ...childRel.split("/"));
    // stat follows symlinks; a broken one is skipped.
    const info = await stat(full).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      if (depth >= MAX_DEPTH) continue;
      let children: Dirent[];
      try {
        children = await readdir(full, { withFileTypes: true });
      } catch (e) {
        throw unreadable(full, e);
      }
      await walk(root, childRel, children, depth + 1, found);
    } else if (info.isFile()) {
      if (!KNOWLEDGE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
        found.skipped.push(childRel);
        continue;
      }
      found.files.push({ rel: childRel, size: info.size });
      found.bytes += info.size;
      if (found.bytes > found.maxBytes) {
        throw new SnapsolveError(
          "knowledgeTooLarge",
          `The knowledge folder ${root} has more than ${kb(found.maxBytes)} KB of text, answer mode's limit. Remove some files, or point knowledgeDir in config.json at a smaller folder.`,
        );
      }
    }
  }
}

function unreadable(file: string, e: unknown): SnapsolveError {
  return new SnapsolveError(
    "knowledgeUnreadable",
    `Answer mode can't read ${file} (${errorCode(e) ?? "unknown error"}). Check its permissions, or move it out of the knowledge folder.`,
  );
}

/** What `## Reference material` says when the knowledge folder has no text file (Amendment 26). */
const NO_MATERIAL = "None: the user's knowledge folder has no text files.";

/**
 * The answer chat's system prompt: the answer prompt, `## Answer format`, then `## Reference material` with each file.
 * With no file, that section says there is none and names any files of other types left unread (a PDF résumé), so
 * the answer can say they need saving as text.
 */
export function answerSystemPrompt(parts: { base: string; format: string; knowledge: Knowledge }): string {
  const { files, skipped } = parts.knowledge;
  const material =
    files.length > 0
      ? files.map((f) => `<file path="${escapeAttribute(f.path)}">\n${f.text.trimEnd()}\n</file>`).join("\n\n")
      : skipped.length > 0
        ? `${NO_MATERIAL}\n\nNot read (not text files): ${skipped.join(", ")}`
        : NO_MATERIAL;
  return `${[parts.base.trimEnd(), `## Answer format\n\n${parts.format.trim()}`, `## Reference material\n\n${material}`].join("\n\n")}\n`;
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
