#!/usr/bin/env node
// Generates docs/decisions-adr/README.md from every ADR file's front matter,
// so a reader sees every decision's status and amendment graph without
// opening each file. Read-only over the ADR files themselves: the README it
// writes is the only file this script ever changes.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE_RE = /^(\d{4})-.+\.md$/;
const ADR_MENTION_RE = /ADR-(\d{4})/g;
const TRIGGER_RE = /\b(?:amends|amending|supersedes)\b/i;
// Matches a front-matter field line in either shape this repo uses:
// "- **Status:** Accepted" (bulleted, bold) or "Status: Accepted" (plain).
const FIELD_LINE_RE = /^\s*-?\s*\*{0,2}(Status|Date|Owner|Amends|Supersedes):\*{0,2}/i;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = join(SCRIPT_DIR, "..", "docs", "decisions-adr");

export class DuplicateAdrNumberError extends Error {
  /**
   * @param {string} number the shared four-digit ADR number
   * @param {string[]} files the filenames that collide on it
   */
  constructor(number, files) {
    super(`duplicate ADR number ${number}: ${files.join(", ")}`);
    this.number = number;
    this.files = files;
  }
}

/**
 * The value of a front-matter field, joining any indented continuation
 * lines until a blank line, a heading, or the next field. Matches both the
 * bulleted-bold and the plain front-matter shape.
 * @param {string} content full file content
 * @param {string} name field name, e.g. "Status" or "Amends"
 * @returns {string} the field's value, or "" if the field is absent
 */
function fieldValue(content, name) {
  const lines = content.split("\n");
  const startRe = new RegExp(`^\\s*-?\\s*\\*{0,2}${name}:\\*{0,2}\\s*(.*)$`, "i");
  for (let i = 0; i < lines.length; i++) {
    const m = startRe.exec(lines[i]);
    if (!m) continue;
    const parts = [m[1]];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "" || line.startsWith("#") || FIELD_LINE_RE.test(line)) break;
      parts.push(line.trim());
    }
    return parts.join(" ").trim();
  }
  return "";
}

/**
 * The first prose paragraph of the file: the title and the front-matter
 * block (in either shape) are skipped, then text is collected up to the
 * next blank line or heading.
 * @param {string} content full file content
 * @returns {string}
 */
function firstParagraph(content) {
  const lines = content.split("\n").slice(1); // skip the title line
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.startsWith("#")) {
      i++;
      continue;
    }
    if (FIELD_LINE_RE.test(line)) {
      i++;
      while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("#") && !FIELD_LINE_RE.test(lines[i])) {
        i++;
      }
      continue;
    }
    break;
  }
  const para = [];
  while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("#")) {
    para.push(lines[i]);
    i++;
  }
  return para.join(" ").trim();
}

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+/;
// A trigger word whose subject is another, explicitly named ADR (e.g. "ADR-0025
// amends only ADR-0004") describes that other ADR's amendment, not this file's;
// such a sentence is skipped rather than misread as this file amending ADR-0004.
const NAMED_SUBJECT_RE = /ADR-\d{4}\s*$/i;

/**
 * Every ADR-NNNN mention that follows "amends", "amending" or "supersedes"
 * within the sentence that contains the trigger word — never a later
 * sentence — and only when that sentence's subject is this file, not
 * another ADR named just before the trigger word.
 * @param {string} text
 * @returns {string[]} four-digit ADR numbers, in the order they appear
 */
function adrMentionsFromText(text) {
  const mentions = [];
  for (const sentence of text.split(SENTENCE_SPLIT_RE)) {
    const m = TRIGGER_RE.exec(sentence);
    if (!m) continue;
    const before = sentence.slice(0, m.index);
    if (NAMED_SUBJECT_RE.test(before.trim())) continue;
    const after = sentence.slice(m.index + m[0].length);
    for (const mm of after.matchAll(ADR_MENTION_RE)) mentions.push(mm[1]);
  }
  return mentions;
}

/**
 * Parses one ADR file's front matter and amendment mentions.
 * @param {string} filename e.g. "0013-delta-pushes.md"
 * @param {string} content the file's full content
 * @returns {{number: string, filename: string, title: string, status: string, date: string, amends: string[]} | null}
 *   null when the filename does not match the `NNNN-*.md` pattern
 */
