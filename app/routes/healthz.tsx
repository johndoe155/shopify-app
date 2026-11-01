/**
 * Health endpoint.
 *
 * It reports what this process is actually doing with the durable queue, because
 * "the worker is running" is the one claim a serverless deployment can make
 * silently and wrongly. On a serverless host the answer is
 * `driver: "external-tick"`: the queue is drained by cron calling
 * `POST /api/jobs/tick`, and an operator reading this endpoint can see that no
 * in-process worker was started rather than assume one was.
 */
import { queueRuntimeStatus } from "~/jobs/worker.server";
import { isDemoMode } from "~/context.server";

export function loader() {
  const demo = isDemoMode();
  const queue = demo
    ? { driver: "none" as const, serverless: false, workerRunning: false, pollMs: 0 }
    : queueRuntimeStatus();
  return Response.json(
    {
      ok: true,
      service: "india-legal-metrology-mrp",
      demo,
      queue,
      hint:
        queue.driver === "external-tick"
          ? "Schedule POST /api/jobs/tick every minute and POST /api/jobs/nightly daily."
          : undefined,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
