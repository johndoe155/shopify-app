/**
 * The rule engine.
 *
 * Rules, labels, levels, applicability, sources and the tunable parameters all
 * come from `rules.config.json`. This file only contains the *evaluation* for
 * each rule id, so corrected wording ships as a config change.
 *
 * The evaluations below implement the legal audit of 31 October 2026:
 *
 *   R1  price declared per package, not one MRP sprayed across every variant;
 *   R2  manufacturer, packer, importer and seller separated, plus the Rule 6(10)
 *       online-display duty;
 *   R3  canonical country plus the exact label wording;
 *   R4  an explicit imported-package flag instead of a country-code proxy;
 *   R5  the cm and count descriptors, with Rule 13 threshold logic;
 *   R6  label evidence, not just an online title;
 *   R7  manufacture/pre-packing is generally required and cannot be switched off
 *       by a merchant flag; best-before/use-by is a separate conditional field;
 *   R8  package-label contact (name **and** address) separated from the platform's
 *       customer-care duty;
 *   R9  the full 2020 disclosure set, with live-link validation;
 *   R10 grievance display **and** complaint-timing evidence;
 *   R11 a complete 30-day lookback recorded against an announcement event, with no
 *       "tracked since install" pass;
 *   R12 thirteen patterns with the audit cycle labelled as app policy;
 *   R13 unit sale price as a conditional rule with the audited exemptions.
 */
import rawConfig from "./rules.config.json";
import { findCountry } from "./countries";
import { assessUnitSalePrice, declaredUnitSalePriceMatches, standardUnitCorrection } from "./unit-price";
import { variantIsReduced } from "./prior-price";
import {
  COMPLAINT_EVIDENCE_LOOKBACK_MONTHS,
  EMPTY_COMPLAINT_EVIDENCE,
  NET_QUANTITY_UNITS,
  normaliseQuantityUnit,
  type ComplaintEvidence,
  type NetQuantityUnit,
  type PolicyEntry,
  type ProductFacts,
  type RuleLevel,
  type RuleResult,
  type RuleStatus,
  type ScanOutcome,
  type ScanStatus,
  type StoreFacts,
  type StorePolicies,
} from "./types";

export interface RuleConfigEntry {
  id: string;
  order: number;
  label: string;
  level: RuleLevel;
  applicability: string;
  passCondition: string;
  helpText: string;
  enabled: boolean;
  /** Instrument ids from `legal-basis.ts` that the rule rests on. */
  sources?: string[];
  /** One line of commencement wording for this rule. */
  commencement?: string;
}

export interface RuleConfigParameters {
  priorPriceWindowDays: number;
  /** Validity period for a self-audit record. App policy, not a statutory cadence. */
  auditValidityMonths: number;
  /** In-app reminder timing. App policy. */
  auditReminderMonths: number;
  /** True when the audit cadence above is the app's own policy (audit item L14). */
  auditCadenceIsProductPolicy?: boolean;
  /** Rounding for unit sale price, in decimal places (Rule 6(11)). */
  unitSalePriceDecimals?: number;
  /**
   * How old a policy-link check may be before R9 treats the link as unverified
   * again (audit item L11). A link that answered last year says nothing about
   * whether it answers today.
   */
  policyLinkMaxAgeDays?: number;
  /**
   * How far back the complaint register is read for R10's timings, in months.
   * App policy: without a window, one late complaint fails the store for ever.
   */
  complaintEvidenceLookbackMonths?: number;
}

/** Used when the config does not carry `policyLinkMaxAgeDays`. */
export const DEFAULT_POLICY_LINK_MAX_AGE_DAYS = 7;

