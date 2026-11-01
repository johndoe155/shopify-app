-- Legal audit corrections (31 Oct 2026).
--
-- 1. Rule 6(2) package-label contact needs an address, and the e-commerce entity
--    needs its own platform customer-care surface (audit item L10 / R8).
-- 2. The 2020 E-Commerce disclosure set is wider than six items (audit item L11 /
--    R9): modes of payment, grievance redressal, other pre-purchase information
--    and best-before/use-before information.
-- 3. Policy links are validated for accessibility, so their last check is stored.
-- 4. R10 needs operational complaint evidence (audit item L12), which is the
--    Complaint table below.

ALTER TABLE "Shop"
  ADD COLUMN IF NOT EXISTS "consumerCareAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "platformCustomerCareUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "paymentModesUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "paymentModesText" TEXT,
  ADD COLUMN IF NOT EXISTS "grievanceRedressalUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "grievanceRedressalText" TEXT,
  ADD COLUMN IF NOT EXISTS "otherInformationUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "otherInformationText" TEXT,
  ADD COLUMN IF NOT EXISTS "useBeforeInfoUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "useBeforeInfoText" TEXT,
  ADD COLUMN IF NOT EXISTS "policyLinkChecksJson" JSONB;

CREATE TABLE IF NOT EXISTS "Complaint" (
  "id"             TEXT NOT NULL,
  "shopId"         TEXT NOT NULL,
  "receivedAt"     TIMESTAMP(3) NOT NULL,
  "acknowledgedAt" TIMESTAMP(3),
  "resolvedAt"     TIMESTAMP(3),
  "channel"        TEXT NOT NULL DEFAULT 'email',
  "reference"      TEXT NOT NULL,
  "summary"        TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Complaint_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Complaint_shopId_receivedAt_idx"
  ON "Complaint" ("shopId", "receivedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Complaint_shopId_fkey'
  ) THEN
    ALTER TABLE "Complaint"
      ADD CONSTRAINT "Complaint_shopId_fkey"
      FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
