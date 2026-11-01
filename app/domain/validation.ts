/**
 * Input validation for every write path: the bulk editor, the settings form and
 * the CSV import all funnel through these functions, so the rules live once.
 *
 * The field set follows the audit's separation of duties: manufacturer, packer,
 * importer and seller are separate fields (L4); the canonical country and the
 * exact label wording are separate (L5); imported-package status is an explicit
 * flag (L6); manufacture/pre-packing and best-before/use-by are separate dates
 * (L9); the common name carries label evidence (L8); unit sale price is its own
 * declaration (L1).
 */
import { findCountry } from "./countries";
import {
  NET_QUANTITY_UNITS,
  PACKAGE_TYPES,
  normaliseQuantityUnit,
  type ExpiryType,
  type LegalFields,
  type NetQuantityUnit,
  type PackageType,
} from "./types";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface FieldError {
  field: string;
  message: string;
}

const MAX_MRP = 9_999_999;
const MAX_TEXT_LENGTH = 500;
const MAX_ADDRESS_LENGTH = 1000;

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

/**
 * Replaces control characters (U+0000 to U+001F and U+007F) with a space,
 * keeping only the characters listed in `keep`. Written as a loop rather than a
 * regular expression so the source stays free of literal control characters.
 */
function stripControlChars(value: string, keep = ""): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      out += keep.includes(char) ? char : " ";
    } else {
      out += char;
    }
  }
  return out;
}

