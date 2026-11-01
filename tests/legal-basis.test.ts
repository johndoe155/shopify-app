/**
 * The legal basis register.
 *
 * Every date the app prints comes from this file. The audit's repeated failure
 * was a single "these rules start on 1 January 2027" story, so the register is
 * tested as a whole: no instrument may claim a commencement it does not have
 * evidence for, and the three deferred/unverified instruments must keep saying
 * so however the copy around them is edited.
 */
import { describe, expect, it } from "vitest";
import {
  COUNTRY_FILTER_EFFECTIVE_FROM,
  COUNTRY_FILTER_INSTRUMENT,
  ECOM_2026_INSTRUMENT,
  INSTRUMENTS,
  SUPPLIED_2026_COMMENCEMENT,
  USP_INSTRUMENT,
  commencementDisclaimer,
  describeInstrument,
  formatInstrumentDate,
  instrument,
  instrumentsForRule,
  regimeSummaries,
} from "~/domain/legal-basis";
import { ruleEntries } from "~/domain/rules";

describe("the register", () => {
  it("has unique ids", () => {
    const ids = INSTRUMENTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries a citation, a note and at least one rule for every entry", () => {
    for (const entry of INSTRUMENTS) {
      expect(entry.citation.length, entry.id).toBeGreaterThan(10);
      expect(entry.note.length, entry.id).toBeGreaterThan(20);
      expect(entry.ruleIds.length, entry.id).toBeGreaterThan(0);
      expect(entry.shortName.length, entry.id).toBeGreaterThan(5);
    }
  });

  it("only claims a date where it has evidence for one", () => {
    // An effectiveFrom date is a public claim: it must not be set on an
    // instrument whose commencement was never established.
    for (const entry of INSTRUMENTS) {
      if (entry.status === "notified_commencement_unverified" && !entry.commencementVerified) {
        expect(entry.commencementVerified, entry.id).toBe(false);
      }
      if (entry.status === "draft_background") {
        expect(entry.commencementVerified, entry.id).toBe(false);
      }
    }
  });

  it("never marks the 2026 e-commerce amendment as verified", () => {
    // Audit item L2 / item 23: the official copy available here prints missing
    // and garbled G.S.R. and commencement fields.
    expect(ECOM_2026_INSTRUMENT.status).toBe("notified_commencement_unverified");
    expect(ECOM_2026_INSTRUMENT.commencementVerified).toBe(false);
    expect(ECOM_2026_INSTRUMENT.effectiveFrom).toBeNull();
  });

  it("keeps the supplied 2026 date labelled as supplied", () => {
    const supplied = instrument("CP_ECOM_2026_SUPPLIED_DATE")!;
    expect(supplied.effectiveFrom).toBe("2027-01-01");
    expect(supplied.commencementVerified).toBe(false);
    expect(supplied.citation.toLowerCase()).toContain("supplied");
    expect(SUPPLIED_2026_COMMENCEMENT.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("treats G.S.R. 312(E) as the instrument that controls the country filter", () => {
    expect(COUNTRY_FILTER_INSTRUMENT.status).toBe("notified_deferred");
    expect(COUNTRY_FILTER_INSTRUMENT.citation).toContain("G.S.R. 128(E)");
    expect(COUNTRY_FILTER_INSTRUMENT.citation).toContain("G.S.R. 312(E)");
    expect(COUNTRY_FILTER_INSTRUMENT.effectiveFrom).toBe("2027-07-01");
    expect(COUNTRY_FILTER_EFFECTIVE_FROM.toISOString()).toBe("2027-07-01T00:00:00.000Z");
    // The superseded 2025 draft stays in the register as background only.
    expect(instrument("COUNTRY_FILTER_DRAFT_2025")!.status).toBe("draft_background");
  });

  it("dates the unit sale price to 1 January 2024, not to 2027", () => {
    expect(USP_INSTRUMENT.status).toBe("in_force");
    expect(USP_INSTRUMENT.effectiveFrom).toBe("2024-01-01");
    expect(USP_INSTRUMENT.commencementVerified).toBe(true);
  });

  it("covers every rule the app evaluates", () => {
    const covered = new Set(INSTRUMENTS.flatMap((entry) => entry.ruleIds));
    for (const entry of ruleEntries()) {
      expect(covered.has(entry.id), `${entry.id} has no instrument behind it`).toBe(true);
    }
  });

  it("returns the instruments behind one rule", () => {
    expect(instrumentsForRule("R13").map((entry) => entry.id)).toContain("LM_PCR_USP_2022");
    expect(instrumentsForRule("R11").map((entry) => entry.id)).toContain("CP_ECOM_2026");
    expect(instrumentsForRule("R99")).toEqual([]);
    expect(instrument("nope")).toBeNull();
  });
});

describe("formatInstrumentDate", () => {
  it("writes the date the way the app prints it", () => {
    expect(formatInstrumentDate("2027-01-01")).toBe("1 January 2027");
    expect(formatInstrumentDate("2027-07-01")).toBe("1 July 2027");
  });

  it("says so when no date is established", () => {
    expect(formatInstrumentDate(null)).toContain("not established");
  });
});

describe("describeInstrument", () => {
  it("names the instrument, its citation and its date", () => {
    const line = describeInstrument("LM_PCR_USP_2022");
    expect(line).toContain("Unit sale price");
    expect(line).toContain("Rule 6(11)");
    expect(line).toContain("1 January 2024");
  });

  it("adds the caveat where the commencement is not verified", () => {
    expect(describeInstrument("CP_ECOM_2026")).toContain("not verified");
    expect(describeInstrument("LM_PCR_USP_2022")).not.toContain("not verified");
  });

  it("is empty for an unknown id rather than guessing", () => {
    expect(describeInstrument("nope")).toBe("");
  });
});

describe("regimeSummaries", () => {
  it("separates the three stories the app must not merge", () => {
    const summaries = regimeSummaries();
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));
    expect(byId.get("current_lm")!.status).toBe("in_force");
    expect(byId.get("current_ecom")!.status).toBe("in_force");
    expect(byId.get("usp")!.effectiveFrom).toBe("2024-01-01");
    expect(byId.get("ecom_2026")!.status).toBe("notified_commencement_unverified");
    expect(byId.get("ecom_2026")!.verified).toBe(false);
    expect(byId.get("country_filter")!.status).toBe("notified_deferred");
    expect(byId.get("country_filter")!.effectiveFrom).toBe("2027-07-01");
  });

  it("says the self-audit cycle is the app's own policy", () => {
    // The dark-pattern guidelines set no cadence; the 11-month reminder must not
    // be presented as a statutory requirement.
    expect(regimeSummaries().find((summary) => summary.id === "dark_patterns")!.body).toContain(
      "product policy",
    );
  });
});

describe("commencementDisclaimer", () => {
  it("states all four positions in one line", () => {
    const line = commencementDisclaimer();
    expect(line).toContain("in force now");
    expect(line).toContain("1 January 2024");
    expect(line).toContain("unverified");
    expect(line).toContain("G.S.R. 312(E)");
    expect(line).toContain("not been verified against the Gazette");
  });
});
