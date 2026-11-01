import { describe, expect, it } from "vitest";
import { buildAuditPdf, buildScanSummaryPdf } from "~/domain/exports";
import { pdfEscape, renderPdf, wrapText } from "~/domain/pdf";
import { AUDIT_ITEMS } from "~/domain/self-audit";
import { summariseScan } from "~/domain/rules";

const storeResults = [
  { ruleId: "R8", level: "store" as const, status: "pass" as const, message: "Consumer care details are filled." },
  { ruleId: "R9", level: "store" as const, status: "fail" as const, message: "No policy page link or text for: return shipping cost." },
];

function assertValidPdf(buffer: Buffer) {
  const text = buffer.toString("latin1");
  expect(text.startsWith("%PDF-1.4")).toBe(true);
  expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  expect(text).toContain("/Type /Catalog");
  expect(text).toContain("xref");
  expect(text).toContain("trailer");
  expect(text).toContain("/Root 1 0 R");
  // The xref offset must point at the xref table.
  const match = /startxref\n(\d+)\n%%EOF/.exec(text);
  expect(match).not.toBeNull();
  const offset = Number(match![1]);
  expect(text.slice(offset, offset + 4)).toBe("xref");
}

describe("PDF writer", () => {
  it("escapes parentheses and backslashes and drops unsupported characters", () => {
    expect(pdfEscape("MRP (incl. taxes)")).toBe("MRP \\(incl. taxes\\)");
    expect(pdfEscape("back\\slash")).toBe("back\\\\slash");
    expect(pdfEscape("₹249 – 300")).toBe("Rs.249 - 300");
  });

  it("wraps long text instead of overflowing the page", () => {
    const lines = wrapText("word ".repeat(200), 10);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every((line) => line.length <= 100)).toBe(true);
  });

  it("paginates when there is more than one page of content", () => {
    const buffer = renderPdf(
      Array.from({ length: 200 }, (_, index) => ({ style: "body" as const, text: `Line ${index}` })),
      { title: "Pagination test" },
    );
    assertValidPdf(buffer);
    const pages = /\/Count (\d+)/.exec(buffer.toString("latin1"));
    expect(Number(pages![1])).toBeGreaterThan(1);
  });
});

describe("scan summary PDF", () => {
  const pdf = buildScanSummaryPdf({
    shopDomain: "demo.myshopify.com",
    generatedAt: new Date("2026-10-30T10:00:00.000Z"),
    scannedAt: new Date("2026-10-30T09:00:00.000Z"),
    summary: summariseScan([]),
    storeResults,
    worstProducts: [],
    priceHistory: {
      trackingStart: new Date("2026-09-01T00:00:00.000Z"),
      completeBy: new Date("2026-10-01T00:00:00.000Z"),
      complete: false,
    },
    rulesVersion: "2026.1-draft",
    rulesVerified: false,
  });

  it("is a structurally valid PDF", () => {
    assertValidPdf(pdf);
  });

  it("contains the disclaimer, the store checks and the unverified-checklist note", () => {
    const text = pdf.toString("latin1");
    expect(text).toContain("not legal advice");
    expect(text).toContain("R9");
    expect(text).toContain("not yet verified against the Gazette text");
  });
});

describe("self-audit PDF", () => {
  const answers = AUDIT_ITEMS.map((item, index) => ({
    id: item.id,
    answer: index % 4 === 0,
    notes: index === 0 ? "Timer on the cart page is not tied to stock data." : "",
  }));
  const pdf = buildAuditPdf({
    shopDomain: "demo.myshopify.com",
    completedAt: new Date("2026-10-30T10:00:00.000Z"),
    answers,
    recordId: "audit_1",
  });

  it("is a structurally valid PDF", () => {
    assertValidPdf(pdf);
  });

  it("states that it is the merchant's own answers and not a certificate", () => {
    const text = pdf.toString("latin1");
    expect(text).toContain("record of the answers you gave");
    expect(text.toLowerCase()).toContain("not a certificate");
    expect(text).toContain("not legal advice");
    expect(text).toContain("False urgency");
  });

  it("uses the same wording for every pattern as the checklist", () => {
    const text = pdf.toString("latin1");
    for (const item of AUDIT_ITEMS) {
      expect(text).toContain(item.pattern);
    }
  });
});
