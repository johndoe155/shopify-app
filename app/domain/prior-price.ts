/**
 * Prior-price algorithm.
 *
 * Prior price = the lowest price of the good during the **30 days before the
 * announcement** of the reduction (Consumer Protection (E-Commerce) (Amendment)
 * Rules, 2026, prior-price provision inserted after Rule 4(11)).
 *
 * Two audit findings drive this file:
 *
 *   L13 — the rule is about an announced price reduction, not a bare variant price
 *         change, and the app must record the announcement event, the
 *         consumer-facing price, the conditions and the variant identity. A
 *         discount code or automatic discount that announces a reduction is not
 *         categorically excluded by the text reviewed, so the exclusion is gone
 *         and the announcement mechanism is recorded instead.
 *
 *   L16 — there is no short-history safe harbour. A value computed from a partial
 *         install-to-date history must NOT be displayed as the statutory prior
 *         price. It is suppressed until a complete 30-day lookback exists, and any
 *         tracking message that remains is clearly non-statutory.
 *
 * The window itself is anchored on the *price in effect at the window start*
 * rather than "the minimum of the snapshots inside the window": snapshots are only
 * written when a price changes, so a variant that sat at ₹300 for six weeks has a
 * single snapshot, and a pure min-inside-window reading would lose the prior price
 * as soon as that snapshot fell out of the window.
 */
import type { PriceAnnouncement, PriceAnnouncementMechanism, VariantPriorPrice } from "./types";

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface PricePoint {
  price: number;
  observedAt: Date;
}

export interface CurrentPrice {
  /** The variant's selling price, as Shopify holds it. */
  price: number;
  compareAtPrice: number | null;
  /** The moment the current price took effect: the announcement event. */
  effectiveAt: Date;
  /**
   * How the reduction reaches the shopper. Defaults to a variant price change;
   * a recorded code or automatic discount sets its own mechanism so the evidence
   * names the announcement that actually happened.
   */
  mechanism?: PriceAnnouncementMechanism;
  /** Free-text conditions attached to the announcement (code, minimum basket). */
  conditions?: string | null;
  /**
   * What the shopper actually pays, when it is not the variant price.
   *
   * A discount code or an automatic discount is applied at checkout, so the
   * variant price never moves and the app cannot see it. The merchant records
   * the price the shopper sees instead; it is this figure, not `price`, that the
   * prior price has to be lower than and that the announcement names.
   */
  consumerPrice?: number | null;
  /**
   * True when `consumerPrice`, `mechanism`, `conditions` and `effectiveAt` come
   * from an announcement the merchant recorded, rather than from the app's own
   * reading of the price snapshots.
   */
  announcementRecorded?: boolean;
}

/**
 * The price a prior price is measured against.
 *
 * Only a positive, finite recorded consumer price is used; anything else (null,
 * undefined, zero, NaN, a negative) falls back to the variant price, so a
 * half-filled announcement record can never produce a prior price above the
 * price the shopper is being compared with.
 */
function normaliseConsumerPrice(recorded: number | null | undefined, price: number): number {
  if (typeof recorded === "number" && Number.isFinite(recorded) && recorded > 0) return recorded;
  return price;
}

export interface PriorPriceInput {
  snapshots: PricePoint[];
  current: CurrentPrice;
  /** Date price tracking started for this store (the install date). */
  trackingStart: Date;
  /** Defaults to the config value, 30. */
  windowDays?: number;
}

/** Where the prior-price window starts: `effectiveAt` minus the window. */
export function priorPriceWindowStart(current: CurrentPrice, windowDays = 30): Date {
  return new Date(current.effectiveAt.getTime() - windowDays * DAY_MS);
}

/**
 * The price in effect at a moment, worked out from the *last price change* at or
 * before it — not from the snapshots that happen to fall inside a window.
 */
export function priceInEffectAt(
  changes: Array<{ price: number; observedAt: Date }>,
  at: Date,
): number | null {
  let best: { price: number; observedAt: Date } | null = null;
  for (const change of changes) {
    if (change.observedAt.getTime() > at.getTime()) continue;
    if (!best || change.observedAt.getTime() > best.observedAt.getTime()) best = change;
  }
  return best ? best.price : null;
}

