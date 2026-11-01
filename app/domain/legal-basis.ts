/**
 * The legal basis register.
 *
 * The audit (India Legal Metrology & MRP — Audit Results, 31 Oct 2026) rejects a
 * single "these rules start on 1 January 2027" story. Four different things are
 * in play at the same time:
 *
 *   1. duties that are **already operative** (Legal Metrology package
 *      declarations; the 2020 Consumer Protection (E-Commerce) Rules; the 2023
 *      Dark Patterns Guidelines);
 *   2. a Legal Metrology duty whose **final relevant commencement** was
 *      1 January 2024 (unit sale price, Rule 6(11));
 *   3. a **notified but not verifiable** instrument — the 2026 E-Commerce
 *      amendment, whose official copy prints missing/garbled G.S.R. and
 *      commencement fields (audit item L2 / item 23);
 *   4. a **deferred** Legal Metrology filter — G.S.R. 128(E) notified a
 *      country-of-origin filter from 1 July 2026, and the later G.S.R. 312(E)
 *      substituted/deferred it to 1 July 2027 (audit item L15).
 *
 * Everything the app says about dates comes from this file, so no screen, export
 * or listing can quietly present the 2026 amendment as Gazette-verified or the
 * country filter as already enforceable. `verifiedAgainstGazette` on the rule
 * config stays `false` until a reviewer signs each rule (audit item 23).
 */

export type InstrumentStatus =
  /** Operative now. */
  | "in_force"
  /** Notified, but the available official copy does not establish a complete commencement. */
  | "notified_commencement_unverified"
  /** Notified and later deferred/substituted by a subsequent instrument. */
  | "notified_deferred"
  /** Background only: a draft, not the controlling instrument. */
  | "draft_background";

export interface Instrument {
  id: string;
  /** Short label for UI copy. */
  shortName: string;
  /** G.S.R. number / rule reference, exactly as the audit states it. */
  citation: string;
  status: InstrumentStatus;
  /** ISO date (YYYY-MM-DD) the provision takes effect, or null when not established. */
  effectiveFrom: string | null;
  /**
   * True only where the audit establishes the date from the instrument itself.
   * Never true for the 2026 E-Commerce amendment: its commencement fields are
   * missing/garbled in the official copy available here.
   */
  commencementVerified: boolean;
  /** What the app may and may not say about this instrument. */
  note: string;
  /** Rule ids whose evaluation depends on this instrument. */
  ruleIds: string[];
}

