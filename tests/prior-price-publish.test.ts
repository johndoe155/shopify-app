/**
 * Publishing `legal_in.prior_price` (F5 / Block C).
 *
 * These cover the two production failures reported against the publisher:
 *
 *  1. "Block C can show a stale prior price." `publishPriorPrices` skipped every
 *     product without a discount and never cleared the metafield — while its own
 *     comment claimed it did — so after a sale ended the storefront kept showing
 *     "Prior price ₹282" from the last payload.
 *  2. "Prior price disappears after 30 days of stable pricing." The publisher is
 *     the only writer of the metafield, so the reported day-31 and day-45 drops
 *     are exercised end-to-end here: catalogue + snapshots in, metafield out.
 */
import { describe, expect, it } from "vitest";
import { publishPriorPrices, recordPriceSnapshots } from "~/services/price-history.server";
import { runScan } from "~/services/scan.server";
import { FakeCatalog, FakeWriter, makeProduct, makeRepo, DAY } from "./helpers";

const NOW = new Date("2026-12-31T00:00:00.000Z");

function discountedProduct(price: number, compareAtPrice: number | null) {
  return makeProduct({
    productId: "gid://shopify/Product/1",
    handle: "amla-hair-oil",
    variants: [{ variantId: "v1", title: "Default", price, compareAtPrice }],
  });
}

async function storeInstalledDaysAgo(days: number) {
  const { repo, shop } = await makeRepo();
  const installedAt = new Date(NOW.getTime() - days * DAY);
  const updated = await repo.updateShop(shop.id, { installedAt });
  return { repo, shop: updated };
}

function payloadOf(writer: FakeWriter, productId: string) {
  const entry = writer.entriesFor(productId).filter((written) => written.key === "prior_price").at(-1);
  return entry ? (JSON.parse(entry.value) as { variants: Array<Record<string, unknown>> }) : null;
}

describe("publishPriorPrices clears a stale prior price when the sale ends", () => {
  it("deletes the metafield once the compare-at price is gone", async () => {
    const { repo, shop } = await storeInstalledDaysAgo(40);
    const onSale = discountedProduct(249, 300);
    const catalog = new FakeCatalog([onSale]);
    const writer = new FakeWriter(catalog);
    await repo.insertPriceSnapshots(shop.id, [
      { productId: onSale.productId, variantId: "v1", price: 300, compareAt: 300, observedAt: new Date(NOW.getTime() - 10 * DAY), source: "install" },
    ]);

    const first = await publishPriorPrices({ shop, repo, catalog, writer, now: NOW });
    expect(first.published).toBe(1);
    const payload = payloadOf(writer, onSale.productId);
    expect(payload?.variants[0]).toMatchObject({ prior_price: 300, show: true });
    expect(onSale.priorPriceMetafield).toBeTruthy();

    // The sale ends: Shopify clears the compare-at price.
    onSale.variants[0]!.compareAtPrice = null;
    const second = await publishPriorPrices({ shop, repo, catalog, writer, now: NOW });

    expect(second.cleared).toBe(1);
    expect(writer.deletes).toEqual([{ ownerId: onSale.productId, namespace: "legal_in", key: "prior_price" }]);
    expect(onSale.priorPricePublished).toBe(false);
  });

  it("also clears when the compare-at price drops to the selling price", async () => {
    const { repo, shop } = await storeInstalledDaysAgo(40);
    const product = discountedProduct(249, 300);
    const catalog = new FakeCatalog([product]);
    const writer = new FakeWriter(catalog);
    await repo.insertPriceSnapshots(shop.id, [
      { productId: product.productId, variantId: "v1", price: 300, compareAt: 300, observedAt: new Date(NOW.getTime() - 10 * DAY), source: "install" },
    ]);
    await publishPriorPrices({ shop, repo, catalog, writer, now: NOW });

    product.variants[0]!.compareAtPrice = 249;
    const result = await publishPriorPrices({ shop, repo, catalog, writer, now: NOW });
    expect(result.cleared).toBe(1);
  });

  it("does not rewrite a payload that is already current", async () => {
    const { repo, shop } = await storeInstalledDaysAgo(40);
    const product = discountedProduct(249, 300);
    const catalog = new FakeCatalog([product]);
    const writer = new FakeWriter(catalog);
    await repo.insertPriceSnapshots(shop.id, [
      { productId: product.productId, variantId: "v1", price: 300, compareAt: 300, observedAt: new Date(NOW.getTime() - 10 * DAY), source: "install" },
    ]);

    await publishPriorPrices({ shop, repo, catalog, writer, now: NOW });
    const writesAfterFirst = writer.writes.length;
    const second = await publishPriorPrices({ shop, repo, catalog, writer, now: NOW });
    expect(second.skipped).toBe(1);
    expect(second.published).toBe(0);
    expect(writer.writes.length).toBe(writesAfterFirst);
  });

  it("writes nothing for a product that was never discounted and has no metafield", async () => {
    const { repo, shop } = await storeInstalledDaysAgo(40);
    const plain = discountedProduct(249, null);
    const catalog = new FakeCatalog([plain]);
    const writer = new FakeWriter(catalog);
    const result = await publishPriorPrices({ shop, repo, catalog, writer, now: NOW });
    expect(result.published).toBe(0);
    expect(result.cleared).toBe(0);
    expect(writer.writes).toHaveLength(0);
  });

  it("publishes only the products it was asked about", async () => {
    const { repo, shop } = await storeInstalledDaysAgo(40);
    const first = discountedProduct(249, 300);
    const second = makeProduct({
      productId: "gid://shopify/Product/2",
      handle: "second",
      variants: [{ variantId: "v2", title: "Default", price: 199, compareAtPrice: 299 }],
    });
    const catalog = new FakeCatalog([first, second]);
    const writer = new FakeWriter(catalog);
    await repo.insertPriceSnapshots(shop.id, [
      { productId: first.productId, variantId: "v1", price: 300, compareAt: 300, observedAt: new Date(NOW.getTime() - 10 * DAY), source: "install" },
      { productId: second.productId, variantId: "v2", price: 299, compareAt: 299, observedAt: new Date(NOW.getTime() - 10 * DAY), source: "install" },
    ]);

    await publishPriorPrices({ shop, repo, catalog, writer, now: NOW, productIds: [first.productId] });
    expect(writer.entriesFor(first.productId)).toHaveLength(1);
    expect(writer.entriesFor(second.productId)).toHaveLength(0);
  });
});

