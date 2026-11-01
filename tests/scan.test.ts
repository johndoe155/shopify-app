import { describe, expect, it } from "vitest";
import { runProductRescan, runScan } from "~/services/scan.server";
import { publishPriorPrices, recordPriceSnapshots } from "~/services/price-history.server";
import { planCsvImport } from "~/domain/csv";
import { FakeCatalog, FakeWriter, makeProduct, makeRepo, DAY } from "./helpers";

function catalogue() {
  return [
    makeProduct({ productId: "gid://shopify/Product/1", handle: "p1", title: "Passing product" }),
    makeProduct({
      productId: "gid://shopify/Product/2",
      handle: "p2",
      title: "Missing MRP and origin",
      legal: { mrp: null, countryOfOrigin: null },
    }),
    makeProduct({
      productId: "gid://shopify/Product/3",
      handle: "p3",
      title: "Imported, no importer",
      legal: {
        countryOfOrigin: "China",
        // R3 keeps the wording printed on the pack for every package, and for an
        // imported one it must name the country in full — the default "Made in
        // India" would be a genuine failure here.
        countryOfOriginLabel: "Made in China",
        isImportedPackage: true,
        importerName: null,
        importerAddress: null,
      },
    }),
    makeProduct({
      productId: "gid://shopify/Product/4",
      handle: "p4",
      title: "Date sensitive, no date",
      legal: { expiryType: "best_before", expiryDate: null },
    }),
  ];
}

describe("full catalogue scan", () => {
  it("stores one row per product per rule and summarises correctly", async () => {
    const { repo, shop } = await makeRepo();
    const catalog = new FakeCatalog(catalogue());

    const result = await runScan({ shop, repo, catalog, now: new Date("2026-10-30T12:00:00.000Z") });

    expect(result.productCount).toBe(4);
    expect(result.summary.totalProducts).toBe(4);
    expect(result.summary.passingProducts).toBe(1);
    expect(result.summary.scorePercent).toBe(25);
    expect(result.overPlanLimit).toBe(false);

    const rows = await repo.listScanResults(shop.id);
    // 4 products x 9 product rules (R1-R7, R11, R13)
    expect(rows).toHaveLength(36);
    expect(rows.filter((row) => row.status === "fail").map((row) => `${row.productHandle}:${row.ruleId}`)).toEqual(
      expect.arrayContaining(["p2:R1", "p2:R3", "p3:R4", "p4:R7"]),
    );
  });

  it("is idempotent: running twice does not duplicate rows", async () => {
    const { repo, shop } = await makeRepo();
    const catalog = new FakeCatalog(catalogue());
    await runScan({ shop, repo, catalog });
    await runScan({ shop, repo, catalog });
    expect(await repo.listScanResults(shop.id)).toHaveLength(36);
  });

  it("reflects a fix on the next scan", async () => {
    const { repo, shop } = await makeRepo();
    const catalog = new FakeCatalog(catalogue());
    await runScan({ shop, repo, catalog });

    catalog.products[1]!.legal.mrp = 300;
    catalog.products[1]!.legal.countryOfOrigin = "India";
    catalog.products[2]!.legal.importerName = "Aranya Imports Pvt Ltd";
    catalog.products[2]!.legal.importerAddress = "MG Road, Mumbai 400001, Maharashtra";
    catalog.products[3]!.legal.expiryDate = "05/2027";

    const second = await runScan({ shop, repo, catalog });
    expect(second.summary.scorePercent).toBe(100);
    expect(second.summary.passingProducts).toBe(4);
  });

  it("removes rows for products that no longer exist", async () => {
    const { repo, shop } = await makeRepo();
    const catalog = new FakeCatalog(catalogue());
    await runScan({ shop, repo, catalog });
    catalog.products = catalog.products.filter((product) => product.productId !== "gid://shopify/Product/4");
    const second = await runScan({ shop, repo, catalog });
    expect(second.productCount).toBe(3);
    expect((await repo.listScanResults(shop.id)).filter((row) => row.productHandle === "p4")).toHaveLength(0);
  });

  it("scores 500 products with 9 rows each inside the 60 second target", async () => {
    const { repo, shop } = await makeRepo();
    const products = Array.from({ length: 500 }, (_, index) =>
      makeProduct({
        productId: `gid://shopify/Product/${5000 + index}`,
        handle: `bulk-${index}`,
        title: `Product ${index}`,
        legal: index % 3 === 0 ? { mrp: null } : {},
      }),
    );
    const catalog = new FakeCatalog(products);

    const startedAt = Date.now();
    const result = await runScan({ shop, repo, catalog, now: new Date("2026-10-30T12:00:00.000Z") });
    const elapsed = Date.now() - startedAt;

    expect(result.productCount).toBe(500);
    expect(result.summary.totalProducts).toBe(500);
    expect(await repo.listScanResults(shop.id)).toHaveLength(500 * 9);
    // The brief's target is 500 products scored in under a minute; the scoring
    // pass itself must be far below that so the GraphQL wait is the only cost.
    expect(elapsed).toBeLessThan(60_000);
  });

  it("scopes the scan to the plan's product count and says so", async () => {
    const { repo, shop } = await makeRepo();
    const limitedShop = { ...shop, plan: "free" as const };
    const many = Array.from({ length: 14 }, (_, index) =>
      makeProduct({ productId: `gid://shopify/Product/${100 + index}`, handle: `p${index}` }),
    );
    const catalog = new FakeCatalog(many);
    const result = await runScan({ shop: limitedShop, repo, catalog });
    expect(result.coveredCount).toBe(10);
    expect(result.productCount).toBe(14);
    expect(result.overPlanLimit).toBe(true);
    // Nothing is deleted: the 4 products outside the plan simply have no rows.
    expect(await repo.listScanResults(limitedShop.id)).toHaveLength(90);
  });
});

