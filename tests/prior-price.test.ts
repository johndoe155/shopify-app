import { describe, expect, it } from "vitest";
import {
  PRIOR_PRICE_SCHEMA,
  buildPublishedPriorPrice,
  computePriorPrice,
  decideBlockC,
  publishNeedForProduct,
  shouldSnapshot,
  type PricePoint,
} from "~/domain/prior-price";

const DAY = 24 * 60 * 60 * 1000;
const base = new Date("2026-09-01T00:00:00.000Z");
const day = (n: number) => new Date(base.getTime() + n * DAY);

describe("computePriorPrice", () => {
  it("takes the lowest price in the 30 days before the current price took effect", () => {
    const snapshots: PricePoint[] = [
      { price: 349, observedAt: day(0) },
      { price: 299, observedAt: day(5) },
      { price: 319, observedAt: day(10) },
      { price: 249, observedAt: day(40) }, // outside the window
      { price: 249, observedAt: day(60) }, // outside the window
    ];
    const result = computePriorPrice({
      snapshots,
      current: { price: 249, compareAtPrice: 399, effectiveAt: day(31) },
      trackingStart: day(-10),
    });
    expect(result.priorPrice).toBe(299);
    expect(result.historyComplete).toBe(true);
    expect(result.windowDays).toBe(30);
  });

  it("ignores the snapshot that recorded the current price at the moment it took effect", () => {
    const snapshots: PricePoint[] = [
      { price: 399, observedAt: day(10) },
      { price: 249, observedAt: day(20) }, // the current price, at effectiveAt
    ];
    const result = computePriorPrice({
      snapshots,
      current: { price: 249, compareAtPrice: 399, effectiveAt: day(20) },
      trackingStart: day(-10),
    });
    expect(result.priorPrice).toBe(399);
  });

  it("suppresses the amount when tracking is shorter than 30 days (audit item L16)", () => {
    const snapshots: PricePoint[] = [
      { price: 399, observedAt: day(20) },
      { price: 349, observedAt: day(25) },
    ];
    const result = computePriorPrice({
      snapshots,
      current: { price: 299, compareAtPrice: 399, effectiveAt: day(28) },
      trackingStart: day(20),
    });
    // The lowest tracked price would be 349, but a partial history is not a
    // statutory prior price, so the field is empty until the lookback completes.
    expect(result.priorPrice).toBeNull();
    expect(result.historyComplete).toBe(false);
    expect(result.daysOfHistory).toBe(8);
    expect(result.completeBy).toEqual(new Date(day(50).getTime()));
    expect(result.announcement).not.toBeNull();
  });

  it("returns no prior price when there is no history at all", () => {
    const result = computePriorPrice({
      snapshots: [],
      current: { price: 249, compareAtPrice: 399, effectiveAt: day(1) },
      trackingStart: day(0),
    });
    expect(result.priorPrice).toBeNull();
    expect(result.hasSnapshots).toBe(false);
    expect(result.historyComplete).toBe(false);
  });

  it("handles a price drop: the prior price is the higher pre-drop price", () => {
    const snapshots: PricePoint[] = [{ price: 500, observedAt: day(0) }];
    const result = computePriorPrice({
      snapshots,
      current: { price: 350, compareAtPrice: 550, effectiveAt: day(10) },
      trackingStart: day(-40),
    });
    expect(result.priorPrice).toBe(500);
  });

  it("handles a price increase: the prior price is the older lower price", () => {
    const snapshots: PricePoint[] = [
      { price: 350, observedAt: day(0) },
      { price: 400, observedAt: day(5) },
    ];
    const result = computePriorPrice({
      snapshots,
      current: { price: 450, compareAtPrice: 550, effectiveAt: day(10) },
      trackingStart: day(-40),
    });
    expect(result.priorPrice).toBe(350);
  });

  it("caps days of history at the window size", () => {
    const result = computePriorPrice({
      snapshots: [],
      current: { price: 100, compareAtPrice: null, effectiveAt: day(90) },
      trackingStart: day(0),
    });
    expect(result.daysOfHistory).toBe(30);
    expect(result.historyComplete).toBe(true);
  });
});