export function computePriorPrice(input: PriorPriceInput): VariantPriorPrice {
  const windowDays = input.windowDays ?? 30;
  const { current, trackingStart } = input;

  const trackedMs = current.effectiveAt.getTime() - trackingStart.getTime();
  const rawDays = Math.floor(trackedMs / DAY_MS);
  const daysOfHistory = Math.max(0, Math.min(windowDays, rawDays));
  // A complete lookback means the app was already tracking for the whole window
  // before the announcement. Anything shorter is not a statutory prior price.
  const historyComplete = trackedMs >= windowDays * DAY_MS;

  const windowStart = priorPriceWindowStart(current, windowDays);
  const sorted = [...input.snapshots].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());

  // Snapshots strictly inside [windowStart, effectiveAt). The snapshot that
  // recorded the current price at effectiveAt is not part of "before".
  const inWindow = sorted.filter(
    (s) =>
      s.observedAt.getTime() >= windowStart.getTime() &&
      s.observedAt.getTime() < current.effectiveAt.getTime(),
  );

  const startPrice = priceInEffectAt(sorted, windowStart) ?? sorted[0]?.price ?? null;

  // The price the shopper pays. For a code or an automatic discount this is the
  // recorded consumer price, which is below the unmoved variant price, so the
  // comparison cannot use `current.price` alone: the whole point of the lookback
  // is to find the lowest price before *that* price was announced.
  const consumerPrice = normaliseConsumerPrice(current.consumerPrice, current.price);

  const candidates: number[] = [];
  for (const point of inWindow) candidates.push(point.price);
  if (startPrice !== null) candidates.push(startPrice);
  const distinct = candidates.filter((price) => price !== consumerPrice);
  let priorPrice = distinct.length > 0 ? Math.min(...distinct) : null;

  if (priorPrice === null) {
    const before = sorted.filter(
      (point) => point.observedAt.getTime() < current.effectiveAt.getTime() && point.price !== consumerPrice,
    );
    priorPrice = before.length > 0 ? before[before.length - 1]!.price : null;
  }

  const announcement: PriceAnnouncement = {
    announcedAt: current.effectiveAt,
    consumerPrice,
    mechanism: current.mechanism ?? "variant_price",
    conditions: current.conditions ?? null,
  };

  return {
    variantId: "", // filled in by the caller that knows the variant
    // A prior price is only ever reported as a value when the lookback is
    // complete. The raw computation is kept out of the statutory field so no
    // caller can accidentally display a partial-window number as "the" prior
    // price (audit L16).
    priorPrice: historyComplete ? priorPrice : null,
    historyComplete,
    // True when the merchant recorded the announcement event; a derived
    // announcement is the app's inference from its own snapshots (audit L13).
    announcementRecorded: current.announcementRecorded === true,
    trackedSince: trackingStart,
    completeBy: new Date(trackingStart.getTime() + windowDays * DAY_MS),
    windowDays,
    daysOfHistory,
    hasSnapshots: sorted.length > 0,
    announcement,
  };
}

export interface BlockCDecision {
  /** Block C renders a prior price only for a complete statutory lookback. */
  show: boolean;
  priorPrice: number | null;
  /** What the shopper pays, when a recorded announcement says it is not the variant price. */
  consumerPrice: number | null;
  /** "complete" = statutory value published; "incomplete" = suppressed. */
  history: "complete" | "incomplete" | "none";
  completeBy: Date | null;
  /** Recorded for the evidence trail; null when the lookback is incomplete. */
  announcement: PriceAnnouncement | null;
  /**
   * Non-statutory tracking note. Deliberately carries no amount, so it cannot be
   * mistaken for the required prior price (audit L16).
   */
  trackingNote: string | null;
}

/**
 * True when the shopper is being offered a reduction.
 *
 * Either Shopify's own compare-at price stands above the selling price, or the
 * merchant has recorded a consumer price below it. The second case is a discount
 * code or an automatic discount: those are applied at checkout, so no variant
 * price moves and a compare-at-only test would say the product is not reduced at
 * all (audit L13).
 */
