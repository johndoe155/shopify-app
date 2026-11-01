/**
 * F5 / section 6 — price history and the prior price.
 *
 * Snapshots are written on every variant price change (webhook) and by a nightly
 * diff that catches missed webhooks. The computed prior price is published to a
 * product metafield so the storefront block needs no server call.
 *
 * Two things this file is now careful about:
 *
 *  - **Stale prior prices.** The publisher used to skip every product without a
 *    discount and never cleared the metafield, so a sale that ended kept
 *    rendering "Prior price ₹282" from the last payload. It now compares the
 *    stored payload with the live prices and clears the metafield when nothing is
 *    reduced any more.
 *  - **Writing the same value twice.** A payload that is already current is not
 *    rewritten, so a webhook storm does not turn into a metafield storm.
 */
import { RULES_CONFIG } from "~/domain/rules";
import {
  buildClearedPriorPrice,
  buildPublishedPriorPrice,
  computePriorPrice,
  publishNeedForProduct,
  isReducedPrice,
  shouldSnapshot,
  variantsWithPriorPrice,
  type CurrentPrice,
  type PricePoint,
} from "~/domain/prior-price";
import type { PriceAnnouncement, PriceAnnouncementMechanism, VariantPriorPrice } from "~/domain/types";
import type { Repository } from "~/db/repository";
import type { PriceAnnouncementRow, PriceSnapshotRow, ShopRecord } from "~/db/types";
import {
  PRIOR_PRICE_KEY,
  LEGAL_NAMESPACE,
  type CatalogProduct,
  type CatalogSource,
  type MetafieldSetEntry,
  type MetafieldWriter,
} from "./ports";

export interface SnapshotRecordingResult {
  inserted: number;
  variantsSeen: number;
  changedVariants: string[];
}

/**
 * The history a variant's prior price is computed from.
 *
 * `snapshots` must be **price changes**, not daily samples: an install-day
 * baseline plus one row per change. The domain algorithm reads the price in
 * effect at the window start from these, which is why a price that was stable for
 * 45 days still produces a prior price when it finally moves.
 */
export type VariantHistory = Array<{ price: number; observedAt: Date; compareAt: number | null }>;

/** Buckets snapshots by variant, sorted oldest first (the order the domain relies on). */
export function groupSnapshotsByVariant(
  snapshots: PriceSnapshotRow[],
): Map<string, VariantHistory> {
  const byVariant = new Map<string, VariantHistory>();
  for (const snapshot of snapshots) {
    const list = byVariant.get(snapshot.variantId) ?? [];
    list.push({ price: snapshot.price, observedAt: snapshot.observedAt, compareAt: snapshot.compareAt ?? null });
    byVariant.set(snapshot.variantId, list);
  }
  for (const list of byVariant.values()) {
    list.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  }
  return byVariant;
}

/**
 * The moment the current price took effect: the most recent snapshot that
 * recorded the current price, or `fallback` when the current price has never
 * been observed (the install-day baseline).
 */
export function resolvePriceEffectiveAt(
  snapshots: Array<{ price: number; compareAt: number | null; observedAt: Date }>,
  current: { price: number; compareAtPrice: number | null },
  fallback: Date,
  /** When true, only snapshots whose price matches count (ignores compare-at). */
  options: { ignoreCompareAt?: boolean } = {},
): Date {
  let best: Date | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.price !== current.price) continue;
    if (!options.ignoreCompareAt && snapshot.compareAt !== current.compareAtPrice) continue;
    if (!best || snapshot.observedAt.getTime() > best.getTime()) best = snapshot.observedAt;
  }
  return best ?? fallback;
}