/** True when a stored check is older than R9 will trust. */
export function isStalePolicyCheck(checkedAt: Date, now: Date, maxAgeDays: number): boolean {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return false;
  const ageMs = now.getTime() - new Date(checkedAt).getTime();
  if (!Number.isFinite(ageMs)) return true;
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

export interface RuleConfig {
  version: string;
  verifiedAgainstGazette: boolean;
  legalReviewDate?: string;
  sources: string[];
  verificationNote: string;
  commencementNote?: string;
  parameters: RuleConfigParameters;
  rules: RuleConfigEntry[];
  knownGaps?: string[];
}

export const RULES_CONFIG: RuleConfig = rawConfig as RuleConfig;

export function ruleEntries(cfg: RuleConfig = RULES_CONFIG): RuleConfigEntry[] {
  return [...cfg.rules].filter((r) => r.enabled).sort((a, b) => a.order - b.order);
}

export function ruleEntry(ruleId: string, cfg: RuleConfig = RULES_CONFIG): RuleConfigEntry | null {
  return cfg.rules.find((r) => r.id === ruleId) ?? null;
}

export function productRuleIds(cfg: RuleConfig = RULES_CONFIG): string[] {
  return ruleEntries(cfg)
    .filter((r) => r.level === "product")
    .map((r) => r.id);
}

export function storeRuleIds(cfg: RuleConfig = RULES_CONFIG): string[] {
  return ruleEntries(cfg)
    .filter((r) => r.level === "store")
    .map((r) => r.id);
}

const isFilled = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.trim().length > 0;

const isPositive = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const MONTH_YEAR = /^(0[1-9]|1[0-2])\/\d{4}$/;

export function isValidMonthYear(value: string | null | undefined): boolean {
  if (!isFilled(value)) return false;
  return MONTH_YEAR.test((value as string).trim());
}

/**
 * Packages the retail declaration regime does not cover (Rules 3 and 26). The
 * merchant marks these; the app never infers them from a title or a category.
 */
export function isOutOfScopePackage(product: ProductFacts): boolean {
  return product.legal.packageType === "excluded" || product.legal.packageType === "wholesale";
}

/** True when the commodity carries a best-before or use-by date (Rule 6(1)(da)). */
export function requiresExpiryDate(product: ProductFacts): boolean {
  return product.legal.expiryType !== "none";
}

/**
 * Import status. The audit (L6) rejects `country_of_origin == IN` as the legal
 * test, so an explicit flag wins; where the flag is undeclared the country is
 * only a proxy and the rule says so.
 */
export function importedPackageStatus(product: ProductFacts): {
  imported: boolean;
  declared: boolean;
  countryName: string | null;
} {
  const country = findCountry(product.legal.countryOfOrigin);
  if (product.legal.isImportedPackage !== null) {
    return {
      imported: product.legal.isImportedPackage,
      declared: true,
      countryName: country?.name ?? null,
    };
  }
  return {
    imported: country !== null && country.code !== "IN",
    declared: false,
    countryName: country?.name ?? null,
  };
}

function result(
  ruleId: string,
  level: RuleLevel,
  status: RuleStatus,
  message: string,
  fields?: string[],
): RuleResult {
  return fields && fields.length > 0
    ? { ruleId, level, status, message, fields }
    : { ruleId, level, status, message };
}

/** R1 — a price declared per package, and no variant sold above its own price. */
function checkR1(product: ProductFacts): RuleResult {
  if (isOutOfScopePackage(product)) {
    return result(
      "R1",
      "product",
      "not_applicable",
      "Not checked: the package is marked as wholesale or outside the Rules 3 and 26 scope.",
    );
  }
  const { mrp, variantMrp } = product.legal;
  if (!isPositive(mrp) && (!variantMrp || Object.keys(variantMrp).length === 0)) {
    return result("R1", "product", "fail", "No retail sale price is declared for this package.", ["mrp"]);
  }
  const above: string[] = [];
  for (const variant of product.variants) {
    const declared = variantMrp?.[variant.variantId] ?? mrp;
    if (!isPositive(declared)) {
      above.push(variant.title);
      continue;
    }
    if (variant.price > declared) above.push(variant.title);
  }
  if (above.length > 0) {
    return result(
      "R1",
      "product",
      "fail",
      `Selling price is above the declared price on ${above.length} variant${
        above.length === 1 ? "" : "s"
      } (${above.slice(0, 3).join(", ")}). Rule 18(2) prohibits sale above the applicable retail sale price.`,
      ["mrp"],
    );
  }
  return result(
    "R1",
    "product",
    "pass",
    "A retail sale price is declared for the package and no variant sells above its declared price.",
  );
}

/** R2 — manufacturer, packer, importer, seller, and the online-display duty. */
function checkR2(product: ProductFacts, store: StoreFacts): RuleResult {
  const missing: string[] = [];
  const legal = product.legal;

  if (!isFilled(legal.manufacturerName)) missing.push("manufacturer_name");
  if (!isFilled(legal.manufacturerAddress)) missing.push("manufacturer_address");

  // Packer: only required where the merchant has said the packer is a different
  // person. "Manufacturer or packer" is not a general either/or (audit L4).
  if (legal.packerDiffersFromManufacturer === true) {
    if (!isFilled(legal.packerName)) missing.push("packer_name");
    if (!isFilled(legal.packerAddress)) missing.push("packer_address");
  }

  const importStatus = importedPackageStatus(product);
  if (importStatus.imported) {
    if (!isFilled(legal.importerName)) missing.push("importer_name");
    if (!isFilled(legal.importerAddress)) missing.push("importer_address");
  }

  // Seller/dealer data is optional, but a half-filled pair is an incomplete
  // declaration and is reported rather than silently ignored.
  if (isFilled(legal.sellerName) !== isFilled(legal.sellerAddress)) {
    missing.push(isFilled(legal.sellerName) ? "seller_address" : "seller_name");
  }

  if (missing.length > 0) {
    const readable = missing.map((field) => field.replace(/_/g, " ")).join(", ");
    return result("R2", "product", "fail", `The package declaration is incomplete: ${readable}.`, missing);
  }

  // Rule 6(10): the mandatory declarations, other than the manufacture/packing
  // month and year, must be displayed on the e-commerce network. The Legal
  // declarations block is how this app satisfies that, so its status decides.
  if (store.blocks.declarations === "not_found") {
    return result(
      "R2",
      "product",
      "fail",
      "The package declarations are filled in, but they are not displayed on your storefront. Rule 6(10) requires the mandatory declarations to appear on the online listing.",
      ["declarations_block"],
    );
  }
  if (store.blocks.declarations === "unknown") {
    return result(
      "R2",
      "product",
      "inconclusive",
      "The package declarations are filled in, but the app could not verify that they are displayed on your storefront. This check is left out of the score until the Legal declarations block can be seen or you confirm it in Store settings.",
      ["declarations_block"],
    );
  }

  const notes: string[] = [];
  if (legal.packerDiffersFromManufacturer === null) {
    notes.push("the packer is treated as the manufacturer because no packer difference was declared");
  }
  if (!importStatus.declared) {
    notes.push(
      importStatus.imported
        ? "the country of origin suggests an imported package, but the imported-package flag is not set"
        : "the imported-package flag is not set",
    );
  }
  return result(
    "R2",
    "product",
    "pass",
    `Manufacturer name and address are filled and the declarations are displayed online${
      notes.length > 0 ? ` (${notes.join("; ")})` : ""
    }.`,
  );
}

/**
 * Does the recorded label wording name the country in full?
 *
 * "Made in India" names India. "Made in IN", "IN" or "Made in Bengaluru" do not:
 * the audit's wording for an imported package is the *full and complete* name of
 * the country, so an abbreviation, an ISO code or a city inside the country is
 * not enough. Matching is on word boundaries inside the normalised string, so
 * "Produced in the People's Republic of China" contains "China" while
 * "Manufactured in Indiana" does not contain "India" as a word.
 */
export function labelNamesCountry(label: string, country: { name: string }): boolean {
  const normalise = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const haystack = ` ${normalise(label)} `;
  return haystack.includes(` ${normalise(country.name)} `);
}

/**
 * R3 — canonical country plus the exact label wording.
 *
 * The label wording is required for **every** covered package, not only imported
 * ones, and the config says so: the app cannot see the pack, so the wording the
 * merchant records is the only evidence that the canonical country matches what
 * is actually printed. An imported package carries a second, stricter duty — the
 * wording must name the country in full — which is checked below once any
 * wording exists.
 */
function checkR3(product: ProductFacts): RuleResult {
  const legal = product.legal;
  const country = findCountry(legal.countryOfOrigin);
  if (!country) {
    return result(
      "R3",
      "product",
      "fail",
      "Country of origin is missing or is not a recognised country.",
      ["country_of_origin"],
    );
  }
  const importStatus = importedPackageStatus(product);
  if (!isFilled(legal.countryOfOriginLabel)) {
    return result(
      "R3",
      "product",
      "fail",
      importStatus.imported
        ? `Record the exact country wording printed on the pack. An imported package must name the full and complete country (${country.name}).`
        : "Record the exact country wording printed on the pack, for example 'Made in India'. It is kept as label evidence for every package and is not inferred from the country list.",
      ["country_of_origin_label"],
    );
  }
  if (importStatus.imported && !labelNamesCountry(legal.countryOfOriginLabel as string, country)) {
    return result(
      "R3",
      "product",
      "fail",
      `An imported package must name the country in full: the recorded wording "${legal.countryOfOriginLabel}" does not read as ${country.name}. Record the wording exactly as it is printed on the pack, or correct the country of origin.`,
      ["country_of_origin_label"],
    );
  }
  return result(
    "R3",
    "product",
    "pass",
    `Country of origin is ${country.name} and the label wording is recorded as evidence${
      importStatus.imported ? ", and names the country in full" : ""
    }.`,
  );
}

/** R4 — importer details for packages marked as imported. */
function checkR4(product: ProductFacts): RuleResult {
  const legal = product.legal;
  const status = importedPackageStatus(product);
  if (!status.countryName && legal.isImportedPackage === null) {
    return result(
      "R4",
      "product",
      "not_applicable",
      "Not checked until the country of origin or the imported-package flag is set.",
    );
  }
  if (!status.imported) {
    // The flag decides. Where it is unset, the country of origin is only a proxy
    // and the app says so in the message rather than treating an unmarked package
    // as domestic without comment (audit item L6). Reporting it as `inconclusive`
    // would drop the product out of the score for a missing flag, so the status
    // stays `not_applicable` and the inference is stated.
    return result(
      "R4",
      "product",
      "not_applicable",
      status.declared
        ? "Not needed: the package is marked as not imported."
        : "Not needed as far as the app can tell: the country of origin is India and no imported-package flag is set, so import status is inferred from the country rather than recorded. Set the flag to record it.",
    );
  }
  const missing: string[] = [];
  if (!isFilled(legal.importerName)) missing.push("importer_name");
  if (!isFilled(legal.importerAddress)) missing.push("importer_address");
  if (missing.length > 0) {
    return result(
      "R4",
      "product",
      "fail",
      `Importer name and address are required${
        status.declared ? "" : ` because the package appears to be imported from ${status.countryName ?? "outside India"}`
      }. Rule 6(1)(a) requires importer details for any imported package.`,
      missing,
    );
  }
  return result(
    "R4",
    "product",
    "pass",
    `Importer name and address are filled${status.declared ? "" : " (import status inferred from country of origin: set the imported-package flag to record it)"}.`,
  );
}

/** R5 — net quantity in the Rule 13 standard unit. */
function checkR5(product: ProductFacts): RuleResult {
  if (isOutOfScopePackage(product)) {
    return result(
      "R5",
      "product",
      "not_applicable",
      "Not checked: the package is marked as wholesale or outside the Rules 3 and 26 scope.",
    );
  }
  const legal = product.legal;
  const missing: string[] = [];
  if (!isPositive(legal.netQuantityValue)) missing.push("net_quantity_value");
  const unit = normaliseQuantityUnit(legal.netQuantityUnit);
  if (!unit || !(NET_QUANTITY_UNITS as readonly string[]).includes(unit)) {
    missing.push("net_quantity_unit");
  }
  if (missing.length > 0) {
    return result("R5", "product", "fail", "Net quantity is incomplete.", missing);
  }
  const value = legal.netQuantityValue as number;
  const correction = standardUnitCorrection(value, unit as NetQuantityUnit);
  if (correction) {
    return result("R5", "product", "fail", correction.message, [
      "net_quantity_value",
      "net_quantity_unit",
    ]);
  }
  return result(
    "R5",
    "product",
    "pass",
    `Net quantity is ${value} ${unit as NetQuantityUnit}, in the standard unit for this commodity.`,
  );
}

/** R6 — common name, with label evidence. */
function checkR6(product: ProductFacts): RuleResult {
  const legal = product.legal;
  if (!isFilled(legal.genericName)) {
    return result("R6", "product", "fail", "Common or generic name is not filled in.", ["generic_name"]);
  }
  if (legal.genericNameOnLabel !== true) {
    return result(
      "R6",
      "product",
      "fail",
      "A common or generic name is recorded, but there is no confirmation that it is printed on the package or label. An online product title is not evidence that the pack bears the declaration.",
      ["generic_name_on_label"],
    );
  }
  return result("R6", "product", "pass", "Common or generic name is recorded and confirmed on the pack.");
}

/** R7 — manufacture/pre-packing (generally required) and best-before/use-by. */
function checkR7(product: ProductFacts): RuleResult {
  if (isOutOfScopePackage(product)) {
    return result(
      "R7",
      "product",
      "not_applicable",
      "Not checked: the package is marked as wholesale or outside the Rules 3 and 26 scope.",
    );
  }
  const legal = product.legal;
  if (!isValidMonthYear(legal.manufacturedDate)) {
    return result(
      "R7",
      "product",
      "fail",
      isFilled(legal.manufacturedDate)
        ? "The month and year of manufacture or pre-packing must be in MM/YYYY format."
        : "The month and year of manufacture or pre-packing is required for a covered package. It cannot be switched off for a product.",
      ["manufactured_date"],
    );
  }
  if (requiresExpiryDate(product) && !isValidMonthYear(legal.expiryDate)) {
    return result(
      "R7",
      "product",
      "fail",
      isFilled(legal.expiryDate)
        ? "The best-before or use-by date must be in MM/YYYY format."
        : `The best-before or use-by date is required because this commodity may become unfit after a period (${legal.expiryType.replace(
            "_",
            "-",
          )}).`,
      ["expiry_date"],
    );
  }
  return result(
    "R7",
    "product",
    "pass",
    requiresExpiryDate(product)
      ? "Month/year of manufacture and the best-before or use-by date are both recorded."
      : "Month/year of manufacture or pre-packing is recorded.",
  );
}

/** R13 — unit sale price per standard unit (Rule 6(11)). */
function checkR13(product: ProductFacts): RuleResult {
  const legal = product.legal;
  const assessment = assessUnitSalePrice({
    mrp: legal.mrp,
    netQuantityValue: legal.netQuantityValue,
    netQuantityUnit: legal.netQuantityUnit,
    packageType: legal.packageType,
  });
  if (!assessment.applicable) {
    if (assessment.exemption) {
      return result("R13", "product", "not_applicable", `Not required: ${assessment.exemption}.`);
    }
    return result(
      "R13",
      "product",
      "not_applicable",
      "Not checked until the retail sale price and net quantity can be read, because the unit sale price is derived from them.",
    );
  }
  const expected = assessment.expected as number;
  if (!isPositive(legal.unitSalePrice)) {
    return result(
      "R13",
      "product",
      "fail",
      `Unit sale price is not declared. Rule 6(11) requires the price ${assessment.label} — ₹${expected.toFixed(
        2,
      )} for this package.`,
      ["unit_sale_price"],
    );
  }
  if (!declaredUnitSalePriceMatches(legal.unitSalePrice, expected)) {
    return result(
      "R13",
      "product",
      "fail",
      `Unit sale price does not match the declared price and quantity. Expected about ₹${expected.toFixed(
        2,
      )} ${assessment.label} (rounded to two decimal places).`,
      ["unit_sale_price"],
    );
  }
  return result(
    "R13",
    "product",
    "pass",
    `Unit sale price is declared ${assessment.label} and matches the retail sale price divided by the net quantity.`,
  );
}

/**
 * R11 — prior price from a complete 30-day lookback, recorded per announcement.
 *
 * A discount code or an automatic discount is *not* excluded here (audit item
 * L13): it does not move the variant price, so the app cannot see it, but a
 * reduction announced that way is still a reduction. What it needs is an
 * announcement record — the date, the price the shopper pays, the mechanism and
 * the conditions — which the merchant enters on the announcements screen. A
 * reduction nobody recorded is still measured from the announcement the app can
 * derive, and the message says which of the two it used.
 */
function checkR11(product: ProductFacts, store: StoreFacts): RuleResult {
  // Not "compare-at above price" alone: a recorded announcement can put the price
  // the shopper pays below the selling price without touching either.
  const discounted = product.variants.filter((variant) => variantIsReduced(variant));
  if (discounted.length === 0) {
    return result("R11", "product", "not_applicable", "No reduced-price variant on this product.");
  }
  if (store.blocks.priorPrice === "not_found") {
    return result(
      "R11",
      "product",
      "fail",
      "The prior price block is not live on the storefront.",
      ["prior_price_block"],
    );
  }
  if (store.blocks.priorPrice === "unknown") {
    // Not a failure: the block check could not see the storefront. Reporting
    // this as a fail would lower the merchant's score for something the app
    // could not look at.
    return result(
      "R11",
      "product",
      "inconclusive",
      "The prior price block could not be verified from the storefront. This check is left out of the score until it can be seen or you confirm the block in Store settings.",
      ["prior_price_block"],
    );
  }

  const incomplete = discounted.filter((v) => v.priorPrice && !v.priorPrice.historyComplete);
  if (incomplete.length > 0) {
    const completeBy = incomplete
      .map((v) => v.priorPrice?.completeBy)
      .filter((d): d is Date => d instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const trackingStart = incomplete[0]!.priorPrice!.trackedSince;
    return result(
      "R11",
      "product",
      "fail",
      completeBy
        ? `The price history covers only part of the 30 days before the announcement. A statutory prior price cannot be shown for ${
            incomplete.length
          } reduced variant${incomplete.length === 1 ? "" : "s"}: this app began tracking on ${formatDate(
            trackingStart,
          )} and prices from before then are not backfilled, so only a reduction announced on or after ${formatDate(
            completeBy,
          )} can have one, and no prior price is published for ${incomplete.length === 1 ? "it" : "them"}.`
        : `The price history covers only part of the 30 days before the announcement, so no statutory prior price can be shown for ${
            incomplete.length
          } reduced variant${incomplete.length === 1 ? "" : "s"}.`,
      ["prior_price"],
    );
  }

  const withoutPrior = discounted.filter((v) => v.priorPrice === null || v.priorPrice.priorPrice === null);
  if (withoutPrior.length > 0) {
    return result(
      "R11",
      "product",
      "fail",
      withoutPrior.every((v) => !v.priorPrice?.hasSnapshots)
        ? `No price history is recorded yet for ${withoutPrior.length} reduced variant${
            withoutPrior.length === 1 ? "" : "s"
          }. The app records prices from the day it was installed, and a statutory prior price needs a full 30-day lookback.`
        : `No prior price can be shown for ${withoutPrior.length} reduced variant${
            withoutPrior.length === 1 ? "" : "s"
          }: the announcement is not covered by recorded price history.`,
      ["prior_price"],
    );
  }

  const noAnnouncement = discounted.filter((v) => !v.priorPrice?.announcement);
  if (noAnnouncement.length > 0) {
    return result(
      "R11",
      "product",
      "fail",
      `The announcement event (the date and the consumer-facing price of the reduction) is not recorded for ${
        noAnnouncement.length
      } reduced variant${noAnnouncement.length === 1 ? "" : "s"}. The prior price is the lowest price in the 30 days before the announcement.`,
      ["prior_price_announcement"],
    );
  }

  if (!product.priorPricePublished) {
    return result(
      "R11",
      "product",
      "fail",
      "The prior price has not been published to the product metafield yet.",
      ["prior_price"],
    );
  }

  const recorded = discounted.filter((v) => v.priorPrice?.announcementRecorded === true);
  const codes = discounted.filter(
    (v) =>
      v.priorPrice?.announcement?.mechanism === "discount_code" ||
      v.priorPrice?.announcement?.mechanism === "automatic_discount",
  );
  const message =
    codes.length > 0
      ? "Prior price is shown from a complete 30-day lookback, computed from the reduction you recorded: a discount code or automatic discount was recorded as the announcement event, with the date and the price the shopper pays."
      : recorded.length > 0
        ? `Prior price is shown from a complete 30-day lookback before the reduction you recorded on ${formatDate(
            recorded[0]!.priorPrice!.announcement!.announcedAt,
          )}.`
        : "Prior price is shown from a complete 30-day lookback before the announced reduction. The announcement is derived from this app's own price history: if the reduction was announced another way, for example with a discount code or an automatic discount, record it so the evidence names what actually happened.";
  return result("R11", "product", "pass", message);
}

function formatDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

/**
 * R8 — two regimes, reported separately: the Rule 6(2) package-label contact
 * (name and address required, telephone and e-mail "if available") and the
 * e-commerce entity's platform customer care.
 */
function checkR8(store: StoreFacts): RuleResult {
  const labelMissing: string[] = [];
  if (!isFilled(store.consumerCare.storeName)) labelMissing.push("contact name");
  if (!isFilled(store.consumerCare.address)) labelMissing.push("contact address");

  // Two duties, two answers. The Rule 6(2) contact is printed on the pack; the
  // 2020 Rules require the e-commerce entity to publish its own customer care on
  // the platform. Accepting the pack's telephone or e-mail as the platform's
  // contact collapsed the two into one (audit item L10), so only the platform's
  // own published contact can satisfy the second half.
  const hasPlatformContact = isFilled(store.platformCustomerCareUrl);

  if (labelMissing.length > 0 || !hasPlatformContact) {
    const parts: string[] = [];
    if (labelMissing.length > 0) {
      parts.push(
        `the package-label contact needs a ${labelMissing.join(" and ")} for consumer complaints (Rule 6(2))`,
      );
    }
    if (!hasPlatformContact) {
      parts.push(
        "the e-commerce entity needs its own published customer-care contact, separate from the package-label contact (rule 4(2)(d) of the 2020 E-Commerce Rules)",
      );
    }
    return result("R8", "store", "fail", `Consumer care details are incomplete: ${parts.join("; ")}.`);
  }

  const optional = [
    isFilled(store.consumerCare.phone) ? null : "telephone",
    isFilled(store.consumerCare.email) ? null : "e-mail",
  ].filter((field): field is string => field !== null);

  return result(
    "R8",
    "store",
    "pass",
    `The complaint contact's name and address are filled, a platform customer-care contact is published${
      optional.length > 0
        ? `, and ${optional.join(" and ")} ${optional.length === 1 ? "is" : "are"} recorded as not available`
        : ""
    }.`,
  );
}

interface PolicyRequirement {
  key: keyof StorePolicies;
  /** The disclosure name used in messages. */
  name: string;
  /** False for the conditional items the audit describes as "where relevant". */
  required: boolean;
}

const POLICY_REQUIREMENTS: readonly PolicyRequirement[] = [
  { key: "returnPolicy", name: "return policy", required: true },
  { key: "refundPolicy", name: "refund policy", required: true },
  { key: "exchangePolicy", name: "exchange policy", required: true },
  { key: "warrantyPolicy", name: "warranty and guarantee", required: true },
  { key: "deliveryTerms", name: "delivery and shipment terms", required: true },
  { key: "paymentModes", name: "modes of payment", required: true },
  { key: "grievanceRedressal", name: "grievance-redressal information", required: true },
  { key: "otherInformation", name: "other pre-purchase information", required: true },
  { key: "returnShippingCost", name: "return shipping cost", required: true },
  { key: "useBeforeInfo", name: "best-before or use-before information", required: false },
];

function policyProvided(entry: PolicyEntry): boolean {
  return isFilled(entry.url) || isFilled(entry.text);
}

/**
 * R9 — the full 2020 disclosure set.
 *
 * A link is accepted only when it was checked, answered successfully, **and the
 * check is recent**. A page that answered eight months ago says nothing about
 * whether it answers today, so a check older than `policyLinkMaxAgeDays` is
 * treated exactly like one that never ran: unverified, not passing (audit item
 * L11). The nightly job re-checks every link, so a healthy store never drifts
 * back into this state on its own.
 */
function checkR9(store: StoreFacts, cfg: RuleConfig = RULES_CONFIG, now: Date = new Date()): RuleResult {
  const maxAgeDays = cfg.parameters.policyLinkMaxAgeDays ?? DEFAULT_POLICY_LINK_MAX_AGE_DAYS;
  const missing = POLICY_REQUIREMENTS.filter(
    (requirement) => requirement.required && !policyProvided(store.policies[requirement.key]),
  ).map((requirement) => requirement.name);

  const broken: string[] = [];
  const unverified: string[] = [];
  const stale: string[] = [];
  for (const requirement of POLICY_REQUIREMENTS) {
    const entry = store.policies[requirement.key];
    if (!isFilled(entry.url)) continue;
    const check = store.policyLinkChecks[requirement.key];
    if (!check) {
      unverified.push(requirement.name);
      continue;
    }
    if (isStalePolicyCheck(check.checkedAt, now, maxAgeDays)) {
      stale.push(requirement.name);
      continue;
    }
    if (!check.ok || check.contentSuspect) broken.push(requirement.name);
  }

  if (missing.length > 0 || broken.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`no link or text for ${missing.join(", ")}`);
    if (broken.length > 0) parts.push(`a link that did not load when last checked for ${broken.join(", ")}`);
    return result("R9", "store", "fail", `Pre-purchase disclosures are incomplete: ${parts.join("; ")}.`);
  }

  if (unverified.length > 0 || stale.length > 0) {
    const parts: string[] = [];
    if (unverified.length > 0) parts.push(`never checked: ${unverified.join(", ")}`);
    if (stale.length > 0)
      parts.push(
        `last checked more than ${maxAgeDays} day${maxAgeDays === 1 ? "" : "s"} ago: ${stale.join(", ")}`,
      );
    return result(
      "R9",
      "store",
      "inconclusive",
      `Every disclosure has a link or text, but the link is not currently verified for the following — ${parts.join(
        "; ",
      )}. Run the link check so the app can confirm the pages are live and readable. The app re-checks them nightly.`,
    );
  }

  return result(
    "R9",
    "store",
    "pass",
    `Every required pre-purchase disclosure has live, accessible content, checked within the last ${maxAgeDays} day${
      maxAgeDays === 1 ? "" : "s"
    }.`,
  );
}

function complaintEvidence(store: StoreFacts): ComplaintEvidence {
  return store.complaints ?? EMPTY_COMPLAINT_EVIDENCE;
}

/**
 * R10 — grievance officer displayed, plus evidence that the timings are met.
 *
 * The timings are read over a recent window (`complaintEvidenceLookbackMonths`,
 * app policy). The register itself is never pruned — it is the merchant's record
 * — but a single complaint acknowledged late two years ago would otherwise fail
 * this check for ever, with nothing the merchant could do to put it right. The
 * window is named in the message so it is visible rather than implied.
 */
function checkR10(store: StoreFacts, cfg: RuleConfig = RULES_CONFIG): RuleResult {
  const officer = store.grievanceOfficer;
  const missing: string[] = [];
  if (!isFilled(officer.name)) missing.push("name");
  if (!isFilled(officer.designation)) missing.push("designation");
  if (!isFilled(officer.email)) missing.push("email");
  if (!isFilled(officer.phone)) missing.push("phone");
  const fields = missing.map((field) => `grievance officer ${field}`);
  if (missing.length > 0) {
    return result(
      "R10",
      "store",
      "fail",
      `Grievance officer details are incomplete: ${missing.join(", ")}.`,
      fields,
    );
  }

  const complaints = complaintEvidence(store);
  const windowMonths = cfg.parameters.complaintEvidenceLookbackMonths ?? COMPLAINT_EVIDENCE_LOOKBACK_MONTHS;
  const windowNote = `of complaints received in the last ${windowMonths} month${windowMonths === 1 ? "" : "s"}`;
  if (complaints.overdueAcknowledgement > 0 || complaints.overdueResolution > 0) {
    const parts: string[] = [];
    if (complaints.overdueAcknowledgement > 0) {
      parts.push(
        `${complaints.overdueAcknowledgement} complaint${
          complaints.overdueAcknowledgement === 1 ? "" : "s"
        } not acknowledged within 48 hours`,
      );
    }
    if (complaints.overdueResolution > 0) {
      parts.push(
        `${complaints.overdueResolution} complaint${
          complaints.overdueResolution === 1 ? "" : "s"
        } not redressed within one month`,
      );
    }
    return result("R10", "store", "fail", `Complaint timings are not met: ${parts.join("; ")} (${windowNote}).`, [
      "complaints",
    ]);
  }

  if (store.blocks.grievance === "not_found") {
    return result(
      "R10",
      "store",
      "fail",
      "The grievance officer block is not live on the storefront.",
      ["grievance_block"],
    );
  }
  if (store.blocks.grievance === "unknown") {
    // Same rule for the store-level check: an unverifiable block is
    // inconclusive, not a failure.
    return result(
      "R10",
      "store",
      "inconclusive",
      "The grievance officer block could not be verified from the storefront. This check is left out of the score until it can be seen or you confirm the block in Store settings.",
      ["grievance_block"],
    );
  }

  const excluded =
    complaints.excludedByWindow && complaints.excludedByWindow > 0
      ? ` ${
          complaints.excludedByWindow === 1 ? "One older complaint is" : `${complaints.excludedByWindow} older complaints are`
        } in the register but outside that window, so ${
          complaints.excludedByWindow === 1 ? "it is" : "they are"
        } not counted; the register itself is never pruned.`
      : "";
  const evidence =
    complaints.total === 0
      ? ` No complaints are recorded in the last ${windowMonths} month${windowMonths === 1 ? "" : "s"}, so there is no acknowledgement or redressal timing to check.${excluded}`
      : ` ${complaints.total} complaint${complaints.total === 1 ? "" : "s"} recorded in the last ${windowMonths} month${
          windowMonths === 1 ? "" : "s"
        }, all within the 48-hour acknowledgement and one-month redressal periods.${excluded}`;
  return result(
    "R10",
    "store",
    "pass",
    `Grievance officer details are filled and displayed on the storefront.${evidence}`,
  );
}

/** R12 — dark-pattern self-audit; the 12-month cycle is labelled app policy. */
function checkR12(store: StoreFacts, cfg: RuleConfig, now: Date): RuleResult {
  if (!store.lastAuditAt) {
    return result("R12", "store", "fail", "No self-audit record was saved yet.", ["self_audit"]);
  }
  const months = cfg.parameters.auditValidityMonths;
  const expiresAt = addMonths(store.lastAuditAt, months);
  const policy = cfg.parameters.auditCadenceIsProductPolicy ? " (app policy, not a statutory cadence)" : "";
  if (now.getTime() > expiresAt.getTime()) {
    return result(
      "R12",
      "store",
      "fail",
      `The last self-audit (${formatDate(store.lastAuditAt)}) is more than ${months} months old${policy}.`,
      ["self_audit"],
    );
  }
  return result(
    "R12",
    "store",
    "pass",
    `Self-audit recorded on ${formatDate(store.lastAuditAt)}, within the ${months}-month cycle${policy}.`,
  );
}

export function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const daysInMonth = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(day, daysInMonth));
  return next;
}