/** Strips control characters, angle brackets and collapses whitespace. */
export function sanitizeText(value: unknown, maxLength = MAX_TEXT_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const cleaned = stripControlChars(value)
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

export function sanitizeMultilineText(value: unknown, maxLength = MAX_ADDRESS_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const cleaned = stripControlChars(value, "\n\t\r")
    .replace(/[<>]/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

/** Accepts "1299", "1,299.00", "₹1299.5". Rejects negatives, zero and >2 decimals. */
export function parseMoney(input: unknown): ParseResult<number | null> {
  if (isBlank(input)) return { ok: true, value: null };
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return { ok: false, error: "Enter a number." };
    if (input <= 0) return { ok: false, error: "Enter an amount greater than 0." };
    if (input > MAX_MRP) return { ok: false, error: `Enter an amount below ${MAX_MRP}.` };
    if (Math.round(input * 100) !== Number((input * 100).toFixed(6))) {
      return { ok: false, error: "Use at most 2 decimal places." };
    }
    return { ok: true, value: Math.round(input * 100) / 100 };
  }
  if (typeof input !== "string") return { ok: false, error: "Enter a number." };
  const cleaned = input.replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return { ok: false, error: "Enter a plain number with up to 2 decimal places (for example 249.00)." };
  }
  const value = Number(cleaned);
  if (value <= 0) return { ok: false, error: "Enter an amount greater than 0." };
  if (value > MAX_MRP) return { ok: false, error: `Enter an amount below ${MAX_MRP}.` };
  return { ok: true, value };
}

export function parseNetQuantity(input: unknown): ParseResult<number | null> {
  if (isBlank(input)) return { ok: true, value: null };
  const cleaned = typeof input === "number" ? String(input) : String(input).replace(/[,\s]/g, "");
  if (!/^\d+(\.\d{1,3})?$/.test(cleaned)) {
    return { ok: false, error: "Enter a quantity such as 100 or 2.5." };
  }
  const value = Number(cleaned);
  if (value <= 0) return { ok: false, error: "Net quantity must be greater than 0." };
  if (value > 1_000_000) return { ok: false, error: "Net quantity looks too large." };
  return { ok: true, value };
}

/**
 * Rule 13 units, including cm and the count descriptors. The legacy "pcs" spelling
 * is accepted and stored as "piece" so older exports still import.
 */
export function parseUnit(input: unknown): ParseResult<NetQuantityUnit | null> {
  if (isBlank(input)) return { ok: true, value: null };
  const value = normaliseQuantityUnit(String(input));
  if (!value || !(NET_QUANTITY_UNITS as readonly string[]).includes(value)) {
    return {
      ok: false,
      error: `Use one of: ${NET_QUANTITY_UNITS.join(", ")}.`,
    };
  }
  return { ok: true, value };
}

/** Best-before/use-by type. `none` means the commodity is not perishable. */
export function parseExpiryType(input: unknown): ParseResult<ExpiryType> {
  const value = isBlank(input) ? "none" : String(input).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (value === "none" || value === "best_before" || value === "use_by") {
    return { ok: true, value: value as ExpiryType };
  }
  return { ok: false, error: "Choose none, best before or use by." };
}

/** Package scope under Rules 3 and 26. */
export function parsePackageType(input: unknown): ParseResult<PackageType> {
  const value = isBlank(input) ? "packaged" : String(input).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((PACKAGE_TYPES as readonly string[]).includes(value)) {
    return { ok: true, value: value as PackageType };
  }
  return { ok: false, error: `Choose one of: ${PACKAGE_TYPES.join(", ")}.` };
}

/** Tri-state booleans: true, false, or null for "not declared". */
export function parseNullableBoolean(input: unknown): ParseResult<boolean | null> {
  if (isBlank(input)) return { ok: true, value: null };
  if (typeof input === "boolean") return { ok: true, value: input };
  const value = String(input).trim().toLowerCase();
  if (["true", "yes", "1", "y"].includes(value)) return { ok: true, value: true };
  if (["false", "no", "0", "n"].includes(value)) return { ok: true, value: false };
  return { ok: false, error: "Choose yes or no." };
}

/** Plain boolean used for the label-evidence confirmations. */
export function parseBooleanFlag(input: unknown): ParseResult<boolean> {
  if (input === null || input === undefined || input === "") return { ok: true, value: false };
  if (typeof input === "boolean") return { ok: true, value: input };
  const value = String(input).trim().toLowerCase();
  if (["true", "yes", "1", "y", "on"].includes(value)) return { ok: true, value: true };
  if (["false", "no", "0", "n", "off"].includes(value)) return { ok: true, value: false };
  return { ok: false, error: "Choose yes or no." };
}

/** MM/YYYY, the form the declaration takes on the pack. */
export function parseMonthYear(input: unknown): ParseResult<string | null> {
  if (isBlank(input)) return { ok: true, value: null };
  const value = String(input).trim();
  // A person typing "3/2026" or a spreadsheet writing "03-2026" means the same
  // month; both are stored as MM/YYYY so the stored form is one shape. A year
  // outside 2000-2100 is a typo, not a declaration.
  const match = value.match(/^(\d{1,2})[/-](\d{4})$/);
  if (!match) {
    return { ok: false, error: "Enter the month and year as MM/YYYY, for example 03/2026." };
  }
  const month = Number(match[1]);
  const year = Number(match[2]);
  if (month < 1 || month > 12) {
    return { ok: false, error: "Enter the month and year as MM/YYYY, for example 03/2026." };
  }
  if (year < 2000 || year > 2100) {
    return { ok: false, error: "Enter a four-digit year between 2000 and 2100." };
  }
  return { ok: true, value: `${String(month).padStart(2, "0")}/${year}` };
}

/** Country of origin, stored as the canonical country name. */
export function parseCountry(input: unknown): ParseResult<string | null> {
  if (isBlank(input)) return { ok: true, value: null };
  const country = findCountry(String(input));
  if (!country) {
    return { ok: false, error: "Choose the country of origin from the list." };
  }
  return { ok: true, value: country.name };
}

/**
 * Per-variant declared prices where a variant is a separate package (audit L3).
 * Stored as a JSON object of variant id to amount; `null` clears it.
 */
export function parseVariantMrp(input: unknown): ParseResult<Record<string, number> | null> {
  if (isBlank(input)) return { ok: true, value: null };
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      return { ok: false, error: 'Enter the per-variant prices as JSON, for example {"gid://shopify/ProductVariant/1": 249}.' };
    }
  }
  if (parsed === null) return { ok: true, value: null };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Enter an object of variant id to price." };
  }
  const values: Record<string, number> = {};
  for (const [variantId, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!variantId.trim()) return { ok: false, error: "Every variant price needs a variant id." };
    const amount = parseMoney(raw);
    if (!amount.ok) return { ok: false, error: `${variantId}: ${amount.error}` };
    if (amount.value === null) continue;
    values[variantId] = amount.value;
  }
  return { ok: true, value: Object.keys(values).length > 0 ? values : null };
}

