/**
 * Reporting layer tests (dashboard model, CSV, PDF).
 *
 * The rules engine reports an `inconclusive` status when the storefront cannot
 * be read (item 4). These tests prove the rest of the pipeline honours it: the
 * scan stores the status, the dashboard model counts those products separately,
 * the filter can list them, and the exports say "unverified" rather than
 * "failing". They also prove the score cannot be dragged down by a check the app
 * was unable to look at.
 */
import { describe, expect, it } from "vitest";
import type { ScanResultRow } from "~/db/types";
import { buildScanCsv } from "~/domain/csv";
import { buildScanSummaryPdf } from "~/domain/exports";
import { INCONCLUSIVE_FILTER } from "~/domain/filters";
import { ruleEntries, summariseScan } from "~/domain/rules";
import type { ScanOutcome } from "~/domain/types";
import { buildProductViews, filterFailingProducts } from "~/services/report.server";
import { runScan } from "~/services/scan.server";
import { FakeCatalog, makeProduct, makeRepo } from "./helpers";

const scannedAt = new Date("2026-10-30T12:00:00.000Z");
const PRODUCT_RULES = ruleEntries()
  .filter((rule) => rule.level === "product")
  .map((rule) => rule.id);

/** One stored row per product rule; anything not passed in is a pass. */
function rowsFor(
  productId: string,
  handle: string,
  title: string,
  overrides: Partial<Record<string, ScanResultRow["status"]>> = {},
): ScanResultRow[] {
  return PRODUCT_RULES.map((ruleId) => ({
    productId,
    productHandle: handle,
    productTitle: title,
    productVendor: "Aranya Naturals",
    productType: "Beauty & personal care",
    ruleId,
    status: overrides[ruleId] ?? "pass",
    message: overrides[ruleId] === "inconclusive" ? "Could not be verified." : "Checked.",
    scannedAt,
  }));
}

const rows = [
  ...rowsFor("gid://shopify/Product/1", "sale-a", "Sale product A", { R11: "inconclusive" }),
  ...rowsFor("gid://shopify/Product/2", "broken-b", "Broken product B", { R1: "fail" }),
  ...rowsFor("gid://shopify/Product/3", "clean-c", "Clean product C"),
];

function outcomeFrom(view: ReturnType<typeof buildProductViews>[number]): ScanOutcome {
  return {
    productId: view.productId,
    handle: view.handle,
    title: view.title,
    vendor: view.vendor,
    productType: view.productType,
    status: view.status,
    passed: view.passed,
    failingRuleIds: view.failingRuleIds,
    inconclusiveRuleIds: view.inconclusiveRuleIds,
    results: view.results,
  };
}

function exportRow(view: ReturnType<typeof buildProductViews>[number]) {
  return {
    productId: view.productId,
    handle: view.handle,
    title: view.title,
    vendor: view.vendor,
    productType: view.productType,
    passing: view.passed,
    status: view.status,
    failingRuleIds: view.failingRuleIds,
    inconclusiveRuleIds: view.inconclusiveRuleIds,
    ruleStatuses: Object.fromEntries(view.results.map((result) => [result.ruleId, result.status])),
    scannedAt: view.scannedAt ?? scannedAt,
  };
}

