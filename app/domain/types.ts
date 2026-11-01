/**
 * Shared domain types.
 *
 * Everything in `app/domain` is pure: no network, no database, no Shopify SDK.
 * That is what makes the rule engine, the prior-price algorithm, the CSV codec
 * and the plan limits testable without a Shopify dev store or a Postgres server.
 */

export type RuleLevel = "product" | "store";

/**
 * A rule passes, fails, does not apply to this product/store, or — and this is
 * the important one — could not be determined from the data available.
 *
 * `inconclusive` exists because the app must never punish a merchant for
 * something it could not check. R2, R10 and R11 depend on seeing the theme app
 * block on the live storefront; when the storefront is password-protected,
 * unreachable, or simply does not render the sampled page, the honest answer is
 * "we could not tell", not "fail". Inconclusive results are excluded from the
 * score denominator and reported separately, so a merchant who installed a block
 * correctly never sees a lower score because the check could not look.
 */
export type RuleStatus = "pass" | "fail" | "not_applicable" | "inconclusive";

/** The rolled-up status of one product across every applicable product rule. */
export type ScanStatus = "pass" | "fail" | "inconclusive";

/**
 * When the commodity may become unfit for human consumption, Rule 6(1)(da)
 * requires a best-before or use-by date as well as the manufacture/pre-packing
 * date. `none` means the commodity is not one of those, not that the merchant
 * has switched the date check off: the manufacture/pre-packing date is a
 * separate, generally applicable declaration.
 */
export type ExpiryType = "none" | "best_before" | "use_by";

/**
 * Package scope. Rules 3 and 26 exclude some packages from the retail
 * declaration regime entirely, and combination / multi-piece packages are
 * treated separately (audit item L1). The merchant marks the package type; the
 * app never guesses it from the product title.
 */
export type PackageType = "packaged" | "combination" | "multi_piece" | "wholesale" | "excluded";

export const PACKAGE_TYPES: readonly PackageType[] = [
  "packaged",
  "combination",
  "multi_piece",
  "wholesale",
  "excluded",
] as const;

/**
 * Rule 13 net-quantity units. `cm` was missing before the audit; the count
 * descriptors (number, unit, piece, pair, set) are the vocabulary the rule
 * permits where a commodity is sold by number. `pcs` was an app invention and is
 * now read as `piece` for backwards compatibility.
 */
export const NET_QUANTITY_UNITS = [
  "g",
  "kg",
  "ml",
  "l",
  "cm",
  "m",
  "number",
  "unit",
  "piece",
  "pair",
  "set",
] as const;
export type NetQuantityUnit = (typeof NET_QUANTITY_UNITS)[number];

/** Old spellings accepted on read and normalised on write. */
const LEGACY_UNIT_ALIASES: Record<string, NetQuantityUnit> = {
  pcs: "piece",
  pc: "piece",
  nos: "number",
  ltr: "l",
  litre: "l",
  liter: "l",
  gm: "g",
  gram: "g",
  mtr: "m",
};

export function normaliseQuantityUnit(input: string | null | undefined): NetQuantityUnit | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  if ((NET_QUANTITY_UNITS as readonly string[]).includes(value)) return value as NetQuantityUnit;
  return LEGACY_UNIT_ALIASES[value] ?? null;
}

/**
 * The declared legal values read from / written to `legal_in.*` metafields.
 *
 * The shape follows the audit's separation of duties:
 *  - manufacturer, packer, importer and seller/dealer are separate (L4);
 *  - the canonical country and the exact label wording are separate (L5);
 *  - imported-package status is explicit rather than inferred from origin (L6);
 *  - manufacture/pre-packing and best-before/use-by are separate (L9);
 *  - the common name carries an "is it on the pack" evidence flag (L8);
 *  - unit sale price is a first-class declaration (L1).
 */
export interface LegalFields {
  /** R1 — maximum retail price, inclusive of all taxes (Rule 2(m), 6(1)(e)). */
  mrp: number | null;
  /**
   * R1 — a per-variant declared price where a variant is a separate package.
   * One MRP is not automatically applied to every package/variant (audit L3).
   */
  variantMrp: Record<string, number> | null;

  /** R2 — manufacturer's name and address, as printed (Rule 6(1)(a)). */
  manufacturerName: string | null;
  manufacturerAddress: string | null;
  /** R2 — true when the packer is a different person from the manufacturer. */
  packerDiffersFromManufacturer: boolean | null;
  packerName: string | null;
  packerAddress: string | null;
  /** R2 — dealer/seller data where the package carries it. */
  sellerName: string | null;
  sellerAddress: string | null;

