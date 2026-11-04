/**
 * Durable job worker.
 *
 * The queue used to be in-process only, so a restart or a deploy dropped every
 * queued scan and webhook follow-up. Now:
 *
 *   enqueueJob()  -> writes a `QueuedJob` row first, then kicks the worker
 *   drainOnce()   -> recovers expired leases, claims due jobs, runs them,
 *                    persists success, failure and retry state
 *   startJobWorker() -> polls drainOnce() on an interval (in-process worker)
 *   POST /api/jobs/tick -> the same drain for serverless hosts on a cron
 *
 * Which driver to use is a deployment decision, and the app has to be honest
 * about it. The in-process worker needs a process that stays alive between
 * requests. A serverless function (Vercel, Netlify, Lambda, Cloudflare Workers)
 * has none: a `setInterval` registered during a request is frozen or discarded as
 * soon as the response is sent, so the "worker started" it reports is not a
 * worker at all. On those hosts the durable queue is drained by the scheduler
 * calling `POST /api/jobs/tick` (and `POST /api/jobs/nightly`), and the app says
 * so in `/healthz` and the startup log instead of pretending otherwise.
 *
 * Demo mode has no database, so it keeps using the in-process queue.
 */
import type { Repository } from "~/db/repository";
import {
  DurableJobQueue,
  InProcessJobQueue,
  defaultJobKey,
  handlerFor,
  registeredHandlers,
  type DrainResult,
  type DurableQueueOptions,
  type Job,
  type JobName,
} from "./queue.server";

/** A claimed job whose lease has not been renewed for this long is recovered. */
export const JOB_LEASE_MS = Number(process.env.JOBS_LEASE_MS ?? 5 * 60 * 1000);
/** How often the in-process worker looks for due jobs. */
export const JOB_POLL_MS = Number(process.env.JOBS_POLL_MS ?? 15_000);
export const JOB_CONCURRENCY = Number(process.env.JOBS_CONCURRENCY ?? 2);

let durable: DurableJobQueue | null = null;
let memory: InProcessJobQueue | null = null;
let workerTimer: ReturnType<typeof setInterval> | null = null;
let handlersRegistered = false;

/** How this process is driving the queue. Reported by `/healthz`. */
export type QueueDriver = "in-process-worker" | "external-tick" | "disabled" | "none";

/**
 * Detects a runtime where a long-lived in-process timer cannot work.
 *
 * - `process.env.VERCEL`, `AWS_LAMBDA_FUNCTION_NAME`, `NETLIFY`,
 *   `CF_PAGES`, `DENO_DEPLOYMENT_ID`: serverless platforms.
 * - `K_SERVICE` (Cloud Run) and `DYNO` (Heroku) are *not* in this list: both keep
 *   a process warm and can run an interval.
 */
export function isServerlessRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.VERCEL ||
      env.AWS_LAMBDA_FUNCTION_NAME ||
      env.NETLIFY ||
      env.CF_PAGES ||
      env.DENO_DEPLOYMENT_ID ||
      env.FUNCTIONS_WORKER_RUNTIME,
  );
}

/**
 * What will actually drain the queue in this process. `JOBS_WORKER` decides:
 * `off` disables it outright, `tick` declares that cron drives it, and the
 * default (`on`) starts the interval unless the runtime is serverless.
 */
export function resolveQueueDriver(env: NodeJS.ProcessEnv = process.env): QueueDriver {
  if (env.DEMO_MODE === "1" || !env.DATABASE_URL) return "none";
  const setting = (env.JOBS_WORKER ?? "").trim().toLowerCase();
  if (setting === "off" || setting === "0" || setting === "false") return "disabled";
  if (setting === "tick" || setting === "cron") return "external-tick";
  if (isServerlessRuntime(env)) return "external-tick";
  return "in-process-worker";
}

/** The slice of the repository port the durable queue needs. */
export type QueueRepository = DurableQueueOptions["repo"];

