-- Durable background job queue.
--
-- Until now queued work lived only in process memory: a restart, a deploy or a
-- crash silently dropped scans and webhook follow-up. Every job is now written
-- here before it runs, claimed with a lease, and retried with persisted state.

-- CreateTable
CREATE TABLE "QueuedJob" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "shopDomain" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "QueuedJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QueuedJob_dedupeKey_key" ON "QueuedJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "QueuedJob_status_runAt_idx" ON "QueuedJob"("status", "runAt");

-- CreateIndex
CREATE INDEX "QueuedJob_shopDomain_status_idx" ON "QueuedJob"("shopDomain", "status");
