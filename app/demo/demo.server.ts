/**
 * DEMO_MODE state: a seeded in-memory shop plus a fake catalogue.
 *
 * This exists so the finished app can be reviewed and screenshotted without a
 * Shopify dev store. It is never enabled unless DEMO_MODE=1, and the production
 * code paths (Prisma, Admin API bulk operations, Shopify Billing) do not touch
 * it.
 */
import { MemoryRepository } from "~/db/memory.server";
import type { Repository } from "~/db/repository";
import type { ShopRecord } from "~/db/types";
import type { CatalogProduct, CatalogSource, MetafieldSetEntry, MetafieldType, MetafieldWriteResult, MetafieldWriter } from "~/services/ports";
import { LEGAL_METAFIELD_TO_FIELD, LEGAL_NAMESPACE, METAFIELD_TYPES } from "~/services/ports";
import { runScan } from "~/services/scan.server";
import { publishPriorPrices } from "~/services/price-history.server";
import { generateDemoCatalog } from "./demo-data";

export const DEMO_SHOP_DOMAIN = "aranya-naturals.myshopify.com";

const DAY = 24 * 60 * 60 * 1000;

class DemoCatalog implements CatalogSource {
  constructor(private readonly products: CatalogProduct[]) {}

  async fetchProducts(): Promise<CatalogProduct[]> {
    return this.products.map((product) => ({ ...product }));
  }

  async fetchProduct(productId: string): Promise<CatalogProduct | null> {
    const product = this.products.find((p) => p.productId === productId);
    return product ? { ...product } : null;
  }

  async fetchProductsByIds(productIds: string[]): Promise<CatalogProduct[]> {
    const wanted = new Set(productIds);
    return this.products.filter((product) => wanted.has(product.productId)).map((product) => ({ ...product }));
  }

  all(): CatalogProduct[] {
    return this.products;
  }

  /** Lookup used by the writer to mirror a metafield write into the catalogue. */
  find(productId: string): CatalogProduct | undefined {
    return this.products.find((product) => product.productId === productId);
  }

  write(ownerId: string, key: string, value: string): boolean {
    const product = this.products.find((p) => p.productId === ownerId);
    if (!product) return false;
    if (key === "prior_price") {
      product.priorPricePublished = true;
      product.priorPriceMetafield = value;
      return true;
    }
    const field = LEGAL_METAFIELD_TO_FIELD[key as keyof typeof LEGAL_METAFIELD_TO_FIELD];
    if (!field) return true; // shop-level or unknown key: accepted without a product change
    const target = product.legal as unknown as Record<string, unknown>;
    const type = METAFIELD_TYPES[key as keyof typeof METAFIELD_TYPES];
    if (value === "") {
      // An empty write clears the declaration. Booleans keep their default rather
      // than becoming null, because the domain type treats them as flags.
      target[field] = type === "boolean" ? false : null;
      return true;
    }
    if (type === "number_decimal") target[field] = Number(value);
    else if (type === "boolean") target[field] = value === "true";
    else if (type === "json") {
      try {
        target[field] = JSON.parse(value);
      } catch {
        target[field] = null;
      }
    } else target[field] = value;
    return true;
  }
}

class DemoMetafieldWriter implements MetafieldWriter {
  constructor(private readonly catalog: DemoCatalog) {}

  async setMetafields(entries: MetafieldSetEntry[]): Promise<MetafieldWriteResult> {
    // Mirrors the real 25-per-call behaviour so batching is exercised in demo mode too.
    let written = 0;
    const errors: MetafieldWriteResult["errors"] = [];
    for (let i = 0; i < entries.length; i += 25) {
      for (const entry of entries.slice(i, i + 25)) {
        if (entry.namespace !== LEGAL_NAMESPACE) {
          errors.push({ ownerId: entry.ownerId, key: entry.key, message: "Unexpected namespace." });
          continue;
        }
        const ok = this.catalog.write(entry.ownerId, entry.key, entry.value);
        if (ok) written += 1;
        else errors.push({ ownerId: entry.ownerId, key: entry.key, message: "Owner not found." });
      }
    }
    return {
      written,
      errors,
      batches: Math.ceil(entries.length / 25),
      retries: 0,
    };
  }

  /** Mirrors `metafieldsDelete` for a prior-price payload that must be cleared. */
  async deleteProductMetafields(
    keys: Array<{ ownerId: string; namespace: string; key: string }>,
  ): Promise<MetafieldWriteResult> {
    let written = 0;
    const errors: MetafieldWriteResult["errors"] = [];
    for (const entry of keys) {
      const product = this.catalog.find(entry.ownerId);
      if (!product) {
        errors.push({ ownerId: entry.ownerId, key: entry.key, message: "Owner not found." });
        continue;
      }
      if (entry.key === "prior_price") {
        product.priorPricePublished = false;
        product.priorPriceMetafield = null;
      }
      written += 1;
    }
    return { written, errors, batches: 1, retries: 0 };
  }

  async shopOwnerId(): Promise<string> {
    return "gid://shopify/Shop/1";
  }
}

export interface DemoState {
  repo: Repository;
  catalog: DemoCatalog;
  writer: DemoMetafieldWriter;
  shop: ShopRecord;
}

declare global {
   
  var __legalMrpDemo: Promise<DemoState> | undefined;
}

