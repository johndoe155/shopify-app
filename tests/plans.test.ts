import { describe, expect, it } from "vitest";
import {
  PLANS,
  canWriteProducts,
  computeMrr,
  getPlan,
  planForProductCount,
  priceFor,
  scanScope,
  usageFor,
} from "~/domain/plans";

describe("plan catalogue", () => {
  it("matches the pricing table in the brief", () => {
    expect(PLANS.map((plan) => [plan.id, plan.monthlyUsd, plan.productLimit])).toEqual([
      ["free", 0, 10],
      ["standard", 19, 500],
      ["pro", 39, 5000],
      ["scale", 79, null],
    ]);
  });

  it("prices annual plans at ten times the monthly price", () => {
    expect(priceFor("standard", "annual")).toBe(190);
    expect(priceFor("pro", "annual")).toBe(390);
    expect(priceFor("scale", "annual")).toBe(790);
    expect(priceFor("standard", "monthly")).toBe(19);
  });

  it("gives paid plans a 7-day trial and the free plan none", () => {
    expect(getPlan("free").trialDays).toBe(0);
    expect(getPlan("standard").trialDays).toBe(7);
    expect(getPlan("pro").trialDays).toBe(7);
    expect(getPlan("scale").trialDays).toBe(7);
  });

  it("falls back to the free plan for an unknown plan id", () => {
    expect(getPlan("enterprise").id).toBe("free");
  });
});

describe("limit enforcement", () => {
  it("is inside the limit at exactly the product count", () => {
    const usage = usageFor("free", 10);
    expect(usage.overLimit).toBe(false);
    expect(usage.remaining).toBe(0);
  });

  it("is over the limit one product past it", () => {
    const usage = usageFor("free", 11);
    expect(usage.overLimit).toBe(true);
    expect(usage.upgradeTo).toBe("standard");
    expect(usage.message).toContain("Nothing has been deleted");
  });

  it("never treats an unlimited plan as over the limit", () => {
    const usage = usageFor("scale", 500_000);
    expect(usage.overLimit).toBe(false);
    expect(usage.limit).toBeNull();
    expect(usage.remaining).toBeNull();
  });

  it("blocks writes when over the limit and allows them inside it", () => {
    expect(canWriteProducts("free", 10)).toBe(true);
    expect(canWriteProducts("free", 11)).toBe(false);
    expect(canWriteProducts("pro", 2000)).toBe(true);
  });

  it("scopes a scan to the plan's product count without deleting anything", () => {
    expect(scanScope("free", 240)).toBe(10);
    expect(scanScope("standard", 240)).toBe(240);
    expect(scanScope("scale", 5000)).toBe(5000);
  });

  it("picks the smallest plan that covers the catalogue", () => {
    expect(planForProductCount(10)).toBe("free");
    expect(planForProductCount(11)).toBe("standard");
    expect(planForProductCount(500)).toBe("standard");
    expect(planForProductCount(501)).toBe("pro");
    expect(planForProductCount(5001)).toBe("scale");
  });
});

describe("MRR", () => {
  it("counts annual plans as one twelfth of the annual price", () => {
    const mrr = computeMrr([
      { planId: "standard", interval: "monthly", status: "ACTIVE" },
      { planId: "pro", interval: "annual", status: "ACTIVE" },
      { planId: "scale", interval: "monthly", status: "TRIAL" },
    ]);
    expect(mrr).toBeCloseTo(19 + 390 / 12 + 79, 6);
  });

  it("ignores cancelled, declined, expired and frozen subscriptions", () => {
    const mrr = computeMrr([
      { planId: "pro", interval: "monthly", status: "CANCELLED" },
      { planId: "scale", interval: "monthly", status: "EXPIRED" },
      { planId: "standard", interval: "monthly", status: "ACTIVE" },
    ]);
    expect(mrr).toBe(19);
  });

  it("is zero for free-plan shops", () => {
    expect(computeMrr([{ planId: "free", interval: "monthly", status: "ACTIVE" }])).toBe(0);
  });
});
