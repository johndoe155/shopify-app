/**
 * Recorded price announcements (audit item L13).
 *
 * A discount code or an automatic discount is applied at checkout, so no variant
 * price moves and the app's own snapshots cannot show that a reduction was
 * announced. Those reductions are not excluded — they are **recorded**, and the
 * 30-day lookback is measured from the recorded announcement. These tests cover
 * the register, the resolution order, and the effect on R11 and on the published
 * metafield.
 */
import { describe, expect, it } from "vitest";
import {
  groupAnnouncementsByProduct,
  pickAnnouncement,
  productPriorPrices,
  publishPriorPrices,
  resolveVariantCurrent,
} from "~/services/price-history.server";
import { runScan } from "~/services/scan.server";
import { FakeCatalog, FakeWriter, makeProduct, makeRepo, DAY } from "./helpers";
import type { PriceAnnouncementRow } from "~/db/types";
import type { PriceAnnouncementMechanism } from "~/domain/types";

const NOW = new Date("2026-12-31T00:00:00.000Z");

function product(price: number, compareAtPrice: number | null) {
  return makeProduct({
    productId: "gid://shopify/Product/1",
    handle: "amla-hair-oil",
    variants: [{ variantId: "v1", title: "Default", price, compareAtPrice }],
  });
}

/** A row shaped like one the repository returns. */
function row(overrides: Partial<PriceAnnouncementRow> = {}): PriceAnnouncementRow {
  return {
    id: "a1",
    productId: "gid://shopify/Product/1",
    variantId: "v1",
    announcedAt: new Date(NOW.getTime() - 5 * DAY),
    consumerPrice: 224,
    mechanism: "discount_code",
    conditions: "Code MONSOON",
    createdAt: new Date(NOW.getTime() - 4 * DAY),
    ...overrides,
  };
}

describe("the announcement register", () => {
  it("records, lists and deletes an announcement", async () => {
    const { repo, shop } = await makeRepo();
    const created = await repo.recordPriceAnnouncement(shop.id, {
      productId: "gid://shopify/Product/1",
      variantId: "v1",
      announcedAt: new Date("2026-12-01T00:00:00.000Z"),
      consumerPrice: 224,
      mechanism: "discount_code",
      conditions: "Code MONSOON",
    });
    expect(created.id).toBeTruthy();
    const listed = await repo.listPriceAnnouncements(shop.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ productId: "gid://shopify/Product/1", consumerPrice: 224 });

    expect(await repo.deletePriceAnnouncement(shop.id, created.id)).toBe(true);
    expect(await repo.listPriceAnnouncements(shop.id)).toHaveLength(0);
    // Deleting twice is not an error: the row is already gone.
    expect(await repo.deletePriceAnnouncement(shop.id, created.id)).toBe(false);
  });

  it("replaces the announcement for the same product and variant", async () => {
    // One current announcement per variant: two would make "the 30 days before
    // the announcement" ambiguous.
    const { repo, shop } = await makeRepo();
    await repo.recordPriceAnnouncement(shop.id, {
      productId: "gid://shopify/Product/1",
      variantId: "v1",
      announcedAt: new Date("2026-12-01T00:00:00.000Z"),
      consumerPrice: 224,
      mechanism: "discount_code",
      conditions: "Code MONSOON",
    });
    await repo.recordPriceAnnouncement(shop.id, {
      productId: "gid://shopify/Product/1",
      variantId: "v1",
      announcedAt: new Date("2026-12-20T00:00:00.000Z"),
      consumerPrice: 199,
      mechanism: "automatic_discount",
      conditions: "20% off automatically at checkout",
    });
    const listed = await repo.listPriceAnnouncements(shop.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      consumerPrice: 199,
      mechanism: "automatic_discount",
      announcedAt: new Date("2026-12-20T00:00:00.000Z"),
    });
  });

  it("keeps a whole-product record apart from a per-variant one", async () => {
    const { repo, shop } = await makeRepo();
    await repo.recordPriceAnnouncement(shop.id, {
      productId: "gid://shopify/Product/1",
      variantId: null,
      announcedAt: new Date("2026-12-01T00:00:00.000Z"),
      consumerPrice: 224,
      mechanism: "discount_code",
      conditions: "Code MONSOON",
    });
    await repo.recordPriceAnnouncement(shop.id, {
      productId: "gid://shopify/Product/1",
      variantId: "v2",
      announcedAt: new Date("2026-12-10T00:00:00.000Z"),
      consumerPrice: 199,
      mechanism: "automatic_discount",
      conditions: null,
    });
    expect(await repo.listPriceAnnouncements(shop.id)).toHaveLength(2);
    expect(
      await repo.listPriceAnnouncements(shop.id, { productId: "gid://shopify/Product/2" }),
    ).toHaveLength(0);
    expect(
      await repo.listPriceAnnouncements(shop.id, { productId: "gid://shopify/Product/1" }),
    ).toHaveLength(2);
  });

  it("deletes the announcements with the rest of the shop's data", async () => {
    const { repo, shop } = await makeRepo();
    await repo.recordPriceAnnouncement(shop.id, {
      productId: "gid://shopify/Product/1",
      variantId: null,
      announcedAt: NOW,
      consumerPrice: 224,
      mechanism: "discount_code",
      conditions: null,
    });
    await repo.deleteShopData(shop.shopDomain);
    expect(await repo.listPriceAnnouncements(shop.id)).toHaveLength(0);
  });
});

