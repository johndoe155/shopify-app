/**
 * Job handlers. Registered once per process from `shopify.server.ts` (install
 * scan), from the webhook route (per-product work) and from the scheduled job
 * endpoint (nightly scan, nightly price diff, block check).
 *
 * Shape of a `products/update` webhook after this pass:
 *
 *   price-snapshot   one targeted product read, writes a PriceSnapshot
 *   rescan-product   one targeted product read, rewrites that product's rows
 *   publish-prior-prices (coalesced: one per shop per window)
 *                    publishes the one product that changed
 *
 * None of those starts a bulk operation, and none of them republishes the
 * catalogue. The previous version ran a full-catalogue bulk scan *and* a
 * full-catalogue prior-price publish for every webhook — 200 products edited in
 * the Shopify bulk editor meant 400 bulk operations for a shop that Shopify only
 * lets run one at a time.
 */
import shopify from "~/shopify.server";
import type { Repository } from "~/db/repository";
import type { ShopRecord } from "~/db/types";
import { ShopifyCatalogSource } from "~/services/catalog.server";
import { ShopifyMetafieldWriter } from "~/services/metafields.server";
import { runProductRescan, runScan } from "~/services/scan.server";
import { publishPriorPrices, recordPriceSnapshots } from "~/services/price-history.server";
import { detectStorefrontBlocks } from "~/services/blocks.server";
import { checkPolicyLinks } from "~/services/policy-links.server";
import { registerHandler, type Job } from "./queue.server";

let registered = false;

export interface ShopServices {
  shop: ShopRecord;
  repo: Repository;
  catalog: ShopifyCatalogSource;
  writer: ShopifyMetafieldWriter;
}