  /** R3 — canonical country of origin (e.g. "India"). */
  countryOfOrigin: string | null;
  /** R3 — the exact wording on the package or label (e.g. "Made in India"). */
  countryOfOriginLabel: string | null;

  /** R4 — explicit imported-package status (not a proxy on country code). */
  isImportedPackage: boolean | null;
  importerName: string | null;
  importerAddress: string | null;

  /** R5 — package scope under Rules 3 and 26. */
  packageType: PackageType;
  netQuantityValue: number | null;
  netQuantityUnit: NetQuantityUnit | null;

  /** R6 — common/generic name, and whether it is printed on the pack. */
  genericName: string | null;
  genericNameOnLabel: boolean;

  /** R7 — month/year of manufacture or pre-packing (MM/YYYY), generally required. */
  manufacturedDate: string | null;
  /** R7 — best-before/use-by where the commodity may become unfit (Rule 6(1)(da)). */
  expiryType: ExpiryType;
  expiryDate: string | null;

  /** R13 — unit sale price per standard unit, rounded to the nearest two decimals. */
  unitSalePrice: number | null;
}

export const EMPTY_LEGAL_FIELDS: LegalFields = {
  mrp: null,
  variantMrp: null,
  manufacturerName: null,
  manufacturerAddress: null,
  packerDiffersFromManufacturer: null,
  packerName: null,
  packerAddress: null,
  sellerName: null,
  sellerAddress: null,
  countryOfOrigin: null,
  countryOfOriginLabel: null,
  isImportedPackage: null,
  importerName: null,
  importerAddress: null,
  packageType: "packaged",
  netQuantityValue: null,
  netQuantityUnit: null,
  genericName: null,
  genericNameOnLabel: false,
  manufacturedDate: null,
  expiryType: "none",
  expiryDate: null,
  unitSalePrice: null,
};

/** Field labels used by the bulk editor, CSV headings and error messages. */
export const LEGAL_FIELD_LABELS: Record<keyof LegalFields, string> = {
  mrp: "MRP (inclusive of all taxes)",
  variantMrp: "MRP per variant",
  manufacturerName: "Manufacturer name",
  manufacturerAddress: "Manufacturer address",
  packerDiffersFromManufacturer: "Packer differs from manufacturer",
  packerName: "Packer name",
  packerAddress: "Packer address",
  sellerName: "Seller / dealer name",
  sellerAddress: "Seller / dealer address",
  countryOfOrigin: "Country of origin",
  countryOfOriginLabel: "Country of origin as printed on the pack",
  isImportedPackage: "Imported package",
  importerName: "Importer name",
  importerAddress: "Importer address",
  packageType: "Package type",
  netQuantityValue: "Net quantity (value)",
  netQuantityUnit: "Net quantity (unit)",
  genericName: "Common / generic name",
  genericNameOnLabel: "Common name printed on the pack",
  manufacturedDate: "Month/year of manufacture or pre-packing",
  expiryType: "Best-before / use-by type",
  expiryDate: "Best-before / use-by month and year",
  unitSalePrice: "Unit sale price",
};

export interface VariantFacts {
  variantId: string;
  title: string;
  price: number;
  compareAtPrice: number | null;
  /** Result of the prior-price algorithm for this variant, when any history exists. */
  priorPrice: VariantPriorPrice | null;
}

export interface ProductFacts {
  productId: string;
  handle: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  status: string;
  legal: LegalFields;
  variants: VariantFacts[];
  /** `legal_in.prior_price` storefront metafield is present and current for this product. */
  priorPricePublished: boolean;
}

/** How confident we are that a theme app block is live on the storefront. */
export type BlockStatus = "detected" | "confirmed_manual" | "not_found" | "unknown";

export interface BlockStatuses {
  declarations: BlockStatus;
  grievance: BlockStatus;
  priorPrice: BlockStatus;
}

export interface PolicyEntry {
  url: string | null;
  text: string | null;
}

/**
 * The result of the last accessibility check on a policy link. A link is only
 * acceptable if it is live and readable, so R9 depends on this rather than on the
 * merchant's word (audit item L11: "validate link accessibility/content").
 */
export interface PolicyLinkCheck {
  url: string;
  ok: boolean;
  status: number | null;
  checkedAt: Date;
  /** True when the page was fetched but looked empty or was a redirect loop. */
  contentSuspect?: boolean;
  error?: string | null;
}

/**
 * Rule 6(2) package-label contact — the person or office contactable for
 * consumer complaints. Deliberately separate from the e-commerce entity's
 * platform contact details, which the 2020 Rules require separately (audit L10).
 */
