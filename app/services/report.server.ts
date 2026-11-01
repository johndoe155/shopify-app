/**
 * Assembles the dashboard/export view from stored scan results. One model is
 * shared by the dashboard, the CSV export and the PDF export so the numbers on
 * screen and the numbers in the evidence file cannot drift apart.
 */
import {
  RULES_CONFIG,
  evaluateStoreRules,
  rollUpStatus,
  ruleEntries,
  summariseScan,
  type RuleConfig,
  type ScanSummary,
} from "~/domain/rules";
import { DAY_MS } from "~/domain/prior-price";
import type { RuleResult, ScanOutcome, ScanStatus } from "~/domain/types";
import type { ScanResultRow } from "~/db/types";
import { INCONCLUSIVE_FILTER } from "~/domain/filters";
import type { AppContext } from "~/context.server";
import { loadStoreFacts } from "~/context.server";

export interface ProductScanView {
  productId: string;
  handle: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  status: ScanStatus;
  passed: boolean;
  failingRuleIds: string[];
  inconclusiveRuleIds: string[];
  results: RuleResult[];
  scannedAt: Date | null;
}

export interface PriceHistoryStatus {
  trackingStart: Date;
  completeBy: Date;
  complete: boolean;
  daysTracked: number;
}

export interface ScanReport {
  products: ProductScanView[];
  outcomes: ScanOutcome[];
  summary: ScanSummary;
  storeResults: RuleResult[];
  scannedAt: Date | null;
  priceHistory: PriceHistoryStatus;
  rulesConfig: RuleConfig;
}

export function buildProductViews(
  rows: ScanResultRow[],
  config: RuleConfig = RULES_CONFIG,
): ProductScanView[] {
  const byProduct = new Map<string, ScanResultRow[]>();
  for (const row of rows) {
    const list = byProduct.get(row.productId) ?? [];
    list.push(row);
    byProduct.set(row.productId, list);
  }

  const views: ProductScanView[] = [];
  for (const [productId, productRows] of byProduct.entries()) {
    const first = productRows[0]!;
    const results: RuleResult[] = ruleEntries(config)
      .filter((entry) => entry.level === "product")
      .map((entry) => {
        const row = productRows.find((candidate) => candidate.ruleId === entry.id);
        return {
          ruleId: entry.id,
          level: "product" as const,
          status: row ? row.status : "not_applicable",
          message: row?.message ?? "Not evaluated in the last scan.",
        };
      });
    const failingRuleIds = results
      .filter((result) => result.status === "fail")
      .map((result) => result.ruleId);
    const inconclusiveRuleIds = results
      .filter((result) => result.status === "inconclusive")
      .map((result) => result.ruleId);
    views.push({
      productId,
      handle: first.productHandle,
      title: first.productTitle,
      vendor: first.productVendor,
      productType: first.productType,
      status: rollUpStatus(failingRuleIds, inconclusiveRuleIds),
      passed: failingRuleIds.length === 0 && inconclusiveRuleIds.length === 0,
      failingRuleIds,
      inconclusiveRuleIds,
      results,
      scannedAt: first.scannedAt,
    });
  }

  return views.sort((a, b) => {
    if (a.failingRuleIds.length !== b.failingRuleIds.length) {
      return b.failingRuleIds.length - a.failingRuleIds.length;
    }
    if (a.inconclusiveRuleIds.length !== b.inconclusiveRuleIds.length) {
      return b.inconclusiveRuleIds.length - a.inconclusiveRuleIds.length;
    }
    return a.title.localeCompare(b.title);
  });
}

export async function loadScanReport(ctx: AppContext, now: Date = new Date()): Promise<ScanReport> {
  const rows = await ctx.repo.listScanResults(ctx.shop.id);
  const products = buildProductViews(rows);
  const outcomes: ScanOutcome[] = products.map((product) => ({
    productId: product.productId,
    handle: product.handle,
    title: product.title,
    vendor: product.vendor,
    productType: product.productType,
    status: product.status,
    passed: product.passed,
    failingRuleIds: product.failingRuleIds,
    inconclusiveRuleIds: product.inconclusiveRuleIds,
    results: product.results,
  }));

  const storeFacts = await loadStoreFacts(ctx);
  const storeResults = evaluateStoreRules(storeFacts, RULES_CONFIG, now);

  const trackingStart = ctx.shop.installedAt;
  const completeBy = new Date(
    trackingStart.getTime() + RULES_CONFIG.parameters.priorPriceWindowDays * DAY_MS,
  );

  return {
    products,
    outcomes,
    summary: summariseScan(outcomes),
    storeResults,
    scannedAt: ctx.shop.lastScanCompletedAt,
    priceHistory: {
      trackingStart,
      completeBy,
      complete: now.getTime() >= completeBy.getTime(),
      daysTracked: Math.min(
        RULES_CONFIG.parameters.priorPriceWindowDays,
        Math.floor((now.getTime() - trackingStart.getTime()) / DAY_MS),
      ),
    },
    rulesConfig: RULES_CONFIG,
  };
}

/**
 * Products that need attention, filtered by rule (or by the inconclusive
 * sentinel) and by search text. `onlyFailing` now means "not passing": a product
 * with an inconclusive rule is listed too, in its own bucket, so the merchant can
 * act on it without it being counted as a failure.
 */
export function filterFailingProducts(
  products: ProductScanView[],
  options: { ruleId?: string | null; query?: string | null; onlyFailing?: boolean } = {},
): ProductScanView[] {
  const query = options.query?.trim().toLowerCase() ?? "";
  return products.filter((product) => {
    if (options.onlyFailing !== false && product.passed) return false;
    if (options.ruleId === INCONCLUSIVE_FILTER) {
      if (product.inconclusiveRuleIds.length === 0) return false;
    } else if (options.ruleId && !product.failingRuleIds.includes(options.ruleId)) return false;
    if (!query) return true;
    return (
      product.title.toLowerCase().includes(query) ||
      product.handle.toLowerCase().includes(query) ||
      (product.vendor ?? "").toLowerCase().includes(query)
    );
  });
}