describe("an unverifiable block check in the reporting layer", () => {
  it("keeps the inconclusive status in the stored rows and in the dashboard model", () => {
    const views = buildProductViews(rows);
    const saleA = views.find((view) => view.handle === "sale-a")!;
    expect(saleA.status).toBe("inconclusive");
    expect(saleA.failingRuleIds).toEqual([]);
    expect(saleA.inconclusiveRuleIds).toEqual(["R11"]);
    // Not passing, but not a failure either: `passed` drives the "needs attention" list.
    expect(saleA.passed).toBe(false);

    const broken = views.find((view) => view.handle === "broken-b")!;
    expect(broken.status).toBe("fail");
    expect(broken.inconclusiveRuleIds).toEqual([]);

    expect(views.find((view) => view.handle === "clean-c")!.status).toBe("pass");
  });

  it("removes unverifiable products from the score denominator", () => {
    const summary = summariseScan(buildProductViews(rows).map(outcomeFrom));
    expect(summary.totalProducts).toBe(3);
    expect(summary.passingProducts).toBe(1);
    expect(summary.failingProducts).toBe(1);
    expect(summary.inconclusiveProducts).toBe(1);
    expect(summary.scoredProducts).toBe(2);
    // 1 of the 2 products that could be fully checked passes.
    expect(summary.scorePercent).toBe(50);
    // The plain "share of the whole catalogue" number is still reported.
    expect(summary.rawScorePercent).toBe(33);

    const r11 = summary.byRule.find((rule) => rule.ruleId === "R11")!;
    expect(r11.inconclusive).toBe(1);
    expect(r11.fail).toBe(0);
    expect(r11.pass).toBe(2);
  });

  it("is unaffected by how many products are unverified", () => {
    const cleanOnly = rows.filter((row) => row.productHandle === "clean-c");
    const withUnverified = [...cleanOnly, ...rows.filter((row) => row.productHandle === "sale-a")];
    // The verified product always reads 100%, whatever else is pending.
    expect(summariseScan(buildProductViews(cleanOnly).map(outcomeFrom)).scorePercent).toBe(100);
    const mixed = summariseScan(buildProductViews(withUnverified).map(outcomeFrom));
    expect(mixed.scorePercent).toBe(100);
    expect(mixed.rawScorePercent).toBe(50);
    expect(mixed.inconclusiveProducts).toBe(1);
  });

  it("lists unverified products under their own filter, never under a rule", () => {
    const views = buildProductViews(rows);
    expect(
      filterFailingProducts(views, { ruleId: INCONCLUSIVE_FILTER }).map((view) => view.handle),
    ).toEqual(["sale-a"]);
    expect(filterFailingProducts(views, { ruleId: "R1" }).map((view) => view.handle)).toEqual([
      "broken-b",
    ]);
    // "Needs attention" includes both, with the reason distinguishable per row.
    expect(
      filterFailingProducts(views)
        .map((view) => view.handle)
        .sort(),
    ).toEqual(["broken-b", "sale-a"]);
  });

  it("writes 'a check could not be verified' into the CSV instead of 'checks failing'", () => {
    const csv = buildScanCsv(buildProductViews(rows).map(exportRow), PRODUCT_RULES, scannedAt);
    expect(csv).toMatch(/^product_id,handle,title,/m);
    expect(csv).toMatch(/sale-a,Sale product A[^\n]*a check could not be verified/);
    expect(csv).toMatch(/broken-b,Broken product B[^\n]*checks failing/);
    expect(csv).toMatch(/clean-c,Clean product C[^\n]*all checks pass/);
    // The per-rule column preserves the status so the merchant can see which rule.
    expect(csv).toMatch(/sale-a[^\n]*inconclusive/);
  });

  it("explains the exclusion in the PDF summary instead of hiding it", () => {
    const summary = summariseScan(buildProductViews(rows).map(outcomeFrom));
    const pdf = buildScanSummaryPdf({
      shopDomain: "demo.myshopify.com",
      generatedAt: scannedAt,
      scannedAt,
      summary,
      storeResults: [],
      worstProducts: buildProductViews(rows)
        .map(outcomeFrom)
        .filter((outcome) => outcome.status === "fail"),
      priceHistory: {
        trackingStart: new Date("2026-09-01T00:00:00.000Z"),
        completeBy: new Date("2026-10-01T00:00:00.000Z"),
        complete: true,
      },
      rulesVersion: "test",
      rulesVerified: false,
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1_000);
    const text = pdf.toString("latin1");
    expect(text).toContain("products that could be fully checked");
    expect(text).toContain("left out of the score");
  });
});

describe("the scan stores the inconclusive status end to end", () => {
  it("stores R11 as inconclusive when the storefront blocks are unreadable", async () => {
    const { repo, shop } = await makeRepo();
    const catalog = new FakeCatalog([
      makeProduct({
        productId: "gid://shopify/Product/1",
        handle: "sale-a",
        title: "Sale product A",
        variants: [{ variantId: "v1", title: "Default", price: 249, compareAtPrice: 399 }],
      }),
      makeProduct({
        productId: "gid://shopify/Product/2",
        handle: "broken-b",
        title: "Broken product B",
        legal: { mrp: null },
        // No discount, so R11 does not apply and this product is a plain failure.
      }),
    ]);

    const unknown = await runScan({
      shop,
      repo,
      catalog,
      blocks: { declarations: "unknown", grievance: "unknown", priorPrice: "unknown" },
      now: scannedAt,
    });

    const stored = (await repo.listScanResults(shop.id)).filter((row) => row.ruleId === "R11");
    expect(stored).toHaveLength(2);
    expect(stored.find((row) => row.productHandle === "sale-a")!.status).toBe("inconclusive");
    expect(stored.find((row) => row.productHandle === "broken-b")!.status).toBe("not_applicable");

    expect(unknown.summary.totalProducts).toBe(2);
    expect(unknown.summary.failingProducts).toBe(1);
    expect(unknown.summary.inconclusiveProducts).toBe(1);
    expect(unknown.summary.scoredProducts).toBe(1);
    expect(unknown.summary.scorePercent).toBe(0);

    // Nothing is reported as failing R11 while it is unverified.
    const views = buildProductViews(await repo.listScanResults(shop.id));
    expect(views.flatMap((view) => view.failingRuleIds)).not.toContain("R11");
  });

  it("re-scores the product on the next scan once the block can be seen", async () => {
    const { repo, shop } = await makeRepo();
    const catalog = new FakeCatalog([
      makeProduct({
        productId: "gid://shopify/Product/1",
        handle: "sale-a",
        title: "Sale product A",
        variants: [{ variantId: "v1", title: "Default", price: 249, compareAtPrice: 399 }],
      }),
    ]);

    const unknown = await runScan({
      shop,
      repo,
      catalog,
      blocks: { declarations: "unknown", grievance: "unknown", priorPrice: "unknown" },
      now: scannedAt,
    });
    expect(unknown.summary.inconclusiveProducts).toBe(1);
    expect(unknown.summary.scoredProducts).toBe(0);
    // With nothing scorable, the score is reported as 0 rather than NaN.
    expect(unknown.summary.scorePercent).toBe(0);

    // Blocks visible on the next scan: R11 now has an opinion (no history yet).
    const detected = await runScan({
      shop,
      repo,
      catalog,
      blocks: { declarations: "detected", grievance: "detected", priorPrice: "detected" },
      now: scannedAt,
    });
    expect(detected.summary.inconclusiveProducts).toBe(0);
    expect(detected.summary.scoredProducts).toBe(1);
    const views = buildProductViews(await repo.listScanResults(shop.id));
    expect(views[0]!.failingRuleIds).toContain("R11");
  });
});
