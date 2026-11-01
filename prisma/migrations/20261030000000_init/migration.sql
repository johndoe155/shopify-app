-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN,
    "emailVerified" BOOLEAN,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "onboardingCompletedAt" TIMESTAMP(3),
    "plan" TEXT NOT NULL DEFAULT 'free',
    "planStatus" TEXT NOT NULL DEFAULT 'NONE',
    "billingInterval" TEXT,
    "subscriptionId" TEXT,
    "trialEndsAt" TIMESTAMP(3),
    "planUpdatedAt" TIMESTAMP(3),
    "storeName" TEXT,
    "consumerCarePhone" TEXT,
    "consumerCareEmail" TEXT,
    "grievanceName" TEXT,
    "grievanceDesignation" TEXT,
    "grievanceEmail" TEXT,
    "grievancePhone" TEXT,
    "returnPolicyUrl" TEXT,
    "returnPolicyText" TEXT,
    "refundPolicyUrl" TEXT,
    "refundPolicyText" TEXT,
    "exchangePolicyUrl" TEXT,
    "exchangePolicyText" TEXT,
    "warrantyPolicyUrl" TEXT,
    "warrantyPolicyText" TEXT,
    "deliveryTermsUrl" TEXT,
    "deliveryTermsText" TEXT,
    "returnShippingCostUrl" TEXT,
    "returnShippingCostText" TEXT,
    "blocksDetectedAt" TIMESTAMP(3),
    "blocksDetectedJson" JSONB,
    "confirmDeclarationsBlock" BOOLEAN NOT NULL DEFAULT false,
    "confirmGrievanceBlock" BOOLEAN NOT NULL DEFAULT false,
    "confirmPriorPriceBlock" BOOLEAN NOT NULL DEFAULT false,
    "countryFilterConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "lastScanStartedAt" TIMESTAMP(3),
    "lastScanCompletedAt" TIMESTAMP(3),
    "lastScanProductCount" INTEGER NOT NULL DEFAULT 0,
    "lastScanBulkOperationId" TEXT,
    "reviewPromptShown" BOOLEAN NOT NULL DEFAULT false,
    "reviewPromptShownAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanResult" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productHandle" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "productVendor" TEXT,
    "productType" TEXT,
    "ruleId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceSnapshot" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "compareAt" DECIMAL(12,2),
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'webhook',

    CONSTRAINT "PriceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditRecord" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "answersJson" JSONB NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productHandle" TEXT,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,

    CONSTRAINT "ChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "name" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "meta" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "ScanResult_shopId_status_idx" ON "ScanResult"("shopId", "status");

-- CreateIndex
CREATE INDEX "ScanResult_shopId_productId_idx" ON "ScanResult"("shopId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ScanResult_shopId_productId_ruleId_key" ON "ScanResult"("shopId", "productId", "ruleId");

-- CreateIndex
CREATE INDEX "PriceSnapshot_shopId_variantId_observedAt_idx" ON "PriceSnapshot"("shopId", "variantId", "observedAt");

-- CreateIndex
CREATE INDEX "PriceSnapshot_shopId_observedAt_idx" ON "PriceSnapshot"("shopId", "observedAt");

-- CreateIndex
CREATE INDEX "AuditRecord_shopId_completedAt_idx" ON "AuditRecord"("shopId", "completedAt");

-- CreateIndex
CREATE INDEX "ChangeLog_shopId_changedAt_idx" ON "ChangeLog"("shopId", "changedAt");

-- CreateIndex
CREATE INDEX "ChangeLog_shopId_productId_idx" ON "ChangeLog"("shopId", "productId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_shopDomain_topic_idx" ON "WebhookDelivery"("shopDomain", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_idempotencyKey_key" ON "JobRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "JobRun_name_status_idx" ON "JobRun"("name", "status");

-- AddForeignKey
ALTER TABLE "ScanResult" ADD CONSTRAINT "ScanResult_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceSnapshot" ADD CONSTRAINT "PriceSnapshot_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditRecord" ADD CONSTRAINT "AuditRecord_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeLog" ADD CONSTRAINT "ChangeLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

