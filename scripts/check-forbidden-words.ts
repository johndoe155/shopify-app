#!/usr/bin/env tsx
/**
 * Fails the build if "certified", "approved" or "guaranteed" (or their close
 * variants) appear in any user-facing string. The negated claims wording that
 * the brief requires is allow-listed in app/domain/copy.ts.
 *
 *   npm run check:words
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { findForbiddenWords } from "../app/domain/copy";

const ROOT = new URL("..", import.meta.url).pathname;
const TARGETS: Array<[string, string[]]> = [
  ["app", [".ts", ".tsx"]],
  ["extensions", [".liquid", ".json", ".css"]],
  ["listing", [".md", ".txt", ".html"]],
];
// These files legitimately contain the words: the detector itself, and the copy
// module where the allow-list is defined.
const SKIP = new Set(["app/domain/copy.ts"]);

function walk(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path, extensions));
      continue;
    }
    if (extensions.some((extension) => entry.endsWith(extension))) out.push(path);
  }
  return out;
}

const files = TARGETS.flatMap(([dir, extensions]) => walk(join(ROOT, dir), extensions));
let failures = 0;

for (const file of files) {
  const relativePath = relative(ROOT, file);
  if (SKIP.has(relativePath)) continue;
  const text = readFileSync(file, "utf8");
  for (const hit of findForbiddenWords(text)) {
    failures += 1;
    console.error(`${relativePath}:${hit.line}  forbidden word "${hit.word}"\n    ${hit.snippet}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} forbidden word(s) found in user-facing strings.`);
  process.exit(1);
}

console.log(`Checked ${files.length} files: no forbidden words in user-facing strings.`);
