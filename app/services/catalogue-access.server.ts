/**
 * Where the admin routes get their catalogue from.
 *
 * The problem this solves: every admin page load, filter, pagination step and
 * save used to call `catalog.fetchProducts()`, and on a real store that is a
 * GraphQL bulk operation — create, wait, download. The bulk editor therefore ran
 * a full bulk operation on *every* page load (25 rows of it), on every filter and
 * every save, which both made the "200 products in under 5 minutes" target
 * unreachable and put the admin UI in direct competition with the nightly job and
 * the webhook path for the shop's one bulk operation.
 *
 * There are now two layers:
 *
 *  1. **Snapshot cache (shared, TTL).** One catalogue snapshot per shop, reused by
 *     every request for `CATALOGUE_TTL_MS`. A merchant paging through 8 pages of
 *     a 200-product catalogue does one bulk read, not eight. Writes through the
 *     app patch the cached snapshot in place, so the merchant sees their own edit
 *     immediately instead of waiting for the TTL.
 *  2. **Request-scoped memo.** Within one request, the loader and the action share
 *     whatever the cache returned; nothing reads twice.
 *
 * A stale snapshot is bounded by the TTL plus the nightly job, and it is only
 * ever a *read* cache: writes always go to Shopify first.
 */
import type { Repository } from "~/db/repository";
import type { CatalogProduct, CatalogSource } from "./ports";

/** How long a catalogue snapshot is reused before the next bulk read. */
export const CATALOGUE_TTL_MS = Number(process.env.CATALOGUE_CACHE_MS ?? 5 * 60 * 1000);

interface Entry {
  products: CatalogProduct[];
  loadedAt: number;
  inflight: Promise<CatalogProduct[]> | null;
}

const cache = new Map<string, Entry>();

function entryFor(key: string): Entry {
  const existing = cache.get(key);
  if (existing) return existing;
  const created: Entry = { products: [], loadedAt: 0, inflight: null };
  cache.set(key, created);
  return created;
}

function isFresh(entry: Entry, now: number, ttlMs: number): boolean {
  return entry.products.length > 0 && now - entry.loadedAt < ttlMs;
}

export interface CatalogueAccessOptions {
  /** The shop the snapshot belongs to (the cache is per shop). */
  shopDomain: string;
  repo: Repository;
  catalog: CatalogSource;
  ttlMs?: number;
  now?: () => Date;
}

/**
 * The catalogue for admin reads: from the cache when it is fresh, otherwise one
 * shared bulk read. Concurrent callers share the same read.
 */
export async function getCatalogue(options: CatalogueAccessOptions): Promise<CatalogProduct[]> {
  const ttlMs = options.ttlMs ?? CATALOGUE_TTL_MS;
  const now = (options.now ?? (() => new Date()))().getTime();
  const key = options.shopDomain;
  const entry = entryFor(key);

  // A read that has already started wins over a slightly stale snapshot: joining
  // it is cheaper and keeps a burst of page loads to one bulk operation.
  if (entry.inflight) return entry.inflight;
  if (isFresh(entry, now, ttlMs)) return entry.products;

  const read = (async () => {
    try {
      const products = await options.catalog.fetchProducts();
      entry.products = products;
      entry.loadedAt = now;
      return products;
    } finally {
      entry.inflight = null;
    }
  })();
  entry.inflight = read;
  return read;
}

/** Replaces the cached snapshot (after a bulk operation the caller already ran). */
export function setCatalogue(shopDomain: string, products: CatalogProduct[], now: Date = new Date()): void {
  const entry = entryFor(shopDomain);
  entry.products = products;
  entry.loadedAt = now.getTime();
}

/**
 * Applies an in-app write to the cached snapshot so the merchant sees it at once.
 * Only the fields the write touched are patched; the rest of the snapshot stands.
 */
export function patchCatalogueProduct(
  shopDomain: string,
  productId: string,
  patch: { legal?: Partial<CatalogProduct["legal"]>; priorPriceMetafield?: string | null },
): void {
  const entry = cache.get(shopDomain);
  if (!entry) return;
  entry.products = entry.products.map((product) => {
    if (product.productId !== productId) return product;
    const next: CatalogProduct = { ...product };
    if (patch.legal) next.legal = { ...product.legal, ...patch.legal };
    if (patch.priorPriceMetafield !== undefined) {
      next.priorPriceMetafield = patch.priorPriceMetafield;
      next.priorPricePublished = patch.priorPriceMetafield !== null;
    }
    return next;
  });
}

/** Drops the snapshot for a shop (or every shop) - used after external changes. */
export function invalidateCatalogue(shopDomain?: string): void {
  if (shopDomain) cache.delete(shopDomain);
  else cache.clear();
}

/** Test seam. */
export function catalogueCacheSize(): number {
  return cache.size;
}
