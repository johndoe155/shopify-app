/**
 * User-facing copy constants. The claims wording lives here once so it is
 * identical in the UI, the CSV and the PDF exports, and so the forbidden-words
 * check has a single whitelist to compare against.
 */
import {
  COUNTRY_FILTER_EFFECTIVE_FROM,
  SUPPLIED_2026_COMMENCEMENT,
  commencementDisclaimer,
} from "./legal-basis";

/**
 * The checklist disclaimer, required on every screen that shows a score and on
 * every export.
 *
 * Audit item L17: the old sentence was acceptable as a basic limitation but
 * incomplete, because this repository's `verifiedAgainstGazette` is false and the
 * checklist has known gaps. It now says the app is informational, may be
 * incomplete or out of date, is not a legal opinion or certification, and is not
 * legal advice.
 */
export const DISCLAIMER =
  "This tool checks listing data against a published checklist. It is informational, may be incomplete or out of date, is not a legal opinion or certification, and is not legal advice.";

/** Claims language used in the app and the App Store listing. */
export const CLAIMS =
  "This app helps you prepare your listings. It does not guarantee compliance and it is not legal advice.";

/** Wording for the self-audit record. Deliberately never calls itself a certificate. */
export const AUDIT_RECORD_NOTE =
  "This is a record of the answers you gave, saved on the date shown. It is not a certificate and it does not establish compliance.";

/**
 * The support address is deployment configuration, not copy: it lives in
 * `app/config.server.ts` (`SUPPORT_EMAIL`) and is hidden in the UI when it has
 * not been set, rather than defaulting to a placeholder that looks real.
 */

/**
 * The 2026 E-Commerce amendment's commencement.
 *
 * Audit items L2 and 23: the official eGazette copy available prints the G.S.R.
 * and commencement fields with missing/garbled values, so the 1 January 2027 date
 * is a **supplied** date. It is used for preparation advice and a clearly
 * labelled countdown, never as "the date every rule starts".
 */
export const SUPPLIED_ECOM_2026_DATE = SUPPLIED_2026_COMMENCEMENT;

/**
 * Install by this date and 30 days of price history exist before the supplied
 * 2026 date. Shown only as preparation advice; the prior price is never published
 * from a short history whatever the date (audit L16).
 */
export const PRICE_HISTORY_INSTALL_BY = new Date(
  SUPPLIED_ECOM_2026_DATE.getTime() - 30 * 24 * 60 * 60 * 1000,
);

/** The country-of-origin filter's controlling commencement (G.S.R. 312(E)). */
export const COUNTRY_FILTER_DATE = COUNTRY_FILTER_EFFECTIVE_FROM;

export const APP_NAME = "India Legal Metrology & MRP";

