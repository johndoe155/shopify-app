/**
 * A reinstall must bring the shop back to life. `markUninstalled` leaves the row
 * in place, and the post-auth hook used to create a row only when none existed,
 * so the shop stayed inactive, every job skipped it, the dashboard kept the old
 * scan and the welcome screen never came back.
 */
import { describe, expect, it } from "vitest";
import { MemoryRepository } from "~/db/memory.server";
import { installScanKey, registerInstall } from "~/services/install.server";
import { makeShop } from "./helpers";

const DOMAIN = "demo.myshopify.com";

describe("registerInstall", () => {
  it("creates the shop on a first install", async () => {
    const repo = new MemoryRepository();
    const result = await registerInstall(repo, DOMAIN, new Date("2026-11-03T10:00:00.000Z"));
    expect(result.created).toBe(true);
    expect(result.reinstalled).toBe(false);
    expect(result.shop.isActive).toBe(true);
    expect(result.shop.onboardingCompletedAt).toBeNull();
  });

  it("reactivates an uninstalled shop and resets onboarding, plan and scan state", async () => {
    const repo = new MemoryRepository();
    await repo.createShop(
      DOMAIN,
      makeShop({
        plan: "standard",
        planStatus: "ACTIVE",
        billingInterval: "monthly",
        subscriptionId: "gid://shopify/AppSubscription/1",
        lastScanProductCount: 371,
        lastScanCompletedAt: new Date("2026-11-03T08:00:00.000Z"),
      }),
    );
    await repo.markUninstalled(DOMAIN);
    expect((await repo.getShop(DOMAIN))?.isActive).toBe(false);

    const now = new Date("2026-11-04T07:00:00.000Z");
    const result = await registerInstall(repo, DOMAIN, now);

    expect(result.reinstalled).toBe(true);
    expect(result.shop.isActive).toBe(true);
    expect(result.shop.uninstalledAt).toBeNull();
    expect(result.shop.onboardingCompletedAt).toBeNull();
    expect(result.shop.installedAt).toEqual(now);
    expect(result.shop.plan).toBe("free");
    expect(result.shop.planStatus).toBe("NONE");
    expect(result.shop.subscriptionId).toBeNull();
    expect(result.shop.lastScanProductCount).toBe(0);
    expect(result.shop.lastScanCompletedAt).toBeNull();
    // The merchant's settings survive an uninstall.
    expect(result.shop.grievanceName).toBe("Priya Menon");
  });

  it("leaves a live shop alone when the hook runs again", async () => {
    const repo = new MemoryRepository();
    const created = await repo.createShop(DOMAIN, makeShop());
    const result = await registerInstall(repo, DOMAIN, new Date("2026-11-04T07:00:00.000Z"));
    expect(result.reinstalled).toBe(false);
    expect(result.shop.onboardingCompletedAt).toEqual(created.onboardingCompletedAt);
    expect(result.shop.plan).toBe("pro");
  });

  it("gives a reinstall a different first-scan key from the install before it", async () => {
    const repo = new MemoryRepository();
    const first = await registerInstall(repo, DOMAIN, new Date("2026-11-03T10:00:00.000Z"));
    await repo.markUninstalled(DOMAIN);
    const second = await registerInstall(repo, DOMAIN, new Date("2026-11-04T07:00:00.000Z"));
    expect(installScanKey(second.shop)).not.toBe(installScanKey(first.shop));
  });
});
