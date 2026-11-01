/**
 * Test doubles: a fake catalogue, a fake metafield writer and shop/product
 * factories. These stand in for Shopify so the scan, the metafield batching and
 * the webhook handlers can be integration tested with no dev store.
 */
import { MemoryRepository } from "~/db/memory.server";
import type { ShopRecord } from "~/db/types";
import { EMPTY_LEGAL_FIELDS, type LegalFields } from "~/domain/types";
import {
  LEGAL_METAFIELD_TO_FIELD,
  METAFIELD_TYPES,
  type CatalogProduct,
  type CatalogSource,
  type MetafieldSetEntry,
  type MetafieldWriteResult,
  type MetafieldWriter,
} from "~/services/ports";

export const DAY = 24 * 60 * 60 * 1000;

/**
 * A complete, passing declaration for a domestic 100 ml package. Tests override
 * one field at a time so a failure points at the rule under test rather than at a
 * missing neighbour.
 */
export function makeLegalFields(overrides: Partial<LegalFields> = {}): LegalFields {
  return {
    ...EMPTY_LEGAL_FIELDS,
    mrp: 300,
    variantMrp: null,
    manufacturerName: "Aranya Naturals",
    manufacturerAddress: "12 Industrial Estate, Bengaluru 560001, Karnataka",
    packerDiffersFromManufacturer: false,
    packerName: null,
    packerAddress: null,
    sellerName: null,
    sellerAddress: null,
    countryOfOrigin: "India",
    countryOfOriginLabel: "Made in India",
    isImportedPackage: false,
    importerName: null,
    importerAddress: null,
    packageType: "packaged",
    netQuantityValue: 100,
    netQuantityUnit: "ml",
    genericName: "face wash",
    genericNameOnLabel: true,
    manufacturedDate: "03/2026",
    expiryType: "none",
    expiryDate: null,
    // 300 for 100 ml is 3.00 per ml: Rule 13 keeps the millilitre below 1,000 ml.
    unitSalePrice: 3,
    ...overrides,
  };
}

export function makeProduct(
  overrides: Partial<Omit<CatalogProduct, "legal">> & { legal?: Partial<LegalFields> } = {},
): CatalogProduct {
  const { legal, ...rest } = overrides;
  return {
    productId: "gid://shopify/Product/1",
    handle: "amla-hair-oil-200-ml",
    title: "Amla hair oil 200 ml",
    vendor: "Aranya Naturals",
    productType: "Beauty & personal care",
    status: "ACTIVE",
    variants: [{ variantId: "gid://shopify/ProductVariant/1", title: "Default", price: 249, compareAtPrice: null }],
    priorPricePublished: false,
    ...rest,
    legal: makeLegalFields(legal),
  };
}

export function makeShop(overrides: Partial<ShopRecord> = {}): ShopRecord {
  const now = new Date("2026-09-01T00:00:00.000Z");
  return {
    id: "shop_1",
    shopDomain: "demo.myshopify.com",
    installedAt: new Date(now.getTime() - 40 * DAY),
    uninstalledAt: null,
    isActive: true,
    onboardingCompletedAt: now,
    plan: "pro",
    planStatus: "ACTIVE",
    billingInterval: "monthly",
    subscriptionId: null,
    trialEndsAt: null,
    storeName: "Aranya Naturals",
    consumerCareAddress: "12 Industrial Estate, Bengaluru 560001, Karnataka",
    consumerCarePhone: "+91 80 4123 7788",
    consumerCareEmail: "care@example.com",
    platformCustomerCareUrl: "/pages/contact",
    grievanceName: "Priya Menon",
    grievanceDesignation: "Grievance Officer",
    grievanceEmail: "grievance@example.com",
    grievancePhone: "+91 80 4123 7799",
    returnPolicyUrl: "/pages/returns",
    returnPolicyText: null,
    refundPolicyUrl: "/pages/refunds",
    refundPolicyText: null,
    exchangePolicyUrl: "/pages/exchanges",
    exchangePolicyText: null,
    warrantyPolicyUrl: "/pages/warranty",
    warrantyPolicyText: null,
    deliveryTermsUrl: "/pages/shipping",
    deliveryTermsText: null,
    returnShippingCostUrl: null,
    returnShippingCostText: "Return shipping is free for damaged items",
    paymentModesUrl: "/pages/payment-methods",
    paymentModesText: null,
    grievanceRedressalUrl: "/pages/grievance-redressal",
    grievanceRedressalText: null,
    otherInformationUrl: null,
    otherInformationText: "Country of origin is printed on each pack",
    useBeforeInfoUrl: null,
    useBeforeInfoText: null,
    policyLinkChecks: {},
    confirmDeclarationsBlock: false,
    confirmGrievanceBlock: false,
    confirmPriorPriceBlock: false,
    countryFilterConfirmed: false,
    blocksDetectedAt: now,
    blocksDetected: { declarations: "detected", grievance: "detected", priorPrice: "detected" },
    lastScanStartedAt: null,
    lastScanCompletedAt: null,
    lastScanProductCount: 0,
    reviewPromptShown: false,
    reviewPromptShownAt: null,
    ...overrides,
  };
}