describe("decideBlockC", () => {
  const prior = (overrides: Partial<ReturnType<typeof computePriorPrice>> = {}) => ({
    ...computePriorPrice({
      snapshots: [{ price: 399, observedAt: day(0) }],
      current: { price: 249, compareAtPrice: 399, effectiveAt: day(5) },
      trackingStart: day(-40),
    }),
    variantId: "v1",
    ...overrides,
  });

  it("shows when the compare-at price is above the selling price", () => {
    const decision = decideBlockC({ price: 249, compareAtPrice: 399, effectiveAt: day(5) }, prior());
    expect(decision.show).toBe(true);
    expect(decision.priorPrice).toBe(399);
    expect(decision.history).toBe("complete");
  });

  it("hides when there is no compare-at price", () => {
    const decision = decideBlockC({ price: 249, compareAtPrice: null, effectiveAt: day(5) }, prior());
    expect(decision.show).toBe(false);
  });

  it("hides when the compare-at price is not above the selling price", () => {
    const decision = decideBlockC({ price: 399, compareAtPrice: 399, effectiveAt: day(5) }, prior());
    expect(decision.show).toBe(false);
  });

  it("suppresses a short history and explains when a lookback exists, without a figure", () => {
    const shortHistory = prior({ historyComplete: false, priorPrice: null });
    const decision = decideBlockC({ price: 249, compareAtPrice: 399, effectiveAt: day(5) }, shortHistory);
    expect(decision.show).toBe(false);
    expect(decision.priorPrice).toBeNull();
    expect(decision.history).toBe("incomplete");
    expect(decision.completeBy).not.toBeNull();
    // The remaining wording is explicitly non-statutory and carries no amount.
    expect(decision.trackingNote).toContain("No prior price is shown until then");
    expect(decision.trackingNote).not.toMatch(/₹|Rs\.?\s?\d/);
  });
});

describe("shouldSnapshot", () => {
  it("snapshots the first observation", () => {
    expect(shouldSnapshot(null, { price: 100, compareAtPrice: null })).toBe(true);
  });

  it("skips identical prices", () => {
    expect(shouldSnapshot({ price: 100, compareAtPrice: 150 }, { price: 100, compareAtPrice: 150 })).toBe(false);
  });

  it("snapshots a price change and a compare-at change", () => {
    expect(shouldSnapshot({ price: 100, compareAtPrice: 150 }, { price: 90, compareAtPrice: 150 })).toBe(true);
    expect(shouldSnapshot({ price: 100, compareAtPrice: 150 }, { price: 100, compareAtPrice: 180 })).toBe(true);
  });
});

describe("buildPublishedPriorPrice", () => {
  it("writes one entry per variant with the label the block shows", () => {
    const published = buildPublishedPriorPrice(
      [
        {
          variantId: "v1",
          current: { price: 249, compareAtPrice: 399, effectiveAt: day(5) },
          prior: {
            ...computePriorPrice({
              snapshots: [{ price: 399, observedAt: day(0) }],
              current: { price: 249, compareAtPrice: 399, effectiveAt: day(5) },
              trackingStart: day(-40),
            }),
            variantId: "v1",
          },
        },
        {
          variantId: "v2",
          current: { price: 100, compareAtPrice: null, effectiveAt: day(5) },
          prior: null,
        },
      ],
      day(-40),
      30,
      day(6),
    );
    expect(published.variants).toHaveLength(2);
    expect(published.variants[0]).toMatchObject({ variant_id: "v1", prior_price: 399, show: true, label: "complete" });
    expect(published.variants[1]).toMatchObject({ variant_id: "v2", prior_price: null, show: false });
    expect(published.window_days).toBe(30);
    expect(published.history_complete).toBe(false); // the second variant has no history
  });
});

