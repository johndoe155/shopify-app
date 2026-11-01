/**
 * Catalogue reads, and the one thing that has to be true for them to be safe.
 *
 * Shopify allows **one bulk operation of a given type per shop at a time**. The
 * app used to start a fresh `bulkOperationRunQuery` from every place that wanted
 * the catalogue: each `products/update` webhook, the nightly job, the bulk
 * editor's loader and action, the dashboard's block check. A bulk price edit of
 * 200 products therefore produced 200 overlapping bulk requests, all but one of
 * which failed with "Another bulk operation is running for this shop", were
 * retried by the queue, and failed again — the unresolved spike 2.
 *
 * This module is the fix. It is the only code that may start a bulk query, and it
 * enforces two rules:
 *
 *  1. **Single flight.** Concurrent callers in the same process share one
 *     in-flight run instead of starting a second operation.
 *  2. **Adopt before start.** Before starting anything it asks Shopify for the
 *     operation already running *for this shop* (which may have been started by
 *     another instance, a deploy, or a previous process). If one is running it
 *     waits for that one and uses its result, so the shop never has two.
 *
 * The result is cached for a short TTL so the follow-up work a webhook triggers
 * (price snapshot, metafield publish, rescans for a bulk edit) reads the same
 * catalogue instead of walking the bulk-operation pipeline again.
 *
 * A targeted read (a handful of known product ids) does not use a bulk operation
 * at all: bulk queries are for "the whole catalogue", and using one to look up
 * one product was the other half of the collision.
 */
import type { CatalogProduct, CatalogVariant } from "./ports";

export interface AdminGraphQL {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

export class BulkOperationError extends Error {}

export interface BulkOperationState {
  id: string;
  status: string;
  url: string | null;
  errorCode: string | null;
  objectCount: string | null;
  createdAt: string | null;
  completedAt: string | null;
}

export const START_BULK_OPERATION = `#graphql
  mutation StartProductBulkOperation($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status createdAt }
      userErrors { field message }
    }
  }
`;

export const CURRENT_BULK_OPERATION = `#graphql
  query CurrentBulkOperation {
    currentBulkOperation(type: QUERY) {
      id
      status
      errorCode
      createdAt
      completedAt
      objectCount
      url
    }
  }
`;

/** Shopify's message for "this shop already has a bulk operation running". */
export function isAlreadyRunningError(message: string): boolean {
  return /already (in progress|running)|another (bulk )?operation|one bulk operation/i.test(message);
}

export interface CoordinatorOptions {
  /** How long a completed catalogue is reused before the next bulk read. */
  cacheTtlMs?: number;
  /** How often to poll a running bulk operation. */
  pollIntervalMs?: number;
  /** Give up on a single run after this long. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Called when a second caller joins an in-flight run (for observability). */
  onCoalesce?: (info: { inFlight: boolean; adopted: boolean }) => void;
}

export interface CatalogueRead {
  products: CatalogProduct[];
  /** "bulk" = a bulk operation run; "cache" = reused within the TTL. */
  via: "bulk" | "cache";
}

export class BulkOperationCoordinator {
  private cached: { products: CatalogProduct[]; loadedAt: number } | null = null;
  private inFlight: Promise<CatalogProduct[]> | null = null;
  private readonly cacheTtlMs: number;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly onCoalesce: CoordinatorOptions["onCoalesce"];

