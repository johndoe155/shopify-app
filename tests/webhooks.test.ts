import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PUBLISH_COALESCE_MS,
  handleWebhook,
  publishWindowKey,
  verifyWebhookHmac,
  webhookDedupeKey,
  type WebhookJobRequest,
} from "~/services/webhooks.server";
import { makeRepo, makeProduct } from "./helpers";
import type { CatalogProduct } from "~/services/ports";

const SECRET = "test-webhook-secret";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

function collector() {
  const jobs: WebhookJobRequest[] = [];
  return {
    jobs,
    deps: (repo: Awaited<ReturnType<typeof makeRepo>>["repo"]) => ({
      repo,
      enqueue: async (job: WebhookJobRequest) => {
        jobs.push(job);
      },
    }),
  };
}

describe("webhook HMAC verification", () => {
  it("accepts a correct signature", () => {
    const body = JSON.stringify({ id: 1 });
    expect(verifyWebhookHmac(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    const body = JSON.stringify({ id: 1 });
    expect(verifyWebhookHmac(body, sign(body, "other-secret"), SECRET)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ id: 1 });
    expect(verifyWebhookHmac(JSON.stringify({ id: 2 }), sign(body), SECRET)).toBe(false);
  });

  it("rejects a missing header, an empty secret and a malformed header", () => {
    expect(verifyWebhookHmac("{}", null, SECRET)).toBe(false);
    expect(verifyWebhookHmac("{}", sign("{}"), "")).toBe(false);
    expect(verifyWebhookHmac("{}", "not-base64-and-wrong-length", SECRET)).toBe(false);
  });
});

describe("webhook dispatch", () => {
  it("app/uninstalled marks the shop inactive", async () => {
    const { repo, shop } = await makeRepo();
    const { deps } = collector();
    const result = await handleWebhook({
      topic: "app/uninstalled",
      shopDomain: shop.shopDomain,
      payload: { id: 1 },
      deps: deps(repo),
    });
    expect(result.status).toBe(200);
    const updated = await repo.getShop(shop.shopDomain);
    expect(updated?.isActive).toBe(false);
    expect(updated?.uninstalledAt).toBeInstanceOf(Date);
  });

  it("products/create and products/update queue a price snapshot, a rescan and one coalesced publish", async () => {
    const { repo, shop } = await makeRepo();
    const { deps, jobs } = collector();
    for (const topic of ["products/create", "products/update"]) {
      jobs.length = 0;
      const result = await handleWebhook({
        topic,
        shopDomain: shop.shopDomain,
        payload: { id: 42, admin_graphql_api_id: "gid://shopify/Product/42" },
        deps: deps(repo),
      });
      expect(result.status).toBe(200);
      expect(jobs.map((job) => job.name)).toEqual([
        "price-snapshot",
        "rescan-product",
        "publish-prior-prices",
      ]);
      expect(jobs[0]!.productId).toBe("gid://shopify/Product/42");
      // The publish is scoped to the product that changed and shares one dedupe
      // key per shop per window, so a bulk edit of 200 products queues one
      // publish, not 200 catalogue-wide ones.
      expect(jobs[2]!.productIds).toEqual(["gid://shopify/Product/42"]);
      expect(jobs[2]!.key).toBe(publishWindowKey(shop.shopDomain, new Date()));
    }
  });

  it("gives every product in the same window the same publish key, and a new window a new one", () => {
    // publishWindowKey is deterministic per minute-bucket, which is what makes
    // the durable queue fold a burst of deliveries into a single job.
    const now = new Date("2026-10-30T12:00:00.000Z");
    const later = new Date(now.getTime() + PUBLISH_COALESCE_MS - 1);
    const next = new Date(now.getTime() + PUBLISH_COALESCE_MS);
    expect(publishWindowKey("a.myshopify.com", now)).toBe(publishWindowKey("a.myshopify.com", later));
    expect(publishWindowKey("a.myshopify.com", now)).not.toBe(publishWindowKey("a.myshopify.com", next));
    expect(publishWindowKey("a.myshopify.com", now)).not.toBe(publishWindowKey("b.myshopify.com", now));
  });

  it("products/delete queues the removal", async () => {
    const { repo, shop } = await makeRepo();
    const { deps, jobs } = collector();
    await handleWebhook({
      topic: "products/delete",
      shopDomain: shop.shopDomain,
      payload: { id: 7 },
      deps: deps(repo),
    });
    expect(jobs[0]).toMatchObject({ name: "delete-product", productId: "gid://shopify/Product/7" });
  });

  it("customers/data_request and customers/redact return 200 and store nothing", async () => {
    const { repo, shop } = await makeRepo();
    const { deps } = collector();
    for (const topic of ["customers/data_request", "customers/redact"]) {
      const result = await handleWebhook({
        topic,
        shopDomain: shop.shopDomain,
        payload: { customer: { id: 99, email: "someone@example.com" } },
        deps: deps(repo),
      });
      expect(result.status).toBe(200);
      expect(result.body.stored_customer_data).toBe(false);
    }
    // Nothing customer-shaped is persisted anywhere in the repository.
    const scanRows = await repo.listScanResults(shop.id);
    const changeLog = await repo.listChangeLog(shop.id);
    expect(scanRows).toEqual([]);
    expect(changeLog).toEqual([]);
  });

  it("shop/redact deletes all data for the shop", async () => {
    const { repo, shop } = await makeRepo();
    const { deps } = collector();
    await repo.replaceScanResults(
      shop.id,
      [
        {
          productId: "gid://shopify/Product/1",
          productHandle: makeProduct().handle,
          productTitle: "A",
          productVendor: null,
          productType: null,
          ruleId: "R1",
          status: "pass",
          message: "ok",
          scannedAt: new Date(),
        },
      ],
      { productCount: 1, startedAt: new Date(), completedAt: new Date(), purgeMissing: [] },
    );
    await repo.appendChangeLog(shop.id, [
      {
        productId: "p1",
        productHandle: "p1",
        field: "mrp",
        oldValue: null,
        newValue: "1",
        changedAt: new Date(),
        source: "bulk_editor",
      },
    ]);
    await repo.saveAuditRecord(shop.id, { answers: [] }, new Date());

    const result = await handleWebhook({
      topic: "shop/redact",
      shopDomain: shop.shopDomain,
      payload: {},
      deps: deps(repo),
    });
    expect(result.status).toBe(200);
    expect(await repo.getShop(shop.shopDomain)).toBeNull();
    expect(await repo.listScanResults(shop.id)).toEqual([]);
    expect(await repo.listChangeLog(shop.id)).toEqual([]);
    expect(await repo.latestAuditRecord(shop.id)).toBeNull();
  });

  it("an unknown topic is acknowledged, not retried forever", async () => {
    const { repo, shop } = await makeRepo();
    const { deps } = collector();
    const result = await handleWebhook({
      topic: "orders/create",
      shopDomain: shop.shopDomain,
      payload: {},
      deps: deps(repo),
    });
    expect(result.status).toBe(200);
    expect(String(result.body.ignored)).toContain("orders/create");
  });
});

describe("webhook idempotency", () => {
  it("claims a delivery once", async () => {
    const { repo } = await makeRepo();
    const key = webhookDedupeKey("products/update", "demo.myshopify.com", { id: 1 }, "evt_1");
    expect(await repo.claimWebhookDelivery(key, "products/update", "demo.myshopify.com")).toBe(true);
    expect(await repo.claimWebhookDelivery(key, "products/update", "demo.myshopify.com")).toBe(false);
  });

  it("derives a stable key from the payload when Shopify sends no event id", async () => {
    const a = webhookDedupeKey("products/update", "s.myshopify.com", { id: 5, title: "A" });
    const b = webhookDedupeKey("products/update", "s.myshopify.com", { id: 5, title: "A" });
    const c = webhookDedupeKey("products/update", "s.myshopify.com", { id: 6, title: "A" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("keys differ across shops and topics", () => {
    const base = webhookDedupeKey("products/update", "a.myshopify.com", { id: 1 });
    expect(webhookDedupeKey("products/update", "b.myshopify.com", { id: 1 })).not.toBe(base);
    expect(webhookDedupeKey("products/create", "a.myshopify.com", { id: 1 })).not.toBe(base);
  });
});

describe("webhook payloads without a product id", () => {
  it("is acknowledged and ignored rather than throwing", async () => {
    const { repo, shop } = await makeRepo();
    const { deps, jobs } = collector();
    const result = await handleWebhook({
      topic: "products/update",
      shopDomain: shop.shopDomain,
      payload: {},
      deps: deps(repo),
    });
    expect(result.status).toBe(200);
    expect(jobs).toHaveLength(0);
  });
});

export type { CatalogProduct };