async function buildDemoState(): Promise<DemoState> {
  const now = new Date();
  const installedAt = new Date(now.getTime() - 12 * DAY);
  const catalogue = generateDemoCatalog({ count: 248, now });
  const catalog = new DemoCatalog(catalogue);
  const writer = new DemoMetafieldWriter(catalog);
  const repo = new MemoryRepository();

  const shop = await repo.createShop(DEMO_SHOP_DOMAIN, {
    installedAt,
    onboardingCompletedAt: installedAt,
    plan: "pro",
    planStatus: "ACTIVE",
    billingInterval: "monthly",
    subscriptionId: "gid://shopify/AppSubscription/1",
    storeName: "Aranya Naturals",
    consumerCarePhone: "+91 80 4123 7788",
    consumerCareEmail: "care@aranyanaturals.example",
    grievanceName: "Priya Menon",
    grievanceDesignation: "Grievance Officer",
    grievanceEmail: "grievance@aranyanaturals.example",
    grievancePhone: "+91 80 4123 7799",
    returnPolicyUrl: "/pages/returns",
    refundPolicyUrl: "/pages/refunds",
    exchangePolicyUrl: "/pages/exchanges",
    warrantyPolicyUrl: "/pages/warranty",
    deliveryTermsUrl: "/pages/shipping",
    returnShippingCostText: null, // the one missing item, so R9 has something to report
    blocksDetected: { declarations: "detected", grievance: "not_found", priorPrice: "detected" },
    blocksDetectedAt: now,
    lastScanStartedAt: new Date(now.getTime() - 60 * 60 * 1000),
    lastScanCompletedAt: new Date(now.getTime() - 59 * 60 * 1000),
    lastScanProductCount: catalogue.length,
  });

  // Price history: one snapshot per variant at install, plus a real price drop
  // 8 days ago for the discounted products, so prior price has something to show.
  const snapshots = [];
  for (const product of catalogue) {
    for (const variant of product.variants) {
      const was = variant.compareAtPrice ?? Math.round(variant.price * 1.22 * 100) / 100;
      const dip = Math.round(was * 0.96 * 100) / 100;
      // Install-day baseline: the price the product was selling at.
      snapshots.push({
        productId: product.productId,
        variantId: variant.variantId,
        price: was,
        compareAt: variant.compareAtPrice,
        observedAt: new Date(installedAt.getTime() + 60 * 1000),
        source: "install" as const,
      });
      if (variant.compareAtPrice !== null) {
        // A dip a few days later, then the current price 8 days ago. The prior
        // price the block shows is the dip, not the old full price.
        snapshots.push({
          productId: product.productId,
          variantId: variant.variantId,
          price: dip,
          compareAt: variant.compareAtPrice,
          observedAt: new Date(now.getTime() - 10 * DAY),
          source: "nightly_diff" as const,
        });
        snapshots.push({
          productId: product.productId,
          variantId: variant.variantId,
          price: variant.price,
          compareAt: variant.compareAtPrice,
          observedAt: new Date(now.getTime() - 8 * DAY),
          source: "webhook" as const,
        });
      }
    }
  }
  await repo.insertPriceSnapshots(shop.id, snapshots);

  // One announcement the merchant had to record for themselves (audit item L13):
  // a discount code is applied at checkout, so no variant price moves and nothing
  // in the price history shows that the reduction was announced. Seeding it here
  // means the Price announcements screen, R11 and the published payload all have
  // something real to show in the demo instead of an empty register.
  const reduced = catalogue.find((product) =>
    product.variants.some((variant) => variant.compareAtPrice !== null),
  );
  const reducedVariant = reduced?.variants.find((variant) => variant.compareAtPrice !== null);
  if (reduced && reducedVariant) {
    await repo.recordPriceAnnouncement(shop.id, {
      productId: reduced.productId,
      variantId: reducedVariant.variantId,
      announcedAt: new Date(now.getTime() - 2 * DAY),
      consumerPrice: Math.round(reducedVariant.price * 0.9 * 100) / 100,
      mechanism: "discount_code",
      conditions: "Code MONSOON, one per customer",
    });
  }

  // A self-audit completed 11.5 months ago: still inside the 12-month window, and
  // past the 11-month point, so the reminder banner is visible.
  await repo.saveAuditRecord(
    shop.id,
    {
      answers: buildDemoAuditAnswers(),
    },
    new Date(now.getTime() - 350 * DAY),
  );

  // Run the first scan and publish prior prices, exactly as the app does on install.
  await runScan({ shop, repo, catalog });
  await publishPriorPrices({ shop, repo, catalog, writer });
  const scanned = (await repo.getShop(DEMO_SHOP_DOMAIN)) ?? shop;

  return { repo, catalog, writer, shop: scanned };
}

function buildDemoAuditAnswers(): Array<{ id: string; answer: boolean; notes: string }> {
  return [
    { id: "false_urgency", answer: false, notes: "" },
    { id: "basket_sneaking", answer: false, notes: "" },
    { id: "confirm_shaming", answer: true, notes: "Cart drawer uses 'No thanks, I like paying more' on the free-shipping nudge. Scheduled to be rewritten." },
    { id: "forced_action", answer: false, notes: "" },
    { id: "subscription_trap", answer: false, notes: "No subscriptions sold." },
    { id: "interface_interference", answer: false, notes: "" },
    { id: "bait_and_switch", answer: false, notes: "" },
    { id: "drip_pricing", answer: true, notes: "Delivery fee shown only at checkout step 2." },
    { id: "disguised_advertisement", answer: false, notes: "" },
    { id: "nagging", answer: false, notes: "" },
    { id: "trick_question", answer: false, notes: "" },
    { id: "saas_billing", answer: false, notes: "" },
    { id: "rogue_malwares", answer: false, notes: "" },
  ];
}

export async function getDemoState(): Promise<DemoState> {
  if (!global.__legalMrpDemo) global.__legalMrpDemo = buildDemoState();
  return global.__legalMrpDemo;
}

export async function resetDemoState(): Promise<DemoState> {
  global.__legalMrpDemo = buildDemoState();
  return global.__legalMrpDemo!;
}

export type { MetafieldType };