  constructor(
    private readonly admin: AdminGraphQL,
    private readonly parse: (jsonl: string[]) => CatalogProduct[],
    private readonly query: string,
    options: CoordinatorOptions = {},
  ) {
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
    this.pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 1_000);
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 5 * 60 * 1000);
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
    this.onCoalesce = options.onCoalesce;
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await this.admin.graphql(query, variables ? { variables } : undefined);
    const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors && body.errors.length > 0) {
      throw new BulkOperationError(body.errors.map((e) => e.message).join("; "));
    }
    if (!body.data) throw new BulkOperationError("Shopify returned no data for the bulk operation.");
    return body.data;
  }

  private cacheFresh(): boolean {
    if (!this.cached) return false;
    return this.now().getTime() - this.cached.loadedAt < this.cacheTtlMs;
  }

  /** Marks the cached catalogue stale (called after this app writes to products). */
  invalidate(): void {
    this.cached = null;
  }

  private async currentOperation(): Promise<BulkOperationState | null> {
    const data = await this.graphql<{ currentBulkOperation?: BulkOperationState | null }>(
      CURRENT_BULK_OPERATION,
    );
    return data.currentBulkOperation ?? null;
  }

  /**
   * Starts a bulk query, or joins the one already running for this shop.
   * Resolves with the completed operation's URL.
   */
  private async runOrAdopt(options: { force?: boolean } = {}): Promise<string> {
    let operationId: string | null = null;

    const existing = await this.currentOperation();
    if (existing && (existing.status === "RUNNING" || existing.status === "CREATED")) {
      // Another worker, instance or deploy is already fetching this catalogue.
      // Joining it is both cheaper and the only way to stay inside Shopify's
      // one-operation-per-shop limit.
      this.onCoalesce?.({ inFlight: true, adopted: true });
      operationId = existing.id;
    } else if (existing && existing.status === "COMPLETED" && existing.url && !options.force) {
      // A finished operation whose result has not expired: use it rather than
      // starting another. A caller that asked for fresh data (`force`, the
      // nightly job) starts its own, because `currentBulkOperation` reports
      // operations from the last several days and adopting one of those would
      // hand the scan a stale catalogue.
      this.onCoalesce?.({ inFlight: false, adopted: true });
      operationId = existing.id;
    }

    if (!operationId) {
      const data = await this.graphql<{
        bulkOperationRunQuery?: {
          bulkOperation?: { id: string };
          userErrors?: Array<{ message: string }>;
        };
      }>(START_BULK_OPERATION, { query: this.query });
      const userErrors = data.bulkOperationRunQuery?.userErrors ?? [];
      if (userErrors.length > 0) {
        const message = userErrors.map((e) => e.message).join("; ");
        if (isAlreadyRunningError(message)) {
          // Lost a race against another instance between the read and the write.
          // Adopt whatever is running now instead of retrying into the same error.
          const adopted = await this.currentOperation();
          if (adopted && (adopted.status === "RUNNING" || adopted.status === "CREATED" || adopted.status === "COMPLETED")) {
            this.onCoalesce?.({ inFlight: true, adopted: true });
            operationId = adopted.id;
          } else {
            throw new BulkOperationError(message);
          }
        } else {
          throw new BulkOperationError(message);
        }
      } else {
        const id = data.bulkOperationRunQuery?.bulkOperation?.id;
        if (!id) throw new BulkOperationError("Shopify did not return a bulk operation id.");
        operationId = id;
      }
    }

    return this.waitFor(operationId);
  }

  private async waitFor(operationId: string): Promise<string> {
    let id = operationId;
    const startedAt = Date.now();
    let delay = this.pollIntervalMs;
    for (;;) {
      const operation = await this.currentOperation();
      if (!operation) throw new BulkOperationError("The bulk operation disappeared before it finished.");
      if (operation.id === id && operation.status === "COMPLETED") {
        if (!operation.url) throw new BulkOperationError("The bulk operation finished without a result file.");
        return operation.url;
      }
      if (operation.id !== id) {
        // The operation we started (or adopted) is no longer current. A newer one
        // for this shop is just as valid a catalogue read, so follow it rather
        // than failing: another instance started it while we were waiting.
        id = operation.id;
        delay = this.pollIntervalMs;
        if (operation.status === "COMPLETED" && operation.url) return operation.url;
      }
      if (operation.status === "FAILED" || operation.status === "CANCELED" || operation.status === "EXPIRED") {
        throw new BulkOperationError(
          `The bulk operation ended with status ${operation.status}${
            operation.errorCode ? ` (${operation.errorCode})` : ""
          }.`,
        );
      }
      if (Date.now() - startedAt > this.timeoutMs) {
        throw new BulkOperationError("Timed out waiting for the bulk operation to finish.");
      }
      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
  }

  private async download(url: string): Promise<CatalogProduct[]> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new BulkOperationError(`Could not download the bulk operation result (HTTP ${response.status}).`);
    }
    const text = await response.text();
    return this.parse(text.split("\n"));
  }

  /**
   * The catalogue, from the cache, an in-flight run, or a new (or adopted) bulk
   * operation. Never starts a second operation while one is running.
   */
  async load(options: { force?: boolean } = {}): Promise<CatalogueRead> {
    if (!options.force && this.cacheFresh()) {
      return { products: this.cached!.products, via: "cache" };
    }
    if (this.inFlight) {
      this.onCoalesce?.({ inFlight: true, adopted: false });
      return { products: await this.inFlight, via: "bulk" };
    }
    const run = (async () => {
      const url = await this.runOrAdopt({ force: options.force });
      const products = await this.download(url);
      this.cached = { products, loadedAt: this.now().getTime() };
      return products;
    })();
    this.inFlight = run;
    try {
      return { products: await run, via: "bulk" };
    } finally {
      this.inFlight = null;
    }
  }
}

/** Default freshness window for a catalogue read used inside one job/request. */
export const DEFAULT_CACHE_TTL_MS = 60_000;

/** Reads one page of products by id in a single request. */
export const PRODUCTS_BY_IDS_QUERY = `#graphql
  query ProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        handle
        title
        vendor
        productType
        status
        variants(first: 100) {
          edges { node { id title price compareAtPrice } }
        }
        metafields(namespace: "legal_in", first: 30) {
          edges { node { key value updatedAt } }
        }
      }
    }
  }
`;

export interface ProductNode {
  id: string;
  handle: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  status: string;
  variants: { edges: Array<{ node: { id: string; title: string; price: string; compareAtPrice: string | null } }> };
  metafields: { edges: Array<{ node: { key: string; value: string } }> };
}

export function variantFromNode(node: { id: string; title: string; price: string; compareAtPrice: string | null }): CatalogVariant {
  const price = Number(node.price);
  const compareAt = node.compareAtPrice === null ? null : Number(node.compareAtPrice);
  return {
    variantId: node.id,
    title: node.title,
    price: Number.isFinite(price) ? price : 0,
    compareAtPrice: compareAt !== null && Number.isFinite(compareAt) ? compareAt : null,
  };
}

