/**
 * Request context: one place that decides between the Shopify app and DEMO_MODE.
 *
 * Route loaders/actions call `requireAppContext(request)` and get a repository,
 * the shop record, a catalogue source and a metafield writer. Nothing else in
 * the route code knows which mode it is running in.
 */

import shopify, { authenticate, login } from "~/shopify.server";
import type { Repository } from "~/db/repository";
import type { ShopRecord } from "~/db/types";
import type { StoreFacts } from "~/domain/types";
import { toStoreFacts } from "~/db/types";
import type { CatalogSource, MetafieldWriter } from "~/services/ports";
import { ShopifyMetafieldWriter } from "~/services/metafields.server";
import { ShopifyCatalogSource } from "~/services/catalog.server";
import { syncPlanFromShopify } from "~/services/billing.server";
import { DEMO_SHOP_DOMAIN, getDemoState } from "~/demo/demo.server";

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "1";
}

export interface BillingClient {
  request: (options: { plan: string; isTest?: boolean; returnUrl: string }) => Promise<Response>;
}

export type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export interface AppContext {
  mode: "shopify" | "demo";
  repo: Repository;
  shop: ShopRecord;
  catalog: CatalogSource;
  writer: MetafieldWriter;
  admin: AdminClient | null;
  billing: BillingClient | null;
  shopDomain: string;
}

export async function requireAppContext(request: Request): Promise<AppContext> {
  if (isDemoMode()) {
    const state = await getDemoState();
    const shop = (await state.repo.getShop(DEMO_SHOP_DOMAIN)) ?? state.shop;
    return {
      mode: "demo",
      repo: state.repo,
      shop,
      catalog: state.catalog,
      writer: state.writer,
      admin: null,
      billing: null,
      shopDomain: DEMO_SHOP_DOMAIN,
    };
  }

  const { admin, session, billing } = await authenticate.admin(request);
  // Make sure the durable worker is running in this process. Idempotent and
  // cheap (a guard plus one setInterval), so it costs nothing per request.
  const [{ startJobWorker }, { PrismaRepository, prisma }] = await Promise.all([
    import("~/jobs/worker.server"),
    import("~/db/prisma.server"),
  ]);
  startJobWorker();
  const repo = new PrismaRepository(prisma);

  let shop = await repo.getShop(session.shop);
  if (!shop) {
    try {
      shop = await repo.createShop(session.shop, { plan: "free", planStatus: "NONE" });
    } catch (error) {
      shop = await repo.getShop(session.shop);
      if (!shop) throw error;
    }
  }

  // Billing status check on app load (F9). Never upgrades a shop automatically.
  try {
    const synced = await syncPlanFromShopify({ shop, repo, admin });
    shop = synced.shop;
  } catch (error) {
    console.error(
      `[billing] could not read the subscription for ${session.shop}: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }

  return {
    mode: "shopify",
    repo,
    shop,
    catalog: new ShopifyCatalogSource(admin),
    writer: new ShopifyMetafieldWriter(admin),
    admin,
    billing: billing as unknown as BillingClient | null,
    shopDomain: session.shop,
  };
}

/**
 * Store facts including the latest audit record and the complaint register, ready
 * for the rule engine. R10 reads the register because displaying a grievance
 * block is not evidence that the 48-hour and one-month duties are met.
 */
export async function loadStoreFacts(ctx: AppContext, now: Date = new Date()): Promise<StoreFacts> {
  const [audit, complaints] = await Promise.all([
    ctx.repo.latestAuditRecord(ctx.shop.id),
    ctx.repo.listComplaints(ctx.shop.id),
  ]);
  return toStoreFacts(ctx.shop, ctx.shop.blocksDetected, {
    lastAuditAt: audit?.completedAt ?? null,
    complaints,
    now,
  });
}

export { shopify, authenticate, login };