describe("publishPriorPrices survives long stable pricing", () => {
  for (const dropDay of [20, 29, 31, 45]) {
    it(`handles a drop on day ${dropDay} after install according to the lookback`, async () => {
      const { repo, shop } = await storeInstalledDaysAgo(dropDay + 5);
      const product = discountedProduct(249, 300);
      const catalog = new FakeCatalog([product]);
      const writer = new FakeWriter(catalog);

      // Install-day baseline at ₹300, then nothing until the drop: the only
      // snapshot is the baseline, recorded before the window even starts.
      const installedAt = shop.installedAt;
      await repo.insertPriceSnapshots(shop.id, [
        {
          productId: product.productId,
          variantId: "v1",
          price: 300,
          compareAt: 300,
          observedAt: new Date(installedAt.getTime() + 60 * 1000),
          source: "install",
        },
        {
          productId: product.productId,
          variantId: "v1",
          price: 249,
          compareAt: 300,
          observedAt: new Date(installedAt.getTime() + dropDay * DAY),
          source: "webhook",
        },
      ]);

      const result = await publishPriorPrices({
        shop,
        repo,
        catalog,
        writer,
        now: new Date(installedAt.getTime() + dropDay * DAY + DAY),
      });
      expect(result.published).toBe(1);
      const payload = payloadOf(writer, product.productId);
      // Audit item L16: the amount is only published when the 30 days before the
      // drop were fully tracked. A drop on day 20 or 29 has a shorter history, so
      // the entry is written but suppressed rather than labelled with a figure.
      if (dropDay >= 30) {
        expect(payload?.variants[0]).toMatchObject({ prior_price: 300, show: true, label: "complete" });
      } else {
        expect(payload?.variants[0]).toMatchObject({ prior_price: null, show: false, label: "incomplete" });
        expect(payload?.variants[0]?.tracking_note).toContain("No prior price is shown until then");
      }
    });
  }
});

describe("price snapshots are only written on change", () => {
  it("records the install baseline and then nothing while the price is stable", async () => {
    const { repo, shop } = await storeInstalledDaysAgo(40);
    const product = discountedProduct(249, 300);
    const catalog = new FakeCatalog([product]);

    expect((await recordPriceSnapshots({ shop, repo, products: [product], source: "install", now: NOW })).inserted).toBe(1);
    expect((await recordPriceSnapshots({ shop, repo, products: [product], source: "nightly_diff", now: NOW })).inserted).toBe(0);
    // 20 days of a stable price writes no rows: the baseline is the history.
    expect((await repo.listPriceSnapshots(shop.id)).length).toBe(1);
    void catalog;
  });
});

/**
 * The reported scenario, end to end: scan + publish + R11, not just the domain
 * function. A variant sells at ₹300 from install and drops to ₹249 on day N; the
 * only snapshot is the install-day baseline because nothing changed in between.
 * Before the fix, day 31 and day 45 produced no prior price — so R11 failed and
 * Block C hid. Those are exactly the timings the plan targets (installs by 2 Dec,
 * sales after 1 Jan).
 */