export function validateEmail(input: unknown, { required = false } = {}): ParseResult<string | null> {
  if (isBlank(input)) {
    return required ? { ok: false, error: "Enter an email address." } : { ok: true, value: null };
  }
  const value = String(input).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) || value.length > 254) {
    return { ok: false, error: "Enter a valid email address." };
  }
  return { ok: true, value };
}

export function validatePhone(input: unknown, { required = false } = {}): ParseResult<string | null> {
  if (isBlank(input)) {
    return required ? { ok: false, error: "Enter a phone number." } : { ok: true, value: null };
  }
  const value = String(input).trim();
  const digits = value.replace(/[^\d]/g, "");
  if (!/^[+\d][\d\s()-]{5,24}$/.test(value) || digits.length < 7 || digits.length > 15) {
    return { ok: false, error: "Enter a phone number with 7 to 15 digits." };
  }
  return { ok: true, value };
}

/** Accepts an absolute http(s) URL or a storefront path such as /pages/returns. */
export function validatePolicyLink(input: unknown): ParseResult<string | null> {
  if (isBlank(input)) return { ok: true, value: null };
  const value = String(input).trim();
  if (value.startsWith("/")) {
    if (value.length > 500 || /\s/.test(value)) return { ok: false, error: "Enter a link without spaces." };
    return { ok: true, value };
  }
  if (!/^https?:\/\/[^\s]+\.[^\s]+$/i.test(value)) {
    return { ok: false, error: "Enter a full https:// link or a path starting with /." };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Legal-field patch validation (bulk editor + CSV import)
// ---------------------------------------------------------------------------

export type LegalPatchInput = Partial<Record<keyof LegalFields, unknown>>;

export interface ValidatedLegalPatch {
  values: Partial<LegalFields>;
  errors: FieldError[];
}

const text = (input: unknown) => ({ ok: true as const, value: sanitizeText(input) });
const multiline = (input: unknown) => ({ ok: true as const, value: sanitizeMultilineText(input) });

const FIELD_PARSERS: {
  [K in keyof LegalFields]: (input: unknown) => ParseResult<LegalFields[K]>;
} = {
  mrp: parseMoney,
  variantMrp: parseVariantMrp,
  manufacturerName: text,
  manufacturerAddress: multiline,
  packerDiffersFromManufacturer: parseNullableBoolean,
  packerName: text,
  packerAddress: multiline,
  sellerName: text,
  sellerAddress: multiline,
  countryOfOrigin: parseCountry,
  countryOfOriginLabel: (input) => ({ ok: true, value: sanitizeText(input, 120) }),
  isImportedPackage: parseNullableBoolean,
  importerName: text,
  importerAddress: multiline,
  packageType: parsePackageType,
  netQuantityValue: parseNetQuantity,
  netQuantityUnit: parseUnit,
  genericName: (input) => ({ ok: true, value: sanitizeText(input, 200) }),
  genericNameOnLabel: parseBooleanFlag,
  manufacturedDate: parseMonthYear,
  expiryType: parseExpiryType,
  expiryDate: parseMonthYear,
  unitSalePrice: parseMoney,
};

/**
 * Validates a partial patch; only the fields present in the patch are returned.
 * `current` lets the cross-field checks see values already stored on the product
 * when the patch does not touch them.
 */
export function validateLegalPatch(
  patch: LegalPatchInput,
  current?: Partial<LegalFields>,
): ValidatedLegalPatch {
  const values: Partial<LegalFields> = {};
  const errors: FieldError[] = [];
  for (const key of Object.keys(patch) as Array<keyof LegalFields>) {
    const parser = FIELD_PARSERS[key];
    if (!parser) continue;
    const parsed = parser(patch[key]);
    if (!parsed.ok) {
      errors.push({ field: key, message: parsed.error });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (values as any)[key] = parsed.value;
    }
  }

  const effectiveExpiryType = values.expiryType ?? current?.expiryType ?? "none";
  const effectiveExpiryDate = values.expiryDate !== undefined ? values.expiryDate : current?.expiryDate;
  const effectiveManufactured =
    values.manufacturedDate !== undefined ? values.manufacturedDate : current?.manufacturedDate;

  // A best-before/use-by date without its type is meaningless, and a type with no
  // date is an incomplete declaration (R7 reports it, but catching it here stops
  // half-entered rows being written).
  if (effectiveExpiryType === "none" && effectiveExpiryDate) {
    errors.push({
      field: "expiryType",
      message: "Choose best before or use by for this date, or clear the date.",
    });
  }
  if (effectiveExpiryType !== "none" && !effectiveExpiryDate) {
    errors.push({
      field: "expiryDate",
      message: "Enter the best-before or use-by date as MM/YYYY.",
    });
  }
  // The manufacture/pre-packing date is a separate declaration and is required
  // for a covered package (audit L9). This is a completeness hint, not a rule
  // result: R7 is what scores it.
  if (effectiveExpiryDate && effectiveManufactured && isLaterThan(effectiveExpiryDate, effectiveManufactured)) {
    errors.push({
      field: "expiryDate",
      message: "The best-before or use-by date cannot be earlier than the manufacture date.",
    });
  }
  // One message per field: a value that failed its own parser would otherwise also
  // fail the cross-field checks and report the same field twice.
  const seen = new Set<string>();
  const deduped = errors.filter((error) => {
    if (seen.has(error.field)) return false;
    seen.add(error.field);
    return true;
  });
  return { values, errors: deduped };
}

function isLaterThan(earlier: string, later: string): boolean {
  const toIndex = (value: string): number | null => {
    const [monthPart, yearPart] = value.split("/");
    const month = Number(monthPart);
    const year = Number(yearPart);
    if (!Number.isFinite(month) || !Number.isFinite(year)) return null;
    return year * 12 + month;
  };
  const a = toIndex(earlier);
  const b = toIndex(later);
  if (a === null || b === null) return false;
  return a < b;
}

/** Net quantity has to arrive as a pair; used by the bulk editor's row save. */
export function validateQuantityPair(
  value: unknown,
  unit: unknown,
): { values: { netQuantityValue?: number | null; netQuantityUnit?: NetQuantityUnit | null }; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const parsedValue = parseNetQuantity(value);
  const parsedUnit = parseUnit(unit);
  const values: { netQuantityValue?: number | null; netQuantityUnit?: NetQuantityUnit | null } = {};
  if (!parsedValue.ok) errors.push({ field: "netQuantityValue", message: parsedValue.error });
  else values.netQuantityValue = parsedValue.value;
  if (!parsedUnit.ok) errors.push({ field: "netQuantityUnit", message: parsedUnit.error });
  else values.netQuantityUnit = parsedUnit.value;
  if (parsedValue.ok && parsedUnit.ok) {
    if (parsedValue.value !== null && parsedUnit.value === null) {
      errors.push({ field: "netQuantityUnit", message: "Choose a unit for the net quantity." });
    }
    if (parsedValue.value === null && parsedUnit.value !== null) {
      errors.push({ field: "netQuantityValue", message: "Enter a net quantity for this unit." });
    }
  }
  return { values, errors };
}