describe("single product rescan (webhook path)", () => {
  it("updates only that product's rows", async () => {
    const { repo, shop } = await makeRepo();
    const catalog = new FakeCatalog(catalogue());
    await runScan({ shop, repo, catalog });

    const target = catalog.products[1]!;
    target.legal.mrp = 300;
    const outcome = await runProductRescan({
      shop,
      repo,
      catalog,
      productId: target.productId,
    });
    expect(outcome?.failingRuleIds).toEqual(["R3"]);

    const rows = await repo.listScanResults(shop.id);
    expect(rows.filter((row) => row.productHandle === "p2" && row.ruleId === "R1")[0]!.status).toBe("pass");
    expect(rows).toHaveLength(36);
  });
});

describe("price history", () => {
  it("records a snapshot on the install baseline and then only on change", async () => {
    const { repo, shop } = await makeRepo();
    const catalog = new FakeCatalog(catalogue());
    const first = await recordPriceSnapshots({ shop, repo, products: catalog.products, source: "install" });
    expect(first.inserted).toBe(4);

    const second = await recordPriceSnapshots({ shop, repo, products: catalog.products, source: "nightly_diff" });
    expect(second.inserted).toBe(0);

    catalog.products[0]!.variants[0]!.price = 199;
    const third = await recordPriceSnapshots({
      shop,
      repo,
      products: catalog.products,
      source: "webhook",
      now: new Date(shop.installedAt.getTime() + DAY),
    });
    expect(third.inserted).toBe(1);
  });

  it("publishes prior price metafields for discounted products only", async () => {
    const { repo, shop } = await makeRepo();
    const discounted = makeProduct({
      productId: "gid://shopify/Product/9",
      handle: "discounted",
      variants: [{ variantId: "v9", title: "Default", price: 249, compareAtPrice: 399 }],
    });
    const plain = makeProduct({ productId: "gid://shopify/Product/10", handle: "plain" });
    const catalog = new FakeCatalog([discounted, plain]);
    const writer = new FakeWriter(catalog);

    await repo.insertPriceSnapshots(shop.id, [
      {
        productId: discounted.productId,
        variantId: "v9",
        price: 399,
        compareAt: 399,
        // Inside the 30-day window: the price before the drop.
        observedAt: new Date(Date.now() - 15 * DAY),
        source: "webhook",
      },
    ]);

    const result = await publishPriorPrices({ shop, repo, catalog, writer });
    expect(result.published).toBe(1);
    const entries = writer.entriesFor(discounted.productId);
    expect(entries).toHaveLength(1);
    const payload = JSON.parse(entries[0]!.value) as { variants: Array<{ prior_price: number | null }> };
    expect(payload.variants[0]!.prior_price).toBe(399);
    expect(writer.entriesFor(plain.productId)).toHaveLength(0);
  });
});

describe("CSV import applied through the same write path", () => {
  it("writes the imported fields and logs each change", async () => {
    const { repo, shop } = await makeRepo();
    const catalog = new FakeCatalog(catalogue());
    await runScan({ shop, repo, catalog });

    const { applyLegalUpdates } = await import("~/services/legal-writes.server");
    const writer = new FakeWriter(catalog);
    const csv = "handle,mrp,country_of_origin\np2,349,India\n";
    const preview = planCsvImport(
      csv,
      catalog.products.map((product) => ({
        handle: product.handle,
        title: product.title,
        productType: product.productType,
        legal: product.legal,
      })),
    );
    const result = await applyLegalUpdates({
      shop,
      repo,
      writer,
      products: catalog.products,
      updates: preview.rows.map((row) => ({
        productId: catalog.products.find((product) => product.handle === row.handle)!.productId,
        values: row.values,
      })),
      source: "csv_import",
    });
    expect(result.written).toBe(2);
    const changeLog = await repo.listChangeLog(shop.id);
    expect(changeLog.map((row) => row.field).sort()).toEqual(["country_of_origin", "mrp"]);
    expect(changeLog.every((row) => row.source === "csv_import")).toBe(true);
    expect(changeLog.every((row) => row.changedAt instanceof Date)).toBe(true);
  });
});