export function isReducedPrice(current: {
  price: number;
  compareAtPrice: number | null;
  consumerPrice?: number | null;
}): boolean {
  if (current.compareAtPrice !== null && current.compareAtPrice > current.price) return true;
  const consumer = current.consumerPrice;
  return typeof consumer === "number" && Number.isFinite(consumer) && consumer > 0 && consumer < current.price;
}

/**
 * The note shown while a reduction has no statutory prior price.
 *
 * The previous wording promised a prior price "available from" the
 * tracking-complete date. That is false for the reduction on screen: whether a
 * lookback is complete is decided by the announcement date, so a reduction
 * announced before that date can never catch up. The note now says what is
 * actually true — there is no short-history safe harbour, prices from before
 * install are not backfilled, and nothing is published until a reduction is
 * announced after the window has filled (audit L16).
 */
/**
 * Whether the shopper is shown a reduction for this variant.
 *
 * `compare_at` is not the only way to announce one: a recorded discount code or
 * automatic discount puts the price the shopper pays below the selling price
 * without moving it. R11 uses this so such a reduction is in scope rather than
 * skipped as "not discounted" (audit L13).
 *
 * Only a *recorded* announcement can do this. A derived one has, by definition,
 * the selling price as its consumer price, so it changes nothing.
 */
export function variantIsReduced(variant: {
  price: number;
  compareAtPrice: number | null;
  priorPrice?: VariantPriorPrice | null;
}): boolean {
  const announcement = variant.priorPrice?.announcement ?? null;
  const recorded =
    variant.priorPrice?.announcementRecorded === true ? (announcement?.consumerPrice ?? null) : null;
  return isReducedPrice({
    price: variant.price,
    compareAtPrice: variant.compareAtPrice,
    consumerPrice: recorded,
  });
}

function trackingNoteFor(completeBy: Date): string {
  return `This app began tracking prices on install. A statutory prior price needs the lowest price across the full 30 days before the reduction was announced, so only a reduction announced on or after ${formatIsoDate(
    completeBy,
  )} can have one. Prices from before install are not backfilled. No prior price is shown until then.`;
}

function formatIsoDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

/**
 * Block C shows a prior price only when the live compare-at price is above the
 * current price *and* the lookback behind it is complete. An incomplete lookback
 * hides the amount and leaves only the non-statutory tracking note.
 */
export function decideBlockC(
  current: CurrentPrice,
  prior: VariantPriorPrice | null,
): BlockCDecision {
  if (!prior) {
    return {
      show: false,
      priorPrice: null,
      consumerPrice: null,
      history: "none",
      completeBy: null,
      announcement: null,
      trackingNote: null,
    };
  }
  const completeBy = prior.completeBy;
  const history = prior.historyComplete ? ("complete" as const) : ("incomplete" as const);
  const consumerPrice = normaliseConsumerPrice(current.consumerPrice, current.price);

  if (!isReducedPrice({ ...current, consumerPrice }) || prior.priorPrice === null) {
    return {
      show: false,
      priorPrice: null,
      consumerPrice: null,
      history,
      completeBy: prior.historyComplete ? null : completeBy,
      announcement: null,
      trackingNote: prior.historyComplete ? null : trackingNoteFor(completeBy),
    };
  }
  return {
    show: true,
    priorPrice: prior.priorPrice,
    consumerPrice,
    history,
    completeBy: null,
    announcement: prior.announcement,
    trackingNote: null,
  };
}

export interface VariantPriceState {
  price: number;
  compareAtPrice: number | null;
}

/** True when a webhook/diff should append a new PriceSnapshot. */
export function shouldSnapshot(previous: VariantPriceState | null, next: VariantPriceState): boolean {
  if (!previous) return true;
  return previous.price !== next.price || previous.compareAtPrice !== next.compareAtPrice;
}