/**
 * Regression tests for the reported failure: "Prior price disappears after 30
 * days of stable pricing." Snapshots are only written when a price changes, so a
 * variant that sold at ₹300 from install until it dropped to ₹249 has exactly one
 * snapshot — on install day. Counting only the snapshots inside the 30-day window
 * found nothing once that single snapshot fell out of it, so a drop on day 31 or
 * 45 reported no prior price, R11 failed and Block C hid. Those are the cases the
 * plan targets: installs by 2 December and sales after 1 January.
 */
describe("stable pricing followed by a drop (reported failure)", () => {
  const install = day(0);
  // One snapshot: the install-day baseline. The price never changed until the
  // drop, so nothing else was ever written.
  const stableAt300: PricePoint[] = [{ price: 300, observedAt: day(0) }];

  const dropOnDay = (n: number) =>
    computePriorPrice({
      snapshots: stableAt300,
      current: { price: 249, compareAtPrice: 300, effectiveAt: day(n) },
      trackingStart: install,
    });

  it("suppresses a drop on day 20, when the lookback is not yet complete", () => {
    const result = dropOnDay(20);
    expect(result.priorPrice).toBeNull();
    expect(result.historyComplete).toBe(false);
  });

  it("suppresses a drop on day 29 for the same reason", () => {
    expect(dropOnDay(29).priorPrice).toBeNull();
  });

  it("keeps the prior price for a drop on day 31, after the baseline left the window", () => {
    const result = dropOnDay(31);
    expect(result.priorPrice).toBe(300);
    expect(result.historyComplete).toBe(true);
  });

  it("keeps the prior price for a drop on day 45", () => {
    expect(dropOnDay(45).priorPrice).toBe(300);
  });

  it("still reports the price in effect at the window start long after install", () => {
    expect(dropOnDay(400).priorPrice).toBe(300);
    expect(dropOnDay(400).historyComplete).toBe(true);
  });

  it("takes the lowest price in effect during the window when the price moved inside it", () => {
    const snapshots: PricePoint[] = [
      { price: 300, observedAt: day(0) }, // install baseline, price in effect at the window start
      { price: 280, observedAt: day(20) }, // inside the window of a day-40 drop
      { price: 290, observedAt: day(30) },
    ];
    const result = computePriorPrice({
      snapshots,
      current: { price: 249, compareAtPrice: 300, effectiveAt: day(40) },
      trackingStart: install,
    });
    // The window starts on day 10 (40 - 30): the price carried into it is 300,
    // then 280 and 290 are recorded inside it. The lowest of those is 280.
    expect(result.priorPrice).toBe(280);
  });

  it("carries the pre-window price in when the window opens between two snapshots", () => {
    const snapshots: PricePoint[] = [
      { price: 300, observedAt: day(0) },
      { price: 320, observedAt: day(5) },
    ];
    const result = computePriorPrice({
      snapshots,
      current: { price: 249, compareAtPrice: 399, effectiveAt: day(45) },
      trackingStart: install,
    });
    // Window starts on day 15: the price in effect then is 320 (recorded day 5),
    // and there is nothing else inside the window.
    expect(result.priorPrice).toBe(320);
  });
});

/**
 * Regression test: "A compare-at-only change can produce a prior price equal to
 * the current price." Reducing the compare-at price without touching the selling
 * price writes a snapshot (compare-at changed) whose price equals the current
 * price, which the old minimum happily returned.
 */