/**
 * How the reduction reached the shopper, from the history the app can see.
 *
 * A price that fell is a variant-price announcement; a compare-at price that
 * appeared above an unchanged selling price is a compare-at announcement. The
 * audit (L13) requires the mechanism to be recorded, so a code or automatic
 * discount that is announced can be recorded against the same variant instead of
 * being excluded as a legal conclusion. Discount codes and checkout-level
 * automatic discounts are not visible to the Admin API, so the caller can pass an
 * explicit mechanism when one is recorded.
 *
 * This is the *derived* mechanism: the fallback for a reduction nobody recorded.
 * `pickAnnouncement` prefers a recorded announcement whenever there is one,
 * because only the merchant can name a mechanism the app cannot observe.
 */
export function resolveAnnouncementMechanism(
  snapshots: VariantHistory,
  current: { price: number; compareAtPrice: number | null },
): PriceAnnouncementMechanism {
  const samePrice = snapshots.filter((snapshot) => snapshot.price === current.price);
  if (samePrice.length === 0) return "variant_price";
  const last = samePrice[samePrice.length - 1]!;
  if (last.compareAt !== current.compareAtPrice && current.compareAtPrice !== null) return "compare_at";
  return "variant_price";
}

/**
 * The announcement that applies to one variant, and where it came from.
 *
 * Resolution order: an announcement recorded for this variant, then one recorded
 * for the whole product, then the announcement derived from the app's own
 * snapshots. A future-dated record is reported as invalid rather than silently
 * ignored, so a mistyped year cannot quietly move the lookback window.
 */
export interface ResolvedAnnouncement {
  /** The announcement to use: a recorded one when there is a usable record. */
  announcement: PriceAnnouncement;
  /** True when `announcement` came from a record the merchant entered. */
  recorded: boolean;
  /** A record dated after `now`: the app reports it instead of using it. */
  invalid: PriceAnnouncementRow | null;
}

export function pickAnnouncement(
  candidates: readonly PriceAnnouncementRow[],
  variantId: string,
  fallback: { effectiveAt: Date; consumerPrice: number; mechanism: PriceAnnouncementMechanism },
  now: Date,
): ResolvedAnnouncement {
  const forVariant = candidates.filter((row) => row.variantId === variantId);
  const forProduct = candidates.filter((row) => row.variantId === null);
  const ordered = [...forVariant, ...forProduct].sort(
    (a, b) => b.announcedAt.getTime() - a.announcedAt.getTime(),
  );
  const usable = ordered.filter((row) => row.announcedAt.getTime() <= now.getTime());
  const record = usable[0] ?? null;
  if (!record) {
    const future = ordered[0] ?? null;
    return {
      announcement: {
        announcedAt: fallback.effectiveAt,
        consumerPrice: fallback.consumerPrice,
        mechanism: fallback.mechanism,
        conditions: null,
      },
      recorded: false,
      invalid: future,
    };
  }
  return {
    announcement: {
      announcedAt: record.announcedAt,
      consumerPrice: record.consumerPrice,
      mechanism: record.mechanism,
      conditions: record.conditions,
    },
    recorded: true,
    invalid: null,
  };
}

/** Buckets recorded announcements by product id. */
export function groupAnnouncementsByProduct(
  announcements: readonly PriceAnnouncementRow[],
): Map<string, PriceAnnouncementRow[]> {
  const byProduct = new Map<string, PriceAnnouncementRow[]>();
  for (const row of announcements) {
    const list = byProduct.get(row.productId) ?? [];
    list.push(row);
    byProduct.set(row.productId, list);
  }
  for (const list of byProduct.values()) {
    list.sort((a, b) => b.announcedAt.getTime() - a.announcedAt.getTime());
  }
  return byProduct;
}

export interface ProductPriorPriceOptions {
  product: CatalogProduct;
  snapshotsByVariant: Map<string, VariantHistory>;
  trackingStart: Date;
  now: Date;
  windowDays?: number;
  /**
   * Announcements recorded for this product (audit item L13). Optional so the
   * callers that have not loaded any keep their current behaviour: the
   * announcement is then derived from the price snapshots, exactly as before.
   */
  announcements?: readonly PriceAnnouncementRow[];
}

