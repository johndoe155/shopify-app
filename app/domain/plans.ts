/**
 * Plans and product-count limits (brief F9).
 * Free = up to 10 products, Standard = 500, Pro = 5,000, Scale = unlimited.
 * Annual billing is 10x the monthly price on paid plans.
 */

export type PlanId = "free" | "standard" | "pro" | "scale";
export type BillingInterval = "monthly" | "annual";

export interface Plan {
  id: PlanId;
  name: string;
  monthlyUsd: number;
  /** null = unlimited */
  productLimit: number | null;
  annualUsd: number;
  trialDays: number;
  features: string;
}

const make = (
  id: PlanId,
  name: string,
  monthlyUsd: number,
  productLimit: number | null,
  trialDays: number,
): Plan => ({
  id,
  name,
  monthlyUsd,
  productLimit,
  annualUsd: monthlyUsd * 10, // 10x the monthly price, per F9
  trialDays,
  features: "Everything: scan, bulk editor, theme blocks, self-audit, exports",
});

export const PLANS: readonly Plan[] = [
  make("free", "Free", 0, 10, 0),
  make("standard", "Standard", 19, 500, 7),
  make("pro", "Pro", 39, 5000, 7),
  make("scale", "Scale", 79, null, 7),
] as const;

export const PLAN_IDS = PLANS.map((p) => p.id);

export function getPlan(planId: PlanId | string | null | undefined): Plan {
  const found = PLANS.find((p) => p.id === planId);
  return found ?? PLANS[0]!;
}

export function priceFor(planId: PlanId, interval: BillingInterval): number {
  const plan = getPlan(planId);
  return interval === "annual" ? plan.annualUsd : plan.monthlyUsd;
}

/** Smallest plan whose limit covers this catalogue size. */
export function planForProductCount(productCount: number): PlanId {
  for (const plan of PLANS) {
    if (plan.productLimit === null || productCount <= plan.productLimit) return plan.id;
  }
  return "scale";
}

export interface PlanUsage {
  planId: PlanId;
  planName: string;
  limit: number | null;
  used: number;
  remaining: number | null;
  overLimit: boolean;
  percentUsed: number;
  /** How many products the plan lets the merchant edit when over the limit. */
  editableProducts: number;
  /** Plan to offer in the upgrade prompt when over the limit, null when within it. */
  upgradeTo: PlanId | null;
  /** Plain-language, non-blocking copy for the UI. */
  message: string;
}

export function usageFor(planId: PlanId | string, productCount: number): PlanUsage {
  const plan = getPlan(planId);
  const used = Math.max(0, Math.trunc(productCount));
  const overLimit = plan.productLimit !== null && used > plan.productLimit;
  const remaining = plan.productLimit === null ? null : Math.max(0, plan.productLimit - used);
  return {
    planId: plan.id,
    planName: plan.name,
    limit: plan.productLimit,
    used,
    remaining,
    overLimit,
    percentUsed:
      plan.productLimit === null
        ? 0
        : Math.min(100, Math.round((used / Math.max(1, plan.productLimit)) * 100)),
    editableProducts: plan.productLimit === null ? used : Math.min(used, plan.productLimit),
    upgradeTo: overLimit ? planForProductCount(used) : null,
    message: overLimit
      ? `Your ${plan.name} plan covers ${plan.productLimit} products. ${used} products are in this store, so scanning and editing are limited to the first ${plan.productLimit}. Nothing has been deleted.`
      : plan.productLimit === null
        ? "Your plan covers an unlimited number of products."
        : `Your ${plan.name} plan covers up to ${plan.productLimit} products (${used} in this store).`,
  };
}

/** Writes (metafields) are allowed only inside the plan's product limit. */
export function canWriteProducts(planId: PlanId | string, productCount: number): boolean {
  return !usageFor(planId, productCount).overLimit;
}

/** A scan may run over the limit but only reports on the products the plan covers. */
export function scanScope(planId: PlanId | string, productCount: number): number {
  const plan = getPlan(planId);
  return plan.productLimit === null ? productCount : Math.min(productCount, plan.productLimit);
}

export interface SubscriptionForMrr {
  planId: PlanId;
  interval: BillingInterval;
  status: "ACTIVE" | "TRIAL" | "CANCELLED" | "DECLINED" | "EXPIRED" | "FROZEN";
}

/**
 * Monthly recurring revenue, counting an annual plan as its price divided by 12.
 * Testers/cancelled/expired subscriptions do not count.
 */
export function computeMrr(subscriptions: SubscriptionForMrr[]): number {
  return subscriptions
    .filter((s) => s.status === "ACTIVE" || s.status === "TRIAL")
    .reduce((total, s) => {
      const plan = getPlan(s.planId);
      if (plan.monthlyUsd === 0) return total;
      return total + (s.interval === "annual" ? plan.annualUsd / 12 : plan.monthlyUsd);
    }, 0);
}

/** Shopify AppSubscription status -> our stored plan status. */
export function normaliseSubscriptionStatus(status: string | null | undefined): SubscriptionForMrr["status"] {
  const upper = (status ?? "").toUpperCase();
  if (upper === "ACTIVE" || upper === "TRIAL") return upper;
  if (upper === "CANCELLED" || upper === "DECLINED" || upper === "EXPIRED" || upper === "FROZEN") {
    return upper;
  }
  return "CANCELLED";
}