/** Builds the services for a shop outside a request, using the offline session. */
export async function shopServices(shopDomain: string): Promise<ShopServices | null> {
  const { PrismaRepository, prisma } = await import("~/db/prisma.server");
  const repo = new PrismaRepository(prisma);
  const shop = await repo.getShop(shopDomain);
  if (!shop || !shop.isActive) return null;
  const { admin } = await shopify.unauthenticated.admin(shopDomain);
  return {
    shop,
    repo,
    catalog: new ShopifyCatalogSource(admin),
    writer: new ShopifyMetafieldWriter(admin),
  };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The nightly job (F2 + F5 + R11):
 *  1. price diff (catches missed products/update webhooks)
 *  2. publish prior prices for the storefront block
 *  3. storefront block detection
 *  4. full catalogue scan
 * Idempotent per shop per day via the JobRun ledger.
 *
 * The catalogue is read once and passed to each step: one bulk operation for the
 * whole nightly job, which is what keeps it from colliding with the webhook path.
 */
export async function runNightlyForShop(shopDomain: string, now: Date = new Date()): Promise<{
  ran: boolean;
  reason?: string;
}> {
  const services = await shopServices(shopDomain);
  if (!services) return { ran: false, reason: "shop not installed or inactive" };
  const { shop, repo, catalog, writer } = services;

  const key = `nightly:${shopDomain}:${isoDate(now)}`;
  const claimed = await repo.claimJobRun(key, "nightly-scan", shop.id);
  if (!claimed) return { ran: false, reason: "already ran today" };

  try {
    const products = await catalog.fetchProducts({ force: true });
    await recordPriceSnapshots({ shop, repo, products, now, source: "nightly_diff" });

    // The catalogue was read once, above. Handing it to the publisher (and to the
    // scan) means the whole nightly job costs one bulk operation, and the stored
    // `prior_price` payloads it carries are exactly what the publisher needs to
    // decide between rewriting, clearing and leaving a product alone.
    const publish = await publishPriorPrices({ shop, repo, catalog, writer, now, products });
    if (publish.failed > 0) {
      console.warn(
        `[nightly] ${shopDomain}: ${publish.failed} prior-price write(s) failed; they are retried on the next run`,
      );
    }

    // R9 only trusts a link check that is recent, and a page that answered six
    // months ago says nothing about today (audit item L11). Re-checking here means
    // a working link stays current without the merchant having to remember the
    // button on the settings screen.
    try {
      const linkChecks = await checkPolicyLinks({ shop, shopDomain, now });
      if (Object.keys(linkChecks).length > 0) {
        await repo.updateShop(shop.id, { policyLinkChecks: linkChecks });
      }
    } catch (error) {
      // A failure here must not lose the night's scan: the previous results stand
      // and the next run tries again.
      console.warn(
        `[nightly] ${shopDomain}: the policy-link check failed; the previous results are kept (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }

    const detection = await detectStorefrontBlocks({
      shopDomain,
      productHandle: products.find((product) => product.status === "ACTIVE")?.handle ?? null,
    });
    await repo.setDetectedBlocks(shop.id, detection.blocks, now);
    const scan = await runScan({ shop, repo, catalog, now, blocks: detection.blocks, products });

    await repo.updateShop(shop.id, {
      lastScanCompletedAt: new Date(),
      lastScanProductCount: scan.productCount,
    });
    await repo.finishJobRun(key, "done");
    return { ran: true };
  } catch (error) {
    await repo.finishJobRun(key, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Runs the nightly job for every active shop (used by the cron endpoint). */
export async function runNightlyForAllShops(now: Date = new Date()): Promise<{
  shops: number;
  ran: number;
  skipped: number;
  failed: string[];
}> {
  const { PrismaRepository, prisma } = await import("~/db/prisma.server");
  const repo = new PrismaRepository(prisma);
  const shops = await repo.listActiveShops();
  const failed: string[] = [];
  let ran = 0;
  let skipped = 0;
  for (const shop of shops) {
    try {
      const result = await runNightlyForShop(shop.shopDomain, now);
      if (result.ran) ran += 1;
      else skipped += 1;
    } catch (error) {
      failed.push(`${shop.shopDomain}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { shops: shops.length, ran, skipped, failed };
}

async function handlePriceSnapshot(job: Job): Promise<void> {
  const shopDomain = String(job.payload.shopDomain ?? "");
  const productId = String(job.payload.productId ?? "");
  const services = await shopServices(shopDomain);
  if (!services) return;
  // Targeted read: no bulk operation for a single product.
  const product = await services.catalog.fetchProduct(productId);
  if (!product) return;
  await recordPriceSnapshots({
    shop: services.shop,
    repo: services.repo,
    products: [product],
    source: "webhook",
  });
}

async function handleRescanProduct(job: Job): Promise<void> {
  const shopDomain = String(job.payload.shopDomain ?? "");
  const productId = String(job.payload.productId ?? "");
  const services = await shopServices(shopDomain);
  if (!services) return;
  await runProductRescan({
    shop: services.shop,
    repo: services.repo,
    catalog: services.catalog,
    productId,
  });
  // Publishing this product's prior price goes through the coalesced
  // publish-prior-prices job the webhook queued, so a bulk edit of 200 products
  // produces one store-wide publish instead of 200 catalogue publishes.
}

async function handleDeleteProduct(job: Job): Promise<void> {
  const shopDomain = String(job.payload.shopDomain ?? "");
  const productId = String(job.payload.productId ?? "");
  const services = await shopServices(shopDomain);
  if (!services) return;
  await services.repo.replaceScanResults(services.shop.id, [], {
    productCount: services.shop.lastScanProductCount,
    startedAt: new Date(),
    completedAt: new Date(),
    purgeMissing: [productId],
  });
}

async function handleDetectBlocks(job: Job): Promise<void> {
  const shopDomain = String(job.payload.shopDomain ?? "");
  const services = await shopServices(shopDomain);
  if (!services) return;
  const products = await services.catalog.fetchProducts();
  const detection = await detectStorefrontBlocks({
    shopDomain,
    productHandle: products.find((product) => product.status === "ACTIVE")?.handle ?? null,
  });
  await services.repo.setDetectedBlocks(services.shop.id, detection.blocks, new Date());
}

/**
 * Publishes `legal_in.prior_price`. Carries the product ids the enqueuing webhook
 * saw, so the job writes only those products; an empty payload means "every
 * product" (the manual *refresh* action and the nightly job).
 */
async function handlePublishPriorPrices(job: Job): Promise<void> {
  const shopDomain = String(job.payload.shopDomain ?? "");
  const rawIds = job.payload.productIds;
  const productIds = Array.isArray(rawIds)
    ? rawIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const services = await shopServices(shopDomain);
  if (!services) return;
  await publishPriorPrices({
    shop: services.shop,
    repo: services.repo,
    catalog: services.catalog,
    writer: services.writer,
    productIds: productIds.length > 0 ? productIds : undefined,
  });
}

async function handleNightly(job: Job): Promise<void> {
  const shopDomain = String(job.payload.shopDomain ?? "");
  if (!shopDomain) {
    await runNightlyForAllShops();
    return;
  }
  await runNightlyForShop(shopDomain);
}

/** Idempotent: safe to call on every request that might need the handlers. */
export function registerJobHandlers(): void {
  if (registered) return;
  registered = true;
  registerHandler("nightly-scan", handleNightly);
  registerHandler("price-snapshot", handlePriceSnapshot);
  registerHandler("rescan-product", handleRescanProduct);
  registerHandler("delete-product", handleDeleteProduct);
  registerHandler("detect-blocks", handleDetectBlocks);
  registerHandler("publish-prior-prices", handlePublishPriorPrices);
}