export interface ConsumerCare {
  /** Name of the person or office contactable for complaints. */
  storeName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
}

export interface GrievanceOfficer {
  name: string | null;
  designation: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * The disclosure set the 2020 E-Commerce Rules require. The audit's L11 finding
 * is that the old six-item list was incomplete: return, refund, exchange,
 * warranty and guarantee, delivery/shipment, modes of payment, grievance
 * redressal and other pre-purchase information, plus return-shipping cost and,
 * where relevant, best-before/use-before information.
 */
export interface StorePolicies {
  returnPolicy: PolicyEntry;
  refundPolicy: PolicyEntry;
  exchangePolicy: PolicyEntry;
  warrantyPolicy: PolicyEntry;
  deliveryTerms: PolicyEntry;
  returnShippingCost: PolicyEntry;
  paymentModes: PolicyEntry;
  grievanceRedressal: PolicyEntry;
  otherInformation: PolicyEntry;
  useBeforeInfo: PolicyEntry;
}

/**
 * How far back the complaint register is read for R10's timings.
 *
 * A register that is never pruned makes one late complaint from 2019 fail the
 * store check forever, with no way to put it right. This window is the app's own
 * policy for what "are the timings being met now" means; the 48-hour and
 * one-month periods themselves are statutory and are not changed by it. Tunable
 * in `rules.config.json` as `complaintEvidenceLookbackMonths`.
 */
export const COMPLAINT_EVIDENCE_LOOKBACK_MONTHS = 12;

/** Operational complaint evidence behind the 48-hour / one-month duties (L12). */
export interface ComplaintEvidence {
  total: number;
  open: number;
  /** Acknowledged more than 48 hours after receipt. */
  overdueAcknowledgement: number;
  /** Unresolved more than one month after receipt. */
  overdueResolution: number;
  /** Most recent complaint received, for the message. */
  lastReceivedAt: Date | null;
  /**
   * Complaints in the register but outside the evidence window, so not counted.
   * Reported rather than dropped silently, so a merchant who wonders why their
   * register total differs from R10's number can see why.
   */
  excludedByWindow?: number;
}

export const EMPTY_COMPLAINT_EVIDENCE: ComplaintEvidence = {
  total: 0,
  open: 0,
  overdueAcknowledgement: 0,
  overdueResolution: 0,
  lastReceivedAt: null,
};

export interface StoreFacts {
  shopDomain: string;
  consumerCare: ConsumerCare;
  grievanceOfficer: GrievanceOfficer;
  /** The e-commerce entity's own customer-care surface (2020 Rules, Rule 4(2)(d)). */
  platformCustomerCareUrl: string | null;
  policies: StorePolicies;
  /** Last accessibility check per policy key; missing key = never checked. */
  policyLinkChecks: Record<string, PolicyLinkCheck>;
  blocks: BlockStatuses;
  complaints: ComplaintEvidence;
  lastAuditAt: Date | null;
  installDate: Date;
  /** = installDate; the date full 30-day price history is available is installDate + 30 days. */
  priceTrackingStart: Date;
}

export interface RuleResult {
  ruleId: string;
  level: RuleLevel;
  status: RuleStatus;
  /** One short sentence shown in the dashboard and exports. Contains no legal claims. */
  message: string;
  /** Machine-readable list of the fields that caused a failure. */
  fields?: string[];
}

export interface ScanOutcome {
  productId: string;
  handle: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  /** Rolled-up status: any failure makes it "fail", otherwise any unknown check
   * makes it "inconclusive", otherwise "pass". */
  status: ScanStatus;
  /** True only when every applicable product rule passed. */
  passed: boolean;
  failingRuleIds: string[];
  /** Rules that could not be determined (currently R2/R11 when a block cannot be seen). */
  inconclusiveRuleIds: string[];
  results: RuleResult[];
}

export interface VariantPriorPrice {
  variantId: string;
  priorPrice: number | null;
  /** True when a full 30-day window was tracked before the current price took effect. */
  historyComplete: boolean;
  /**
   * True when the announcement behind this prior price was **recorded** by the
   * merchant (a discount code, an automatic discount, or a dated price change
   * they entered) rather than derived from the app's own price snapshots.
   *
   * Derived announcements are still evidence — the app saw the price move — but
   * only a recorded one can name a mechanism the app cannot see, such as a code
   * applied at checkout (audit item L13).
   */
  announcementRecorded: boolean;
  /** Date from which price history is being tracked (= install date). */
  trackedSince: Date;
  /** Tracked since + window; after this date history is complete for every product. */
  completeBy: Date;
  windowDays: number;
  /** Days of history actually available before the price took effect, capped at window. */
  daysOfHistory: number;
  hasSnapshots: boolean;
  /**
   * The announced reduction this prior price belongs to: the moment the current
   * consumer-facing price took effect. Recorded so the prior-price evidence names
   * an announcement event, not merely a variant price change (audit L13).
   */
  announcement: PriceAnnouncement | null;
}

/**
 * How a reduction reaches the shopper.
 *
 * `variant_price` and `compare_at` are the two the app can see through the Admin
 * API. `discount_code` and `automatic_discount` are the two it cannot: they are
 * applied at checkout, so no variant price moves. The audit (L13) is explicit
 * that a code or automatic discount that *announces* a reduction is not
 * categorically outside the rule, so both are first-class mechanisms the merchant
 * can record — the app no longer claims they are out of scope.
 */
export const PRICE_ANNOUNCEMENT_MECHANISMS = [
  "variant_price",
  "compare_at",
  "automatic_discount",
  "discount_code",
] as const;

export type PriceAnnouncementMechanism = (typeof PRICE_ANNOUNCEMENT_MECHANISMS)[number];

/** Labels for the announcement form and for the rule messages. */
export const PRICE_ANNOUNCEMENT_MECHANISM_LABELS: Record<PriceAnnouncementMechanism, string> = {
  variant_price: "Selling price reduced on the variant",
  compare_at: "Compare-at price set above the selling price",
  automatic_discount: "Automatic discount applied at checkout",
  discount_code: "Discount code",
};

export function isPriceAnnouncementMechanism(value: unknown): value is PriceAnnouncementMechanism {
  return typeof value === "string" && (PRICE_ANNOUNCEMENT_MECHANISMS as readonly string[]).includes(value);
}

/**
 * A price-reduction announcement. The audit (L13) requires the app to record the
 * announcement event, the consumer-facing price, the conditions and the
 * variant/good identity — a discount code or automatic discount that announces a
 * reduction is not categorically excluded by the text reviewed.
 */
export interface PriceAnnouncement {
  /** When the reduction was announced / took effect. */
  announcedAt: Date;
  /** The price the shopper actually sees. */
  consumerPrice: number;
  /** How the reduction reaches the shopper. */
  mechanism: PriceAnnouncementMechanism;
  /** Free-text conditions (for example a code, minimum basket, market). */
  conditions: string | null;
}

// ---------------------------------------------------------------------------
// Legacy metafield values written by earlier releases
// ---------------------------------------------------------------------------
/**
 * Two column shapes predate the current field set:
 *
 *  - `importer_details` held the importer's name and address in one string;
 *  - `date_type` + `date_value` held a single date that was either the
 *    month/year of manufacture or a best-before/use-by month and year.
 *
 * Both are still read so a store installed before this release keeps its
 * declarations, and the mapping lives here, once, because it used to be written
 * twice and the two copies disagreed: the CSV importer read `date_type=none`
 * (and an empty type) as a manufacture date while the metafield parser ignored
 * exactly those two values, so a value that imported cleanly vanished again on
 * the next scan.
 *
 * Neither shape is allowed to set `isImportedPackage`: the audit (L6) rejected
 * inferring import status from anything other than the merchant's own flag, and
 * a legacy importer string is the same inference wearing a different hat. The
 * importer's name and address are still recovered; only the flag is left
 * undeclared, which is what makes R4 report the inference instead of assuming it.
 */
export interface LegacyImporterDetails {
  name: string | null;
  address: string | null;
}

export function parseLegacyImporterDetails(value: string | null | undefined): LegacyImporterDetails | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const [name, ...rest] = trimmed.split(",");
  const importerName = (name ?? "").trim() || null;
  const importerAddress = rest.join(",").trim() || null;
  if (!importerName && !importerAddress) return null;
  return { name: importerName, address: importerAddress };
}

export interface LegacyDateFields {
  manufacturedDate: string | null;
  expiryType: ExpiryType;
  expiryDate: string | null;
}

/** `date_type=none` and an empty type both mean "this is a manufacture date". */
export function parseLegacyDateFields(
  dateType: string | null | undefined,
  dateValue: string | null | undefined,
): LegacyDateFields | null {
  if (typeof dateValue !== "string") return null;
  const value = dateValue.trim();
  if (!value) return null;
  const type = (dateType ?? "").trim().toLowerCase();
  if (type === "best_before" || type === "use_by") {
    return { manufacturedDate: null, expiryType: type, expiryDate: value };
  }
  return { manufacturedDate: value, expiryType: "none", expiryDate: null };
}
