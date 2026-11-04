/**
 * Install bookkeeping for the post-auth hook.
 *
 * Uninstalling does not delete the shop row (only `shop/redact` does, 48 hours
 * later): `markUninstalled` sets `isActive=false`, stamps `uninstalledAt` and
 * deletes the sessions. A reinstall therefore finds an existing row, and the old
 * hook only created a row when none existed. The shop stayed inactive, every job
 * skipped it (`shopServices` returns null for an inactive shop), the dashboard
 * kept the previous install's scan and the onboarding flag stayed set.
 *
 * Kept free of Shopify imports so it can be tested against the in-memory
 * repository.
 */
import type { Repository } from "~/db/repository";
import type { ShopRecord } from "~/db/types";

export interface RegisterInstallResult {
  shop: ShopRecord;
  /** True when an uninstalled shop came back. */
  reinstalled: boolean;
  /** True when no row existed before. */
  created: boolean;
}

/**
 * The dedupe key for a shop's first scan. It carries the install time because a
 * `QueuedJob` dedupe key is unique forever: a bare `install-scan:<shop>` key
 * meant a reinstall's scan was silently dropped as a duplicate of the first
 * install's.
 */
export function installScanKey(shop: Pick<ShopRecord, "shopDomain" | "installedAt">): string {
  return `install-scan:${shop.shopDomain}:${shop.installedAt.getTime()}`;
}

export async function registerInstall(
  repo: Repository,
  shopDomain: string,
  now: Date = new Date(),
): Promise<RegisterInstallResult> {
  const existing = await repo.getShop(shopDomain);
  if (!existing) {
    const shop = await repo.createShop(shopDomain, { plan: "free", planStatus: "NONE" });
    return { shop, reinstalled: false, created: true };
  }

  // Nothing to repair for a shop that is active and was never uninstalled. The
  // hook can run again for a live shop (a re-auth after a scope change), and that
  // must not wipe its onboarding state or plan.
  if (existing.isActive && !existing.uninstalledAt) {
    return { shop: existing, reinstalled: false, created: false };
  }

  const shop = await repo.updateShop(existing.id, {
    isActive: true,
    uninstalledAt: null,
    // Onboarding is shown again, and the welcome screen starts the first scan.
    onboardingCompletedAt: null,
    // Price tracking was not running while the app was uninstalled, so the
    // tracking start (which R11 measures the 30-day window from) restarts here
    // instead of claiming history for the gap.
    installedAt: now,
    // Shopify cancels the app subscription on uninstall; the stored plan would
    // otherwise show the previous install's paid plan until the first billing sync.
    plan: "free",
    planStatus: "NONE",
    billingInterval: null,
    subscriptionId: null,
    trialEndsAt: null,
    // Forget the previous install's scan so the dashboard cannot show it as
    // current. The rows themselves are replaced by the first scan.
    lastScanStartedAt: null,
    lastScanCompletedAt: null,
    lastScanProductCount: 0,
  });
  return { shop, reinstalled: true, created: false };
}
