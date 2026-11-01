import { describe, expect, it } from "vitest";
import {
  chunk,
  writeMetafieldsInBatches,
  type GraphQLExecutor,
} from "~/services/metafields.server";
import { applyLegalUpdates, buildDefaultUpdates, buildLegalMetafieldEntries } from "~/services/legal-writes.server";
import { FakeCatalog, FakeWriter, makeProduct, makeRepo } from "./helpers";
import type { MetafieldSetEntry } from "~/services/ports";

function entries(count: number): MetafieldSetEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    ownerId: `gid://shopify/Product/${index}`,
    namespace: "legal_in",
    key: "mrp",
    type: "number_decimal" as const,
    value: String(100 + index),
  }));
}

describe("batching", () => {
  it("splits into chunks of 25", () => {
    expect(chunk(entries(60), 25).map((batch) => batch.length)).toEqual([25, 25, 10]);
    expect(chunk([], 25)).toEqual([]);
  });

  it("writes 60 entries in three calls of at most 25", async () => {
    const sizes: number[] = [];
    const execute: GraphQLExecutor = async (_query, variables) => {
      const sent = variables.metafields as unknown[];
      sizes.push(sent.length);
      return { data: { metafieldsSet: { metafields: sent, userErrors: [] } } };
    };
    const result = await writeMetafieldsInBatches(entries(60), execute, { concurrency: 1, sleep: async () => {} });
    expect(result.written).toBe(60);
    expect(result.batches).toBe(3);
    expect(sizes).toEqual([25, 25, 10]);
    expect(result.errors).toEqual([]);
  });

  it("retries with backoff when Shopify throttles, then succeeds", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const execute: GraphQLExecutor = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("Throttled: too many requests");
      return { data: { metafieldsSet: { metafields: [], userErrors: [] } } };
    };
    const result = await writeMetafieldsInBatches(entries(10), execute, {
      concurrency: 1,
      maxAttempts: 4,
      baseBackoffMs: 10,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(result.written).toBe(10);
    expect(result.retries).toBe(2);
    expect(waits).toEqual([10, 20]);
  });

  it("reports per-entry user errors instead of failing the whole write", async () => {
    const execute: GraphQLExecutor = async (_query, variables) => {
      const sent = variables.metafields as Array<{ ownerId: string }>;
      if (sent.some((entry) => entry.ownerId.endsWith("/1"))) {
        return { data: { metafieldsSet: { metafields: [], userErrors: [{ message: "Value is invalid" }] } } };
      }
      return { data: { metafieldsSet: { metafields: sent, userErrors: [] } } };
    };
    const result = await writeMetafieldsInBatches(entries(50), execute, {
      concurrency: 1,
      sleep: async () => {},
    });
    expect(result.written).toBe(25);
    expect(result.errors).toHaveLength(25);
    expect(result.errors[0]!.message).toContain("Value is invalid");
  });
});

describe("metafield entry building", () => {
  it("skips values that did not change", () => {
    const current = makeProduct().legal;
    const built = buildLegalMetafieldEntries(current, { mrp: current.mrp, genericName: "new name" });
    expect(built.map((entry) => entry.key)).toEqual(["generic_name"]);
  });

  it("maps domain fields to the legal_in keys and types", () => {
    const built = buildLegalMetafieldEntries(makeProduct().legal, { mrp: 199, manufacturerAddress: "New address" });
    expect(built).toEqual([
      expect.objectContaining({ key: "mrp", type: "number_decimal", value: "199" }),
      expect.objectContaining({ key: "manufacturer_address", type: "multi_line_text_field", value: "New address" }),
    ]);
  });
});

