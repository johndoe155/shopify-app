import { describe, expect, it } from "vitest";
import {
  APP_NAME,
  COUNTRY_FILTER_DATE,
  CLAIMS,
  countdownLabel,
  countryFilterStatus,
  daysUntil,
  DISCLAIMER,
  formatDateTime,
  formatInr,
  formatLongDate,
  formatShortDate,
  PRICE_HISTORY_INSTALL_BY,
  SUPPLIED_ECOM_2026_DATE,
} from "~/domain/copy";
import * as copy from "~/domain/copy";

describe("formatInr", () => {
  it("uses Indian digit grouping", () => {
    expect(formatInr(1167.98)).toBe("\u20b91,167.98");
    expect(formatInr(99)).toBe("\u20b999.00");
    expect(formatInr(1234567.5)).toBe("\u20b912,34,567.50");
  });

  it("always shows two decimals so a column of prices lines up", () => {
    expect(formatInr(249)).toBe("\u20b9249.00");
    expect(formatInr(249.005)).toBe("\u20b9249.01");
  });
});

describe("dates", () => {
  it("formats dates without the server timezone leaking in", () => {
    expect(formatLongDate(new Date("2026-10-30T06:57:00.000Z"))).toBe("Friday, 30 October 2026");
    expect(formatShortDate(new Date("2026-10-30T06:57:00.000Z"))).toBe("30 Oct 2026");
    expect(formatDateTime(new Date("2026-10-30T06:57:00.000Z"))).toBe("30 Oct 2026, 06:57 UTC");
  });

  it("counts whole days to a target date", () => {
    expect(daysUntil(SUPPLIED_ECOM_2026_DATE, new Date("2026-10-30T09:00:00.000Z"))).toBe(63);
  });
});

describe("commencement copy (audit item L2)", () => {
  it("does not present the 2027 date as the start of the whole regime", () => {
    const label = countdownLabel(new Date("2026-10-30T09:00:00.000Z"));
    expect(label).toContain("apply now");
    expect(label).toContain("in force since 1 January 2024");
    expect(label).toContain("supplied 1 January 2027");
    expect(label).toContain("2026 E-Commerce amendment");
  });

  it("still counts the days, so preparation advice stays useful", () => {
    expect(countdownLabel(new Date("2026-10-30T09:00:00.000Z"))).toContain("63 days");
  });

  it("says what happened, not what might happen, once the date has passed", () => {
    expect(countdownLabel(new Date("2028-01-01T00:00:00.000Z"))).toContain("has passed");
  });

  it("keeps the install-by date thirty days before the supplied date", () => {
    const days = (SUPPLIED_ECOM_2026_DATE.getTime() - PRICE_HISTORY_INSTALL_BY.getTime()) / 86_400_000;
    expect(days).toBe(30);
  });

  it("removed the single global effective date entirely", () => {
    // Audit item L2: one date for the whole regime was the bug. The export must be
    // gone, not merely unused, or a later screen can reintroduce the claim.
    expect("RULES_EFFECTIVE_DATE" in copy).toBe(false);
  });
});

describe("country-of-origin filter copy (audit item L15)", () => {
  it("describes the filter as deferred, not as a draft", () => {
    const line = countryFilterStatus(new Date("2026-10-30T09:00:00.000Z"));
    expect(line).toContain("G.S.R. 128(E)");
    expect(line).toContain("G.S.R. 312(E)");
    expect(line).toContain("1 July 2027");
    expect(line).not.toContain("draft");
  });

  it("points at 1 July 2027", () => {
    expect(COUNTRY_FILTER_DATE.toISOString().slice(0, 10)).toBe("2027-07-01");
  });
});

describe("fixed copy", () => {
  it("carries the extended disclaimer (audit item L17)", () => {
    expect(DISCLAIMER).toBe(
      "This tool checks listing data against a published checklist. It is informational, may be incomplete or out of date, is not a legal opinion or certification, and is not legal advice.",
    );
    expect(DISCLAIMER).toContain("not a legal opinion");
    expect(DISCLAIMER).toContain("not legal advice");
  });

  it("keeps the corrective claims sentence the listing gate expects", () => {
    expect(CLAIMS).toBe(
      "This app helps you prepare your listings. It does not guarantee compliance and it is not legal advice.",
    );
  });

  it("uses a 27 character app name", () => {
    expect(APP_NAME).toBe("India Legal Metrology & MRP");
    expect(APP_NAME.length).toBe(27);
  });
});
