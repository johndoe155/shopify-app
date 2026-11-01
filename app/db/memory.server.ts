/**
 * In-memory implementation of the Repository port.
 * Used by the integration tests and by DEMO_MODE, so the full scan / bulk-write /
 * export path can be exercised without Postgres.
 */
import type { BlockStatuses } from "~/domain/types";
import { defaultShopRecord } from "./defaults";
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

export class MemoryRepository implements Repository {
  private shops = new Map<string, ShopRecord>();
  private scanResults = new Map<string, ScanResultRow[]>();
  private priceSnapshots = new Map<string, PriceSnapshotRow[]>();
  private changeLog = new Map<string, ChangeLogRow[]>();
  private audits = new Map<string, AuditRecordRow[]>();
  private complaints = new Map<string, ComplaintRow[]>();
  private announcements = new Map<string, PriceAnnouncementRow[]>();
  private announcementSeq = 0;
  private webhooks = new Set<string>();
  private jobs = new Map<string, { name: string; status: string; error?: string }>();
  private queuedJobs = new Map<string, QueuedJobRecord>();
  private queuedJobSeq = 0;

  async getShop(shopDomain: string): Promise<ShopRecord | null> {
    return this.shops.get(shopDomain) ?? null;
  }

  async getShopById(id: string): Promise<ShopRecord | null> {
    for (const shop of this.shops.values()) if (shop.id === id) return shop;
    return null;
  }

  async createShop(shopDomain: string, overrides: Partial<ShopRecord> = {}): Promise<ShopRecord> {
    const shop = defaultShopRecord(shopDomain, overrides);
    this.shops.set(shopDomain, shop);
    return shop;
  }

  async updateShop(id: string, patch: Partial<ShopRecord>): Promise<ShopRecord> {
    for (const [domain, shop] of this.shops.entries()) {
      if (shop.id !== id) continue;
      const next = { ...shop, ...patch };
      this.shops.set(domain, next);
      return next;
    }
    throw new Error(`Unknown shop id ${id}`);
  }

  async updateShopSettings(id: string, patch: ShopSettingsPatch): Promise<ShopRecord> {
    return this.updateShop(id, patch as Partial<ShopRecord>);
  }

  async listActiveShops(): Promise<ShopRecord[]> {
    return [...this.shops.values()].filter((s) => s.isActive);
  }

  async markUninstalled(shopDomain: string): Promise<void> {
    const shop = this.shops.get(shopDomain);
    if (!shop) return;
    this.shops.set(shopDomain, { ...shop, isActive: false, uninstalledAt: new Date() });
  }

  async deleteShopData(shopDomain: string): Promise<void> {
    const shop = this.shops.get(shopDomain);
    if (!shop) return;
    this.shops.delete(shopDomain);
    this.scanResults.delete(shop.id);
    this.priceSnapshots.delete(shop.id);
    this.changeLog.delete(shop.id);
    this.audits.delete(shop.id);
    this.complaints.delete(shop.id);
    this.announcements.delete(shop.id);
    for (const [id, job] of this.queuedJobs.entries()) {
      if (job.shopDomain === shopDomain) this.queuedJobs.delete(id);
    }
  }

  async setDetectedBlocks(id: string, blocks: BlockStatuses, detectedAt: Date): Promise<void> {
    await this.updateShop(id, { blocksDetected: blocks, blocksDetectedAt: detectedAt });
  }

  async replaceScanResults(shopId: string, rows: ScanResultRow[], options: SaveScanOptions): Promise<void> {
    const existing = this.scanResults.get(shopId) ?? [];
    const missing = new Set(options.purgeMissing);
    const kept = existing.filter((row) => !missing.has(row.productId));
    // Replace by (productId, ruleId) so a re-scan is idempotent.
    const key = (row: ScanResultRow) => `${row.productId}::${row.ruleId}`;
    const merged = new Map(kept.map((row) => [key(row), row]));
    for (const row of rows) merged.set(key(row), row);
    this.scanResults.set(shopId, [...merged.values()]);
    await this.updateShop(shopId, {
      lastScanStartedAt: options.startedAt,
      lastScanCompletedAt: options.completedAt,
      lastScanProductCount: options.productCount,
    });
  }

  async listScanResults(shopId: string): Promise<ScanResultRow[]> {
    return this.scanResults.get(shopId) ?? [];
  }

