/**
 * F2 — the catalog scan.
 *
 * Reads the catalogue through the CatalogSource port, evaluates R1–R7 and R11
 * for every product, and stores one ScanResult row per (product, rule).
 * Idempotent: re-running replaces the rows for the products it saw and removes
 * rows for products that no longer exist.
 */
import { RULES_CONFIG, evaluateProduct, summariseScan, type RuleConfig, type ScanSummary } from "~/domain/rules";
import { scanScope } from "~/domain/plans";
import { computePriorPrice } from "~/domain/prior-price";
import { toStoreFacts, type ShopRecord } from "~/db/types";
import type { Repository } from "~/db/repository";
import type { ScanResultRow } from "~/db/types";
import type { BlockStatuses, ProductFacts, ScanOutcome, VariantFacts } from "~/domain/types";
import type { CatalogProduct, CatalogSource } from "./ports";
import {
  groupAnnouncementsByProduct,
  groupSnapshotsByVariant,
  productPriorPrices,
  resolvePriceEffectiveAt,
} from "./price-history.server";

export interface ScanDeps {
  shop: ShopRecord;
  repo: Repository;
  catalog: CatalogSource;
  rulesConfig?: RuleConfig;
  now?: Date;
  /** Block status confirmed by storefront detection or the merchant. */
  blocks?: BlockStatuses;
  /**
   * A catalogue the caller already read. The nightly job passes the same array
   * it used for the price diff and the publish, so the whole job costs one bulk
   * operation instead of three.
   */
  products?: CatalogProduct[];
}

export interface ScanRunResult {
  summary: ScanSummary;
  outcomes: ScanOutcome[];
  scannedAt: Date;
  productCount: number;
  coveredCount: number;
  overPlanLimit: boolean;
  rulesVersion: string;
}

/** Builds the pure ProductFacts for one catalogue product. */
export function toProductFacts(
  product: CatalogProduct,
  priceHistory: Awaited<ReturnType<typeof productPriorPrices>>,
): ProductFacts {
  const variants: VariantFacts[] = product.variants.map((variant) => ({
    variantId: variant.variantId,
    title: variant.title,
    price: variant.price,
    compareAtPrice: variant.compareAtPrice,
    priorPrice: priceHistory.get(variant.variantId) ?? null,
  }));
  return {
    productId: product.productId,
    handle: product.handle,
    title: product.title,
    vendor: product.vendor,
    productType: product.productType,
    status: product.status,
    legal: product.legal,
    variants,
    priorPricePublished: product.priorPricePublished,
  };
}

export async function runScan(deps: ScanDeps): Promise<ScanRunResult> {
  const now = deps.now ?? new Date();
  const config = deps.rulesConfig ?? RULES_CONFIG;
  const startedAt = now;

  const allProducts = deps.products ?? (await deps.catalog.fetchProducts());
  const coverCount = scanScope(deps.shop.plan, allProducts.length);
  const products = allProducts.slice(0, coverCount);

  const [audit, complaints, announcements] = await Promise.all([
    deps.repo.latestAuditRecord(deps.shop.id),
    deps.repo.listComplaints(deps.shop.id),
    deps.repo.listPriceAnnouncements(deps.shop.id),
  ]);
  const shopWithBlocks: ShopRecord =
    deps.blocks !== undefined
      ? { ...deps.shop, blocksDetected: deps.blocks }
      : deps.shop;
  const storeFacts = toStoreFacts(shopWithBlocks, shopWithBlocks.blocksDetected, {
    lastAuditAt: audit?.completedAt ?? null,
    complaints,
    now,
    // R10's evidence window is app policy and lives with the other parameters.
    evidenceWindowMonths: config.parameters.complaintEvidenceLookbackMonths,
  });

  const snapshots = await deps.repo.listPriceSnapshots(deps.shop.id);
  const snapshotsByVariant = groupSnapshotsByVariant(snapshots);
  const announcementsByProduct = groupAnnouncementsByProduct(announcements);

  const outcomes: ScanOutcome[] = [];
  const rows: ScanResultRow[] = [];

  for (const product of products) {
    const history = productPriorPrices({
      product,
      snapshotsByVariant,
      trackingStart: deps.shop.installedAt,
      now,
      windowDays: config.parameters.priorPriceWindowDays,
      announcements: announcementsByProduct.get(product.productId) ?? [],
    });
    const facts = toProductFacts(product, history);
    const outcome = evaluateProduct(facts, storeFacts, config);
    outcomes.push(outcome);
    for (const result of outcome.results) {
      rows.push({
        productId: product.productId,
        productHandle: product.handle,
        productTitle: product.title,
        productVendor: product.vendor,
        productType: product.productType,
        ruleId: result.ruleId,
        status: result.status,
        message: result.message,
        scannedAt: now,
      });
    }
  }

  const coveredIds = new Set(products.map((p) => p.productId));
  const previous = await deps.repo.listScanResults(deps.shop.id);
  const missing = [...new Set(previous.map((row) => row.productId))].filter((id) => !coveredIds.has(id));

  await deps.repo.replaceScanResults(deps.shop.id, rows, {
    productCount: allProducts.length,
    startedAt,
    completedAt: new Date(),
    // Products outside a plan's limit keep their previous results: nothing is deleted.
    purgeMissing: missing.filter((id) => allProducts.every((p) => p.productId !== id)),
  });

  return {
    summary: summariseScan(outcomes, config),
    outcomes,
    scannedAt: now,
    productCount: allProducts.length,
    coveredCount: products.length,
    overPlanLimit: coverCount < allProducts.length,
    rulesVersion: config.version,
  };
}