export function parseAdrFile(filename, content) {
  const fileMatch = FILE_RE.exec(filename);
  if (!fileMatch) return null;
  const number = fileMatch[1];

  const firstLine = content.split("\n", 1)[0];
  const dashIndex = firstLine.indexOf("—");
  const title = dashIndex === -1 ? firstLine.replace(/^#\s*/, "").trim() : firstLine.slice(dashIndex + 1).trim();

  const statusRaw = fieldValue(content, "Status");
  const status = statusRaw ? statusRaw.replace(/\s+/g, " ").trim() : "unknown";
  const date = fieldValue(content, "Date");

  const amends = new Set();
  for (const m of fieldValue(content, "Amends").matchAll(ADR_MENTION_RE)) amends.add(m[1]);
  for (const n of adrMentionsFromText(firstLine)) amends.add(n);
  for (const n of adrMentionsFromText(firstParagraph(content))) amends.add(n);
  amends.delete(number);

  return { number, filename, title, status, date, amends: [...amends] };
}

/**
 * Reads and parses every ADR file in a directory, filling `amendedBy` as
 * the inverse of `amends` across all of them.
 * @param {string} dir directory holding `NNNN-*.md` ADR files
 * @returns {Array<{number: string, filename: string, title: string, status: string, date: string, amends: string[], amendedBy: string[]}>}
 *   sorted by number, ascending
 * @throws {DuplicateAdrNumberError} when two files share a number
 */
export function readAdrEntries(dir) {
  const filenames = readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort();

  const byNumber = new Map();
  for (const filename of filenames) {
    const number = FILE_RE.exec(filename)[1];
    const existing = byNumber.get(number);
    if (existing) throw new DuplicateAdrNumberError(number, [existing.filename, filename]);
    const content = readFileSync(join(dir, filename), "utf8");
    const parsed = parseAdrFile(filename, content);
    byNumber.set(number, { ...parsed, amends: new Set(parsed.amends), amendedBy: new Set() });
  }

  for (const entry of byNumber.values()) {
    for (const n of entry.amends) {
      byNumber.get(n)?.amendedBy.add(entry.number);
    }
  }

  return [...byNumber.values()]
    .map((e) => ({ ...e, amends: [...e.amends].sort(), amendedBy: [...e.amendedBy].sort() }))
    .sort((a, b) => a.number.localeCompare(b.number));
}

function cell(s) {
  return String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

/**
 * Renders the `docs/decisions-adr/README.md` content for a set of entries.
 * @param {ReturnType<typeof readAdrEntries>} entries
 * @returns {string}
 */
export function renderReadme(entries) {
  const byNumber = new Map(entries.map((e) => [e.number, e]));
  const link = (number) => {
    const entry = byNumber.get(number);
    return entry ? `[${number}](${entry.filename})` : number;
  };

  const header =
    "# Decisions\n\n" +
    "Generated by `node scripts/adr-index.mjs`; do not edit by hand. " +
    "Accepted ADRs are never edited; a change supersedes or amends them with a new number.\n\n";
  const tableHeader = "| ADR | Title | Status | Date | Amends | Amended by |\n|---|---|---|---|---|---|\n";
  const rows = entries.map((e) => {
    const amends = e.amends.map(link).join(", ");
    const amendedBy = e.amendedBy.map(link).join(", ");
    return `| ${link(e.number)} | ${cell(e.title)} | ${cell(e.status)} | ${cell(e.date)} | ${amends} | ${amendedBy} |`;
  });

  return header + tableHeader + rows.join("\n") + "\n";
}

/**
 * @param {string[]} argv arguments after the script name, e.g. ["--check"]
 * @param {{dir?: string, readmePath?: string}} [opts] injection points for tests
 * @returns {number} process exit code
 */
export function run(argv, opts = {}) {
  const dir = opts.dir ?? DEFAULT_DIR;
  const readmePath = opts.readmePath ?? join(dir, "README.md");
  const check = argv.includes("--check");

  let entries;
  try {
    entries = readAdrEntries(dir);
  } catch (err) {
    if (err instanceof DuplicateAdrNumberError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }

  const content = renderReadme(entries);

  if (check) {
    const existing = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : null;
    if (existing !== content) {
      console.error("docs/decisions-adr/README.md is stale; run node scripts/adr-index.mjs");
      return 1;
    }
    return 0;
  }

  writeFileSync(readmePath, content);
  console.log(`docs/decisions-adr/README.md written: ${entries.length} ADRs`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run(process.argv.slice(2)));
}
