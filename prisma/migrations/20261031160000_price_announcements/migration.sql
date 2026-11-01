-- Price-reduction announcements (audit item L13, rule R11).
--
-- A prior price is the lowest price of the good during the 30 days before a
-- reduction was ANNOUNCED, so the announcement — not a bare price change — is the
-- event the evidence has to name. The app derives that event when a variant
-- price or a compare-at price moves, because it sees both through the Admin API.
-- It cannot see a discount code or an automatic discount: those are applied at
-- checkout and move no variant price. Those two are recorded here instead, with
-- the date, the price the shopper actually pays, the mechanism and the
-- conditions. A NULL "variantId" records a whole-product announcement, which
-- applies to every variant that has no record of its own.

CREATE TABLE IF NOT EXISTS "PriceAnnouncement" (
  "id"            TEXT NOT NULL,
  "shopId"        TEXT NOT NULL,
  "productId"     TEXT NOT NULL,
  "variantId"     TEXT,
  "announcedAt"   TIMESTAMP(3) NOT NULL,
  "consumerPrice" DECIMAL(12, 2) NOT NULL,
  "mechanism"     TEXT NOT NULL,
  "conditions"    TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PriceAnnouncement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PriceAnnouncement_shopId_productId_idx"
  ON "PriceAnnouncement" ("shopId", "productId");

CREATE INDEX IF NOT EXISTS "PriceAnnouncement_shopId_variantId_idx"
  ON "PriceAnnouncement" ("shopId", "variantId");

CREATE INDEX IF NOT EXISTS "PriceAnnouncement_shopId_announcedAt_idx"
  ON "PriceAnnouncement" ("shopId", "announcedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PriceAnnouncement_shopId_fkey'
  ) THEN
    ALTER TABLE "PriceAnnouncement"
      ADD CONSTRAINT "PriceAnnouncement_shopId_fkey"
      FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
