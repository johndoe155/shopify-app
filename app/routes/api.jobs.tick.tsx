/**
 * Queue tick endpoint.
 *
 * Hosts that cannot run a long-lived worker (serverless, or a platform that
 * only gives you cron) drive the durable queue from here:
 *
 *   * * * * * curl -fsS -X POST https://your-app.example/api/jobs/tick \
 *     -H "x-jobs-secret: $JOBS_SECRET"
 *
 * Each call recovers expired leases, then claims and runs whatever is due, and
 * returns counts. It is safe to call as often as you like: claiming is
 * optimistic, so overlapping calls do not run the same job twice.
 *
 * This endpoint is the *only* working driver on a serverless host: a function
 * cannot keep the in-process worker's timer alive between requests (see
 * app/jobs/worker.server.ts). A host that runs `npm run jobs:worker`, or a
 * long-lived server where the app starts the worker on the first admin request,
 * does not need it.
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
    return Response.json({ ok: true, demo: true, note: "Demo mode has no database-backed queue." });
  }
  const { drainJobs } = await import("~/jobs/worker.server");
  const result = await drainJobs();
  if (!result) {
    return Response.json(
      { ok: false, message: "No database is configured, so there is no durable queue to drain." },
      { status: 503 },
    );
  }
  return Response.json({ ok: true, ...result });
}

export function loader() {
  return new Response("POST only.", { status: 405 });
}
