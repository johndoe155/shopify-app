/**
 * How the queue is driven, and in what order jobs run.
 *
 * Two reported issues are covered here:
 *
 *  1. "The in-process worker only works on a long-running server, not
 *     serverless." A `setInterval` registered inside a serverless invocation is
 *     frozen when the response is sent, so the app used to start a worker that
 *     did not exist. It now detects the runtime, does not start a timer there,
 *     and reports `external-tick` so an operator schedules `POST /api/jobs/tick`.
 *  2. "Every products/update webhook ... republishes everything." The publish a
 *     webhook queues is coalesced into one job per shop per window, and the
 *     product ids are merged into that job so nothing is dropped. Queue priority
 *     then keeps the snapshot ahead of the rescan and the publish.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  isServerlessRuntime,
  queueRuntimeStatus,
  resetQueueDriverWarningForTests,
  resetJobRuntimeForTests,
  resolveQueueDriver,
  startJobWorker,
} from "~/jobs/worker.server";
import { JOB_PRIORITY, priorityFor, registerHandler, DurableJobQueue } from "~/jobs/queue.server";
import { MemoryRepository } from "~/db/memory.server";
import { PUBLISH_COALESCE_MS, publishWindowKey } from "~/services/webhooks.server";

const BASE_ENV = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
};

afterEach(() => {
  resetJobRuntimeForTests();
  resetQueueDriverWarningForTests();
});

describe("queue driver selection", () => {
  it("uses the in-process worker on a long-running server", () => {
    expect(resolveQueueDriver({ ...BASE_ENV })).toBe("in-process-worker");
  });

  it("does not use the in-process worker on a serverless runtime", () => {
    for (const marker of ["VERCEL", "AWS_LAMBDA_FUNCTION_NAME", "NETLIFY", "CF_PAGES"]) {
      expect(isServerlessRuntime({ [marker]: "1" })).toBe(true);
      expect(resolveQueueDriver({ ...BASE_ENV, [marker]: "1" })).toBe("external-tick");
    }
  });

  it("honours an explicit JOBS_WORKER=off or JOBS_WORKER=tick", () => {
    expect(resolveQueueDriver({ ...BASE_ENV, JOBS_WORKER: "off" })).toBe("disabled");
    expect(resolveQueueDriver({ ...BASE_ENV, JOBS_WORKER: "tick" })).toBe("external-tick");
  });

  it("reports no driver when there is no database or in demo mode", () => {
    expect(resolveQueueDriver({})).toBe("none");
    expect(resolveQueueDriver({ ...BASE_ENV, DEMO_MODE: "1" })).toBe("none");
  });

  it("does not start a timer it cannot keep alive on a serverless runtime", () => {
    const previous = { ...process.env };
    try {
      Object.assign(process.env, BASE_ENV, { VERCEL: "1" });
      delete process.env.JOBS_WORKER;
      startJobWorker({ intervalMs: 1_000 });
      const status = queueRuntimeStatus();
      expect(status.serverless).toBe(true);
      expect(status.driver).toBe("external-tick");
      // The important assertion: no worker was started, so nothing claims jobs
      // in a process that will be frozen.
      expect(status.workerRunning).toBe(false);
    } finally {
      process.env = previous;
    }
  });
});

describe("job priority", () => {
  it("runs the price snapshot before the rescan before the publish", () => {
    expect(priorityFor("price-snapshot")).toBeLessThan(priorityFor("rescan-product"));
    expect(priorityFor("rescan-product")).toBeLessThan(priorityFor("publish-prior-prices"));
    expect(priorityFor("publish-prior-prices")).toBeLessThan(priorityFor("nightly-scan"));
  });

  it("claims due jobs in priority order regardless of insertion order", async () => {
    const repo = new MemoryRepository();
    const now = new Date("2026-12-01T00:00:00.000Z");
    // Queued in the order the webhook handler writes them, but inserted last-first
    // to prove the order comes from the queue and not from the array.
    await repo.enqueueJob({ name: "nightly-scan", dedupeKey: "n", payload: {}, priority: JOB_PRIORITY["nightly-scan"], runAt: now });
    await repo.enqueueJob({
      name: "publish-prior-prices",
      dedupeKey: "pub",
      payload: {},
      priority: JOB_PRIORITY["publish-prior-prices"],
      runAt: now,
    });
    await repo.enqueueJob({
      name: "rescan-product",
      dedupeKey: "rescan",
      payload: {},
      priority: JOB_PRIORITY["rescan-product"],
      runAt: now,
    });
    await repo.enqueueJob({
      name: "price-snapshot",
      dedupeKey: "snap",
      payload: {},
      priority: JOB_PRIORITY["price-snapshot"],
      runAt: now,
    });

    const claimed = await repo.claimDueJobs(now, 10);
    expect(claimed.map((job) => job.name)).toEqual([
      "price-snapshot",
      "rescan-product",
      "publish-prior-prices",
      "nightly-scan",
    ]);
  });
});

describe("coalesced prior-price publish", () => {
  it("folds a burst of webhooks into one job that carries every product id", async () => {
    const repo = new MemoryRepository();
    const handled: string[][] = [];
    registerHandler("publish-prior-prices", async (job) => {
      handled.push((job.payload.productIds as string[]) ?? []);
    });
    const queue = new DurableJobQueue({ repo, concurrency: 1, baseBackoffMs: 1 });
    const now = new Date("2026-12-01T00:00:00.000Z");
    const key = publishWindowKey("shop.myshopify.com", now);

    // 200 products edited in the bulk editor: 200 deliveries, one window.
    for (let index = 0; index < 200; index += 1) {
      const payload = { shopDomain: "shop.myshopify.com", productIds: [`gid://shopify/Product/${index}`] };
      const queued = await queue.enqueue("publish-prior-prices", payload, key);
      if (!queued) await queue.mergeProductIds(key, payload);
    }

    expect(repo.listQueuedJobs()).toHaveLength(1);
    await queue.drainOnce();
    expect(handled).toHaveLength(1);
    expect(handled[0]).toHaveLength(200);
  });

  it("still records a product delivered after the shared job was claimed", async () => {
    const repo = new MemoryRepository();
    const handled: string[][] = [];
    registerHandler("publish-prior-prices", async (job) => {
      handled.push((job.payload.productIds as string[]) ?? []);
    });
    const queue = new DurableJobQueue({ repo, concurrency: 1, baseBackoffMs: 1 });
    const key = publishWindowKey("shop.myshopify.com", new Date("2026-12-01T00:00:00.000Z"));

    await queue.enqueue("publish-prior-prices", { shopDomain: "s", productIds: ["p1"] }, key);
    // Claimed before p2 arrives: merging into a running job is refused, so the
    // caller falls back to a fresh job with its own window key.
    await repo.claimDueJobs(new Date(), 1);
    const merged = await queue.mergeProductIds(key, { productIds: ["p2"] });
    expect(merged).toBe(false);
    const queuedAgain = await queue.enqueue("publish-prior-prices", { productIds: ["p2"] }, `${key}:p2`);
    expect(queuedAgain).toBe(true);
  });

  it("uses one window key per minute", () => {
    const now = new Date("2026-12-01T00:00:00.000Z");
    expect(PUBLISH_COALESCE_MS).toBeGreaterThanOrEqual(10_000);
    expect(publishWindowKey("a", now)).toContain(Math.floor(now.getTime() / PUBLISH_COALESCE_MS).toString());
  });
});