export class FakeCatalog implements CatalogSource {
  constructor(public products: CatalogProduct[]) {}

  async fetchProducts(): Promise<CatalogProduct[]> {
    return this.products.map((product) => ({ ...product, legal: { ...product.legal } }));
  }

  async fetchProduct(productId: string): Promise<CatalogProduct | null> {
    const found = this.products.find((product) => product.productId === productId);
    return found ? { ...found, legal: { ...found.legal } } : null;
  }

  find(productId: string): CatalogProduct | undefined {
    return this.products.find((product) => product.productId === productId);
  }
}

export interface WrittenEntry extends MetafieldSetEntry {
  at: number;
}

/** Records every write, mirrors it into the fake catalogue, can simulate throttling. */
export class FakeWriter implements MetafieldWriter {
  public readonly writes: WrittenEntry[] = [];
  public readonly deletes: Array<{ ownerId: string; key: string; namespace: string }> = [];
  public batches: number[] = [];
  private failuresRemaining: number;

  constructor(
    private readonly catalog?: FakeCatalog,
    options: { failFirstBatches?: number } = {},
  ) {
    this.failuresRemaining = options.failFirstBatches ?? 0;
  }

  async setMetafields(entries: MetafieldSetEntry[]): Promise<MetafieldWriteResult> {
    const batchSize = 25;
    const errors: MetafieldWriteResult["errors"] = [];
    let written = 0;
    let retries = 0;
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      this.batches.push(batch.length);
      if (this.failuresRemaining > 0) {
        this.failuresRemaining -= 1;
        retries += 1;
        for (const entry of batch) {
          errors.push({ ownerId: entry.ownerId, key: entry.key, message: "Throttled" });
        }
        continue;
      }
      for (const entry of batch) {
        this.writes.push({ ...entry, at: Date.now() });
        const product = this.catalog?.find(entry.ownerId);
        if (!product) continue;
        if (entry.key === "prior_price") {
          product.priorPricePublished = true;
          product.priorPriceMetafield = entry.value;
          continue;
        }
        // The fake writer uses the app's own key map and value types, so a test
        // cannot pass on a mapping the real writer does not have.
        const field = LEGAL_METAFIELD_TO_FIELD[entry.key as keyof typeof LEGAL_METAFIELD_TO_FIELD];
        if (!field) continue;
        const type = METAFIELD_TYPES[entry.key as keyof typeof METAFIELD_TYPES];
        const target = product.legal as unknown as Record<string, unknown>;
        if (entry.value === "") {
          target[field] = type === "boolean" ? false : null;
          continue;
        }
        if (type === "number_decimal") target[field] = Number(entry.value);
        else if (type === "boolean") target[field] = entry.value === "true";
        else if (type === "json") {
          try {
            target[field] = JSON.parse(entry.value);
          } catch {
            target[field] = null;
          }
        } else target[field] = entry.value;
      }
      written += batch.length;
    }
    return { written, errors, batches: this.batches.length, retries };
  }

  /** Mirrors `metafieldsDelete`: removes the stored value and records the call. */
  async deleteProductMetafields(
    keys: Array<{ ownerId: string; namespace: string; key: string }>,
  ): Promise<MetafieldWriteResult> {
    for (const entry of keys) {
      this.deletes.push(entry);
      const product = this.catalog?.find(entry.ownerId);
      if (!product) continue;
      if (entry.key === "prior_price") {
        product.priorPricePublished = false;
        product.priorPriceMetafield = null;
      }
    }
    return { written: keys.length, errors: [], batches: 1, retries: 0 };
  }

  async shopOwnerId(): Promise<string> {
    return "gid://shopify/Shop/1";
  }

  entriesFor(ownerId: string): WrittenEntry[] {
    return this.writes.filter((entry) => entry.ownerId === ownerId);
  }
}

export async function makeRepo(): Promise<{ repo: MemoryRepository; shop: ShopRecord }> {
  const repo = new MemoryRepository();
  const shop = await repo.createShop("demo.myshopify.com", makeShop());
  return { repo, shop };
}