const PRODUCT_CHECKS: Record<string, (product: ProductFacts, store: StoreFacts, cfg: RuleConfig) => RuleResult> = {
  R1: (product) => checkR1(product),
  R2: (product, store) => checkR2(product, store),
  R3: (product) => checkR3(product),
  R4: (product) => checkR4(product),
  R5: (product) => checkR5(product),
  R6: (product) => checkR6(product),
  R7: (product) => checkR7(product),
  R11: (product, store) => checkR11(product, store),
  R13: (product) => checkR13(product),
};

const STORE_CHECKS: Record<string, (store: StoreFacts, cfg: RuleConfig, now: Date) => RuleResult> = {
  R8: (store) => checkR8(store),
  R9: (store, cfg, now) => checkR9(store, cfg, now),
  R10: (store, cfg) => checkR10(store, cfg),
  R12: (store, cfg, now) => checkR12(store, cfg, now),
};

/** Runs every enabled product rule for one product, in config order. */
export function evaluateProductRules(
  product: ProductFacts,
  store: StoreFacts,
  cfg: RuleConfig = RULES_CONFIG,
): RuleResult[] {
  const results: RuleResult[] = [];
  for (const entry of ruleEntries(cfg)) {
    if (entry.level !== "product") continue;
    const check = PRODUCT_CHECKS[entry.id];
    if (!check) continue; // a rule id in the config with no implementation is skipped, not faked
    results.push(check(product, store, cfg));
  }
  return results;
}

