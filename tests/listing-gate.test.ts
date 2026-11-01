/**
 * The listing gate must itself fail when the copy breaks a rule.
 *
 * `scripts/check-listing.ts` is the only thing standing between "we measured the
 * fields" and "we assumed we did", so it gets the same treatment as the app: a
 * green run proves nothing unless a red run is also proven. Each case copies the
 * real `listing/` directory into a temp folder, breaks exactly one thing, and
 * asserts the script exits non-zero and names the problem.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = join(__dirname, "..");
const script = join(projectRoot, "scripts/check-listing.ts");
const realListing = join(projectRoot, "listing");

interface ListingFile {
  limits: Record<string, number>;
  verifiedInPartnerDashboard: boolean;
  fields: {
    name: string;
    subtitle: string;
    introduction: string;
    details: string;
    features: string[];
    searchTerms: string[];
  };
}

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch copy of `listing/` that the script can be pointed at via cwd. */
function sandbox(mutate: (listing: ListingFile, dir: string) => void): {
  code: number;
  output: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "listing-gate-"));
  created.push(dir);
  mkdirSync(join(dir, "listing"), { recursive: true });
  for (const file of ["listing-fields.json", "app-store-listing.md"]) {
    copyFileSync(join(realListing, file), join(dir, "listing", file));
  }
  const listingPath = join(dir, "listing/listing-fields.json");
  const listing = JSON.parse(readFileSync(listingPath, "utf8")) as ListingFile;
  mutate(listing, dir);
  writeFileSync(listingPath, JSON.stringify(listing, null, 2));

  try {
    const output = execFileSync("npx", ["tsx", script], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

describe("check-listing.ts", () => {
  it("passes on the real listing copy", () => {
    const result = sandbox(() => {});
    expect(result.output).toContain("all fields within limits");
    expect(result.code).toBe(0);
  }, 60_000);

  it("fails when a field is over its limit", () => {
    const result = sandbox((listing) => {
      listing.fields.subtitle = "x".repeat(listing.limits.subtitle! + 1);
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/subtitle is \d+ characters; the limit is \d+/);
  });

  it("fails when a field has trailing whitespace", () => {
    const result = sandbox((listing) => {
      listing.fields.name = `${listing.fields.name} `;
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/name has leading or trailing whitespace/);
  });

  it("fails on superlatives and compliance claims", () => {
    for (const phrase of ["The best MRP checker", "100% compliant", "A certified tool"]) {
      const result = sandbox((listing) => {
        listing.fields.details = `${listing.fields.details} ${phrase}.`;
      });
      expect(result.code, phrase).not.toBe(0);
      expect(result.output, phrase).toMatch(
        /language Shopify rejects|does not contain the checked details/,
      );
    }
  });

  it("fails when the markdown no longer matches the checked values", () => {
    const result = sandbox((listing, dir) => {
      const path = join(dir, "listing/app-store-listing.md");
      writeFileSync(path, readFileSync(path, "utf8").replace(/.+/g, "rewritten by hand"));
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/app-store-listing\.md does not contain the checked/);
  });

  it("fails when there are more features or search terms than the limit", () => {
    const result = sandbox((listing) => {
      listing.fields.features = Array.from(
        { length: listing.limits.features! + 1 },
        () => "Short feature",
      );
      listing.fields.searchTerms = Array.from(
        { length: listing.limits.searchTerms! + 1 },
        (_, index) => `term ${index}`,
      );
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/features; the limit is/);
    expect(result.output).toMatch(/search terms; the limit is/);
  });
});