describe("applyLegalUpdates", () => {
  it("writes, then logs old value, new value and timestamp per field", async () => {
    const { repo, shop } = await makeRepo();
    const catalog = new FakeCatalog([
      makeProduct({ productId: "gid://shopify/Product/1", legal: { mrp: null, genericName: null } }),
    ]);
    const writer = new FakeWriter(catalog);
    const now = new Date("2026-10-30T09:15:00.000Z");

    const result = await applyLegalUpdates({
      shop,
      repo,
      writer,
      products: catalog.products,
      updates: [{ productId: "gid://shopify/Product/1", values: { mrp: 249, genericName: "face wash" } }],
      source: "bulk_editor",
      now,
    });

    expect(result.written).toBe(2);
    expect(result.productsChanged).toBe(1);
    const log = await repo.listChangeLog(shop.id);
    expect(log).toHaveLength(2);
    const mrp = log.find((row) => row.field === "mrp")!;
    expect(mrp.oldValue).toBeNull();
    expect(mrp.newValue).toBe("249");
    expect(mrp.changedAt).toEqual(now);
    expect(mrp.source).toBe("bulk_editor");
  });

  it("records nothing when the value is unchanged", async () => {
    const { repo, shop } = await makeRepo();
    const catalog = new FakeCatalog([makeProduct({ legal: { mrp: 300 } })]);
    const writer = new FakeWriter(catalog);
    const result = await applyLegalUpdates({
      shop,
      repo,
      writer,
      products: catalog.products,
      updates: [{ productId: catalog.products[0]!.productId, values: { mrp: 300 } }],
      source: "bulk_editor",
    });
    expect(result.written).toBe(0);
    expect(await repo.listChangeLog(shop.id)).toEqual([]);
  });

  it("rejects invalid values per row without writing that row", async () => {
    const { repo, shop } = await makeRepo();
    const catalog = new FakeCatalog([
      makeProduct({ productId: "gid://shopify/Product/1", handle: "a" }),
      makeProduct({ productId: "gid://shopify/Product/2", handle: "b", legal: { countryOfOrigin: null } }),
    ]);
    const writer = new FakeWriter(catalog);
    const result = await applyLegalUpdates({
      shop,
      repo,
      writer,
      products: catalog.products,
      updates: [
        // Deliberately invalid input: the merchant typed a word into the MRP box.
        { productId: "gid://shopify/Product/1", values: { mrp: "not-a-number" as unknown as number } },
        { productId: "gid://shopify/Product/2", values: { countryOfOrigin: "India" } },
      ],
      source: "bulk_editor",
    });
    expect(result.validationErrors).toEqual([
      { productId: "gid://shopify/Product/1", field: "mrp", message: expect.any(String) },
    ]);
    expect(result.written).toBe(1);
    const log = await repo.listChangeLog(shop.id);
    expect(log).toHaveLength(1);
    expect(log[0]!.productId).toBe("gid://shopify/Product/2");
  });

  it("blocks a product id that is not in the catalogue snapshot", async () => {
    const { repo, shop } = await makeRepo();
    const catalog = new FakeCatalog([makeProduct()]);
    const writer = new FakeWriter(catalog);
    const result = await applyLegalUpdates({
      shop,
      repo,
      writer,
      products: catalog.products,
      updates: [{ productId: "gid://shopify/Product/999", values: { mrp: 100 } }],
      source: "bulk_editor",
    });
    expect(result.written).toBe(0);
    expect(result.validationErrors[0]!.message).toContain("not in the current catalogue");
  });

  it("applies a default to a vendor group and only to empty fields", async () => {
    const products = [
      makeProduct({ productId: "1", handle: "a", vendor: "Aranya", legal: { genericName: null } }),
      makeProduct({ productId: "2", handle: "b", vendor: "Aranya", legal: { genericName: "already set" } }),
      makeProduct({ productId: "3", handle: "c", vendor: "Other", legal: { genericName: null } }),
    ];
    const updates = buildDefaultUpdates(products, {
      groupBy: "vendor",
      groupValue: "Aranya",
      field: "genericName",
      value: "face wash",
    });
    expect(updates).toEqual([{ productId: "1", values: { genericName: "face wash" } }]);
  });

  it("can overwrite every product in a group when asked", async () => {
    const products = [
      makeProduct({ productId: "1", handle: "a", vendor: "Aranya", legal: { genericName: "x" } }),
      makeProduct({ productId: "2", handle: "b", vendor: "Aranya", legal: { genericName: null } }),
    ];
    const updates = buildDefaultUpdates(products, {
      groupBy: "vendor",
      groupValue: "Aranya",
      field: "genericName",
      value: "face wash",
      onlyMissing: false,
    });
    expect(updates).toHaveLength(2);
  });

  it("writes 200 products in batches of 25", async () => {
    const { repo, shop } = await makeRepo();
    const products = Array.from({ length: 200 }, (_, index) =>
      makeProduct({ productId: `gid://shopify/Product/${index}`, handle: `p${index}`, legal: { mrp: null } }),
    );
    const catalog = new FakeCatalog(products);
    const writer = new FakeWriter(catalog);
    const result = await applyLegalUpdates({
      shop,
      repo,
      writer,
      products: catalog.products,
      updates: products.map((product) => ({ productId: product.productId, values: { mrp: 249 } })),
      source: "bulk_editor",
    });
    expect(result.written).toBe(200);
    expect(writer.batches).toEqual(Array.from({ length: 8 }, () => 25));
    const log = await repo.listChangeLog(shop.id, 500);
    expect(log).toHaveLength(200);
  });
});