/** Runs the store-level rules from store settings, block status, complaints and the audit record. */
export function evaluateStoreRules(
  store: StoreFacts,
  cfg: RuleConfig = RULES_CONFIG,
  now: Date = new Date(),
): RuleResult[] {
  const results: RuleResult[] = [];
  for (const entry of ruleEntries(cfg)) {
    if (entry.level !== "store") continue;
    const check = STORE_CHECKS[entry.id];
    if (!check) continue;
    results.push(check(store, cfg, now));
  }
  return results;
}

export function evaluateProduct(
  product: ProductFacts,
  store: StoreFacts,
  cfg: RuleConfig = RULES_CONFIG,
): ScanOutcome {
  const results = evaluateProductRules(product, store, cfg);
  const failingRuleIds = results.filter((r) => r.status === "fail").map((r) => r.ruleId);
  const inconclusiveRuleIds = results
    .filter((r) => r.status === "inconclusive")
    .map((r) => r.ruleId);
  return {
    productId: product.productId,
    handle: product.handle,
    title: product.title,
    vendor: product.vendor,
    productType: product.productType,
    status: rollUpStatus(failingRuleIds, inconclusiveRuleIds),
    passed: failingRuleIds.length === 0 && inconclusiveRuleIds.length === 0,
    failingRuleIds,
    inconclusiveRuleIds,
    results,
  };
}

