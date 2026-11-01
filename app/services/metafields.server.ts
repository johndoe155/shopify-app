/**
 * Batched metafield writer.
 *
 * `metafieldsSet` accepts up to 25 metafields per call, so writes are chunked in
 * 25s with a small concurrency window and exponential backoff on throttling.
 * The batching logic is exported separately from the Shopify call so it can be
 * integration tested (ChangeLog entries are produced by the caller from the
 * result, which always reports exactly what was written).
 */
import type { MetafieldSetEntry, MetafieldType, MetafieldWriteError, MetafieldWriteResult, MetafieldWriter } from "./ports";

export const METAFIELDS_SET_BATCH_SIZE = 25;

export function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

export interface MetafieldSetCall {
  entries: MetafieldSetEntry[];
  attempt: number;
}

/** Minimal GraphQL surface the writer needs; the Shopify client and test fakes both satisfy it. */
export interface GraphQLExecutor {
  (query: string, variables: Record<string, unknown>): Promise<{
    data?: unknown;
    errors?: Array<{ message: string }>;
  }>;
}

const METAFIELDS_SET = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key namespace }
      userErrors { field message code }
    }
  }
`;

export interface BatchWriteOptions {
  batchSize?: number;
  /** How many batches are in flight at once. */
  concurrency?: number;
  /** Retry attempts per batch after a throttling or network error. */
  maxAttempts?: number;
  /** Base backoff in ms; attempt n waits base * 2^(n-1). */
  baseBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface BatchWriteSummary extends MetafieldWriteResult {
  batches: number;
  retries: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isThrottled(message: string): boolean {
  return /throttl|rate limit|too many requests|429/i.test(message);
}

/**
 * Writes entries in batches with bounded concurrency and retry/backoff.
 * Per-entry user errors are returned rather than thrown so one bad row cannot
 * fail a 2,000-product write.
 */
export async function writeMetafieldsInBatches(
  entries: MetafieldSetEntry[],
  execute: GraphQLExecutor,
  options: BatchWriteOptions = {},
): Promise<BatchWriteSummary> {
  const batchSize = options.batchSize ?? METAFIELDS_SET_BATCH_SIZE;
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const baseBackoffMs = options.baseBackoffMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;

  const batches = chunk(entries, batchSize);
  const errors: MetafieldWriteError[] = [];
  let written = 0;
  let retries = 0;

  const runBatch = async (batch: MetafieldSetEntry[]): Promise<void> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await execute(METAFIELDS_SET, {
          metafields: batch.map((entry) => ({
            ownerId: entry.ownerId,
            namespace: entry.namespace,
            key: entry.key,
            type: entry.type as MetafieldType,
            value: entry.value,
          })),
        });
        const payload = response.data as
          | { metafieldsSet?: { metafields?: unknown[]; userErrors?: Array<{ message: string; field?: string[] }> } }
          | undefined;
        const userErrors = payload?.metafieldsSet?.userErrors ?? [];
        const topLevel = response.errors ?? [];
        const failureMessages = [
          ...topLevel.map((e) => e.message),
          ...userErrors.map((e) => e.message),
        ];
        if (failureMessages.length > 0) {
          const throttled = failureMessages.some(isThrottled);
          if (throttled && attempt < maxAttempts) {
            retries += 1;
            await sleep(baseBackoffMs * 2 ** (attempt - 1));
            continue;
          }
          // Map user errors back to the entries we sent; a failed batch is
          // reported per entry so the merchant sees which rows did not save.
          for (const entry of batch) {
            errors.push({
              ownerId: entry.ownerId,
              key: entry.key,
              message: failureMessages.join("; ").slice(0, 300),
            });
          }
          return;
        }
        written += batch.length;
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < maxAttempts) {
          retries += 1;
          await sleep(baseBackoffMs * 2 ** (attempt - 1));
          continue;
        }
        for (const entry of batch) {
          errors.push({ ownerId: entry.ownerId, key: entry.key, message: message.slice(0, 300) });
        }
        return;
      }
    }
  };

  for (let i = 0; i < batches.length; i += concurrency) {
    const group = batches.slice(i, i + concurrency);
    await Promise.all(group.map((batch) => runBatch(batch)));
  }

  return { written, errors, batches: batches.length, retries };
}

/** Shopify-backed writer. */
export class ShopifyMetafieldWriter implements MetafieldWriter {
  private cachedShopId: string | null = null;

  constructor(
    private readonly admin: {
      graphql: (
        query: string,
        options?: { variables?: Record<string, unknown> },
      ) => Promise<Response>;
    },
    private readonly options: BatchWriteOptions = {},
  ) {}

  private execute: GraphQLExecutor = async (query, variables) => {
    const response = await this.admin.graphql(query, { variables });
    return (await response.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  };

  async setMetafields(entries: MetafieldSetEntry[]): Promise<MetafieldWriteResult> {
    return writeMetafieldsInBatches(entries, this.execute, this.options);
  }

  /** Clears product metafields in the same 25-per-call batches as the writes. */
  async deleteProductMetafields(
    keys: Array<{ ownerId: string; namespace: string; key: string }>,
  ): Promise<MetafieldWriteResult> {
    return deleteMetafieldsInBatches(keys, this.execute, this.options);
  }

  async shopOwnerId(): Promise<string> {
    if (this.cachedShopId) return this.cachedShopId;
    const response = await this.admin.graphql(`#graphql
      query ShopId { shop { id } }
    `);
    const body = (await response.json()) as { data?: { shop?: { id?: string } } };
    const id = body.data?.shop?.id;
    if (!id) throw new Error("Could not read the shop id from Shopify.");
    this.cachedShopId = id;
    return id;
  }
}

const METAFIELDS_DELETE = `#graphql
  mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { ownerId key namespace }
      userErrors { field message }
    }
  }
