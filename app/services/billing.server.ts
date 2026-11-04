/**
 * F9 — Shopify Billing API.
 *
 * Plan definitions live in `~/domain/plans` (one source of truth for prices and
 * limits). This module converts them to the Shopify billing config, reads the
 * shop's active subscription and syncs the stored plan. It never upgrades a shop
 * on its own: a shop only moves plan after the merchant confirms a charge in Shopify.
 */
import { BillingInterval, BillingReplacementBehavior } from "@shopify/shopify-app-react-router/server";
import type { shopifyApp } from "@shopify/shopify-app-react-router/server";
import { PLANS, getPlan, normaliseSubscriptionStatus, type BillingInterval as Interval, type PlanId } from "~/domain/plans";
import type { Repository } from "~/db/repository";
import type { ShopRecord } from "~/db/types";

export const BILLING_PLAN_PREFIX = "legal_mrp";

/**
 * Whether the app asks Shopify for TEST charges.
 *
 * This used to be `NODE_ENV !== "production"`, but the Render image always runs
 * with NODE_ENV=production, so a development store was sent real-charge requests
 * that it cannot confirm. It is now its own switch:
 *
 *   BILLING_TEST_MODE=true   test charges (development stores, QA)
 *   BILLING_TEST_MODE=false  real charges
 *
 * When it is unset the old behaviour applies (test outside production, real in
 * production), so forgetting the variable can never make a live store free.
 */
export function isBillingTestMode(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.BILLING_TEST_MODE?.trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes" || raw === "on") return true;
  if (raw === "false" || raw === "0" || raw === "no" || raw === "off") return false;
  return env.NODE_ENV !== "production";
}

export function billingPlanName(planId: PlanId, interval: Interval): string {
  return `${BILLING_PLAN_PREFIX}_${planId}_${interval}`;
}

export function parseBillingPlanName(
  name: string,
): { planId: PlanId; interval: Interval } | null {
  const match = /^legal_mrp_(free|standard|pro|scale)_(monthly|annual)$/.exec(name);
  if (!match) return null;
  return { planId: match[1] as PlanId, interval: match[2] as Interval };
}

/** The exact shape `shopifyApp({ billing })` expects, taken from the SDK itself. */
export type BillingConfig = NonNullable<Parameters<typeof shopifyApp>[0]["billing"]>;

/** Shape passed to `shopifyApp({ billing })`. Free has no Shopify charge. */
export function buildBillingConfig(): BillingConfig {
  const config: BillingConfig = {};
  for (const plan of PLANS) {
    if (plan.monthlyUsd === 0) continue;
    config[billingPlanName(plan.id, "monthly")] = {
      lineItems: [
        {
          amount: plan.monthlyUsd,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
      trialDays: plan.trialDays,
      replacementBehavior: BillingReplacementBehavior.Standard,
    };
    config[billingPlanName(plan.id, "annual")] = {
      lineItems: [
        {
          amount: plan.annualUsd,
          currencyCode: "USD",
          interval: BillingInterval.Annual,
        },
      ],
      trialDays: plan.trialDays,
      replacementBehavior: BillingReplacementBehavior.Standard,
    };
  }
  return config;
}

export const ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query ActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        test
        trialDays
        currentPeriodEnd
        lineItems {
          plan {
            pricingDetails {
              ... on AppRecurringPricing {
                price { amount currencyCode }
                interval
              }
            }
          }
        }
      }
    }
  }
`;

export interface ActiveSubscription {
  id: string;
  name: string;
  status: string;
  test: boolean;
}

export async function readActiveSubscription(admin: {
  graphql: (query: string) => Promise<Response>;
}): Promise<ActiveSubscription | null> {
  const response = await admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY);
  const body = (await response.json()) as {
    data?: {
      currentAppInstallation?: {
        activeSubscriptions?: Array<{ id: string; name: string; status: string; test: boolean }>;
      };
    };
  };
  const subscriptions = body.data?.currentAppInstallation?.activeSubscriptions ?? [];
  const active = subscriptions.find((subscription) => subscription.status === "ACTIVE" || subscription.status === "TRIAL");
  return active ?? null;
}

export interface PlanSyncResult {
  shop: ShopRecord;
  changed: boolean;
  subscription: ActiveSubscription | null;
}

/**
 * Billing-status check on app load. Reads the active subscription and stores the
 * plan locally. A shop with no paid subscription is on the free plan — never
 * auto-upgraded, and never demoted to a plan whose limit would delete data.
 */
export async function syncPlanFromShopify(options: {
  shop: ShopRecord;
  repo: Repository;
  admin: { graphql: (query: string) => Promise<Response> };
}): Promise<PlanSyncResult> {
  const subscription = await readActiveSubscription(options.admin);
  if (!subscription) {
    if (options.shop.plan === "free" && options.shop.planStatus === "NONE") {
      return { shop: options.shop, changed: false, subscription: null };
    }
    const shop = await options.repo.updateShop(options.shop.id, {
      plan: "free",
      planStatus: "NONE",
      billingInterval: null,
      subscriptionId: null,
      trialEndsAt: null,
    });
    return { shop, changed: true, subscription: null };
  }

  const parsed = parseBillingPlanName(subscription.name);
  if (!parsed) {
    return { shop: options.shop, changed: false, subscription };
  }
  const status = normaliseSubscriptionStatus(subscription.status);
  const changed =
    options.shop.plan !== parsed.planId ||
    options.shop.billingInterval !== parsed.interval ||
    options.shop.planStatus !== status ||
    options.shop.subscriptionId !== subscription.id;

  if (!changed) return { shop: options.shop, changed: false, subscription };

  const shop = await options.repo.updateShop(options.shop.id, {
    plan: parsed.planId,
    billingInterval: parsed.interval,
    planStatus: status,
    subscriptionId: subscription.id,
    trialEndsAt: null,
  });
  return { shop, changed: true, subscription };
}

/** Cancelling keeps the plan until the paid period ends; the app never deletes data. */
export async function markSubscriptionCancelled(options: {
  shop: ShopRecord;
  repo: Repository;
}): Promise<ShopRecord> {
  return options.repo.updateShop(options.shop.id, { planStatus: "CANCELLED" });
}

export function planDisplay(shop: ShopRecord): {
  name: string;
  priceLabel: string;
  interval: Interval | null;
  status: string;
} {
  const plan = getPlan(shop.plan);
  const interval = shop.billingInterval;
  const priceLabel =
    plan.monthlyUsd === 0
      ? "$0"
      : interval === "annual"
        ? `$${plan.annualUsd}/yr`
        : `$${plan.monthlyUsd}/mo`;
  return { name: plan.name, priceLabel, interval, status: shop.planStatus };
}
