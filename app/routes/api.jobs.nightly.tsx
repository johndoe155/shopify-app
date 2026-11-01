/**
 * Scheduled job endpoint. Call it from the host's scheduler, for example:
 *
 *   0 2 * * * curl -fsS -X POST https://your-app.example/api/jobs/nightly \
 *     -H "x-jobs-secret: $JOBS_SECRET"
 *
 * Pass `?shop=example.myshopify.com` to run one shop only. The work itself is
 * idempotent per shop per day, so a double trigger is harmless.
 */
import type { ActionFunctionArgs } from "react-router";
import { isDemoMode } from "~/context.server";

function authorised(request: Request): boolean {
  const secret = process.env.JOBS_SECRET;
  if (!secret) return false;
  const header = request.headers.get("x-jobs-secret");
  const bearer = request.headers.get("authorization");
  if (header && header === secret) return true;
  return Boolean(bearer && bearer === `Bearer ${secret}`);
}

export async function action({ request }: ActionFunctionArgs) {
  if (!authorised(request)) return new Response("Forbidden", { status: 403 });
  if (isDemoMode()) {
    return Response.json({ ok: true, demo: true, note: "Demo mode has no shops to scan." });
  }
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const { runNightlyForAllShops, runNightlyForShop } = await import("~/jobs/handlers.server");
  if (shop) {
    const result = await runNightlyForShop(shop);
    return Response.json({ ok: true, shop, ...result });
  }
  const result = await runNightlyForAllShops();
  return Response.json({ ok: true, ...result });
}

export function loader() {
  return new Response("POST only.", { status: 405 });
}