export interface UnscopedPriorPriceInput {
  product: CatalogProduct;
  snapshotsByVariant: Map<string, Array<{ price: number; observedAt: Date }>>;
  trackingStart: Date;
  now: Date;
  windowDays: number;
}

/** The catalogue read a scan will use, so a job can reuse it for other steps. */
export async function loadCatalogue(
  catalog: CatalogSource,
  options: { force?: boolean } = {},
): Promise<CatalogProduct[]> {
  return catalog.fetchProducts(options);
}

export { resolvePriceEffectiveAt, computePriorPrice };

/**
 * Re-scan a single product (products/create and products/update webhooks).
 * Replaces only that product's rows, so a webhook never disturbs the rest of the
 * dashboard, and is safe to run repeatedly.
 */
export async function runProductRescan(deps: {
  shop: ShopRecord;
  repo: Repository;
  catalog: CatalogSource;
  productId: string;
  blocks?: BlockStatuses;
  rulesConfig?: RuleConfig;
  now?: Date;
}): Promise<ScanOutcome | null> {
  const now = deps.now ?? new Date();
  const config = deps.rulesConfig ?? RULES_CONFIG;
  const product = await deps.catalog.fetchProduct(deps.productId);
  if (!product) return null;

  const [audit, complaints, announcements] = await Promise.all([
    deps.repo.latestAuditRecord(deps.shop.id),
    deps.repo.listComplaints(deps.shop.id),
    deps.repo.listPriceAnnouncements(deps.shop.id),
  ]);
  const shopWithBlocks: ShopRecord =
    deps.blocks !== undefined ? { ...deps.shop, blocksDetected: deps.blocks } : deps.shop;
  const storeFacts = toStoreFacts(shopWithBlocks, shopWithBlocks.blocksDetected, {
    lastAuditAt: audit?.completedAt ?? null,
    complaints,
    now,
    evidenceWindowMonths: config.parameters.complaintEvidenceLookbackMonths,
  });

  // The snapshot for this change is recorded by the price-snapshot job that runs
  // first (queue priority), so this read sees the change and R11 scores the
  // product against a history that includes it.
  const snapshots = await deps.repo.listPriceSnapshots(deps.shop.id);
  const snapshotsByVariant = groupSnapshotsByVariant(snapshots);

  const history = productPriorPrices({
    product,
    snapshotsByVariant,
    trackingStart: deps.shop.installedAt,
    now,
    windowDays: config.parameters.priorPriceWindowDays,
    announcements: announcements.filter((row) => row.productId === product.productId),
  });
  const outcome = evaluateProduct(toProductFacts(product, history), storeFacts, config);

  const rows: ScanResultRow[] = outcome.results.map((result) => ({
    productId: product.productId,
    productHandle: product.handle,
    productTitle: product.title,
    productVendor: product.vendor,
    productType: product.productType,
    ruleId: result.ruleId,
    status: result.status,
    message: result.message,
    scannedAt: now,
  }));

  await deps.repo.replaceScanResults(deps.shop.id, rows, {
    productCount: deps.shop.lastScanProductCount,
    startedAt: now,
    completedAt: now,
    purgeMissing: [],
  });

  return outcome;
}