export const INSTRUMENTS: readonly Instrument[] = [
  {
    id: "LM_PCR_2011",
    shortName: "Legal Metrology (Packaged Commodities) Rules, 2011",
    citation:
      "Legal Metrology (Packaged Commodities) Rules, 2011, G.S.R. 202(E) — Rules 2(m), 3, 6(1)(a)-(e), 6(2), 6(10), 13, 18(2), 26",
    status: "in_force",
    effectiveFrom: null,
    commencementVerified: true,
    note:
      "Already operative. The package declarations (manufacturer, net quantity, common name, MRP, month/year of manufacture or pre-packing) and the ban on selling above the retail sale price are current duties, not a 2027 deadline.",
    ruleIds: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R13"],
  },
  {
    id: "LM_PCR_USP_2022",
    shortName: "Unit sale price amendment (Rule 6(11))",
    citation:
      "Legal Metrology (Packaged Commodities) Amendment Rules — Rule 6(11), as amended by G.S.R. 779(E) dated 2 November 2021 and G.S.R. 226(E) dated 28 March 2022",
    status: "in_force",
    effectiveFrom: "2024-01-01",
    commencementVerified: true,
    note:
      "Unit sale price must be declared in the applicable standard unit, rounded to the nearest two decimal places, for covered pre-packaged commodities. The final relevant commencement moved to 1 January 2024; this is not a 2027 rule. It does not apply where the retail sale price equals the unit sale price, and Rules 3 and 26 add scope exclusions.",
    ruleIds: ["R13"],
  },
  {
    id: "CP_ECOM_2020",
    shortName: "Consumer Protection (E-Commerce) Rules, 2020",
    citation:
      "Consumer Protection (E-Commerce) Rules, 2020 — Rules 4(2)(d), 4(4), 4(5), 5(3)(c), 6(5)(d), 7(1)(a)",
    status: "in_force",
    effectiveFrom: null,
    commencementVerified: true,
    note:
      "Already operative, and they apply to marketplace and inventory models including D2C stores. Platform/customer-care information and grievance-officer display, acknowledgement within 48 hours and redressal within one month are current duties.",
    ruleIds: ["R8", "R9", "R10"],
  },
  {
    id: "CP_ECOM_2026",
    shortName: "Consumer Protection (E-Commerce) (Amendment) Rules, 2026",
    citation:
      "Consumer Protection (E-Commerce) (Amendment) Rules, 2026 — inserted prior-price provision after Rule 4(11), commonly numbered 4(13) in the available text",
    status: "notified_commencement_unverified",
    effectiveFrom: null,
    commencementVerified: false,
    note:
      "Notified, but the official eGazette copy available for review prints the G.S.R. and commencement fields with missing/garbled values. A 1 January 2027 date was supplied for review and is used only as a supplied date in this app; it must not be described as Gazette-verified.",
    ruleIds: ["R11", "R12"],
  },
  {
    id: "CP_ECOM_2026_SUPPLIED_DATE",
    shortName: "Supplied commencement date for the 2026 E-Commerce amendment",
    citation: "Supplied with the review brief; not read from a legible official Gazette copy",
    status: "notified_commencement_unverified",
    effectiveFrom: "2027-01-01",
    commencementVerified: false,
    note:
      "A supplied date, recorded so the countdown and the price-history preparation advice can be shown. It is not evidence of commencement and must be re-confirmed against a legible official copy before any public claim relies on it.",
    ruleIds: ["R11", "R12"],
  },
  {
    id: "DARK_PATTERNS_2023",
    shortName: "Guidelines for Prevention and Regulation of Dark Patterns, 2023",
    citation: "Guidelines for Prevention and Regulation of Dark Patterns, 2023 — clauses 3-7 and Annexure 1",
    status: "in_force",
    effectiveFrom: null,
    commencementVerified: true,
    note:
      "The 13 patterns named in Annexure 1 are current. The Guidelines do not prescribe an 11-month reminder or a 12-month validity period: both are product policy in this app. The later yearly self-audit and certificate wording belongs to the 2026 E-Commerce amendment, not to these Guidelines.",
    ruleIds: ["R12"],
  },
  {
    id: "LM_PCR_COUNTRY_FILTER_2026",
    shortName: "Country-of-origin filter",
    citation:
      "Legal Metrology (Packaged Commodities) First Amendment Rules, 2026, G.S.R. 128(E) dated 13 February 2026, as substituted/deferred by the Second Amendment Rules, 2026, G.S.R. 312(E) dated 27 April 2026",
    status: "notified_deferred",
    effectiveFrom: "2027-07-01",
    commencementVerified: true,
    note:
      "G.S.R. 128(E) notified a searchable/sortable country-of-origin filter for imported products with a 1 July 2026 commencement. The later G.S.R. 312(E), issued before that date, substitutes/defers the filter to 1 July 2027 and therefore controls the current schedule. As at 31 October 2026 the filter is a notified future requirement, not a currently enforceable duty.",
    ruleIds: ["R3"],
  },
  {
    id: "COUNTRY_FILTER_DRAFT_2025",
    shortName: "November 2025 draft country-of-origin filter",
    citation: "Draft amendment dated 10 November 2025",
    status: "draft_background",
    effectiveFrom: null,
    commencementVerified: false,
    note:
      "Background only. Superseded as the controlling instrument by G.S.R. 128(E) and then by G.S.R. 312(E); never describe the filter as merely a draft or as already enforceable.",
    ruleIds: ["R3"],
  },
] as const;

const BY_ID = new Map(INSTRUMENTS.map((instrument) => [instrument.id, instrument]));

export function instrument(id: string): Instrument | null {
  return BY_ID.get(id) ?? null;
}

/** Instruments behind one rule id, in register order. */
export function instrumentsForRule(ruleId: string): Instrument[] {
  return INSTRUMENTS.filter((entry) => entry.ruleIds.includes(ruleId));
}

/** The country-of-origin filter instrument, used by the help page and R3 copy. */
export const COUNTRY_FILTER_INSTRUMENT = instrument("LM_PCR_COUNTRY_FILTER_2026")!;

/** The 2026 E-Commerce amendment instrument (commencement unverified). */
export const ECOM_2026_INSTRUMENT = instrument("CP_ECOM_2026")!;

/** Unit sale price instrument. */
export const USP_INSTRUMENT = instrument("LM_PCR_USP_2022")!;

/**
 * The date used by the app's countdown. It is the *supplied* date, kept in one
 * place and always labelled as supplied rather than Gazette-verified.
 */