describe("pickAnnouncement", () => {
  const fallback = {
    effectiveAt: new Date("2026-12-25T00:00:00.000Z"),
    consumerPrice: 249,
    mechanism: "compare_at" as PriceAnnouncementMechanism,
  };

  it("prefers a recorded announcement over the derived one", () => {
    const resolved = pickAnnouncement([row()], "v1", fallback, NOW);
    expect(resolved.recorded).toBe(true);
    expect(resolved.invalid).toBeNull();
    expect(resolved.announcement).toEqual({
      announcedAt: new Date(NOW.getTime() - 5 * DAY),
      consumerPrice: 224,
      mechanism: "discount_code",
      conditions: "Code MONSOON",
    });
  });

  it("falls back to the derived announcement when nothing is recorded", () => {
    const resolved = pickAnnouncement([], "v1", fallback, NOW);
    expect(resolved.recorded).toBe(false);
    expect(resolved.announcement).toMatchObject({ consumerPrice: 249, mechanism: "compare_at" });
  });

  it("prefers a per-variant record over a whole-product one", () => {
    const resolved = pickAnnouncement(
      [row({ id: "product-wide", variantId: null, consumerPrice: 200 }), row({ id: "per-variant" })],
      "v1",
      fallback,
      NOW,
    );
    expect(resolved.announcement.consumerPrice).toBe(224);
  });

  it("uses the whole-product record for a variant with no record of its own", () => {
    const resolved = pickAnnouncement([row({ variantId: null })], "v9", fallback, NOW);
    expect(resolved.recorded).toBe(true);
    expect(resolved.announcement.mechanism).toBe("discount_code");
  });

  it("reports a future-dated record instead of using it", () => {
    // A mistyped year must not quietly move the lookback window.
    const future = row({ announcedAt: new Date("2027-06-01T00:00:00.000Z") });
    const resolved = pickAnnouncement([future], "v1", fallback, NOW);
    expect(resolved.recorded).toBe(false);
    expect(resolved.invalid).toEqual(future);
    expect(resolved.announcement.announcedAt).toEqual(fallback.effectiveAt);
  });

  it("takes the most recent usable record", () => {
    const resolved = pickAnnouncement(
      [
        row({ id: "old", announcedAt: new Date("2026-11-01T00:00:00.000Z") }),
        row({ id: "new", announcedAt: new Date("2026-12-01T00:00:00.000Z"), consumerPrice: 180 }),
      ],
      "v1",
      fallback,
      NOW,
    );
    expect(resolved.announcement.consumerPrice).toBe(180);
  });

  it("groups records by product, newest first", () => {
    const grouped = groupAnnouncementsByProduct([
      row({ productId: "p1" }),
      row({ id: "a2", productId: "p2" }),
      row({ id: "a3", productId: "p1", announcedAt: new Date("2026-12-01T00:00:00.000Z") }),
    ]);
    expect([...grouped.keys()].sort()).toEqual(["p1", "p2"]);
    expect(grouped.get("p1")).toHaveLength(2);
    // a1 is dated five days before NOW, a3 on 1 December: newest first.
    expect(grouped.get("p1")![0]!.id).toBe("a1");
  });
});

describe("resolveVariantCurrent", () => {
  it("takes the effective date and consumer price from the record", () => {
    const current = resolveVariantCurrent(
      { variantId: "v1", price: 299, compareAtPrice: null },
      [{ price: 299, observedAt: new Date(NOW.getTime() - 40 * DAY), compareAt: null }],
      [row()],
      NOW,
    );
    expect(current.announcementRecorded).toBe(true);
    expect(current.effectiveAt).toEqual(new Date(NOW.getTime() - 5 * DAY));
    expect(current.consumerPrice).toBe(224);
    expect(current.mechanism).toBe("discount_code");
    expect(current.conditions).toBe("Code MONSOON");
  });

  it("derives the announcement from snapshots when nothing is recorded", () => {
    const current = resolveVariantCurrent(
      { variantId: "v1", price: 249, compareAtPrice: 299 },
      [
        { price: 299, observedAt: new Date(NOW.getTime() - 40 * DAY), compareAt: 299 },
        { price: 249, observedAt: new Date(NOW.getTime() - 3 * DAY), compareAt: 299 },
      ],
      [],
      NOW,
    );
    expect(current.announcementRecorded).toBe(false);
    expect(current.mechanism).toBe("variant_price");
    expect(current.consumerPrice).toBe(249);
  });
});

