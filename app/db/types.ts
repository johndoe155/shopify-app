import type { BillingInterval, PlanId } from "~/domain/plans";
import {
  COMPLAINT_EVIDENCE_LOOKBACK_MONTHS,
  type BlockStatuses,
  type ComplaintEvidence,
  type PolicyLinkCheck,
  type PriceAnnouncementMechanism,
  type RuleStatus,
  type StoreFacts,
} from "~/domain/types";

export interface ShopRecord {
  id: string;
  shopDomain: string;
  installedAt: Date;
  uninstalledAt: Date | null;
  isActive: boolean;
  onboardingCompletedAt: Date | null;

  plan: PlanId;
  planStatus: string;
  billingInterval: BillingInterval | null;
  subscriptionId: string | null;
  trialEndsAt: Date | null;

  /** Rule 6(2) package-label contact: the person or office contactable for complaints. */
  storeName: string | null;
  consumerCareAddress: string | null;
  consumerCarePhone: string | null;
  consumerCareEmail: string | null;
  /** The e-commerce entity's own customer-care surface (2020 Rules, Rule 4(2)(d)). */
  platformCustomerCareUrl: string | null;

  grievanceName: string | null;
  grievanceDesignation: string | null;
  grievanceEmail: string | null;
  grievancePhone: string | null;

  returnPolicyUrl: string | null;
  returnPolicyText: string | null;
  refundPolicyUrl: string | null;
  refundPolicyText: string | null;
  exchangePolicyUrl: string | null;
  exchangePolicyText: string | null;
  warrantyPolicyUrl: string | null;
  warrantyPolicyText: string | null;
  deliveryTermsUrl: string | null;
  deliveryTermsText: string | null;
  returnShippingCostUrl: string | null;
  returnShippingCostText: string | null;
  paymentModesUrl: string | null;
  paymentModesText: string | null;
  grievanceRedressalUrl: string | null;
  grievanceRedressalText: string | null;
  otherInformationUrl: string | null;
  otherInformationText: string | null;
  useBeforeInfoUrl: string | null;
  useBeforeInfoText: string | null;

  /** Result of the last policy-link accessibility check, per policy key. */
  policyLinkChecks: Record<string, PolicyLinkCheck> | null;

  confirmDeclarationsBlock: boolean;
  confirmGrievanceBlock: boolean;
  confirmPriorPriceBlock: boolean;
  countryFilterConfirmed: boolean;
  blocksDetectedAt: Date | null;
  blocksDetected: BlockStatuses | null;

  lastScanStartedAt: Date | null;
  lastScanCompletedAt: Date | null;
  lastScanProductCount: number;

  reviewPromptShown: boolean;
  reviewPromptShownAt: Date | null;
}

export interface ScanResultRow {
  productId: string;
  productHandle: string;
  productTitle: string;
  productVendor: string | null;
  productType: string | null;
  ruleId: string;
  status: RuleStatus;
  message: string;
  scannedAt: Date;
}

export interface PriceSnapshotRow {
  productId: string;
  variantId: string;
  price: number;
  compareAt: number | null;
  observedAt: Date;
  source: "webhook" | "nightly_diff" | "install";
}

export interface AuditRecordRow {
  id: string;
  answers: unknown;
  completedAt: Date;
}

export interface ChangeLogRow {
  productId: string;
  productHandle: string | null;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: Date;
  source: string;
}