/**
 * One product's rolled-up status. Failures win, then unresolved checks, then a
 * clean pass. Kept in one place so the scan, the stored rows and the exports
 * cannot disagree about what a product is.
 */
export function rollUpStatus(
  failingRuleIds: readonly string[],
  inconclusiveRuleIds: readonly string[],
): ScanStatus {
  if (failingRuleIds.length > 0) return "fail";
  if (inconclusiveRuleIds.length > 0) return "inconclusive";
  return "pass";
}

export interface RuleCount {
  ruleId: string;
  label: string;
  level: RuleLevel;
  pass: number;
  fail: number;
  notApplicable: number;
  /** Applicable, but the app could not determine the answer (for example the
   * storefront could not be read). Never counted as a failure. */
  inconclusive: number;
}

export interface ScanSummary {
  totalProducts: number;
  passingProducts: number;
  failingProducts: number;
  /** Products whose only unresolved checks are inconclusive ones. */
  inconclusiveProducts: number;
  /** Products the score is computed over: total minus inconclusive. */
  scoredProducts: number;
  /**
   * passingProducts / scoredProducts. Inconclusive products are removed from
   * the denominator so an unverifiable block check cannot depress the score.
   */
  scorePercent: number;
  /** passingProducts / totalProducts, kept for the plain "share of catalogue" number. */
  rawScorePercent: number;
  byRule: RuleCount[];
}