describe("a reduction only a record can show", () => {
  /**
   * A store whose variant price never moves: 299 throughout, no compare-at price,
   * and a discount code that takes the price the shopper pays to 224. Without a
   * record the app sees no reduction at all.
   */
  async function codeOnlyStore(options: { record: boolean; mechanism?: PriceAnnouncementMechanism } = {
    record: true,
  }) {
    const { repo, shop } = await makeRepo();
    const updated = await repo.updateShop(shop.id, {
      installedAt: new Date(NOW.getTime() - 60 * DAY),
    });
    const item = product(299, null);
    const catalog = new FakeCatalog([item]);
    const writer = new FakeWriter(catalog);
    // One price, observed regularly: the lookback behind any date in the last
    // month is a complete one.
    await repo.insertPriceSnapshots(
      updated.id,
      [50, 40, 30, 20, 10].map((days) => ({
        productId: item.productId,
        variantId: "v1",
        price: 299,
        compareAt: null,
        observedAt: new Date(NOW.getTime() - days * DAY),
        source: "install" as const,
      })),
    );
    if (options.record) {
      await repo.recordPriceAnnouncement(updated.id, {
        productId: item.productId,
        variantId: "v1",
        announcedAt: new Date(NOW.getTime() - 5 * DAY),
        consumerPrice: 224,
        mechanism: options.mechanism ?? "discount_code",
        conditions: "Code MONSOON, one per customer",
      });
    }
    return { repo, shop: updated, item, catalog, writer };
  }

  it("is not scanned as a reduced product when nothing is recorded", async () => {
    const { repo, shop, catalog } = await codeOnlyStore({ record: false });
    await runScan({ shop, repo, catalog, now: NOW });
    const rows = await repo.listScanResults(shop.id);
    expect(rows.find((scanRow) => scanRow.ruleId === "R11")!.status).toBe("not_applicable");
  });

  it("is checked against R11 once the reduction is recorded", async () => {
    const { repo, shop, catalog, writer } = await codeOnlyStore();
    await publishPriorPrices({ shop, repo, catalog, writer, now: NOW });
    await runScan({ shop, repo, catalog, now: NOW });
    const rows = await repo.listScanResults(shop.id);
    const r11 = rows.find((scanRow) => scanRow.ruleId === "R11")!;
    expect(r11.status).toBe("pass");
    expect(r11.message).toContain("discount code");
  });

  it("says which mechanism it used for a recorded automatic discount", async () => {
    const { repo, shop, catalog, writer } = await codeOnlyStore({ record: true, mechanism: "automatic_discount" });
    await publishPriorPrices({ shop, repo, catalog, writer, now: NOW });
    await runScan({ shop, repo, catalog, now: NOW });
    const rows = await repo.listScanResults(shop.id);
    expect(rows.find((scanRow) => scanRow.ruleId === "R11")!.message).toContain("automatic discount");
  });

  it("publishes the price the shopper pays, and that it was recorded", async () => {
    const { repo, shop, catalog, writer, item } = await codeOnlyStore();
    await publishPriorPrices({ shop, repo, catalog, writer, now: NOW });
    const entry = writer
      .entriesFor(item.productId)
      .filter((written) => written.key === "prior_price")
      .at(-1)!;
    const payload = JSON.parse(entry.value) as { variants: Array<Record<string, unknown>> };
    expect(payload.variants[0]).toMatchObject({
      prior_price: 299,
      consumer_price: 224,
      announcement_recorded: true,
      announcement_mechanism: "discount_code",
      announcement_price: 224,
      announcement_conditions: "Code MONSOON, one per customer",
      show: true,
    });
  });

  it("measures the lookback from the recorded date, not from a price change", () => {
    // 299 for most of the history, 279 from twenty days ago, 249 from three days
    // ago. The announcement the app derives is three days old; a recorded one
    // twenty-five days old looks back over a different thirty days, and the
    // lowest price in it is different.
    const points = [
      { price: 299, observedAt: new Date(NOW.getTime() - 50 * DAY), compareAt: 299 },
      { price: 279, observedAt: new Date(NOW.getTime() - 20 * DAY), compareAt: 299 },
      { price: 249, observedAt: new Date(NOW.getTime() - 3 * DAY), compareAt: 299 },
    ];
    const trackingStart = new Date(NOW.getTime() - 60 * DAY);
    const derived = productPriorPrices({
      product: product(249, 299),
      snapshotsByVariant: new Map([["v1", points]]),
      trackingStart,
      now: NOW,
    });
    const recorded = productPriorPrices({
      product: product(249, 299),
      snapshotsByVariant: new Map([["v1", points]]),
      trackingStart,
      now: NOW,
      announcements: [row({ announcedAt: new Date(NOW.getTime() - 25 * DAY) })],
    });
    expect(derived.get("v1")!.announcement!.announcedAt.getTime()).toBe(
      new Date(NOW.getTime() - 3 * DAY).getTime(),
    );
    expect(recorded.get("v1")!.announcement!.announcedAt.getTime()).toBe(
      new Date(NOW.getTime() - 25 * DAY).getTime(),
    );
    expect(derived.get("v1")!.priorPrice).toBe(279);
    expect(recorded.get("v1")!.priorPrice).toBe(299);
    expect(recorded.get("v1")!.historyComplete).toBe(true);
    expect(recorded.get("v1")!.announcementRecorded).toBe(true);
    expect(derived.get("v1")!.announcementRecorded).toBe(false);
  });
});