/** One row of the durable background queue (see `QueuedJob` in the Prisma schema). */
export interface QueuedJobRecord {
  id: string;
  name: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  shopDomain: string | null;
  status: "pending" | "running" | "done" | "failed";
  /** Lower runs first among jobs that are due at the same moment. */
  priority: number;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  lockedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface QueuedJobInsert {
  name: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  shopDomain?: string | null;
  maxAttempts?: number;
  /** Lower runs first among jobs that are due at the same moment. */
  priority?: number;
  /** Delay before the job becomes claimable (used for retry backoff). */
  runAt?: Date;
}

/** Store settings as typed by the merchant, before persistence. */
export interface ShopSettingsPatch {
  storeName?: string | null;
  consumerCareAddress?: string | null;
  consumerCarePhone?: string | null;
  consumerCareEmail?: string | null;
  platformCustomerCareUrl?: string | null;
  grievanceName?: string | null;
  grievanceDesignation?: string | null;
  grievanceEmail?: string | null;
  grievancePhone?: string | null;
  returnPolicyUrl?: string | null;
  returnPolicyText?: string | null;
  refundPolicyUrl?: string | null;
  refundPolicyText?: string | null;
  exchangePolicyUrl?: string | null;
  exchangePolicyText?: string | null;
  warrantyPolicyUrl?: string | null;
  warrantyPolicyText?: string | null;
  deliveryTermsUrl?: string | null;
  deliveryTermsText?: string | null;
  returnShippingCostUrl?: string | null;
  returnShippingCostText?: string | null;
  paymentModesUrl?: string | null;
  paymentModesText?: string | null;
  grievanceRedressalUrl?: string | null;
  grievanceRedressalText?: string | null;
  otherInformationUrl?: string | null;
  otherInformationText?: string | null;
  useBeforeInfoUrl?: string | null;
  useBeforeInfoText?: string | null;
  policyLinkChecks?: Record<string, PolicyLinkCheck> | null;
  confirmDeclarationsBlock?: boolean;
  confirmGrievanceBlock?: boolean;
  confirmPriorPriceBlock?: boolean;
  countryFilterConfirmed?: boolean;
}

/** One row of the complaint register that evidences the R10 timings. */
export interface ComplaintRow {
  id: string;
  receivedAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  channel: string;
  reference: string;
  summary: string | null;
}

/**
 * One recorded price-reduction announcement (audit item L13).
 *
 * The prior price is the lowest price in the 30 days before a reduction was
 * **announced**, so the announcement — not the variant price change — is the
 * event the evidence has to name. The app can derive that event when a variant
 * price or a compare-at price moves, because it sees both through the Admin API.
 * It cannot see a discount code or an automatic discount: those are applied at
 * checkout, and no variant price moves. Those two are recorded here instead, with
 * the date, the price the shopper actually pays and any conditions.
 */
export interface PriceAnnouncementRow {
  id: string;
  productId: string;
  /** Null records an announcement for the whole product, not one variant. */
  variantId: string | null;
  /** When the reduction was announced / took effect. */
  announcedAt: Date;
  /** The price the shopper was offered, including the effect of the reduction. */
  consumerPrice: number;
  mechanism: PriceAnnouncementMechanism;
  /** Free-text conditions: the code, a minimum basket, the market. */
  conditions: string | null;
  createdAt: Date;
}

export type PriceAnnouncementInsert = Omit<PriceAnnouncementRow, "id" | "createdAt">;

export const ACKNOWLEDGEMENT_SLA_MS = 48 * 60 * 60 * 1000;

/** "Within one month" of receipt, computed the same way the rules engine does. */
export function oneMonthAfter(date: Date): Date {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const daysInMonth = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, daysInMonth));
  return next;
}

/** `date` minus `months`, clamped to the last day of a shorter month. */
export function monthsBefore(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() - months);
  const daysInMonth = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, daysInMonth));
  return next;
}

/**
 * Turns the complaint register into the evidence R10 reports (audit item L12:
 * a storefront block is not evidence that complaints are answered in time).
 *
 * Only complaints received inside the lookback window count. Without a window,
 * a single late complaint — even one redressed years ago — fails the store check
 * permanently, and there is nothing the merchant can do to put it right. The
 * 48-hour and one-month duties are about current conduct, so the evidence is
 * read over a recent period. The window is this app's policy, not a statutory
 * limitation period, and it is surfaced in the R10 message rather than hidden.
 */
