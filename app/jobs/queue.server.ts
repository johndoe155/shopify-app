/**
 * Job queue.
 *
 * Two implementations share one handler registry:
 *
 *  - `DurableJobQueue` (production): every job is persisted to the `QueuedJob`
 *    table before it runs, claimed with a lease and retried with persisted
 *    state, so a restart, a deploy or a crash resumes the work instead of
 *    losing it. This is the queue `enqueueJob()` uses whenever a database is
 *    configured.
 *  - `InProcessJobQueue` (tests and DEMO_MODE): the same contract without a
 *    database. It is an execution detail, not the source of truth.
 *
 * The original in-process design is kept as the fallback for the preview app,
 * which deliberately runs with no database.
 *
 * It runs work off the request path, bounds concurrency so Admin API rate limits
 * are respected, and retries with exponential backoff. Every handler receives an
 * idempotency key and is expected to be safe to run twice — the nightly scan
 * claims a JobRun row keyed by shop + date, so a duplicate trigger is a no-op.
 *
 * Long-lived deployments should also hit POST /api/jobs/nightly from the host's
 * scheduler (cron). The pending queue and retry state are in memory and are
 * lost on restart; JobRun only records claimed nightly runs. A durable queue is
 * required for reliable production processing.
 */

import type { Repository } from "~/db/repository";
import type { QueuedJobRecord } from "~/db/types";

export type JobName =
  | "nightly-scan"
  | "rescan-product"
  | "price-snapshot"
  | "delete-product"
  | "detect-blocks"
  | "publish-prior-prices";

export interface Job<T = Record<string, unknown>> {
  name: JobName;
  key: string;
  payload: T;
  /**
   * Lower runs first. The durable queue claims by `runAt`, then by this value, so
   * the price snapshot a webhook queued always lands before the rescan that
   * publishes the prior price and before a coalesced catalogue-wide publish.
   */
  priority?: number;
}

export type JobHandler = (job: Job) => Promise<void>;