export interface VariantCurrentPrice extends CurrentPrice {
  /** A recorded announcement dated in the future, if the merchant entered one. */
  invalidAnnouncement: PriceAnnouncementRow | null;
}

/**
 * The current price of one variant, as the prior-price algorithm sees it.
 *
 * A recorded announcement wins over the derived one, because only the merchant
 * can name a mechanism the app cannot observe: a discount code or an automatic
 * discount is applied at checkout, so no variant price moves and the app's
 * snapshots cannot show that anything was announced at all.
 */
export function resolveVariantCurrent(
  variant: { variantId: string; price: number; compareAtPrice: number | null },
  points: VariantHistory,
  announcements: readonly PriceAnnouncementRow[],
  now: Date,
): VariantCurrentPrice {
  // The current price took effect when it was first recorded at this value. A
  // compare-at-only change moves the compare-at figure without moving the
  // price, so the price-based match comes first and the pair-based one only
  // refines it.
  const effectiveAt = resolvePriceEffectiveAt(points, variant, now, { ignoreCompareAt: true });
  const resolved = pickAnnouncement(
    announcements,
    variant.variantId,
    {
      effectiveAt,
      consumerPrice: variant.price,
      mechanism: resolveAnnouncementMechanism(points, variant),
    },
    now,
  );
  return {
    price: variant.price,
    compareAtPrice: variant.compareAtPrice,
    effectiveAt: resolved.announcement.announcedAt,
    mechanism: resolved.announcement.mechanism,
    conditions: resolved.announcement.conditions,
    consumerPrice: resolved.announcement.consumerPrice,
    announcementRecorded: resolved.recorded,
    invalidAnnouncement: resolved.invalid,
  };
}

/** Prior price for every variant of one product (drop-in for the rule engine). */
export function productPriorPrices(options: ProductPriorPriceOptions): Map<string, VariantPriorPrice> {
  const windowDays = options.windowDays ?? RULES_CONFIG.parameters.priorPriceWindowDays;
  const announcements = options.announcements ?? [];
  const result = new Map<string, VariantPriorPrice>();
  for (const variant of options.product.variants) {
    const points: VariantHistory = options.snapshotsByVariant.get(variant.variantId) ?? [];
    const current = resolveVariantCurrent(variant, points, announcements, options.now);
    const computed = computePriorPrice({
      snapshots: points.map((point): PricePoint => ({ price: point.price, observedAt: point.observedAt })),
      current,
      trackingStart: options.trackingStart,
      windowDays,
    });
    result.set(variant.variantId, { ...computed, variantId: variant.variantId });
  }
  return result;
}

/**
 * The variants a recorded announcement reduces: every variant for a product-wide
 * record, and the named variant for a per-variant one.
 */
export function announcedVariantIdsFor(
  product: { variants: ReadonlyArray<{ variantId: string }> },
  announcements: readonly PriceAnnouncementRow[],
): Set<string> {
  const ids = new Set<string>();
  if (announcements.length === 0) return ids;
  const productWide = announcements.some((row) => row.variantId === null);
  for (const variant of product.variants) {
    if (productWide || announcements.some((row) => row.variantId === variant.variantId)) {
      ids.add(variant.variantId);
    }
  }
  return ids;
}

