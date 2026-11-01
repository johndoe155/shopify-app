#!/usr/bin/env tsx
/**
 * Internal MRR report. Annual plans count as price / 12.
 *
 *   DATABASE_URL=postgres://... npm run mrr
 *
 * With no DATABASE_URL it prints the equivalent SQL and the plan table, so the
 * number can be computed straight from the database.
 */
import "dotenv/config";
import { PLANS, computeMrr, getPlan, type BillingInterval, type PlanId } from "../app/domain/plans";

const SQL = `-- MRR, counting annual plans as price / 12 (prices in USD)
SELECT
  s.plan,
  s."billingInterval" AS interval,
  COUNT(*) AS shops,
  CASE s.plan
    WHEN 'standard' THEN 19
    WHEN 'pro' THEN 39
    WHEN 'scale' THEN 79
    ELSE 0
  END AS monthly_price,
  CASE s.plan
    WHEN 'standard' THEN 19 * 10
    WHEN 'pro' THEN 39 * 10
    WHEN 'scale' THEN 79 * 10
    ELSE 0
  END AS annual_price
FROM "Shop" s
WHERE s."isActive" = true
  AND s."planStatus" IN ('ACTIVE', 'TRIAL')
GROUP BY s.plan, s."billingInterval"
ORDER BY s.plan;

-- Total:
SELECT COALESCE(SUM(
  CASE
    WHEN s."planStatus" NOT IN ('ACTIVE', 'TRIAL') THEN 0
    WHEN s."billingInterval" = 'annual' THEN
      CASE s.plan WHEN 'standard' THEN 190 WHEN 'pro' THEN 390 WHEN 'scale' THEN 790 ELSE 0 END / 12.0
    ELSE
      CASE s.plan WHEN 'standard' THEN 19 WHEN 'pro' THEN 39 WHEN 'scale' THEN 79 ELSE 0 END
  END
), 0) AS mrr_usd
FROM "Shop" s
WHERE s."isActive" = true;`;

async function main() {
  console.log("Plans:\n");
  for (const plan of PLANS) {
    console.log(
      `  ${plan.name.padEnd(9)} $${String(plan.monthlyUsd).padStart(3)}/mo   $${
        plan.annualUsd ? `$${plan.annualUsd}/yr` : "—"
      }   products: ${plan.productLimit ?? "unlimited"}`,
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log("\nNo DATABASE_URL set. Run these queries against the app database:\n");
    console.log(SQL);
    return;
  }

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const shops = await prisma.shop.findMany({
      where: { isActive: true },
      select: { plan: true, billingInterval: true, planStatus: true, shopDomain: true },
    });
    const subscriptions = shops.map((shop) => ({
      planId: shop.plan as PlanId,
      interval: (shop.billingInterval as BillingInterval | null) ?? "monthly",
      status: shop.planStatus as "ACTIVE" | "TRIAL" | "CANCELLED" | "DECLINED" | "EXPIRED" | "FROZEN",
    }));
    const mrr = computeMrr(subscriptions);
    const paying = subscriptions.filter((subscription) => subscription.planId !== "free").length;

    console.log(`\nActive shops: ${shops.length}`);
    console.log(`Shops on a paid plan: ${paying}`);
    console.log(`MRR (annual counted as price / 12): $${mrr.toFixed(2)}`);
    console.log(`ARR at this run rate: $${(mrr * 12).toFixed(2)}\n`);

    const byPlan = new Map<PlanId, number>();
    for (const subscription of subscriptions) {
      byPlan.set(subscription.planId, (byPlan.get(subscription.planId) ?? 0) + 1);
    }
    for (const [planId, count] of byPlan) {
      console.log(`  ${getPlan(planId).name.padEnd(9)} ${count} shop(s)`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
