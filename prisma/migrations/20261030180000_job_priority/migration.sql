-- Job priority: lower runs first among jobs that are due at the same moment.
--
-- A products/update webhook queues a price snapshot and a per-product rescan (or,
-- during a bulk edit, one coalesced publish). Without an order, the rescan could
-- be claimed before the snapshot it depends on and score the product against a
-- history that does not include the change yet. The claim query now orders by
-- (runAt, priority, createdAt).

-- AlterTable
ALTER TABLE "QueuedJob" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 100;

-- DropIndex
DROP INDEX IF EXISTS "QueuedJob_status_runAt_idx";

-- CreateIndex
CREATE INDEX "QueuedJob_status_runAt_priority_idx" ON "QueuedJob"("status", "runAt", "priority");
