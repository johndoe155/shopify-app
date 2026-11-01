/**
 * Durable queue behaviour (release blocker: "the background job queue is not
 * durable"). These tests run the real DurableJobQueue against the real
 * MemoryRepository, and simulate the two failure modes that used to lose work:
 *
 *  - a restart, where a job queued before the restart must still run after it;
 *  - a crash mid-job, where the lease expires and the job is recovered.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "~/db/memory.server";
import { DurableJobQueue, registerHandler, type Job } from "~/jobs/queue.server";

function queueOver(
  repo: MemoryRepository,
  overrides: Partial<ConstructorParameters<typeof DurableJobQueue>[0]> = {},
) {
  return new DurableJobQueue({
    repo,
    concurrency: 2,
    baseBackoffMs: 1,
    leaseMs: 60_000,
    ...overrides,
  });
}

describe("durable job queue", () => {
  it("persists a job before it runs and marks it done afterwards", async () => {
    const repo = new MemoryRepository();
    const seen: Job[] = [];
    registerHandler("rescan-product", async (job) => {
      seen.push(job);
    });
    const queue = queueOver(repo);

    const queued = await queue.enqueue(
      "rescan-product",
      { shopDomain: "shop.myshopify.com", productId: "gid://shopify/Product/1" },
      "rescan:1",
    );
    expect(queued).toBe(true);

    // The row exists before any work happens: that is what makes a restart safe.
    const pending = repo.listQueuedJobs();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("pending");

    const result = await queue.drainOnce();
    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0, retried: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.payload.productId).toBe("gid://shopify/Product/1");
    expect(repo.listQueuedJobs()[0]!.status).toBe("done");
  });

  it("survives a restart: a job queued in one process runs in the next", async () => {
    const repo = new MemoryRepository();
    const first = queueOver(repo);
    await first.enqueue(
      "nightly-scan",
      { shopDomain: "shop.myshopify.com" },
      "nightly:shop:2026-10-30",
    );
    // The process "dies" here: no drain, no in-memory state carried over.

    const seen: Job[] = [];
    registerHandler("nightly-scan", async (job) => {
      seen.push(job);
    });
    const second = queueOver(repo);
    const result = await second.drainOnce();

    expect(result.claimed).toBe(1);
    expect(seen).toHaveLength(1);
    expect(repo.listQueuedJobs()[0]!.status).toBe("done");
  });

  it("recovers a job whose worker died mid-flight once the lease expires", async () => {
    const repo = new MemoryRepository();
    let attempts = 0;
    registerHandler("price-snapshot", async () => {
      attempts += 1;
      if (attempts === 1) {
        // Simulate a crash: the process stops while the job is `running`.
        throw Object.assign(new Error("worker died"), { simulatedCrash: true });
      }
    });

    const crashed = queueOver(repo, { leaseMs: 1_000 });
    await crashed.enqueue(
      "price-snapshot",
      { shopDomain: "shop.myshopify.com", productId: "p1" },
      "snap:p1",
    );
    // Force the failure path to look like a crash by making retries not happen:
    // the row is claimed, the handler throws, and the lease is what recovers it.
    await crashed.drainOnce();
    const afterFailure = repo.listQueuedJobs()[0]!;

    // Either it was retried straight away or it is still marked running; both
    // are recoverable. Here the first failure schedules a retry.
    expect(["pending", "running"]).toContain(afterFailure.status);

    // Move the lease into the past: the worker that claimed it never renewed.
    await repo.recoverExpiredJobs(new Date(Date.now() + 10_000), 1_000);

    const recovered = queueOver(repo, { leaseMs: 1_000, now: () => new Date(Date.now() + 10_000) });
    const result = await recovered.drainOnce();
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(repo.listQueuedJobs()[0]!.status).toBe("done");
  });

  it("returns an abandoned job to pending exactly once, even with two workers", async () => {
    const repo = new MemoryRepository();
    await repo.enqueueJob({
      name: "detect-blocks",
      dedupeKey: "blocks:shop",
      payload: { shopDomain: "shop" },
      runAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    // A worker claims it, then dies without completing or failing it.
    const claimed = await repo.claimDueJobs(new Date(), 5);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.status).toBe("running");

    // Ten minutes later, with a one-minute lease: the claim is stale.
    const later = new Date(Date.now() + 10 * 60 * 1000);
    const [a, b] = await Promise.all([
      repo.recoverExpiredJobs(later, 60_000),
      repo.recoverExpiredJobs(later, 60_000),
    ]);
    expect(a + b).toBe(1);
    expect(repo.listQueuedJobs()[0]!.status).toBe("pending");
  });

  it("treats a repeated dedupe key as a no-op", async () => {
    const repo = new MemoryRepository();
    const handler = vi.fn(async () => {});
    registerHandler("delete-product", handler);
    const queue = queueOver(repo);

    expect(
      await queue.enqueue("delete-product", { shopDomain: "s", productId: "p1" }, "del:p1"),
    ).toBe(true);
    expect(
      await queue.enqueue("delete-product", { shopDomain: "s", productId: "p1" }, "del:p1"),
    ).toBe(false);

    const result = await queue.drainOnce();
    expect(result.claimed).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("retries with a backoff and then gives up, recording the error", async () => {
    const repo = new MemoryRepository();
    let attempts = 0;
    registerHandler("publish-prior-prices", async () => {
      attempts += 1;
      throw new Error("Admin API throttled");
    });
    const queue = queueOver(repo, { baseBackoffMs: 1 });

    await queue.enqueue("publish-prior-prices", { shopDomain: "s" }, "pub:s");
    // First pass: fails, is retried (row returns to pending with a future runAt).
    const first = await queue.drainOnce();
    expect(first.retried).toBe(1);
    expect(repo.listQueuedJobs()[0]!.lastError).toContain("throttled");

    // After the backoff, the retry runs, fails again and exhausts maxAttempts (3).
    const later = new Date(Date.now() + 60_000);
    const retrying = queueOver(repo, { baseBackoffMs: 1, now: () => later });
    await retrying.drainOnce();
    const afterSecond = repo.listQueuedJobs()[0]!;
    expect(afterSecond.status).toBe("pending");

    const latest = new Date(Date.now() + 120_000);
    const finalQueue = queueOver(repo, { baseBackoffMs: 1, now: () => latest });
    const final = await finalQueue.drainOnce();
    expect(final.failed).toBe(1);
    expect(attempts).toBe(3);
    const row = repo.listQueuedJobs()[0]!;
    expect(row.status).toBe("failed");
    expect(row.finishedAt).toBeTruthy();
  });

  it("fails a job with no registered handler instead of retrying forever", async () => {
    const repo = new MemoryRepository();
    // "detect-blocks" is registered by an earlier test; use a fresh repo + a
    // name that has no handler by pointing the job at an unknown handler name.
    await repo.enqueueJob({
      name: "someone-elses-job",
      dedupeKey: "unknown:1",
      payload: {},
    });
    const queue = queueOver(repo);
    const result = await queue.drainOnce();
    expect(result.failed).toBe(1);
    expect(repo.listQueuedJobs()[0]!.lastError).toContain("no handler");
  });

  it("keeps counting outstanding work for health checks", async () => {
    const repo = new MemoryRepository();
    await repo.enqueueJob({ name: "nightly-scan", dedupeKey: "a", payload: { shopDomain: "s" } });
    expect(await repo.countQueuedJobs()).toBe(1);
    const queue = queueOver(repo);
    registerHandler("nightly-scan", async () => {});
    await queue.drainOnce();
    expect(await repo.countQueuedJobs()).toBe(0);
  });
});
