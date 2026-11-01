/**
 * The catalogue cache the admin UI reads through (#4).
 *
 * Reported failure: "The bulk editor runs a full bulk operation on every page
 * load, filter, pagination and save. There is no cache between requests." A page
 * of 25 rows out of 200 products meant eight bulk operations per pass through the
 * editor, each competing with the nightly job and every webhook for the shop's
 * single bulk operation.
 *
 * These tests count reads on the source rather than bytes: one snapshot, shared,
 * until it expires; a write patches it so the merchant sees their own edit.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  CATALOGUE_TTL_MS,
  catalogueCacheSize,
  getCatalogue,
  invalidateCatalogue,
  patchCatalogueProduct,
  setCatalogue,
} from "~/services/catalogue-access.server";
import { FakeCatalog, makeProduct, makeRepo } from "./helpers";

afterEach(() => invalidateCatalogue());

class CountingCatalog extends FakeCatalog {
  public reads = 0;
  override async fetchProducts() {
    this.reads += 1;
    return super.fetchProducts();
  }
}

function shopKey(name: string) {
  return `${name}.myshopify.com`;
}

describe("catalogue access cache", () => {
  it("reads the catalogue once for many page loads and filters", async () => {
    const { repo } = await makeRepo();
    const catalog = new CountingCatalog([makeProduct({ productId: "gid://shopify/Product/1", handle: "p1" })]);
    const shopDomain = shopKey("cache-one");

    for (let request = 0; request < 8; request += 1) {
      const products = await getCatalogue({ shopDomain, repo, catalog });
      expect(products).toHaveLength(1);
    }
    expect(catalog.reads).toBe(1);
  });

  it("shares one read between concurrent requests", async () => {
    const { repo } = await makeRepo();
    const catalog = new CountingCatalog([makeProduct({ productId: "gid://shopify/Product/1", handle: "p1" })]);
    const shopDomain = shopKey("cache-concurrent");
    await Promise.all(Array.from({ length: 10 }, () => getCatalogue({ shopDomain, repo, catalog })));
    expect(catalog.reads).toBe(1);
  });

  it("re-reads once the TTL has passed", async () => {
    const { repo } = await makeRepo();
    const catalog = new CountingCatalog([makeProduct({ productId: "gid://shopify/Product/1", handle: "p1" })]);
    const shopDomain = shopKey("cache-ttl");
    let clock = Date.parse("2026-12-01T00:00:00.000Z");
    const now = () => new Date(clock);
    await getCatalogue({ shopDomain, repo, catalog, now });
    clock += CATALOGUE_TTL_MS - 1;
    await getCatalogue({ shopDomain, repo, catalog, now });
    expect(catalog.reads).toBe(1);
    clock += 2;
    await getCatalogue({ shopDomain, repo, catalog, now });
    expect(catalog.reads).toBe(2);
  });

  it("keeps one snapshot per shop", async () => {
    const { repo } = await makeRepo();
    const catalog = new CountingCatalog([makeProduct({ productId: "gid://shopify/Product/1", handle: "p1" })]);
    await getCatalogue({ shopDomain: shopKey("shop-a"), repo, catalog });
    await getCatalogue({ shopDomain: shopKey("shop-b"), repo, catalog });
    expect(catalog.reads).toBe(2);
    expect(catalogueCacheSize()).toBe(2);
  });

  it("shows a saved edit immediately without a re-read", async () => {
    const { repo } = await makeRepo();
    const catalog = new CountingCatalog([makeProduct({ productId: "gid://shopify/Product/1", handle: "p1" })]);
    const shopDomain = shopKey("cache-patch");
    await getCatalogue({ shopDomain, repo, catalog });

    patchCatalogueProduct(shopDomain, "gid://shopify/Product/1", { legal: { mrp: 349 } });
    const products = await getCatalogue({ shopDomain, repo, catalog });
    expect(products[0]!.legal.mrp).toBe(349);
    expect(catalog.reads).toBe(1);
  });

  it("a forced snapshot replaces the cache and clears on demand", async () => {
    const { repo } = await makeRepo();
    const catalog = new CountingCatalog([makeProduct({ productId: "gid://shopify/Product/1", handle: "p1" })]);
    const shopDomain = shopKey("cache-force");
    setCatalogue(shopDomain, []);
    await getCatalogue({ shopDomain, repo, catalog });
    expect(catalog.reads).toBe(1);
    invalidateCatalogue(shopDomain);
    await getCatalogue({ shopDomain, repo, catalog });
    expect(catalog.reads).toBe(2);
  });
});
