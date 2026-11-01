/**
 * Standalone durable worker process.
 *
 *   npm run jobs:worker
 *
 * The app also starts an in-process worker on the first admin request, so this
 * is for hosts that would rather run one dedicated worker (and keep web
 * requests purely request-scoped). It polls the `QueuedJob` table, recovers
 * leases left behind by a crashed worker, and retries with backoff.
 *
 * Stop it with SIGTERM/SIGINT; a job that is mid-flight when the process dies is
 * recovered by the next worker once its lease expires (JOBS_LEASE_MS).
 */
import "dotenv/config";
import { drainJobs, ensureHandlers, JOB_POLL_MS } from "../app/jobs/worker.server";

const pollMs = Number(process.env.JOBS_POLL_MS ?? JOB_POLL_MS);
let running = true;

async function loop(): Promise<void> {
  await ensureHandlers();
  while (running) {
    try {
      const result = await drainJobs();
      if (result && (result.claimed > 0 || result.recovered > 0)) {
        console.log(
          `[jobs] claimed ${result.claimed}, completed ${result.completed}, retried ${result.retried}, failed ${result.failed}, recovered ${result.recovered}`,
        );
      }
    } catch (error) {
      console.error(`[jobs] pass failed: ${error instanceof Error ? error.message : error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[jobs] ${signal} received; finishing the current pass and stopping`);
    running = false;
  });
}

void loop();
