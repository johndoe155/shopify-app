/**
 * Webhook verification and handlers (brief section 3).
 *
 * HMAC is validated on every request before any parsing. Every delivery is
 * claimed in an idempotency ledger keyed by shop + topic + delivery identity, so
 * a retried delivery is processed once.
 *
 * No customer record is read, stored or logged: the app requests no customer or
 * order scope, and the two customer privacy webhooks return 200 without touching
 * the payload. What a merchant types into the complaint register is stored, so
 * that field asks for no customer details.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Repository } from "~/db/repository";

export const HANDLED_TOPICS = [
  "app/uninstalled",
  "products/create",
  "products/update",
  "products/delete",
  "shop/update",
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;

export type WebhookTopic = (typeof HANDLED_TOPICS)[number];

/** Constant-time HMAC-SHA256 check against the `X-Shopify-Hmac-Sha256` header. */
export function verifyWebhookHmac(
  rawBody: string,
  hmacHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!hmacHeader || !secret) return false;
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const expected = Buffer.from(digest, "utf8");
  const received = Buffer.from(hmacHeader.trim(), "utf8");
  if (expected.length !== received.length) return false;
  try {
    return timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

export function webhookDedupeKey(
  topic: string,
  shopDomain: string,
  payload: unknown,
  deliveryId?: string | null,
): string {
  if (deliveryId) return `${topic}:${shopDomain}:${deliveryId}`;
  const digest = createHmac("sha256", "dedupe").update(JSON.stringify(payload ?? {})).digest("hex").slice(0, 32);
  return `${topic}:${shopDomain}:${digest}`;
}

export interface WebhookJobRequest {
  name: "rescan-product" | "price-snapshot" | "delete-product" | "publish-prior-prices";
  shopDomain: string;
  productId?: string;
  /** For `publish-prior-prices`: the products whose metafield must be refreshed. */
  productIds?: string[];
  /**
   * The dedupe key for this job. A per-product key for the per-product jobs; for
   * the coalesced publish it is one key per shop per window, so a 200-product
   * bulk edit queues one publish rather than 200.
   */
  key?: string;
}

/**
 * How long a coalesced prior-price publish collects product ids before it runs.
 *
 * A bulk edit in Shopify's own bulk editor delivers `products/update` for every
 * affected product within seconds. Bucketing the publish by this window means
 * 200 deliveries become one job carrying 200 product ids, instead of 200 jobs
 * (or, worse, 200 full-catalogue publishes).
 */
export const PUBLISH_COALESCE_MS = 60_000;

/** The dedupe key shared by every publish queued for the same shop and window. */
export function publishWindowKey(shopDomain: string, now: Date = new Date()): string {
  const window = Math.floor(now.getTime() / PUBLISH_COALESCE_MS);
  return `publish-prior-prices:${shopDomain}:${window}`;
}

export interface WebhookDeps {
  repo: Repository;
  enqueue: (job: WebhookJobRequest) => Promise<void>;
  now?: Date;
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

interface ProductPayload {
  id?: number | string;
  admin_graphql_api_id?: string;
  handle?: string;
  title?: string;
}

function productGid(payload: ProductPayload): string | null {
  if (payload.admin_graphql_api_id) return payload.admin_graphql_api_id;
  if (payload.id !== undefined) return `gid://shopify/Product/${payload.id}`;
  return null;
}

/**
 * Routes one verified webhook. Returns the HTTP status the route should send.
 * Shopify retries any non-2xx response, so unexpected topics still get 200 after
 * being ignored.
 */
export async function handleWebhook(options: {
  topic: string;
  shopDomain: string;
  payload: Record<string, unknown>;
  deps: WebhookDeps;
  /** `X-Shopify-Event-Id` of this delivery, when the caller has it. */
  deliveryId?: string | null;
}): Promise<WebhookResult> {
  const { topic, shopDomain, payload, deps, deliveryId } = options;
  const now = deps.now ?? new Date();

  switch (topic) {
    case "app/uninstalled": {
      await deps.repo.markUninstalled(shopDomain);
      return { status: 200, body: { ok: true, action: "shop marked inactive and sessions removed" } };
    }

    case "products/create":
    case "products/update": {
      const shop = await deps.repo.getShop(shopDomain);
      if (!shop) return { status: 200, body: { ok: true, ignored: "no shop record" } };
      const gid = productGid(payload as ProductPayload);
      if (!gid) return { status: 200, body: { ok: true, ignored: "no product id" } };
      // Price history first (cheap, ordered), then the per-product re-scan, then
      // the coalesced publish of this product's prior price. Queue priority
      // (app/jobs/queue.server.ts) keeps that order even when all three become
      // due at the same moment.
      //
      // The two per-product jobs are keyed by the delivery, not by the product.
      // A `QueuedJob` dedupe key is unique for the life of the row, and finished
      // rows are kept, so the old per-product key (`rescan-product:<shop>:<gid>`)
      // let the first update of a product through and silently dropped every later
      // one: edit a product twice and only the first edit was ever re-scanned.
      // A redelivery of the same event still collapses, because it has the same
      // event id (or, without one, the same payload and so the same digest).
      const eventKey = webhookDedupeKey(topic, shopDomain, payload, deliveryId);
      await deps.enqueue({
        name: "price-snapshot",
        shopDomain,
        productId: gid,
        key: `price-snapshot:${eventKey}:${gid}`,
      });
      await deps.enqueue({
        name: "rescan-product",
        shopDomain,
        productId: gid,
        key: `rescan-product:${eventKey}:${gid}`,
      });
      await deps.enqueue({
        name: "publish-prior-prices",
        shopDomain,
        productIds: [gid],
        key: publishWindowKey(shopDomain, now),
      });
      return {
        status: 200,
        body: { ok: true, queued: ["price-snapshot", "rescan-product", "publish-prior-prices"] },
      };
    }

    case "products/delete": {
      const gid = productGid(payload as ProductPayload);
      if (!gid) return { status: 200, body: { ok: true, ignored: "no product id" } };
      await deps.enqueue({ name: "delete-product", shopDomain, productId: gid });
      return { status: 200, body: { ok: true, queued: ["delete-product"] } };
    }

    case "shop/update": {
      const shop = await deps.repo.getShop(shopDomain);
      if (!shop) return { status: 200, body: { ok: true, ignored: "no shop record" } };
      const name = typeof payload.name === "string" ? payload.name : null;
      if (name && !shop.storeName) {
        await deps.repo.updateShop(shop.id, { storeName: name.slice(0, 200) });
      }
      return { status: 200, body: { ok: true } };
    }

    case "customers/data_request":
    case "customers/redact": {
      // The app requests no customer or order scope and reads no customer record,
      // so nothing is read from the payload and nothing is written. The one place a
      // customer detail could reach the database is the complaint register, which is
      // typed by the merchant — that field asks for a reference, dates, a channel and
      // a summary, and the privacy policy asks the merchant to enter no customer
      // names, addresses or order details.
      return {
        status: 200,
        body: {
          ok: true,
          stored_customer_data: false,
          note: "This app requests no customer or order scope and reads no customer record. The complaint register holds only what the merchant types into it; merchants are asked to enter no customer details there.",
        },
      };
    }

    case "shop/redact": {
      await deps.repo.deleteShopData(shopDomain);
      return { status: 200, body: { ok: true, deleted: true, at: now.toISOString() } };
    }

    default:
      return { status: 200, body: { ok: true, ignored: `topic ${topic} is not handled` } };
  }
}
