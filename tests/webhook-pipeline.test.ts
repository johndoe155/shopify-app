/**
 * A `products/update` delivery, end to end through the queue.
 *
 * This is the shape of the spike-2 failure: a bulk price edit in Shopify's own
 * bulk editor delivers one `products/update` per product. The pipeline must turn
 * 200 of those into per-product work plus ONE prior-price publish, with the price
 * snapshot recorded before anything reads it.
 */
import { describe, expect, it } from "vitest";
import { MemoryRepository } from "~/db/memory.server";
import { DurableJobQueue, registerHandler, type Job } from "~/jobs/queue.server";
import { handleWebhook, publishWindowKey, type WebhookJobRequest } from "~/services/webhooks.server";
import { makeShop } from "./helpers";

async function deliveryQueue(repo: MemoryRepository) {
  const seen: Job[] = [];
  for (const name of ["price-snapshot", "rescan-product", "publish-prior-prices"] as const) {
    registerHandler(name, async (job) => {
      seen.push(job);
    });
  }
  const queue = new DurableJobQueue({ repo, concurrency: 50, baseBackoffMs: 1 });
  /**
   * `runAt` optionally pins the due time on every job this delivery writes.
   *
   * Claim order is due time first and priority second, and `enqueueJob` stamps
   * `runAt = new Date()` as each row is inserted, so the three jobs one webhook
   * writes are normally a millisecond apart and are claimed in insertion order,
   * not in priority order. Pinning `runAt` to one instant is what makes priority
   * ordering observable, and it is exactly the arrival pattern of a bulk edit: a
   * burst of deliveries whose jobs all become due at the same moment. Without the
   * pin the assertion would be measuring the machine's insert speed.
   */
  const deliver = async (productId: number, now: Date, runAt?: Date) => {
    await handleWebhook({
      topic: "products/update",
      shopDomain: shop.shopDomain,
      payload: { admin_graphql_api_id: `gid://shopify/Product/${productId}` },
      deps: {
        repo,
        now,
        enqueue: async (job: WebhookJobRequest) => {
          const payload = job.productIds
            ? { shopDomain: job.shopDomain, productIds: job.productIds }
            : { shopDomain: job.shopDomain, productId: job.productId ?? null };
          const queued = await queue.enqueue(job.name, payload, job.key, { runAt });
          if (!queued) await queue.mergeProductIds(job.key ?? "", payload);
        },
      },
    });
  };
  return { queue, seen, deliver };
}

let shop: ReturnType<typeof makeShop>;

describe("products/update through the durable queue", () => {
  it("turns a 200-product bulk edit into per-product work and one publish", async () => {
    const repo = new MemoryRepository();
    shop = await repo.createShop("demo.myshopify.com", makeShop());
    const { queue, seen, deliver } = await deliveryQueue(repo);
    const now = new Date("2026-12-01T00:00:00.000Z");

    for (let index = 0; index < 200; index += 1) await deliver(index + 1, now);

    const rows = repo.listQueuedJobs();
    const byName = (name: string) => rows.filter((row) => row.name === name);
    // One snapshot and one rescan per product...
    expect(byName("price-snapshot")).toHaveLength(200);
    expect(byName("rescan-product")).toHaveLength(200);
    // ...and a single publish carrying all 200 products, not 200 publishes and
    // certainly not 200 full-catalogue reads.
    const publishes = byName("publish-prior-prices");
    expect(publishes).toHaveLength(1);
    expect((publishes[0]!.payload.productIds as string[]).length).toBe(200);
    expect(publishes[0]!.dedupeKey).toBe(publishWindowKey("demo.myshopify.com", now));

    // Draining runs every snapshot before any rescan, and only then the one
    // publish: the publish must read a history that already includes the change.
    for (let pass = 0; pass < 300; pass += 1) {
      const result = await queue.drainOnce();
      if (result.claimed === 0) break;
    }
    const names = seen.map((job) => job.name);
    expect(names).toHaveLength(401);
    expect(names.filter((name) => name === "publish-prior-prices")).toHaveLength(1);
    // Every product got its snapshot and its rescan.
    expect(names.filter((name) => name === "price-snapshot")).toHaveLength(200);
    expect(names.filter((name) => name === "rescan-product")).toHaveLength(200);

    // Claim ordering is the invariant that matters: when a burst of webhook jobs
    // becomes due together, the queue hands out the publish last (it reads what the
    // snapshots and the rescans wrote), and jobs of equal priority come out in
    // insertion order rather than at random. Handlers run concurrently, so
    // completion order is deliberately not asserted.
    //
    // `runAt` is pinned for this half because that is the condition under test. On
    // a real delivery the three jobs are enqueued a moment apart and are already
    // claimed in insertion order; the pin reproduces the case where they all land
    // in the same instant. Asserting it without the pin makes the test depend on
    // whether 20 webhooks' inserts happened to share a millisecond — which is how
    // this passed on one machine and failed on another.
    const secondRepo = new MemoryRepository();
    shop = await secondRepo.createShop("demo.myshopify.com", makeShop());
    const second = await deliveryQueue(secondRepo);
    const dueAt = new Date(now.getTime() - 1_000);
    for (let index = 0; index < 20; index += 1) await second.deliver(index + 1, now, dueAt);
    const claimed = await secondRepo.claimDueJobs(now, 500);
    const claimedNames = claimed.map((job) => job.name);
    // The publish is the single last job claimed.
    expect(claimedNames.at(-1)).toBe("publish-prior-prices");
    expect(claimedNames.indexOf("publish-prior-prices")).toBe(claimedNames.lastIndexOf("publish-prior-prices"));
    // Same due time means the priority field alone decides: every snapshot is
    // claimed before the first rescan, because 50 is below 60.
    expect(claimedNames.indexOf("rescan-product")).toBeGreaterThan(claimedNames.lastIndexOf("price-snapshot"));
    // And each of them appears once per product, whatever the order.
    expect(claimedNames.filter((name) => name === "price-snapshot")).toHaveLength(20);
    expect(claimedNames.filter((name) => name === "rescan-product")).toHaveLength(20);
  });

  it("keeps a re-delivered update idempotent", async () => {
    const repo = new MemoryRepository();
    shop = await repo.createShop("demo.myshopify.com", makeShop());
    const { queue } = await deliveryQueue(repo);
    const now = new Date("2026-12-01T00:00:00.000Z");
    const { deliver } = await deliveryQueue(repo);
    await deliver(7, now);
    await deliver(7, now);
    expect(repo.listQueuedJobs().filter((row) => row.name === "price-snapshot")).toHaveLength(1);
    expect(repo.listQueuedJobs()).toHaveLength(3);
    await queue.drainOnce();
  });
});