describe("R11 and Block C across the whole pipeline", () => {
  const INSTALL = new Date("2026-11-01T00:00:00.000Z");

  async function scenario(dropDay: number) {
    const { repo, shop: base } = await makeRepo();
    const shop = await repo.updateShop(base.id, { installedAt: INSTALL });
    const product = makeProduct({
      productId: "gid://shopify/Product/1",
      handle: "stable-then-dropped",
      variants: [{ variantId: "v1", title: "Default", price: 300, compareAtPrice: 300 }],
    });
    const catalog = new FakeCatalog([product]);
    const writer = new FakeWriter(catalog);

    // Install day: the baseline at the price it was actually selling at.
    await recordPriceSnapshots({
      shop,
      repo,
      products: [product],
      source: "install",
      now: new Date(INSTALL.getTime() + 60 * 1000),
    });

    // Day N: the merchant drops it to ₹249 and puts ₹300 as the compare-at price.
    const dropAt = new Date(INSTALL.getTime() + dropDay * DAY);
    product.variants[0]!.price = 249;
    product.variants[0]!.compareAtPrice = 300;
    await recordPriceSnapshots({ shop, repo, products: [product], source: "webhook", now: dropAt });

    const now = new Date(dropAt.getTime() + 60 * 60 * 1000);
    await publishPriorPrices({ shop, repo, catalog, writer, now });
    const scan = await runScan({
      shop,
      repo,
      catalog,
      now,
      blocks: { declarations: "detected", grievance: "detected", priorPrice: "detected" },
    });
    const outcome = scan.outcomes[0]!;
    return { product, writer, outcome };
  }

  for (const dropDay of [31, 45]) {
    it(`passes R11 and shows the prior price for a drop on day ${dropDay}`, async () => {
      const { product, outcome } = await scenario(dropDay);
      const r11 = outcome.results.find((result) => result.ruleId === "R11")!;
      expect(r11.status).toBe("pass");

      const stored = JSON.parse(product.priorPriceMetafield!) as {
        variants: Array<{ prior_price: number; show: boolean; visible: boolean }>;
      };
      expect(stored.variants[0]).toMatchObject({ prior_price: 300, show: true, visible: true });
    });
  }

  for (const dropDay of [20, 29]) {
    it(`suppresses the prior price, and fails R11, for a drop on day ${dropDay}`, async () => {
      const { product, outcome } = await scenario(dropDay);
      const r11 = outcome.results.find((result) => result.ruleId === "R11")!;
      // No statutory prior price exists yet, so R11 says so instead of passing on
      // a partial-window figure. The storefront publishes no amount either.
      expect(r11.status).toBe("fail");
      expect(r11.message).toContain("30 days");

      const stored = JSON.parse(product.priorPriceMetafield!) as {
        variants: Array<{ prior_price: number | null; show: boolean; visible: boolean }>;
      };
      expect(stored.variants[0]).toMatchObject({ prior_price: null, show: false, visible: false });
    });
  }

  it("drops R11 to not_applicable once the sale ends and the metafield is cleared", async () => {
    const { repo, shop: base } = await makeRepo();
    const shop = await repo.updateShop(base.id, { installedAt: INSTALL });
    const product = makeProduct({
      productId: "gid://shopify/Product/1",
      handle: "sale-ended",
      variants: [{ variantId: "v1", title: "Default", price: 249, compareAtPrice: 300 }],
    });
    const catalog = new FakeCatalog([product]);
    const writer = new FakeWriter(catalog);
    const blocks = { declarations: "detected" as const, grievance: "detected" as const, priorPrice: "detected" as const };

    await recordPriceSnapshots({
      shop,
      repo,
      products: [{ ...product, variants: [{ ...product.variants[0]!, price: 300, compareAtPrice: 300 }] }],
      source: "install",
      now: new Date(INSTALL.getTime() + 60 * 1000),
    });
    const onSaleUntil = new Date(INSTALL.getTime() + 40 * DAY);
    await publishPriorPrices({ shop, repo, catalog, writer, now: onSaleUntil });
    expect(product.priorPriceMetafield).toContain('"prior_price":300');

    const duringSale = await runScan({ shop, repo, catalog, now: onSaleUntil, blocks });
    expect(duringSale.outcomes[0]!.results.find((r) => r.ruleId === "R11")!.status).toBe("pass");

    // The sale ends: Shopify clears the compare-at price.
    product.variants[0]!.compareAtPrice = null;
    const afterSale = new Date(onSaleUntil.getTime() + DAY);
    const cleared = await publishPriorPrices({ shop, repo, catalog, writer, now: afterSale });
    expect(cleared.cleared).toBe(1);
    expect(product.priorPriceMetafield).toBeNull();

    const after = await runScan({ shop, repo, catalog, now: afterSale, blocks });
    // Nothing is discounted any more, so R11 does not apply - it is not a failure,
    // and the storefront metafield the block reads is gone.
    expect(after.outcomes[0]!.results.find((r) => r.ruleId === "R11")!.status).toBe("not_applicable");
  });
});