describe("compare-at-only change never yields prior price === current price", () => {
  it("returns the last different price before the compare-at moved", () => {
    const snapshots: PricePoint[] = [
      { price: 300, observedAt: day(0) },
      { price: 249, observedAt: day(10) }, // selling price dropped to 249
      { price: 249, observedAt: day(20) }, // compare-at changed; price unchanged
    ];
    const result = computePriorPrice({
      snapshots,
      current: { price: 249, compareAtPrice: 349, effectiveAt: day(20) },
      trackingStart: day(-40),
    });
    expect(result.priorPrice).toBe(300);
    expect(result.priorPrice).not.toBe(249);
  });

  it("returns null rather than the current price when no other price exists", () => {
    const snapshots: PricePoint[] = [{ price: 249, observedAt: day(0) }];
    const result = computePriorPrice({
      snapshots,
      current: { price: 249, compareAtPrice: 349, effectiveAt: day(5) },
      trackingStart: day(0),
    });
    expect(result.priorPrice).toBeNull();
  });

  it("does not let Block C render the current price as the prior price", () => {
    const prior = computePriorPrice({
      snapshots: [{ price: 249, observedAt: day(0) }],
      current: { price: 249, compareAtPrice: 349, effectiveAt: day(5) },
      trackingStart: day(0),
    });
    const decision = decideBlockC({ price: 249, compareAtPrice: 349, effectiveAt: day(5) }, prior);
    expect(decision.show).toBe(false);
    expect(decision.priorPrice).toBeNull();
  });
});

describe("publish staleness decisions", () => {
  const product = (price: number, compareAtPrice: number | null) => ({
    variants: [{ variantId: "v1", price, compareAtPrice }],
  });
  const stored = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema: PRIOR_PRICE_SCHEMA,
      variants: [
        {
          variant_id: "v1",
          price: 249,
          compare_at: 399,
          prior_price: 282,
          label: "complete",
          show: true,
          visible: true,
          ...overrides,
        },
      ],
      tracked_since: "2026-01-01T00:00:00.000Z",
      history_complete: true,
      complete_by: "2026-01-31T00:00:00.000Z",
      window_days: 30,
      updated_at: "2026-02-01T00:00:00.000Z",
    });

  it("republishes a product whose sale has ended, so the old payload is cleared", () => {
    // The reported bug: publishPriorPrices skipped products with no discount and
    // never cleared the metafield, so "Prior price ₹282" survived the sale.
    expect(publishNeedForProduct(product(249, null), stored())).toEqual({
      publish: true,
      reason: "no_discount",
    });
  });

  it("republishes when the compare-at price is no longer above the selling price", () => {
    expect(publishNeedForProduct(product(249, 249), stored()).reason).toBe("no_discount");
  });

  it("leaves an already-cleared metafield alone", () => {
    const cleared = JSON.stringify({
      schema: PRIOR_PRICE_SCHEMA,
      variants: [],
      tracked_since: "2026-01-01T00:00:00.000Z",
      history_complete: true,
      complete_by: "2026-01-31T00:00:00.000Z",
      window_days: 30,
      updated_at: "2026-02-01T00:00:00.000Z",
    });
    expect(publishNeedForProduct(product(249, null), cleared)).toEqual({ publish: false, reason: "current" });
  });

  it("leaves a current payload alone", () => {
    expect(publishNeedForProduct(product(249, 399), stored()).publish).toBe(false);
  });

  it("republishes when the stored payload is from an older release", () => {
    expect(publishNeedForProduct(product(249, 399), JSON.stringify({ variants: [{ variant_id: "v1" }] })).reason).toBe(
      "legacy",
    );
  });

  it("republishes when the price moved after the payload was written", () => {
    expect(publishNeedForProduct(product(239, 399), stored()).reason).toBe("missing_variant");
  });

  it("republishes when the stored payload still shows a variant that is no longer reduced", () => {
    const twoVariants = {
      variants: [
        { variantId: "v1", price: 249, compareAtPrice: 399 },
        { variantId: "v2", price: 100, compareAtPrice: null },
      ],
    };
    const payload = JSON.stringify({
      schema: PRIOR_PRICE_SCHEMA,
      variants: [
        { variant_id: "v1", price: 249, compare_at: 399, prior_price: 282, label: "complete", show: true },
        { variant_id: "v2", price: 120, compare_at: 200, prior_price: 150, label: "complete", show: true },
      ],
      tracked_since: "2026-01-01T00:00:00.000Z",
      history_complete: true,
      complete_by: "2026-01-31T00:00:00.000Z",
      window_days: 30,
      updated_at: "2026-02-01T00:00:00.000Z",
    });
    expect(publishNeedForProduct(twoVariants, payload).reason).toBe("stale_variant");
  });
});
