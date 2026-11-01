/**
 * Postgres implementation of the Repository port (Prisma).
 */
import { Prisma, PrismaClient } from "@prisma/client";
import type { BillingInterval, PlanId } from "~/domain/plans";
import type { BlockStatuses, RuleStatus } from "~/domain/types";
import type { Repository, SaveScanOptions } from "./repository";
import type {
  AuditRecordRow,
  ChangeLogRow,
  ComplaintRow,
  PriceAnnouncementInsert,
  PriceAnnouncementRow,
  PriceSnapshotRow,
  QueuedJobInsert,
  QueuedJobRecord,
  ScanResultRow,
  ShopRecord,
  ShopSettingsPatch,
} from "./types";

declare global {
   
  var __legalMrpPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__legalMrpPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") global.__legalMrpPrisma = prisma;

type ShopRow = Prisma.ShopGetPayload<Record<string, never>>;
type QueuedJobRow = Prisma.QueuedJobGetPayload<Record<string, never>>;

function toQueuedJobRecord(row: QueuedJobRow): QueuedJobRecord {
  return {
    id: row.id,
    name: row.name,
    dedupeKey: row.dedupeKey,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    shopDomain: row.shopDomain,
    status: row.status as QueuedJobRecord["status"],
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    runAt: row.runAt,
    lockedAt: row.lockedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

function toShopRecord(row: ShopRow): ShopRecord {
  return {
    id: row.id,
    shopDomain: row.shopDomain,
    installedAt: row.installedAt,
    uninstalledAt: row.uninstalledAt,
    isActive: row.isActive,
    onboardingCompletedAt: row.onboardingCompletedAt,
    plan: row.plan as PlanId,
    planStatus: row.planStatus,
    billingInterval: (row.billingInterval as BillingInterval | null) ?? null,
    subscriptionId: row.subscriptionId,
    trialEndsAt: row.trialEndsAt,
    storeName: row.storeName,
    consumerCareAddress: row.consumerCareAddress,
    consumerCarePhone: row.consumerCarePhone,
    consumerCareEmail: row.consumerCareEmail,
    platformCustomerCareUrl: row.platformCustomerCareUrl,
    grievanceName: row.grievanceName,
    grievanceDesignation: row.grievanceDesignation,
    grievanceEmail: row.grievanceEmail,
    grievancePhone: row.grievancePhone,
    returnPolicyUrl: row.returnPolicyUrl,
    returnPolicyText: row.returnPolicyText,
    refundPolicyUrl: row.refundPolicyUrl,
    refundPolicyText: row.refundPolicyText,
    exchangePolicyUrl: row.exchangePolicyUrl,
    exchangePolicyText: row.exchangePolicyText,
    warrantyPolicyUrl: row.warrantyPolicyUrl,
    warrantyPolicyText: row.warrantyPolicyText,
    deliveryTermsUrl: row.deliveryTermsUrl,
    deliveryTermsText: row.deliveryTermsText,
    returnShippingCostUrl: row.returnShippingCostUrl,
    returnShippingCostText: row.returnShippingCostText,
    paymentModesUrl: row.paymentModesUrl,
    paymentModesText: row.paymentModesText,
    grievanceRedressalUrl: row.grievanceRedressalUrl,
    grievanceRedressalText: row.grievanceRedressalText,
    otherInformationUrl: row.otherInformationUrl,
    otherInformationText: row.otherInformationText,
    useBeforeInfoUrl: row.useBeforeInfoUrl,
    useBeforeInfoText: row.useBeforeInfoText,
    policyLinkChecks: (row.policyLinkChecksJson as unknown as Record<string, import("~/domain/types").PolicyLinkCheck> | null) ?? null,
    confirmDeclarationsBlock: row.confirmDeclarationsBlock,
    confirmGrievanceBlock: row.confirmGrievanceBlock,
    confirmPriorPriceBlock: row.confirmPriorPriceBlock,
    countryFilterConfirmed: row.countryFilterConfirmed,
    blocksDetectedAt: row.blocksDetectedAt,
    blocksDetected: (row.blocksDetectedJson as unknown as BlockStatuses | null) ?? null,
    lastScanStartedAt: row.lastScanStartedAt,
    lastScanCompletedAt: row.lastScanCompletedAt,
    lastScanProductCount: row.lastScanProductCount,
    reviewPromptShown: row.reviewPromptShown,
    reviewPromptShownAt: row.reviewPromptShownAt,
  };
}

const num = (value: Prisma.Decimal | null): number | null =>
  value === null ? null : Number(value.toString());

type PriceAnnouncementDbRow = Prisma.PriceAnnouncementGetPayload<Record<string, never>>;

function toPriceAnnouncementRow(row: PriceAnnouncementDbRow): PriceAnnouncementRow {
  return {
    id: row.id,
    productId: row.productId,
    variantId: row.variantId,
    announcedAt: row.announcedAt,
    consumerPrice: num(row.consumerPrice) ?? 0,
    mechanism: row.mechanism as PriceAnnouncementRow["mechanism"],
    conditions: row.conditions,
    createdAt: row.createdAt,
  };
}

export class PrismaRepository implements Repository {
  constructor(private readonly client: PrismaClient = prisma) {}

  async getShop(shopDomain: string): Promise<ShopRecord | null> {
    const row = await this.client.shop.findUnique({ where: { shopDomain } });
    return row ? toShopRecord(row) : null;
  }

  async getShopById(id: string): Promise<ShopRecord | null> {
    const row = await this.client.shop.findUnique({ where: { id } });
    return row ? toShopRecord(row) : null;
  }

  async createShop(shopDomain: string, overrides: Partial<ShopRecord> = {}): Promise<ShopRecord> {
    const {
      id: _ignoredId,
      blocksDetected,
      policyLinkChecks,
      shopDomain: _ignoredDomain,
      ...rest
    } = overrides;
    const data = {
      ...(rest as unknown as Omit<Prisma.ShopUncheckedCreateInput, "shopDomain">),
      shopDomain,
      blocksDetectedJson: blocksDetected
        ? (blocksDetected as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
      ...(policyLinkChecks
        ? { policyLinkChecksJson: policyLinkChecks as unknown as Prisma.InputJsonValue }
        : {}),
    } as Prisma.ShopUncheckedCreateInput;
    const row = await this.client.shop.create({ data });
    return toShopRecord(row);
  }

  async updateShop(id: string, patch: Partial<ShopRecord>): Promise<ShopRecord> {
    const { id: _ignoredId, blocksDetected, policyLinkChecks, ...rest } = patch;
    const row = await this.client.shop.update({
      where: { id },
      data: {
        ...(rest as Prisma.ShopUncheckedUpdateInput),
        ...(blocksDetected !== undefined
          ? {
              blocksDetectedJson: blocksDetected
                ? (blocksDetected as unknown as Prisma.InputJsonValue)
                : Prisma.DbNull,
            }
          : {}),
        ...(policyLinkChecks !== undefined
          ? {
              policyLinkChecksJson: policyLinkChecks
                ? (policyLinkChecks as unknown as Prisma.InputJsonValue)
                : Prisma.DbNull,
            }
          : {}),
      },
    });
    return toShopRecord(row);
  }

  async updateShopSettings(id: string, patch: ShopSettingsPatch): Promise<ShopRecord> {
    return this.updateShop(id, patch as Partial<ShopRecord>);
  }

  async listActiveShops(): Promise<ShopRecord[]> {
    const rows = await this.client.shop.findMany({ where: { isActive: true } });
    return rows.map(toShopRecord);
  }

  async markUninstalled(shopDomain: string): Promise<void> {
    await this.client.shop.updateMany({
      where: { shopDomain },
      data: { isActive: false, uninstalledAt: new Date(), planStatus: "CANCELLED" },
    });
    await this.client.session.deleteMany({ where: { shop: shopDomain } });
  }

  async deleteShopData(shopDomain: string): Promise<void> {
    const shop = await this.client.shop.findUnique({ where: { shopDomain } });
    await this.client.session.deleteMany({ where: { shop: shopDomain } });
    await this.client.webhookDelivery.deleteMany({ where: { shopDomain } });
    // Queued jobs are keyed by shop domain rather than a foreign key, so they
    // are removed explicitly (shop/redact must leave nothing behind).
    await this.client.queuedJob.deleteMany({ where: { shopDomain } });
    if (!shop) return;
    // Cascades remove scan results, price snapshots, audit records,
    // change log entries and job runs.
    await this.client.shop.delete({ where: { id: shop.id } });
  }

  async setDetectedBlocks(id: string, blocks: BlockStatuses, detectedAt: Date): Promise<void> {
    await this.client.shop.update({
      where: { id },
      data: {
        blocksDetectedJson: blocks as unknown as Prisma.InputJsonValue,
        blocksDetectedAt: detectedAt,
      },
    });
  }

  async replaceScanResults(shopId: string, rows: ScanResultRow[], options: SaveScanOptions): Promise<void> {
    await this.client.$transaction(async (tx) => {
      if (options.purgeMissing.length > 0) {
        await tx.scanResult.deleteMany({
          where: { shopId, productId: { in: options.purgeMissing } },
        });
      }
      for (const row of rows) {
        await tx.scanResult.upsert({
          where: {
            shopId_productId_ruleId: { shopId, productId: row.productId, ruleId: row.ruleId },
          },
          create: {
            shopId,
            productId: row.productId,
            productHandle: row.productHandle,
            productTitle: row.productTitle,
            productVendor: row.productVendor,
            productType: row.productType,
            ruleId: row.ruleId,
            status: row.status,
            message: row.message,
            scannedAt: row.scannedAt,
          },
          update: {
            status: row.status,
            message: row.message,
            scannedAt: row.scannedAt,
            productHandle: row.productHandle,
            productTitle: row.productTitle,
            productVendor: row.productVendor,
            productType: row.productType,
          },
        });
      }
      await tx.shop.update({
        where: { id: shopId },
        data: {
          lastScanStartedAt: options.startedAt,
          lastScanCompletedAt: options.completedAt,
          lastScanProductCount: options.productCount,
        },
      });
    });
  }

  async listScanResults(shopId: string): Promise<ScanResultRow[]> {
    const rows = await this.client.scanResult.findMany({ where: { shopId } });
    return rows.map((row) => ({
      productId: row.productId,
      productHandle: row.productHandle,
      productTitle: row.productTitle,
      productVendor: row.productVendor,
      productType: row.productType,
      ruleId: row.ruleId,
      status: row.status as RuleStatus,
      message: row.message,
      scannedAt: row.scannedAt,
    }));
  }

  async insertPriceSnapshots(shopId: string, rows: PriceSnapshotRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.client.priceSnapshot.createMany({
      data: rows.map((row) => ({
        shopId,
        productId: row.productId,
        variantId: row.variantId,
        price: new Prisma.Decimal(row.price),
        compareAt: row.compareAt === null ? null : new Prisma.Decimal(row.compareAt),
        observedAt: row.observedAt,
        source: row.source,
      })),
    });
  }

  async listPriceSnapshots(shopId: string, options: { since?: Date } = {}): Promise<PriceSnapshotRow[]> {
    const rows = await this.client.priceSnapshot.findMany({
      where: { shopId, ...(options.since ? { observedAt: { gte: options.since } } : {}) },
      orderBy: { observedAt: "asc" },
    });
    return rows.map((row) => ({
      productId: row.productId,
      variantId: row.variantId,
      price: Number(row.price.toString()),
      compareAt: num(row.compareAt),
      observedAt: row.observedAt,
      source: row.source as PriceSnapshotRow["source"],
    }));
  }

  async saveAuditRecord(shopId: string, answers: unknown, completedAt: Date): Promise<AuditRecordRow> {
    const row = await this.client.auditRecord.create({
      data: { shopId, answersJson: answers as Prisma.InputJsonValue, completedAt },
    });
    return { id: row.id, answers: row.answersJson, completedAt: row.completedAt };
  }

  async latestAuditRecord(shopId: string): Promise<AuditRecordRow | null> {
    const row = await this.client.auditRecord.findFirst({
      where: { shopId },
      orderBy: { completedAt: "desc" },
    });
    return row ? { id: row.id, answers: row.answersJson, completedAt: row.completedAt } : null;
  }

  async createComplaint(shopId: string, complaint: Omit<ComplaintRow, "id">): Promise<ComplaintRow> {
    const row = await this.client.complaint.create({
      data: {
        shopId,
        receivedAt: complaint.receivedAt,
        acknowledgedAt: complaint.acknowledgedAt,
        resolvedAt: complaint.resolvedAt,
        channel: complaint.channel,
        reference: complaint.reference,
        summary: complaint.summary,
      },
    });
    return {
      id: row.id,
      receivedAt: row.receivedAt,
      acknowledgedAt: row.acknowledgedAt,
      resolvedAt: row.resolvedAt,
      channel: row.channel,
      reference: row.reference,
      summary: row.summary,
    };
  }

  async listComplaints(shopId: string): Promise<ComplaintRow[]> {
    const rows = await this.client.complaint.findMany({
      where: { shopId },
      orderBy: { receivedAt: "desc" },
    });
    return rows.map((row) => ({
      id: row.id,
      receivedAt: row.receivedAt,
      acknowledgedAt: row.acknowledgedAt,
      resolvedAt: row.resolvedAt,
      channel: row.channel,
      reference: row.reference,
      summary: row.summary,
    }));
  }

  /**
   * Records a price-reduction announcement, replacing any previous announcement
   * for the same product/variant (a variant has one current announcement).
   *
   * Replace-before-insert rather than a unique index: `variantId` is nullable
   * for a product-wide announcement, and Postgres treats NULLs as distinct, so a
   * unique constraint on (shopId, productId, variantId) would not stop
   * duplicates of the product-wide row.
   */
  async recordPriceAnnouncement(
    shopId: string,
    announcement: PriceAnnouncementInsert,
  ): Promise<PriceAnnouncementRow> {
    const variantId = announcement.variantId ?? null;
    const row = await this.client.$transaction(async (tx) => {
      await tx.priceAnnouncement.deleteMany({ where: { shopId, productId: announcement.productId, variantId } });
      return tx.priceAnnouncement.create({
        data: {
          shopId,
          productId: announcement.productId,
          variantId,
          announcedAt: announcement.announcedAt,
          consumerPrice: new Prisma.Decimal(announcement.consumerPrice),
          mechanism: announcement.mechanism,
          conditions: announcement.conditions,
        },
      });
    });
    return toPriceAnnouncementRow(row);
  }

  async listPriceAnnouncements(shopId: string, options: { productId?: string } = {}): Promise<PriceAnnouncementRow[]> {
    const rows = await this.client.priceAnnouncement.findMany({
      where: { shopId, ...(options.productId ? { productId: options.productId } : {}) },
      orderBy: { announcedAt: "desc" },
    });
    return rows.map(toPriceAnnouncementRow);
  }

  async deletePriceAnnouncement(shopId: string, id: string): Promise<boolean> {
    const result = await this.client.priceAnnouncement.deleteMany({ where: { id, shopId } });
    return result.count > 0;
  }

  async appendChangeLog(shopId: string, rows: ChangeLogRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.client.changeLog.createMany({
      data: rows.map((row) => ({
        shopId,
        productId: row.productId,
        productHandle: row.productHandle,
        field: row.field,
        oldValue: row.oldValue,
        newValue: row.newValue,
        changedAt: row.changedAt,
        source: row.source,
      })),
    });
  }

  async listChangeLog(shopId: string, limit = 5000): Promise<ChangeLogRow[]> {
    const rows = await this.client.changeLog.findMany({
      where: { shopId },
      orderBy: { changedAt: "desc" },
      take: limit,
    });
    return rows.map((row) => ({
      productId: row.productId,
      productHandle: row.productHandle,
      field: row.field,
      oldValue: row.oldValue,
      newValue: row.newValue,
      changedAt: row.changedAt,
      source: row.source,
    }));
  }

  async claimWebhookDelivery(key: string, topic: string, shopDomain: string): Promise<boolean> {
    try {
      await this.client.webhookDelivery.create({ data: { id: key, topic, shopDomain } });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
      throw error;
    }
  }

  async claimJobRun(key: string, name: string, shopId: string | null): Promise<boolean> {
    try {
      await this.client.jobRun.create({
        data: { idempotencyKey: key, name, shopId, status: "running" },
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
      throw error;
    }
  }

  async finishJobRun(key: string, status: "done" | "failed", error?: string): Promise<void> {
    await this.client.jobRun.update({
      where: { idempotencyKey: key },
      data: { status, error: error ?? null, finishedAt: new Date() },
    });
  }

  // --- durable queue -------------------------------------------------------

  async enqueueJob(job: QueuedJobInsert): Promise<boolean> {
    try {
      await this.client.queuedJob.create({
        data: {
          name: job.name,
          dedupeKey: job.dedupeKey,
          payload: job.payload as Prisma.InputJsonValue,
          shopDomain: job.shopDomain ?? null,
          maxAttempts: job.maxAttempts ?? 3,
          priority: job.priority ?? 100,
          runAt: job.runAt ?? new Date(),
        },
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
      throw error;
    }
  }

  async mergeJobProductIds(dedupeKey: string, productIds: string[]): Promise<boolean> {
    const job = await this.client.queuedJob.findUnique({ where: { dedupeKey } });
    if (!job || job.status !== "pending") return false;
    const payload = (job.payload ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(payload.productIds)
      ? (payload.productIds as unknown[]).filter((value): value is string => typeof value === "string")
      : [];
    const merged = [...new Set([...existing, ...productIds])];
    // Only a pending row is updated, so a job that was claimed between the read
    // and the write is left alone rather than being edited mid-flight.
    const result = await this.client.queuedJob.updateMany({
      where: { id: job.id, status: "pending" },
      data: { payload: { ...payload, productIds: merged } as Prisma.InputJsonValue },
    });
    return result.count === 1;
  }

  async claimDueJobs(now: Date, limit: number): Promise<QueuedJobRecord[]> {
    const candidates = await this.client.queuedJob.findMany({
      where: { status: "pending", runAt: { lte: now } },
      // Due time, then priority: a webhook's price snapshot must be recorded
      // before the rescan and publish it also queued are claimed. `id` is the
      // final tiebreak so jobs created inside the same millisecond — which is the
      // normal case for the three jobs one webhook writes — are handed out in a
      // stable order instead of whatever the planner returns.
      orderBy: [{ runAt: "asc" }, { priority: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: Math.max(1, limit),
    });
    const claimed: QueuedJobRecord[] = [];
    for (const candidate of candidates) {
      // Optimistic claim: only one worker can move the row out of `pending`.
      const result = await this.client.queuedJob.updateMany({
        where: { id: candidate.id, status: "pending" },
        data: { status: "running", lockedAt: now, attempts: { increment: 1 } },
      });
      if (result.count !== 1) continue;
      const row = await this.client.queuedJob.findUnique({ where: { id: candidate.id } });
      if (row) claimed.push(toQueuedJobRecord(row));
    }
    return claimed;
  }

  async completeJob(id: string): Promise<void> {
    await this.client.queuedJob.update({
      where: { id },
      data: { status: "done", finishedAt: new Date(), lockedAt: null, lastError: null },
    });
  }

  async failJob(id: string, error: string, retryAt: Date | null): Promise<void> {
    await this.client.queuedJob.update({
      where: { id },
      data: retryAt
        ? { status: "pending", runAt: retryAt, lockedAt: null, lastError: error.slice(0, 1000) }
        : { status: "failed", finishedAt: new Date(), lockedAt: null, lastError: error.slice(0, 1000) },
    });
  }

  async recoverExpiredJobs(now: Date, leaseMs: number): Promise<number> {
    const cutoff = new Date(now.getTime() - leaseMs);
    const result = await this.client.queuedJob.updateMany({
      where: { status: "running", lockedAt: { lt: cutoff } },
      data: {
        status: "pending",
        lockedAt: null,
        runAt: now,
        lastError: "lease expired: the worker running this job stopped before it finished",
      },
    });
    return result.count;
  }

  async countQueuedJobs(): Promise<number> {
    return this.client.queuedJob.count({ where: { status: { in: ["pending", "running"] } } });
  }
}
