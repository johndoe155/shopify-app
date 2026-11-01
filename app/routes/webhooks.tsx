/**
 * Single webhook endpoint for all eight topics.
 *
 * Order of operations is deliberate:
 *  1. read the raw body once (HMAC is over the exact bytes),
 *  2. verify `X-Shopify-Hmac-Sha256` in constant time,
 *  3. claim the delivery in the idempotency ledger,
 *  4. dispatch to the handler.
 * A bad signature is rejected with 401 and never parsed.
 */
import type { ActionFunctionArgs } from "react-router";
import { verifyWebhookHmac, webhookDedupeKey, handleWebhook, type WebhookJobRequest } from "~/services/webhooks.server";
import { enqueueJob } from "~/jobs/worker.server";
import { isDemoMode } from "~/context.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await request.text();
  const hmac = request.headers.get("x-shopify-hmac-sha256");
  const topic = request.headers.get("x-shopify-topic") ?? "";
  const shopDomain = request.headers.get("x-shopify-shop-domain") ?? "";
  const deliveryId = request.headers.get("x-shopify-event-id") ?? request.headers.get("x-shopify-webhook-id");
  const secret = process.env.SHOPIFY_API_SECRET ?? "";

  if (!verifyWebhookHmac(rawBody, hmac, secret)) {
    return new Response("Invalid webhook signature", { status: 401 });
  }
  if (!topic || !shopDomain) {
    return new Response("Missing webhook headers", { status: 400 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (isDemoMode()) {
    return Response.json({ ok: true, demo: true, topic });
  }

  const [{ PrismaRepository, prisma }] = await Promise.all([import("~/db/prisma.server")]);
  const repo = new PrismaRepository(prisma);

  const claimed = await repo.claimWebhookDelivery(
    webhookDedupeKey(topic, shopDomain, payload, deliveryId),
    topic,
    shopDomain,
  );
  if (!claimed) {
    // Already processed: acknowledge so Shopify stops retrying.
    return Response.json({ ok: true, duplicate: true });
  }

  const result = await handleWebhook({
    topic,
    shopDomain,
    payload,
    deps: {
      repo,
      enqueue: async (job: WebhookJobRequest) => {
        await enqueueJob(
          job.name,
          job.productIds
            ? { shopDomain: job.shopDomain, productIds: job.productIds }
            : { shopDomain: job.shopDomain, productId: job.productId ?? null },
          job.key,
        );
      },
    },
  });

  return Response.json(result.body, { status: result.status });
}

export function loader() {
  return new Response("This endpoint accepts Shopify webhooks over POST.", { status: 405 });
}