export function summariseScan(
  outcomes: ScanOutcome[],
  cfg: RuleConfig = RULES_CONFIG,
): ScanSummary {
  const total = outcomes.length;
  let passing = 0;
  let failing = 0;
  let inconclusive = 0;
  for (const outcome of outcomes) {
    const status = outcome.status ?? rollUpStatus(outcome.failingRuleIds, outcome.inconclusiveRuleIds ?? []);
    if (status === "fail") failing += 1;
    else if (status === "inconclusive") inconclusive += 1;
    else passing += 1;
  }
  const scored = total - inconclusive;
  const byRule: RuleCount[] = ruleEntries(cfg).map((entry) => {
    let pass = 0;
    let fail = 0;
    let notApplicable = 0;
    let unknown = 0;
    for (const outcome of outcomes) {
      const match = outcome.results.find((r) => r.ruleId === entry.id);
      if (!match || match.status === "not_applicable") notApplicable += 1;
      else if (match.status === "pass") pass += 1;
      else if (match.status === "inconclusive") unknown += 1;
      else fail += 1;
    }
    return {
      ruleId: entry.id,
      label: entry.label,
      level: entry.level,
      pass,
      fail,
      notApplicable,
      inconclusive: unknown,
    };
  });
  return {
    totalProducts: total,
    passingProducts: passing,
    failingProducts: failing,
    inconclusiveProducts: inconclusive,
    scoredProducts: scored,
    scorePercent: scorePercent(passing, scored),
    rawScorePercent: scorePercent(passing, total),
    byRule,
  };
}

/** Products passing every applicable product rule / total products. */
export function scorePercent(passing: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((passing / total) * 100);
}