/** Builds the metafield payload for one product, using the shared algorithm. */
export function priorPricePayloadFor(
  product: CatalogProduct,
  snapshotsByVariant: Map<string, VariantHistory>,
  trackingStart: Date,
  now: Date,
  windowDays: number,
  announcements: readonly PriceAnnouncementRow[] = [],
) {
  const priorPrices = productPriorPrices({
    product,
    snapshotsByVariant,
    trackingStart,
    now,
    windowDays,
    announcements,
  });
  // A variant reduced only through a recorded announcement has no compare-at
  // price, so `variantsWithPriorPrice` misses it; without this a discount-code
  // reduction would leave the metafield empty (audit item L13).
  const announcedIds = announcedVariantIdsFor(product, announcements);
  const reduced = product.variants.filter(
    (variant) => variantsWithPriorPrice(product).includes(variant) || announcedIds.has(variant.variantId),
  );
  // Only the variants that are actually reduced are published: a payload that
  // lists every variant grows with the catalogue and gives the block nothing.
  const publishable = reduced;
  const entries = (publishable.length > 0 ? publishable : product.variants).map((variant) => ({
    variantId: variant.variantId,
    current: resolveVariantCurrent(variant, snapshotsByVariant.get(variant.variantId) ?? [], announcements, now),
    prior: priorPrices.get(variant.variantId) ?? null,
  }));
  return buildPublishedPriorPrice(entries, trackingStart, windowDays, now);
}

/**
 * Records a snapshot for every variant whose price changed since the last
 * stored snapshot. Used by the products/update webhook and by the nightly diff,
 * so a missed webhook is always repaired within 24 hours.
 */
export async function recordPriceSnapshots(options: {
  shop: ShopRecord;
  repo: Repository;
  products: CatalogProduct[];
  now?: Date;
  source: PriceSnapshotRow["source"];
}): Promise<SnapshotRecordingResult> {
  const now = options.now ?? new Date();
  const existing = await options.repo.listPriceSnapshots(options.shop.id);
  const latestByVariant = new Map<string, PriceSnapshotRow>();
  for (const snapshot of existing) {
    const current = latestByVariant.get(snapshot.variantId);
    if (!current || snapshot.observedAt.getTime() > current.observedAt.getTime()) {
      latestByVariant.set(snapshot.variantId, snapshot);
    }
  }

  const rows: PriceSnapshotRow[] = [];
  const changed: string[] = [];
  let variantsSeen = 0;

  for (const product of options.products) {
    for (const variant of product.variants) {
      variantsSeen += 1;
      const previous = latestByVariant.get(variant.variantId) ?? null;
      const next = { price: variant.price, compareAtPrice: variant.compareAtPrice };
      if (
        !shouldSnapshot(
          previous ? { price: previous.price, compareAtPrice: previous.compareAt } : null,
          next,
        )
      ) {
        continue;
      }
      // The install-day baseline is always recorded so history has a start point.
      rows.push({
        productId: product.productId,
        variantId: variant.variantId,
        price: variant.price,
        compareAt: variant.compareAtPrice,
        observedAt: now,
        source: options.source,
      });
      changed.push(variant.variantId);
    }
  }

  await options.repo.insertPriceSnapshots(options.shop.id, rows);
  return { inserted: rows.length, variantsSeen, changedVariants: changed };
}

export interface PublishPriorPricesOptions {
  shop: ShopRecord;
  repo: Repository;
  catalog: CatalogSource;
  writer: MetafieldWriter;
  now?: Date;
  windowDays?: number;
  /**
   * Only these products (a webhook's product, or the products a bulk edit
   * touched). Omit to consider the whole catalogue.
   */
  productIds?: string[];
  /**
   * The catalogue the caller already loaded. Passing it avoids a second full
   * read (and therefore a second bulk operation) in the same job.
   */
  products?: CatalogProduct[];
}

export interface PublishPriorPricesResult {
  /** Metafields written: payloads published and payloads cleared. */
  published: number;
  /** Metafields deleted because the product no longer has a reduced-price variant. */
  cleared: number;
  failed: number;
  /** Products examined. */
  considered: number;
  /** Products whose stored metafield was already correct and were not rewritten. */
  skipped: number;
}

/**
 * Computes and publishes `legal_in.prior_price`.
 *
 * For every product it decides, from the *stored* payload and the *live* prices,
 * whether to write a fresh payload, clear the metafield, or do nothing. Clearing
 * is a delete rather than an empty write: a payload of `{variants: []}` is still
 * a value the block has to reason about, and deleting is what the previous
 * version's comment claimed it did.
 */
