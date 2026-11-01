import type { BlockStatuses } from "~/domain/types";
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

export interface SaveScanOptions {
  /** Products the scan actually covered (a plan may limit this). */
  productCount: number;
  startedAt: Date;
  completedAt: Date;
  /** When true, results for products no longer in the catalogue are removed. */
  purgeMissing: string[];
}

/**
 * The persistence port. Two implementations exist:
 *  - PrismaRepository (Postgres, production)
 *  - MemoryRepository (tests and DEMO_MODE, no database required)
 * Services depend on this interface only, which is what lets the whole scan and
 * bulk-write path be integration tested without a dev store.
 */
export interface Repository {
  getShop(shopDomain: string): Promise<ShopRecord | null>;
  getShopById(id: string): Promise<ShopRecord | null>;
  createShop(shopDomain: string, overrides?: Partial<ShopRecord>): Promise<ShopRecord>;
  updateShop(id: string, patch: Partial<ShopRecord>): Promise<ShopRecord>;
  updateShopSettings(id: string, patch: ShopSettingsPatch): Promise<ShopRecord>;
  listActiveShops(): Promise<ShopRecord[]>;
  markUninstalled(shopDomain: string): Promise<void>;
  /** shop/redact: removes every row owned by the shop. */
  deleteShopData(shopDomain: string): Promise<void>;
  setDetectedBlocks(id: string, blocks: BlockStatuses, detectedAt: Date): Promise<void>;

  replaceScanResults(shopId: string, rows: ScanResultRow[], options: SaveScanOptions): Promise<void>;
  listScanResults(shopId: string): Promise<ScanResultRow[]>;

  insertPriceSnapshots(shopId: string, rows: PriceSnapshotRow[]): Promise<void>;
  listPriceSnapshots(shopId: string, options?: { since?: Date }): Promise<PriceSnapshotRow[]>;

  saveAuditRecord(shopId: string, answers: unknown, completedAt: Date): Promise<AuditRecordRow>;
  latestAuditRecord(shopId: string): Promise<AuditRecordRow | null>;

  /**
   * Complaint register (R10). The 48-hour acknowledgement and one-month
   * redressal duties are operational, so the app stores the evidence rather than
   * inferring it from a storefront block.
   */
  createComplaint(shopId: string, complaint: Omit<ComplaintRow, "id">): Promise<ComplaintRow>;
  listComplaints(shopId: string): Promise<ComplaintRow[]>;

  /**
   * Price-reduction announcements (R11, audit item L13).
   *
   * The prior price is measured from the announcement, and the app cannot see a
   * discount code or an automatic discount — those are applied at checkout and
   * move no variant price — so the merchant records those announcements here
   * with the date, the price the shopper pays and the conditions. Recording the
   * same product/variant again replaces the previous announcement for it: a
   * variant has one current announcement, and a stale duplicate would make the
   * prior price ambiguous.
   */
  recordPriceAnnouncement(shopId: string, announcement: PriceAnnouncementInsert): Promise<PriceAnnouncementRow>;
  listPriceAnnouncements(shopId: string, options?: { productId?: string }): Promise<PriceAnnouncementRow[]>;
  /** Removes a recorded announcement. Returns false when it was not there. */
  deletePriceAnnouncement(shopId: string, id: string): Promise<boolean>;

  appendChangeLog(shopId: string, rows: ChangeLogRow[]): Promise<void>;
  listChangeLog(shopId: string, limit?: number): Promise<ChangeLogRow[]>;

  /** Returns false when this webhook delivery was already processed. */
  claimWebhookDelivery(key: string, topic: string, shopDomain: string): Promise<boolean>;

  /** Idempotency for nightly/backfill jobs. Returns false if already claimed. */
  claimJobRun(key: string, name: string, shopId: string | null): Promise<boolean>;
  finishJobRun(key: string, status: "done" | "failed", error?: string): Promise<void>;

  // --- durable queue -------------------------------------------------------
  /** Inserts a job. Returns false when the dedupe key has been seen before. */
  enqueueJob(job: QueuedJobInsert): Promise<boolean>;
  /**
   * Adds product ids to the payload of a job that is still pending, matching on
   * its dedupe key. Returns false when the job is missing or already running.
   * This is what lets a burst of `products/update` deliveries share one
   * prior-price publish without losing any of the products.
   */
  mergeJobProductIds(dedupeKey: string, productIds: string[]): Promise<boolean>;
  /**
   * Claims up to `limit` due jobs by moving them to `running` under a lease.
   * Only jobs whose `lockedAt` is older than `leaseMs` (or null) can be
   * recovered by `recoverExpiredJobs`; claiming is optimistic, so two workers
   * racing for the same row is a no-op for the loser.
   */
  claimDueJobs(now: Date, limit: number): Promise<QueuedJobRecord[]>;
  completeJob(id: string): Promise<void>;
  /** Re-queues with backoff, or marks the job failed once attempts run out. */
  failJob(id: string, error: string, retryAt: Date | null): Promise<void>;
  /**
   * Returns jobs whose lease expired (worker died mid-job) to `pending`.
   * Returns how many were recovered.
   */
  recoverExpiredJobs(now: Date, leaseMs: number): Promise<number>;
  countQueuedJobs(): Promise<number>;
}