export const SUPPLIED_2026_COMMENCEMENT = new Date(
  Date.UTC(2027, 0, 1, 0, 0, 0),
);

/** 1 July 2027 — country-of-origin filter under G.S.R. 312(E). */
export const COUNTRY_FILTER_EFFECTIVE_FROM = new Date(
  Date.UTC(2027, 6, 1, 0, 0, 0),
);

export function formatInstrumentDate(isoDate: string | null): string {
  if (!isoDate) return "date not established from the available text";
  const [year, month, day] = isoDate.split("-").map((part) => Number(part));
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
  if (!year || !month || !day) return isoDate;
  return `${day} ${months[month - 1]} ${year}`;
}

/** One line a screen or export can print about an instrument, with its caveat. */
export function describeInstrument(id: string): string {
  const entry = instrument(id);
  if (!entry) return "";
  const date = entry.effectiveFrom ? ` Effective ${formatInstrumentDate(entry.effectiveFrom)}.` : "";
  const caveat = entry.commencementVerified ? "" : " Commencement not verified against a legible Gazette copy.";
  return `${entry.shortName}: ${entry.citation}.${date}${caveat}`;
}

/** The three groups of duties the app must not merge (audit item 2). */
export interface RegimeSummary {
  id: string;
  title: string;
  body: string;
  status: InstrumentStatus;
  /** Present only where the app has an established date to show. */
  effectiveFrom: string | null;
  verified: boolean;
}

export function regimeSummaries(): RegimeSummary[] {
  return [
    {
      id: "current_lm",
      title: "Legal Metrology package declarations — in force now",
      body:
        "MRP inclusive of all taxes, manufacturer (and packer/importer where they apply), country of origin, net quantity, common name and the month/year of manufacture or pre-packing apply to covered pre-packaged commodities today.",
      status: "in_force",
      effectiveFrom: null,
      verified: true,
    },
    {
      id: "current_ecom",
      title: "Consumer Protection (E-Commerce) Rules, 2020 — in force now",
      body:
        "Platform and customer-care information, the grievance officer with acknowledgement within 48 hours and redressal within one month, and the seller/platform disclosure duties apply today to marketplace and inventory (D2C) models.",
      status: "in_force",
      effectiveFrom: null,
      verified: true,
    },
    {
      id: "usp",
      title: "Unit sale price — in force since 1 January 2024",
      body:
        "Rule 6(11) requires the unit sale price in the applicable standard unit, rounded to the nearest two decimal places, for covered packages. The available primary text does not establish a blanket e-commerce exemption.",
      status: "in_force",
      effectiveFrom: "2024-01-01",
      verified: true,
    },
    {
      id: "dark_patterns",
      title: "Dark Patterns Guidelines, 2023 — in force now",
      body:
        "The 13 patterns in Annexure 1 are current. The yearly self-audit cycle in this app is its own product policy, not a statutory cadence.",
      status: "in_force",
      effectiveFrom: null,
      verified: true,
    },
    {
      id: "ecom_2026",
      title: "Consumer Protection (E-Commerce) (Amendment) Rules, 2026 — notified, commencement unverified",
      body:
        "The prior-price provision (after Rule 4(11)) and the yearly self-audit/certificate wording come from this instrument. The official copy available to this app has missing/garbled G.S.R. and commencement fields, so the 1 January 2027 date shown in this app is a supplied date, not a Gazette-verified one.",
      status: "notified_commencement_unverified",
      effectiveFrom: "2027-01-01",
      verified: false,
    },
    {
      id: "country_filter",
      title: "Country-of-origin filter — notified, deferred to 1 July 2027",
      body:
        "G.S.R. 128(E) notified the searchable/sortable filter from 1 July 2026; the later G.S.R. 312(E) substitutes/defers it to 1 July 2027 and controls the current schedule. Prepare for it, but it is not enforceable today.",
      status: "notified_deferred",
      effectiveFrom: "2027-07-01",
      verified: true,
    },
  ];
}

/**
 * The one-line status the app shows wherever it used to claim a single
 * "1 January 2027" deadline for every rule.
 */
export function commencementDisclaimer(): string {
  return (
    "Some duties are in force now, unit sale price has been in force since 1 January 2024, and the 2026 " +
    "E-Commerce amendment is notified with an unverified commencement. The country-of-origin filter is deferred " +
    "to 1 July 2027 by G.S.R. 312(E). This checklist has not been verified against the Gazette."
  );
}
