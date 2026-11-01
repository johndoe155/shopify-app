/**
 * App Store listing gate.
 *
 *   npm run check:listing
 *
 * The listing copy used to be written to character limits remembered from the
 * public docs, in a markdown file nothing validated. This script makes the
 * limits executable:
 *
 *  - every field is measured against the limit in listing/listing-fields.json;
 *  - the marketing claims are scanned for the words Shopify rejects (superlatives
 *    and guarantee language) using the same list as the app's own wording gate;
 *  - app-store-listing.md must contain the exact values, so the document a human
 *    submits cannot drift from the values that were checked.
 *
 * It cannot check the Partner dashboard itself. `verifiedInPartnerDashboard`
 * records whether a human has re-read the live form.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const listing = JSON.parse(readFileSync(join(root, "listing/listing-fields.json"), "utf8")) as {
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
};

const problems: string[] = [];
const { limits, fields } = listing;

function checkLength(label: string, value: string, limitKey: string): void {
  const limit = limits[limitKey];
  if (limit === undefined) {
    problems.push(`${label}: no limit defined for "${limitKey}"`);
    return;
  }
  if (value.length > limit) {
    problems.push(`${label} is ${value.length} characters; the limit is ${limit}: "${value}"`);
  }
  if (value.trim() !== value) {
    problems.push(`${label} has leading or trailing whitespace`);
  }
}

// Leave headroom: a field that lands exactly on the limit is one Shopify edit
// away from being rejected, and mobile cards truncate earlier.
const HEADROOM = 2;
function checkHeadroom(label: string, value: string, limitKey: string): void {
  const limit = limits[limitKey] ?? 0;
  if (value.length > limit - HEADROOM) {
    console.warn(
      `warning: ${label} is ${value.length}/${limit} characters, inside ${HEADROOM} of the limit. Consider trimming.`,
    );
  }
}

checkLength("name", fields.name, "name");
checkLength("subtitle", fields.subtitle, "subtitle");
checkLength("introduction", fields.introduction, "introduction");
checkLength("details", fields.details, "details");
fields.features.forEach((feature, index) =>
  checkLength(`feature ${index + 1}`, feature, "feature"),
);
if (fields.features.length > limits.features!) {
  problems.push(`${fields.features.length} features; the limit is ${limits.features}`);
}
if (fields.searchTerms.length > limits.searchTerms!) {
  problems.push(`${fields.searchTerms.length} search terms; the limit is ${limits.searchTerms}`);
}

checkHeadroom("name", fields.name, "name");
checkHeadroom("subtitle", fields.subtitle, "subtitle");
checkHeadroom("introduction", fields.introduction, "introduction");

// Shopify rejects superlatives and guarantee claims in listings.
const BANNED = [
  /\bthe first\b/i,
  /\bthe best\b/i,
  /\bthe only\b/i,
  /\bcertified\b/i,
  /\b100% compliant\b/i,
];

/**
 * Guarantee language, with the corrective forms allowed through.
 *
 * Audit item 22: the app's required disclaimer says it "does not guarantee
 * compliance". A blanket /guarantee[ds]?/ rule rejected that sentence, which
 * pushed the listing towards either dropping the disclaimer or rephrasing it into
 * something weaker. The check therefore removes negated uses ("does not
 * guarantee", "no guarantee", "cannot guarantee") before looking for a claim.
 */
const GUARANTEE_WORD = /\bguarantee[ds]?\b/i;
const NEGATED_GUARANTEE = /\b(does not|doesn't|do not|don't|will not|won't|cannot|can't|no|not)\s+guarantee[ds]?\b/gi;

function containsGuaranteeClaim(value: string): boolean {
  return GUARANTEE_WORD.test(value.replace(NEGATED_GUARANTEE, " "));
}
const allText: Array<[string, string]> = [
  ["name", fields.name],
  ["subtitle", fields.subtitle],
  ["introduction", fields.introduction],
  ["details", fields.details],
  ...fields.features.map((feature, index) => [`feature ${index + 1}`, feature] as [string, string]),
];
for (const [label, value] of allText) {
  for (const pattern of BANNED) {
    if (pattern.test(value))
      problems.push(`${label} contains language Shopify rejects for listings: ${pattern}`);
  }
  if (containsGuaranteeClaim(value)) {
    problems.push(`${label} claims a guarantee: "${value}"`);
  }
}

// The markdown must carry the checked values verbatim.
const markdown = readFileSync(join(root, "listing/app-store-listing.md"), "utf8");
const normalise = (value: string) => value.replace(/\s+/g, " ").trim();
const normalisedMarkdown = normalise(markdown);
for (const [label, value] of allText) {
  if (!normalisedMarkdown.includes(normalise(value))) {
    problems.push(`app-store-listing.md does not contain the checked ${label} text: "${value}"`);
  }
}

if (!listing.verifiedInPartnerDashboard) {
  console.warn(
    "warning: listing/listing-fields.json says verifiedInPartnerDashboard=false. Re-read the Partner dashboard form before submitting and set it to true.",
  );
}

if (problems.length > 0) {
  console.error(`Listing check failed with ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `Listing check: all fields within limits (name ${fields.name.length}/${limits.name}, subtitle ${fields.subtitle.length}/${limits.subtitle}, introduction ${fields.introduction.length}/${limits.introduction}, details ${fields.details.length}/${limits.details}).`,
);