export function complaintEvidence(
  rows: ComplaintRow[],
  now: Date = new Date(),
  lookbackMonths: number = COMPLAINT_EVIDENCE_LOOKBACK_MONTHS,
): ComplaintEvidence {
  const months =
    Number.isFinite(lookbackMonths) && lookbackMonths > 0 ? lookbackMonths : COMPLAINT_EVIDENCE_LOOKBACK_MONTHS;
  const cutoff = monthsBefore(now, months).getTime();
  const inWindow = rows.filter((row) => row.receivedAt.getTime() >= cutoff);
  const excludedByWindow = rows.length - inWindow.length;

  let open = 0;
  let overdueAcknowledgement = 0;
  let overdueResolution = 0;
  let lastReceivedAt: Date | null = null;
  for (const row of inWindow) {
    if (!lastReceivedAt || row.receivedAt.getTime() > lastReceivedAt.getTime()) lastReceivedAt = row.receivedAt;
    const acknowledgeBy = row.receivedAt.getTime() + ACKNOWLEDGEMENT_SLA_MS;
    if (!row.acknowledgedAt) {
      if (now.getTime() > acknowledgeBy) overdueAcknowledgement += 1;
    } else if (row.acknowledgedAt.getTime() > acknowledgeBy) {
      overdueAcknowledgement += 1;
    }
    if (!row.resolvedAt) {
      open += 1;
      if (now.getTime() > oneMonthAfter(row.receivedAt).getTime()) overdueResolution += 1;
    } else if (row.resolvedAt.getTime() > oneMonthAfter(row.receivedAt).getTime()) {
      overdueResolution += 1;
    }
  }
  return {
    total: inWindow.length,
    open,
    overdueAcknowledgement,
    overdueResolution,
    lastReceivedAt,
    excludedByWindow,
  };
}

/**
 * Maps a stored shop to the pure `StoreFacts` the rule engine reads.
 *
 * `extra` carries the data that lives in other tables: the latest self-audit
 * record and the complaint register. Both used to be blanked by callers, which is
 * how the store checks lost their evidence.
 */
export function toStoreFacts(
  shop: ShopRecord,
  detected: BlockStatuses | null,
  extra: {
    lastAuditAt?: Date | null;
    complaints?: ComplaintRow[];
    now?: Date;
    /** R10's complaint-evidence window, in months. Defaults to the domain constant. */
    evidenceWindowMonths?: number;
  } = {},
): StoreFacts {
  const blockStatus = (
    detectedStatus: "declarations" | "grievance" | "priorPrice",
    confirmed: boolean,
  ): StoreFacts["blocks"]["grievance"] => {
    if (detected?.[detectedStatus] === "detected") return "detected";
    if (confirmed) return "confirmed_manual";
    return detected?.[detectedStatus] ?? "unknown";
  };

  return {
    shopDomain: shop.shopDomain,
    consumerCare: {
      storeName: shop.storeName,
      address: shop.consumerCareAddress,
      phone: shop.consumerCarePhone,
      email: shop.consumerCareEmail,
    },
    platformCustomerCareUrl: shop.platformCustomerCareUrl,
    grievanceOfficer: {
      name: shop.grievanceName,
      designation: shop.grievanceDesignation,
      email: shop.grievanceEmail,
      phone: shop.grievancePhone,
    },
    policies: {
      returnPolicy: { url: shop.returnPolicyUrl, text: shop.returnPolicyText },
      refundPolicy: { url: shop.refundPolicyUrl, text: shop.refundPolicyText },
      exchangePolicy: { url: shop.exchangePolicyUrl, text: shop.exchangePolicyText },
      warrantyPolicy: { url: shop.warrantyPolicyUrl, text: shop.warrantyPolicyText },
      deliveryTerms: { url: shop.deliveryTermsUrl, text: shop.deliveryTermsText },
      returnShippingCost: { url: shop.returnShippingCostUrl, text: shop.returnShippingCostText },
      paymentModes: { url: shop.paymentModesUrl, text: shop.paymentModesText },
      grievanceRedressal: { url: shop.grievanceRedressalUrl, text: shop.grievanceRedressalText },
      otherInformation: { url: shop.otherInformationUrl, text: shop.otherInformationText },
      useBeforeInfo: { url: shop.useBeforeInfoUrl, text: shop.useBeforeInfoText },
    },
    policyLinkChecks: shop.policyLinkChecks ?? {},
    blocks: {
      declarations: blockStatus("declarations", shop.confirmDeclarationsBlock),
      grievance: blockStatus("grievance", shop.confirmGrievanceBlock),
      priorPrice: blockStatus("priorPrice", shop.confirmPriorPriceBlock),
    },
    complaints: complaintEvidence(
      extra.complaints ?? [],
      extra.now ?? new Date(),
      extra.evidenceWindowMonths ?? COMPLAINT_EVIDENCE_LOOKBACK_MONTHS,
    ),
    lastAuditAt: extra.lastAuditAt ?? null,
    installDate: shop.installedAt,
    priceTrackingStart: shop.installedAt,
  };
}
