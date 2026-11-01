/**
 * Brief section 10 / checklist item 11: no user-facing string may contain
 * "certified", "approved" or "guaranteed" (or their close variants), except in
 * the negated claims wording that the brief requires.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAIMS, DISCLAIMER, FORBIDDEN_WORDS, findForbiddenWords } from "~/domain/copy";

const ROOT = new URL("..", import.meta.url).pathname;

function walk(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path, extensions));
      continue;
    }
    if (extensions.some((extension) => entry.endsWith(extension))) out.push(path);
  }
  return out;
}

describe("forbidden words detector", () => {
  it("finds each forbidden word", () => {
    for (const word of FORBIDDEN_WORDS) {
      expect(findForbiddenWords(`This product is ${word}.`).length).toBeGreaterThan(0);
    }
  });

  it("ignores the required negated claims wording", () => {
    expect(findForbiddenWords(CLAIMS)).toEqual([]);
    expect(findForbiddenWords(DISCLAIMER)).toEqual([]);
    expect(findForbiddenWords("It does not guarantee compliance and it is not legal advice.")).toEqual([]);
  });

  it("still catches a positive claim next to a negated one", () => {
    const text = `${CLAIMS} This store is certified.`;
    expect(findForbiddenWords(text).length).toBeGreaterThan(0);
  });

  it("is case insensitive", () => {
    expect(findForbiddenWords("APPROVED by legal").length).toBeGreaterThan(0);
  });
});

describe("the codebase", () => {
  const files = [
    ...walk(join(ROOT, "app"), [".ts", ".tsx"]),
    ...walk(join(ROOT, "extensions"), [".liquid", ".json", ".css"]),
    ...walk(join(ROOT, "listing"), [".md", ".txt", ".html"]),
  ];

  it("has files to scan", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("contains no forbidden words in user-facing strings", () => {
    const offenders: Array<{ file: string; word: string; snippet: string }> = [];
    for (const file of files) {
      const relativePath = relative(ROOT, file);
      // This test file and the detector itself necessarily contain the words.
      if (relativePath.includes("forbidden-words.test.ts") || relativePath.includes("domain/copy.ts")) continue;
      const text = readFileSync(file, "utf8");
      for (const hit of findForbiddenWords(text)) {
        offenders.push({ file: relativePath, word: hit.word, snippet: hit.snippet });
      }
    }
    expect(offenders).toEqual([]);
  });
});