`;

/**
 * Deletes metafields in batches. Deleting a metafield that is already gone is
 * not an error in Shopify's API, which is what makes "clear the prior price"
 * safe to run repeatedly and from two places at once.
 */
export async function deleteMetafieldsInBatches(
  keys: Array<{ ownerId: string; namespace: string; key: string }>,
  execute: GraphQLExecutor,
  options: BatchWriteOptions = {},
): Promise<BatchWriteSummary> {
  const batchSize = options.batchSize ?? METAFIELDS_SET_BATCH_SIZE;
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseBackoffMs = options.baseBackoffMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;

  const batches = chunk(keys, batchSize);
  const errors: MetafieldWriteError[] = [];
  let written = 0;
  let retries = 0;

  const runBatch = async (batch: Array<{ ownerId: string; namespace: string; key: string }>): Promise<void> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await execute(METAFIELDS_DELETE, {
          metafields: batch.map((entry) => ({
            ownerId: entry.ownerId,
            namespace: entry.namespace,
            key: entry.key,
          })),
        });
        const payload = response.data as
          | { metafieldsDelete?: { deletedMetafields?: unknown[]; userErrors?: Array<{ message: string }> } }
          | undefined;
        const failureMessages = [
          ...(response.errors ?? []).map((e) => e.message),
          ...(payload?.metafieldsDelete?.userErrors ?? []).map((e) => e.message),
        ];
        if (failureMessages.length > 0) {
          if (failureMessages.some(isThrottled) && attempt < maxAttempts) {
            retries += 1;
            await sleep(baseBackoffMs * 2 ** (attempt - 1));
            continue;
          }
          for (const entry of batch) {
            errors.push({ ownerId: entry.ownerId, key: entry.key, message: failureMessages.join("; ").slice(0, 300) });
          }
          return;
        }
        written += batch.length;
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < maxAttempts) {
          retries += 1;
          await sleep(baseBackoffMs * 2 ** (attempt - 1));
          continue;
        }
        for (const entry of batch) {
          errors.push({ ownerId: entry.ownerId, key: entry.key, message: message.slice(0, 300) });
        }
        return;
      }
    }
  };

  for (let i = 0; i < batches.length; i += concurrency) {
    await Promise.all(batches.slice(i, i + concurrency).map((batch) => runBatch(batch)));
  }

  return { written, errors, batches: batches.length, retries };
}