export async function publishPriorPrices(
  options: PublishPriorPricesOptions,
): Promise<PublishPriorPricesResult> {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? RULES_CONFIG.parameters.priorPriceWindowDays;

  const catalogue = options.products ?? (await options.catalog.fetchProducts());
  const wanted = options.productIds ? new Set(options.productIds) : null;
  let products = wanted ? catalogue.filter((product) => wanted.has(product.productId)) : catalogue;

  // A targeted publish for a product the loaded catalogue does not contain (it
  // was created after the snapshot) is fetched directly.
  if (wanted && products.length < wanted.size && options.catalog.fetchProductsByIds) {
    const have = new Set(products.map((product) => product.productId));
    const missing = [...wanted].filter((id) => !have.has(id));
    if (missing.length > 0) {
      const extra = await options.catalog.fetchProductsByIds(missing);
      products = [...products, ...extra];
    }
  }

  const snapshots = await options.repo.listPriceSnapshots(options.shop.id);
  const snapshotsByVariant = groupSnapshotsByVariant(snapshots);
  // Announcements the merchant recorded. Without them a reduction the app cannot
  // see — a discount code or an automatic discount, both applied at checkout —
  // would leave the product with no payload at all (audit item L13).
  const announcementsByProduct = groupAnnouncementsByProduct(
    await options.repo.listPriceAnnouncements(options.shop.id),
  );

  const entries: MetafieldSetEntry[] = [];
  const toClear: Array<{ ownerId: string; namespace: string; key: string }> = [];
  let skipped = 0;

  for (const product of products) {
    const stored = product.priorPriceMetafield ?? null;
    const productAnnouncements = announcementsByProduct.get(product.productId) ?? [];
    // A product with a recorded announcement is published even though no variant
    // carries a compare-at price: the reduction is real, it is simply one the app
    // cannot read from the catalogue.
    const announcedIds = announcedVariantIdsFor(product, productAnnouncements);
    const need = publishNeedForProduct(product, stored, announcedIds);
    if (!need.publish) {
      skipped += 1;
      continue;
    }
    if (announcedIds.size === 0 && product.variants.every((variant) => !isReducedPrice(variant))) {
      // The sale ended (or the product was never discounted but still carries a
      // payload from an earlier release): remove the metafield so the block has
      // nothing to show.
      if (stored) {
        toClear.push({ ownerId: product.productId, namespace: LEGAL_NAMESPACE, key: PRIOR_PRICE_KEY });
      } else {
        skipped += 1;
      }
      continue;
    }
    const payload = priorPricePayloadFor(
      product,
      snapshotsByVariant,
      options.shop.installedAt,
      now,
      windowDays,
      productAnnouncements,
    );
    entries.push({
      ownerId: product.productId,
      namespace: LEGAL_NAMESPACE,
      key: PRIOR_PRICE_KEY,
      type: "json",
      value: JSON.stringify(payload),
    });
  }

  let published = 0;
  let cleared = 0;
  let failed = 0;

  if (entries.length > 0) {
    const result = await options.writer.setMetafields(entries);
    published = result.written;
    failed += result.errors.length;
  }

  if (toClear.length > 0) {
    if (options.writer.deleteProductMetafields) {
      const result = await options.writer.deleteProductMetafields(toClear);
      cleared = result.written;
      failed += result.errors.length;
    } else {
      // Fallback for a writer without a delete path: write the empty payload, so
      // the block sees `variants.size == 0` and hides. Never leave the old value.
      const fallback = toClear.map((entry) => ({
        ...entry,
        type: "json" as const,
        value: JSON.stringify(buildClearedPriorPrice(options.shop.installedAt, windowDays, now)),
      }));
      const result = await options.writer.setMetafields(fallback);
      cleared = result.written;
      failed += result.errors.length;
    }
  }

  return {
    published,
    cleared,
    failed,
    considered: products.length,
    skipped,
  };
}