export interface QueueOptions {
  concurrency?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  onError?: (job: Job, error: unknown, attempt: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

export class InProcessJobQueue {
  private readonly handlers = new Map<JobName, JobHandler>();
  private readonly pending: Job[] = [];
  private readonly seen = new Set<string>();
  private running = 0;
  private idleResolvers: Array<() => void> = [];

  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly onError: QueueOptions["onError"];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: QueueOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.onError = options.onError;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  register(name: JobName, handler: JobHandler): void {
    this.handlers.set(name, handler);
  }

  /** Enqueues a job. Keys are unique for the lifetime of the process, so a
   * redelivered webhook cannot double-queue the same product twice. */
  enqueue(name: JobName, payload: Record<string, unknown>, key?: string): void {
    const jobKey = key ?? `${name}:${JSON.stringify(payload)}`;
    if (this.seen.has(jobKey)) return;
    this.seen.add(jobKey);
    this.pending.push({ name, key: jobKey, payload });
    queueMicrotask(() => void this.pump());
  }

  private async pump(): Promise<void> {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      if (!job) break;
      this.running += 1;
      void this.execute(job).finally(() => {
        this.running -= 1;
        if (this.running === 0 && this.pending.length === 0) this.resolveIdle();
        else void this.pump();
      });
    }
  }

  private async execute(job: Job): Promise<void> {
    const handler = this.handlers.get(job.name);
    if (!handler) return;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        await handler(job);
        return;
      } catch (error) {
        this.onError?.(job, error, attempt);
        if (attempt === this.maxAttempts) return;
        await this.sleep(this.baseBackoffMs * 2 ** (attempt - 1));
      }
    }
  }

  private resolveIdle(): void {
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  /** Resolves when every queued job has finished (used by tests). */
  onIdle(): Promise<void> {
    if (this.running === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  get pendingCount(): number {
    return this.pending.length + this.running;
  }
}


// ---------------------------------------------------------------------------
// Durable queue
// ---------------------------------------------------------------------------

/**
 * Handler registry, shared by both queue implementations. Handlers live here
 * rather than on a queue instance so a durable worker, an in-process queue and
 * the tests all dispatch to the same code.
 */
const handlers = new Map<JobName, JobHandler>();

export function registerHandler(name: JobName, handler: JobHandler): void {
  handlers.set(name, handler);
}

export function registeredHandlers(): JobName[] {
  return [...handlers.keys()];
}

export function handlerFor(name: JobName): JobHandler | null {
  return handlers.get(name) ?? null;
}

/**
 * Queue ordering. 0 runs first; anything unset is 100.
 *
 *   price-snapshot   50  cheap, per product, must be recorded before it is read
 *   rescan-product   60  per product, reads the snapshot
 *   publish-prior-prices 70  store-wide coalesced publish
 *   nightly-scan     80  last: the widest, most expensive job
 */
export const JOB_PRIORITY: Record<JobName, number> = {
  "price-snapshot": 50,
  "rescan-product": 60,
  "delete-product": 65,
  "publish-prior-prices": 70,
  "detect-blocks": 75,
  "nightly-scan": 80,
};

export function priorityFor(name: JobName): number {
  return JOB_PRIORITY[name] ?? 100;
}

export interface DurableQueueOptions {
  /** Persistence port (Postgres in production, memory in tests). */
  repo: Pick<
    Repository,
    | "enqueueJob"
    | "claimDueJobs"
    | "completeJob"
    | "failJob"
    | "recoverExpiredJobs"
    | "countQueuedJobs"
    | "mergeJobProductIds"
  >;
  concurrency?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  /** How long a claimed job may run before its lease is considered expired. */
  leaseMs?: number;
  now?: () => Date;
  onError?: (job: QueuedJobRecord, error: unknown) => void;
}

export interface DrainResult {
  recovered: number;
  claimed: number;
  completed: number;
  failed: number;
  retried: number;
}

/**
 * A queue that cannot lose work.
 *
 * Every job is written to `QueuedJob` before anything runs, claimed with a
 * lease, and given a persisted attempt count. If the process dies mid-job the
 * lease expires and the job is returned to `pending`, so a restart resumes work
 * instead of dropping it. `drainOnce` is the only thing the worker loop (or a
 * cron tick) calls, which keeps the recovery semantics in one place.
 */
export class DurableJobQueue {
  private readonly repo: DurableQueueOptions["repo"];
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly leaseMs: number;
  private readonly now: () => Date;
  private readonly onError: DurableQueueOptions["onError"];
  private draining: Promise<DrainResult> | null = null;

  constructor(options: DurableQueueOptions) {
    this.repo = options.repo;
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.leaseMs = Math.max(1000, options.leaseMs ?? 60_000);
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError;
  }

  /**
   * Persists a job. Returns false when the dedupe key already exists, which is
   * how a redelivered webhook or a double-clicked rescan becomes a no-op.
   */
  async enqueue(
    name: JobName,
    payload: Record<string, unknown>,
    key?: string,
    options: { shopDomain?: string | null; runAt?: Date; maxAttempts?: number; priority?: number } = {},
  ): Promise<boolean> {
    return this.repo.enqueueJob({
      name,
      dedupeKey: key ?? defaultJobKey(name, payload),
      payload,
      shopDomain: options.shopDomain ?? (typeof payload.shopDomain === "string" ? payload.shopDomain : null),
      runAt: options.runAt,
      maxAttempts: options.maxAttempts ?? this.maxAttempts,
      priority: options.priority ?? priorityFor(name),
    });
  }

  /**
   * Folds extra product ids into an already-queued job instead of enqueuing a
   * second one. Used by the coalesced prior-price publish: every webhook in a
   * window shares one dedupe key, and each delivery adds its product to the
   * pending job's `productIds` so nothing is silently dropped.
   */
  async mergeProductIds(
    key: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const raw = payload.productIds;
    const productIds = Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    if (productIds.length === 0) return false;
    return this.repo.mergeJobProductIds(key, productIds);
  }

  /**
   * Claims and runs whatever is due. Safe to call concurrently: the repository
   * claim is optimistic, so a second caller gets nothing to do.
   */
  async drainOnce(): Promise<DrainResult> {
    if (this.draining) return this.draining;
    this.draining = this.doDrain().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async doDrain(): Promise<DrainResult> {
    const now = this.now();
    const recovered = await this.repo.recoverExpiredJobs(now, this.leaseMs);
    if (recovered > 0) console.warn(`[jobs] recovered ${recovered} job(s) whose lease had expired`);
    const jobs = await this.repo.claimDueJobs(now, this.concurrency);
    const result: DrainResult = { recovered, claimed: jobs.length, completed: 0, failed: 0, retried: 0 };
    if (jobs.length === 0) return result;
    await Promise.all(
      jobs.map(async (job) => {
        const handler = handlers.get(job.name as JobName);
        if (!handler) {
          await this.repo.failJob(job.id, `no handler registered for "${job.name}"`, null);
          result.failed += 1;
          return;
        }
        try {
          await handler({
            name: job.name as JobName,
            key: job.dedupeKey,
            payload: job.payload,
            priority: job.priority,
          });
          await this.repo.completeJob(job.id);
          result.completed += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.onError?.(job, error);
          if (job.attempts >= job.maxAttempts) {
            await this.repo.failJob(job.id, message, null);
            result.failed += 1;
            return;
          }
          const backoff = this.baseBackoffMs * 2 ** Math.max(0, job.attempts - 1);
          await this.repo.failJob(job.id, message, new Date(this.now().getTime() + backoff));
          result.retried += 1;
        }
      }),
    );
    return result;
  }
}

/** A stable dedupe key for a job payload (idempotent by content). */
export function defaultJobKey(name: JobName, payload: Record<string, unknown>): string {
  const shop = typeof payload.shopDomain === "string" ? payload.shopDomain : "";
  const product = typeof payload.productId === "string" ? payload.productId : "";
  return product ? `${name}:${shop}:${product}` : `${name}:${shop}`;
}

/** Reads a payload written to `QueuedJob` back into the handler's shape. */
export function toJob(row: QueuedJobRecord): Job {
  return { name: row.name as JobName, key: row.dedupeKey, payload: row.payload, priority: row.priority };
}