/** One variant entry as written to the `legal_in.prior_price` metafield. */
export interface PublishedPriorPriceVariant {
  variant_id: string;
  price: number;
  compare_at: number | null;
  /** The statutory prior price. Null whenever the lookback is incomplete. */
  prior_price: number | null;
  /**
   * What the shopper pays where it differs from `price` (a recorded discount
   * code or automatic discount). Null when the selling price is the price paid.
   */
  consumer_price: number | null;
  label: "complete" | "incomplete";
  show: boolean;
  /** Same decision as `show`, named for the storefront block. */
  visible: boolean;
  /** True when the announcement was recorded by the merchant, not derived from snapshots. */
  announcement_recorded: boolean;
  announcement_at: string | null;
  announcement_price: number | null;
  announcement_mechanism: PriceAnnouncementMechanism | null;
  announcement_conditions: string | null;
  /** Non-statutory tracking note; contains no amount. */
  tracking_note: string | null;
}

/** Payload written to the `legal_in.prior_price` (json) product metafield for block C. */
export interface PublishedPriorPrice {
  schema: number;
  variants: PublishedPriorPriceVariant[];
  tracked_since: string;
  history_complete: boolean;
  complete_by: string;
  window_days: number;
  updated_at: string;
}

/**
 * The metafield payload. Bump when the stored shape changes so an older payload
 * written by a previous release is refreshed rather than trusted.
 *
 * 2: `prior_price` no longer means "lowest snapshot inside the window".
 * 3: a statutory prior price is only published from a complete 30-day lookback,
 *    each entry records the announcement event (L13), and the
 *    "tracked since install" label is replaced by a suppressed entry with a
 *    non-statutory tracking note (L16).
 * 4: each entry records whether the announcement was recorded by the merchant
 *    and the consumer-facing price where a code or automatic discount makes it
 *    different from the selling price (L13). An announcement recorded with a
 *    mechanism the app cannot see — a discount code or an automatic discount —
 *    is now publishable, which the previous shape had no room for.
 */
export const PRIOR_PRICE_SCHEMA = 4;

/** The variants worth publishing: every variant priced below its compare-at. */
export function variantsWithPriorPrice(
  product: { variants: Array<{ variantId: string; price: number; compareAtPrice: number | null }> },
): Array<{ variantId: string; price: number; compareAtPrice: number | null }> {
  return product.variants.filter((variant) => isReducedPrice(variant));
}

export type PublishReason =
  /** The sale ended or the product was never discounted: the metafield must be cleared. */
  | "no_discount"
  /** The metafield was written by an older release and must be refreshed. */
  | "legacy"
  /** The stored payload does not cover the variant that is currently reduced. */
  | "missing_variant"
  /** The stored payload still shows a variant that is no longer reduced. */
  | "stale_variant"
  /** Every reduced variant already has a current, visible entry. */
  | "current";

export interface PublishNeed {
  publish: boolean;
  reason: PublishReason;
}