/** Indian digit grouping: 1167.9 becomes "₹1,167.90". */
export function formatInr(value: number): string {
  return `\u20b9${value.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatLongDate(date: Date): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${days[date.getUTCDay()]}, ${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function formatShortDate(date: Date): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function formatDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${formatShortDate(date)}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export function daysUntil(target: Date, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * The dashboard's date line.
 *
 * Audit item L2: `RULES_EFFECTIVE_DATE` must not be used as though it were the
 * commencement date for every rule. This sentence therefore says what is in force
 * now, what has been in force since 1 January 2024, and that the 2027 date is a
 * supplied one for a notified instrument with an unverified commencement.
 */
export function countdownLabel(now: Date = new Date()): string {
  const days = daysUntil(SUPPLIED_ECOM_2026_DATE, now);
  const countdown =
    days <= 0
      ? "The supplied date for the 2026 E-Commerce amendment has passed; confirm its actual commencement before relying on it."
      : `${days} day${days === 1 ? "" : "s"} until the supplied 1 January 2027 date for the 2026 E-Commerce amendment.`;
  return `Legal Metrology declarations, the 2020 E-Commerce Rules and the unit sale price duty (in force since 1 January 2024) apply now. ${countdown}`;
}

/** A short, screen-sized version of the same distinction. */
export function commencementLine(): string {
  return commencementDisclaimer();
}

/** Country-of-origin filter status line, used by the help page and R3 copy. */
export function countryFilterStatus(now: Date = new Date()): string {
  const days = daysUntil(COUNTRY_FILTER_DATE, now);
  return days > 0
    ? `The searchable country-of-origin filter is not enforceable yet: G.S.R. 128(E) notified it and G.S.R. 312(E) deferred it to 1 July 2027 (${days} days away). Preparation is optional today.`
    : "The country-of-origin filter's deferred date of 1 July 2027 has arrived under G.S.R. 312(E). Confirm the current text before relying on this line.";
}

// ---------------------------------------------------------------------------
// Forbidden-words policy (brief section 10). Used by scripts/check-forbidden-words.ts
// and by tests. Negated claims from CLAIMS are removed before scanning so the
// required "does not guarantee compliance" wording is legal to write.
// ---------------------------------------------------------------------------
export const FORBIDDEN_WORDS = [
  "certified",
  "certify",
  "certification",
  "approved",
  "approve",
  "approval",
  "guaranteed",
  "guarantee",
  "guarantees",
] as const;

/**
 * Negated forms that are allowed to contain a forbidden word. They are removed
 * before scanning, so the required "does not guarantee compliance" wording can
 * appear in the UI and in the App Store listing.
 */
export const ALLOWED_NEGATIONS = [
  "This app helps you prepare your listings. It does not guarantee compliance and it is not legal advice.",
  "It does not guarantee compliance and it is not legal advice.",
  "does not guarantee compliance",
  "does not guarantee",
  "not guarantee compliance",
  "never guarantees",
  // The extended disclaimer must be able to say what it is not.
  "is not a legal opinion or certification",
  "It is informational, may be incomplete or out of date, is not a legal opinion or certification, and is not legal advice.",
  // Audit item 22: the disclaimer now also says the app does not certify.
  "does not certify anything",
  "does not certify",
  "is not certified",
  "not certified",
];

/**
 * Terms of art that contain a forbidden-looking word without making a claim.
 *
 * The 2020 E-Commerce Rules require the seller to disclose "warranty and
 * guarantee" information, so the phrase has to be writable. It is not a promise
 * about the app.
 */
export const ALLOWED_LEGAL_TERMS = [
  "warranty and guarantee",
  "warranty or guarantee",
  "guarantee period",
  "guarantee claim",
];

export const NEGATED_CLAIM_ALLOWLIST = [...ALLOWED_NEGATIONS];

export interface ForbiddenWordHit {
  word: string;
  line: number;
  snippet: string;
}

/**
 * Scans one text blob for forbidden words.
 *
 * Matching ignores line wrapping (allowed phrases are compared on a
 * whitespace-collapsed copy) so a markdown file that wraps "does not guarantee
 * compliance" across two lines is still treated as the allowed negation.
 */
export function exportAllowedPhrases(): string[] {
  return [...NEGATED_CLAIM_ALLOWLIST, ...ALLOWED_LEGAL_TERMS];
}

export function findForbiddenWords(text: string): ForbiddenWordHit[] {
  const normalised = text.replace(/\s+/g, " ");
  let stripped = normalised;
  for (const allowed of exportAllowedPhrases()) {
    // Case-insensitive, because a label reads "Warranty and guarantee" while the
    // sentence around it reads "warranty and guarantee".
    const escaped = allowed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    stripped = stripped.replace(new RegExp(escaped, "gi"), " ");
  }
  const lowerStripped = stripped.toLowerCase();
  const lines = text.split(/\r?\n/);
  const hits: ForbiddenWordHit[] = [];

  for (const word of FORBIDDEN_WORDS) {
    if (!lowerStripped.includes(word)) continue;
    const lineIndex = lines.findIndex((line) => line.toLowerCase().includes(word));
    hits.push({
      word,
      line: lineIndex === -1 ? 1 : lineIndex + 1,
      snippet: (lineIndex === -1 ? normalised : lines[lineIndex] ?? "").trim().slice(0, 160),
    });
  }
  return hits;
}