function buildDurableQueue(repo: QueueRepository): DurableJobQueue {
  return new DurableJobQueue({
    repo,
    concurrency: JOB_CONCURRENCY,
    leaseMs: JOB_LEASE_MS,
    onError: (job, error) => {
      console.error(
        `[jobs] ${job.name} (${job.dedupeKey}) failed on attempt ${job.attempts}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    },
  });
}

/** Registers the real handlers once, whichever entry point gets there first. */
export async function ensureHandlers(): Promise<void> {
  if (handlersRegistered) return;
  handlersRegistered = true;
  const { registerJobHandlers } = await import("./handlers.server");
  registerJobHandlers();
}

/**
 * The durable queue for this process, or null when there is no database
 * (demo mode). Imported lazily so nothing pulls Prisma into a preview build.
 */
export async function getDurableQueue(): Promise<DurableJobQueue | null> {
  // Read the flag directly rather than through the request context: this module
  // is imported by the Shopify app setup, which the context module also imports.
  if (process.env.DEMO_MODE === "1" || !process.env.DATABASE_URL) return null;
  if (durable) return durable;
  const { PrismaRepository, prisma } = await import("~/db/prisma.server");
  durable = buildDurableQueue(new PrismaRepository(prisma));
  return durable;
}

function getMemoryQueue(): InProcessJobQueue {
  if (!memory) {
    memory = new InProcessJobQueue({
      concurrency: JOB_CONCURRENCY,
      onError: (job, error, attempt) => {
        console.error(
          `[jobs] ${job.name} attempt ${attempt} failed: ${error instanceof Error ? error.message : error}`,
        );
      },
    });
    // Handlers are registered synchronously from the in-memory path because
    // demo mode has no async import cost to worry about.
    for (const name of registeredHandlers()) {
      const handler = handlerFor(name);
      if (handler) memory.register(name, handler);
    }
  }
  return memory;
}

/**
 * The single enqueue entry point used by routes and hooks.
 *
 * With a database, the job is persisted before anything runs, so a crash
 * between the request and the work is recoverable. Without one (demo/tests) it
 * falls back to the in-process queue and returns once the job is scheduled.
 */
export async function enqueueJob(
  name: JobName,
  payload: Record<string, unknown>,
  key?: string,
  options: { runAt?: Date; maxAttempts?: number; priority?: number } = {},
): Promise<{ queued: boolean; durable: boolean; merged?: boolean }> {
  await ensureHandlers();
  const queue = await getDurableQueue();
  if (!queue) {
    const handler = handlerFor(name);
    if (handler) getMemoryQueue().register(name, handler);
    getMemoryQueue().enqueue(name, payload, key ?? defaultJobKey(name, payload));
    return { queued: true, durable: false };
  }
  const queued = await queue.enqueue(name, payload, key, options);
  // A coalesced publish that collided with an existing one has its product ids
  // folded into the queued job instead of being dropped: the publish it joined
  // may already have been claimed, so "already queued" is not "already covered".
  if (!queued) {
    const dedupeKey = key ?? defaultJobKey(name, payload);
    const merged = await (queue as DurableJobQueue).mergeProductIds(dedupeKey, payload);
    if (merged) {
      startJobWorker();
      return { queued: false, durable: true, merged };
    }
    // Nothing was merged because the job that owns this key has already been
    // claimed or has finished (only a pending job can take more ids). Product ids
    // that arrive after that point are not covered by it, and dropping them left
    // those products' prior price unpublished until the nightly run. Queue them
    // under their own key instead.
    const ids = Array.isArray(payload.productIds) ? payload.productIds : [];
    if (ids.length > 0) {
      const followUp = await queue.enqueue(name, payload, `${dedupeKey}:late:${Date.now()}`, options);
      if (followUp) startJobWorker();
      return { queued: followUp, durable: true, merged: false };
    }
    return { queued: false, durable: true, merged };
  }
  startJobWorker();
  return { queued, durable: true };
}

/**
 * One pass of the worker: recover, claim, run. Exported so the cron endpoint
 * and the tests can drive it deterministically instead of waiting on a timer.
 */
export async function drainJobs(repo?: QueueRepository): Promise<DrainResult | null> {
  await ensureHandlers();
  const queue = repo ? buildDurableQueue(repo) : await getDurableQueue();
  if (!queue) return null;
  return queue.drainOnce();
}

/**
 * Starts the in-process worker loop. Idempotent, and the timer is unref'd so it
 * never keeps a process (or a test run) alive.
 *
 * On a serverless runtime this deliberately does nothing and says so once: an
 * interval registered inside a function invocation does not survive the response,
 * so starting one would only produce a misleading "worker running" state while
 * the queue silently backed up. Those hosts drain through `POST /api/jobs/tick`.
 */
export function startJobWorker(options: { intervalMs?: number } = {}): void {
  if (workerTimer) return;
  const driver = resolveQueueDriver();
  if (driver !== "in-process-worker") {
    warnQueueDriverOnce(driver);
    return;
  }
  const interval = Math.max(1000, options.intervalMs ?? JOB_POLL_MS);
  workerTimer = setInterval(() => {
    void drainJobs().catch((error: unknown) => {
      console.error(`[jobs] worker pass failed: ${error instanceof Error ? error.message : error}`);
    });
  }, interval);
  // Do not keep the event loop alive just for polling.
  (workerTimer as unknown as { unref?: () => void }).unref?.();
}

let warnedDriver: QueueDriver | null = null;

function warnQueueDriverOnce(driver: QueueDriver): void {
  if (warnedDriver === driver) return;
  warnedDriver = driver;
  if (driver === "external-tick") {
    console.warn(
      "[jobs] no in-process worker in this runtime: the queue is drained by the scheduler calling " +
        "POST /api/jobs/tick (and POST /api/jobs/nightly). A serverless function cannot keep a timer " +
        "alive between requests, so starting one would report a worker that is not running.",
    );
  } else if (driver === "disabled") {
    console.warn("[jobs] JOBS_WORKER=off: nothing in this process drains the queue. Run `npm run jobs:worker` or schedule POST /api/jobs/tick.");
  }
}

/** What this process is doing with the queue, for `/healthz` and diagnostics. */
export function queueRuntimeStatus(): {
  driver: QueueDriver;
  serverless: boolean;
  workerRunning: boolean;
  pollMs: number;
} {
  return {
    driver: resolveQueueDriver(),
    serverless: isServerlessRuntime(),
    workerRunning: workerTimer !== null,
    pollMs: JOB_POLL_MS,
  };
}

/** Test seam: forget the "already warned" latch. */
export function resetQueueDriverWarningForTests(): void {
  warnedDriver = null;
}

export function stopJobWorker(): void {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
}

/** Test seam: forget the cached queue so a fresh process state can be simulated. */
export function resetJobRuntimeForTests(): void {
  stopJobWorker();
  durable = null;
  memory = null;
}

export type { DrainResult, Job, Repository };