function parseStoredPayload(stored: string | null | undefined): PublishedPriorPrice | null {
  if (!stored) return null;
  try {
    const payload = JSON.parse(stored) as PublishedPriorPrice;
    if (!payload || !Array.isArray(payload.variants)) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Should this product's `legal_in.prior_price` metafield be written again?
 *
 * A product that is no longer discounted is deliberately included: its old
 * payload has to be replaced with an empty one so the storefront stops showing a
 * prior price from a sale that has ended.
 */
/**
 * Variants reduced only through a recorded announcement.
 *
 * A discount code or an automatic discount is applied at checkout, so the
 * catalogue shows no reduction at all. The publisher has to treat those variants
 * as reduced — deciding whether to publish, and whether a stored payload is
 * stale — or it would never write their payload (audit item L13).
 */
export function publishNeedForProduct(
  product: {
    variants: Array<{ variantId: string; price: number; compareAtPrice: number | null }>;
  },
  stored: string | null | undefined,
  announcedVariantIds: ReadonlySet<string> = new Set(),
): PublishNeed {
  const reduced = product.variants.filter(
    (variant) => isReducedPrice(variant) || announcedVariantIds.has(variant.variantId),
  );
  const payload = parseStoredPayload(stored);

  if (!payload) {
    if (reduced.length === 0) return { publish: stored ? true : false, reason: "no_discount" };
    return { publish: true, reason: stored ? "legacy" : "missing_variant" };
  }
  if (payload.schema !== PRIOR_PRICE_SCHEMA) return { publish: true, reason: "legacy" };

  const showing = payload.variants.filter((entry) => entry.show === true);
  if (reduced.length === 0) {
    return showing.length === 0
      ? { publish: false, reason: "current" }
      : { publish: true, reason: "no_discount" };
  }

  const byVariant = new Map(payload.variants.map((entry) => [entry.variant_id, entry]));
  for (const variant of reduced) {
    const entry = byVariant.get(variant.variantId);
    if (!entry) return { publish: true, reason: "missing_variant" };
    // The stored entry must describe this price. A stored entry for a price that
    // has since moved is stale, and an entry whose lookback was incomplete has to
    // be rewritten once the lookback completes (or stays suppressed).
    if (entry.price !== variant.price) return { publish: true, reason: "missing_variant" };
    if (entry.prior_price === null && entry.label === "complete") {
      return { publish: true, reason: "missing_variant" };
    }
  }

  const reducedIds = new Set(reduced.map((variant) => variant.variantId));
  if (payload.variants.some((entry) => entry.show === true && !reducedIds.has(entry.variant_id))) {
    return { publish: true, reason: "stale_variant" };
  }
  return { publish: false, reason: "current" };
}

export function buildPublishedPriorPrice(
  variants: Array<{
    variantId: string;
    current: CurrentPrice;
    prior: VariantPriorPrice | null;
  }>,
  trackingStart: Date,
  windowDays: number,
  now: Date = new Date(),
): PublishedPriorPrice {
  const allComplete = variants.every((v) => v.prior?.historyComplete ?? false);
  return {
    schema: PRIOR_PRICE_SCHEMA,
    variants: variants.map((v) => {
      const decision = decideBlockC(v.current, v.prior);
      const consumerPrice = decision.consumerPrice;
      return {
        variant_id: v.variantId,
        price: v.current.price,
        compare_at: v.current.compareAtPrice,
        prior_price: decision.priorPrice,
        consumer_price:
          consumerPrice !== null && consumerPrice !== v.current.price ? consumerPrice : null,
        label: decision.priorPrice === null ? "incomplete" : "complete",
        show: decision.show,
        visible: decision.show,
        announcement_recorded: v.prior?.announcementRecorded === true,
        announcement_at: decision.announcement?.announcedAt.toISOString() ?? null,
        announcement_price: decision.announcement?.consumerPrice ?? null,
        announcement_mechanism: decision.announcement?.mechanism ?? null,
        announcement_conditions: decision.announcement?.conditions ?? null,
        tracking_note: decision.trackingNote,
      };
    }),
    tracked_since: trackingStart.toISOString(),
    history_complete: allComplete,
    complete_by: new Date(trackingStart.getTime() + windowDays * DAY_MS).toISOString(),
    window_days: windowDays,
    updated_at: now.toISOString(),
  };
}

/**
 * The payload that clears a product whose sale has ended. Same shape, no
 * variants to show, so the block's Liquid can evaluate it like any other payload
 * (and reports `variants.size == 0`, which hides the block).
 */
export function buildClearedPriorPrice(
  trackingStart: Date,
  windowDays: number,
  now: Date = new Date(),
): PublishedPriorPrice {
  return buildPublishedPriorPrice([], trackingStart, windowDays, now);
}

/** True when a stored payload has nothing for the block to show. */
export function isClearedPayload(stored: string | null | undefined): boolean {
  if (!stored) return false;
  try {
    const payload = JSON.parse(stored) as PublishedPriorPrice;
    return Array.isArray(payload.variants) && payload.variants.every((entry) => entry.show !== true);
  } catch {
    return false;
  }
}

/** Date by which every store that installs today has a full 30-day window. */
export function fullHistoryDate(trackingStart: Date, windowDays = 30): Date {
  return new Date(trackingStart.getTime() + windowDays * DAY_MS);
}