  async insertPriceSnapshots(shopId: string, rows: PriceSnapshotRow[]): Promise<void> {
    const existing = this.priceSnapshots.get(shopId) ?? [];
    const seen = new Set(
      existing.map((row) => `${row.variantId}::${row.price}::${row.observedAt.toISOString()}`),
    );
    const added = rows.filter((row) => {
      const key = `${row.variantId}::${row.price}::${row.observedAt.toISOString()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    this.priceSnapshots.set(shopId, [...existing, ...added]);
  }

  async listPriceSnapshots(shopId: string, options: { since?: Date } = {}): Promise<PriceSnapshotRow[]> {
    const rows = this.priceSnapshots.get(shopId) ?? [];
    if (!options.since) return [...rows];
    return rows.filter((row) => row.observedAt.getTime() >= options.since!.getTime());
  }

  async saveAuditRecord(shopId: string, answers: unknown, completedAt: Date): Promise<AuditRecordRow> {
    const record: AuditRecordRow = {
      id: `audit_${completedAt.getTime()}`,
      answers,
      completedAt,
    };
    const existing = this.audits.get(shopId) ?? [];
    this.audits.set(shopId, [...existing, record]);
    return record;
  }

  async createComplaint(shopId: string, complaint: Omit<ComplaintRow, "id">): Promise<ComplaintRow> {
    const record: ComplaintRow = { ...complaint, id: `complaint_${(this.complaints.get(shopId)?.length ?? 0) + 1}` };
    const existing = this.complaints.get(shopId) ?? [];
    this.complaints.set(shopId, [...existing, record]);
    return record;
  }

  async listComplaints(shopId: string): Promise<ComplaintRow[]> {
    return [...(this.complaints.get(shopId) ?? [])].sort(
      (a, b) => b.receivedAt.getTime() - a.receivedAt.getTime(),
    );
  }

  async recordPriceAnnouncement(
    shopId: string,
    announcement: PriceAnnouncementInsert,
  ): Promise<PriceAnnouncementRow> {
    this.announcementSeq += 1;
    const row: PriceAnnouncementRow = { ...announcement, id: `announcement_${this.announcementSeq}`, createdAt: new Date() };
    const existing = this.announcements.get(shopId) ?? [];
    // One current announcement per product/variant: re-recording replaces the
    // previous one for the same good instead of stacking duplicates that would
    // make "the 30 days before the announcement" ambiguous.
    const kept = existing.filter(
      (candidate) =>
        !(candidate.productId === announcement.productId && candidate.variantId === announcement.variantId),
    );
    this.announcements.set(shopId, [...kept, row]);
    return row;
  }

  async listPriceAnnouncements(shopId: string, options: { productId?: string } = {}): Promise<PriceAnnouncementRow[]> {
    const rows = this.announcements.get(shopId) ?? [];
    const filtered = options.productId ? rows.filter((row) => row.productId === options.productId) : rows;
    return [...filtered].sort((a, b) => b.announcedAt.getTime() - a.announcedAt.getTime());
  }

  async deletePriceAnnouncement(shopId: string, id: string): Promise<boolean> {
    const rows = this.announcements.get(shopId) ?? [];
    const kept = rows.filter((row) => row.id !== id);
    if (kept.length === rows.length) return false;
    this.announcements.set(shopId, kept);
    return true;
  }

  async latestAuditRecord(shopId: string): Promise<AuditRecordRow | null> {
    const rows = this.audits.get(shopId) ?? [];
    if (rows.length === 0) return null;
    return [...rows].sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime())[0]!;
  }

  async appendChangeLog(shopId: string, rows: ChangeLogRow[]): Promise<void> {
    const existing = this.changeLog.get(shopId) ?? [];
    this.changeLog.set(shopId, [...existing, ...rows]);
  }

  async listChangeLog(shopId: string, limit = 5000): Promise<ChangeLogRow[]> {
    const rows = this.changeLog.get(shopId) ?? [];
    return [...rows].sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime()).slice(0, limit);
  }

  async claimWebhookDelivery(key: string, _topic: string, _shopDomain: string): Promise<boolean> {
    if (this.webhooks.has(key)) return false;
    this.webhooks.add(key);
    return true;
  }

  async claimJobRun(key: string, name: string, _shopId: string | null): Promise<boolean> {
    if (this.jobs.has(key)) return false;
    this.jobs.set(key, { name, status: "running" });
    return true;
  }

  async finishJobRun(key: string, status: "done" | "failed", error?: string): Promise<void> {
    const job = this.jobs.get(key);
    if (job) this.jobs.set(key, { ...job, status, error });
  }

  // --- durable queue -------------------------------------------------------
  // The memory store keeps the same semantics as Postgres so the queue can be
  // tested (including restart recovery) without a database.

  async enqueueJob(job: QueuedJobInsert): Promise<boolean> {
    for (const existing of this.queuedJobs.values()) {
      if (existing.dedupeKey === job.dedupeKey) return false;
    }
    this.queuedJobSeq += 1;
    const now = new Date();
    this.queuedJobs.set(`job-${this.queuedJobSeq}`, {
      id: `job-${this.queuedJobSeq}`,
      name: job.name,
      dedupeKey: job.dedupeKey,
      payload: job.payload,
      shopDomain: job.shopDomain ?? null,
      status: "pending",
      priority: job.priority ?? 100,
      attempts: 0,
      maxAttempts: job.maxAttempts ?? 3,
      runAt: job.runAt ?? now,
      lockedAt: null,
      lastError: null,
      createdAt: now,
      finishedAt: null,
    });
    return true;
  }

  async mergeJobProductIds(dedupeKey: string, productIds: string[]): Promise<boolean> {
    for (const [id, job] of this.queuedJobs.entries()) {
      if (job.dedupeKey !== dedupeKey) continue;
      if (job.status !== "pending") return false;
      const existing = Array.isArray(job.payload.productIds)
        ? (job.payload.productIds as unknown[]).filter((value): value is string => typeof value === "string")
        : [];
      const merged = [...new Set([...existing, ...productIds])];
      this.queuedJobs.set(id, { ...job, payload: { ...job.payload, productIds: merged } });
      return true;
    }
    return false;
  }

  async claimDueJobs(now: Date, limit: number): Promise<QueuedJobRecord[]> {
    const due = [...this.queuedJobs.values()]
      .filter((job) => job.status === "pending" && job.runAt.getTime() <= now.getTime())
      // Due time first, then priority (price snapshots before the rescans and the
      // catalogue-wide publish a webhook also queued), then insertion order. The
      // id is the final tiebreak because `createdAt` has millisecond resolution
      // and the three jobs one webhook writes usually share a millisecond; without
      // it the order would depend on the sort's stability rather than on the data.
      // Mirrors `PrismaRepository.claimDueJobs`.
      .sort(
        (a, b) =>
          a.runAt.getTime() - b.runAt.getTime() ||
          a.priority - b.priority ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id, "en", { numeric: true }),
      )
      .slice(0, Math.max(1, limit));
    const claimed: QueuedJobRecord[] = [];
    for (const job of due) {
      const next: QueuedJobRecord = {
        ...job,
        status: "running",
        lockedAt: now,
        attempts: job.attempts + 1,
      };
      this.queuedJobs.set(job.id, next);
      claimed.push(next);
    }
    return claimed;
  }

  async completeJob(id: string): Promise<void> {
    const job = this.queuedJobs.get(id);
    if (!job) return;
    this.queuedJobs.set(id, {
      ...job,
      status: "done",
      lockedAt: null,
      lastError: null,
      finishedAt: new Date(),
    });
  }

  async failJob(id: string, error: string, retryAt: Date | null): Promise<void> {
    const job = this.queuedJobs.get(id);
    if (!job) return;
    this.queuedJobs.set(
      id,
      retryAt
        ? { ...job, status: "pending", runAt: retryAt, lockedAt: null, lastError: error }
        : { ...job, status: "failed", lockedAt: null, lastError: error, finishedAt: new Date() },
    );
  }

  async recoverExpiredJobs(now: Date, leaseMs: number): Promise<number> {
    const cutoff = now.getTime() - leaseMs;
    let recovered = 0;
    for (const [id, job] of this.queuedJobs.entries()) {
      if (job.status !== "running") continue;
      if (job.lockedAt && job.lockedAt.getTime() >= cutoff) continue;
      this.queuedJobs.set(id, {
        ...job,
        status: "pending",
        lockedAt: null,
        runAt: now,
        lastError: "lease expired: the worker running this job stopped before it finished",
      });
      recovered += 1;
    }
    return recovered;
  }

  async countQueuedJobs(): Promise<number> {
    return [...this.queuedJobs.values()].filter((job) => job.status === "pending" || job.status === "running")
      .length;
  }

  /** Test helper: the raw queue rows, in insertion order. */
  listQueuedJobs(): QueuedJobRecord[] {
    return [...this.queuedJobs.values()];
  }
}
