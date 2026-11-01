/**
 * Shopify app configuration: OAuth, session storage, billing plans, webhooks and
 * the post-auth hook that creates the shop record, the `legal_in` metafield
 * definitions and the first automatic scan (F1).
 */
import "@shopify/shopify-app-react-router/adapters/node";
import { ApiVersion, AppDistribution, DeliveryMethod, shopifyApp } from "@shopify/shopify-app-react-router/server";
import type { Session } from "@shopify/shopify-app-react-router/server";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { buildBillingConfig } from "~/services/billing.server";
import { ensureMetafieldDefinitions } from "~/services/metafield-definitions.server";

export const APP_SCOPES = ["read_products", "write_products"];

/** The API version the app talks to. Defaults to the current stable release. */
export function resolveApiVersion(raw = process.env.SHOPIFY_API_VERSION): ApiVersion {
  if (!raw) return ApiVersion.October26;
  const match = (Object.values(ApiVersion) as string[]).includes(raw);
  if (!match) {
    console.warn(
      `[shopify] SHOPIFY_API_VERSION="${raw}" is not a version this SDK knows; falling back to ${ApiVersion.October26}.`,
    );
    return ApiVersion.October26;
  }
  return raw as ApiVersion;
}

/**
 * Session storage is resolved lazily so that DEMO_MODE (and the test suite) can
 * import this module without a DATABASE_URL.
 *
 * There used to be a structural-interface cast here: the app SDK pulled
 * @shopify/shopify-api 13.x while the Prisma session adapter pulled 15.x, so the
 * two `Session` types were nominally incompatible. Upgrading the app SDK to 4.x
 * put the whole tree on 15.x (checked with `npm ls @shopify/shopify-api`), so
 * the adapter is now used directly and the cast is gone.
 */
class LazyPrismaSessionStorage implements SessionStorage {
  private inner: SessionStorage | null = null;

  private async resolve(): Promise<SessionStorage> {
    if (!this.inner) {
      const [{ PrismaSessionStorage }, { prisma }] = await Promise.all([
        import("@shopify/shopify-app-session-storage-prisma"),
        import("~/db/prisma.server"),
      ]);
      this.inner = new PrismaSessionStorage(prisma);
    }
    return this.inner;
  }

  async storeSession(session: Session): Promise<boolean> {
    return (await this.resolve()).storeSession(session);
  }

  async loadSession(id: string): Promise<Session | undefined> {
    return (await this.resolve()).loadSession(id);
  }

  async deleteSession(id: string): Promise<boolean> {
    return (await this.resolve()).deleteSession(id);
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    return (await this.resolve()).deleteSessions(ids);
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    return (await this.resolve()).findSessionsByShop(shop);
  }
}


const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET ?? "",
  // Bumped from 2025-10 (which was a year old and inside its support window's
  // final quarter). Shopify supports each version for 12 months; 2026-10 is the
  // current stable release. `SHOPIFY_API_VERSION` allows an emergency pin to a
  // version Shopify has already validated for a store without a code release.
  apiVersion: resolveApiVersion(),
  scopes: APP_SCOPES,
  appUrl: process.env.SHOPIFY_APP_URL ?? "",
  authPathPrefix: "/auth",
  sessionStorage: new LazyPrismaSessionStorage(),
  distribution: AppDistribution.AppStore,
  billing: buildBillingConfig(),
  webhooks: {
    APP_UNINSTALLED: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    PRODUCTS_CREATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    PRODUCTS_UPDATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    PRODUCTS_DELETE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    SHOP_UPDATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    CUSTOMERS_DATA_REQUEST: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    CUSTOMERS_REDACT: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    SHOP_REDACT: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
  },
  hooks: {
    afterAuth: async ({ session, admin }) => {
      const [{ PrismaRepository, prisma }, { enqueueJob }] = await Promise.all([
        import("~/db/prisma.server"),
        import("~/jobs/worker.server"),
      ]);
      const repo = new PrismaRepository(prisma);
      const existing = await repo.getShop(session.shop);
      if (!existing) {
        await repo.createShop(session.shop, { plan: "free", planStatus: "NONE" });
      }

      try {
        await ensureMetafieldDefinitions(admin);
      } catch (error) {
        console.error(
          `[install] could not create metafield definitions for ${session.shop}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }

      // F1: the first scan starts automatically, off the request path. The job
      // is persisted before this hook returns, so a crash straight after install
      // still leaves the scan queued rather than silently dropped.
      await enqueueJob("nightly-scan", { shopDomain: session.shop }, `install-scan:${session.shop}`);
    },
  },
});

export default shopify;
export const authenticate = shopify.authenticate;
export const login = shopify.login;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
