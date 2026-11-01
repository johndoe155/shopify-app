/**
 * Tiny Admin API client for the live-store scripts.
 *
 * These scripts are the parts of the release that could not be run in the build
 * environment: they need a real development store and, for most of them, a real
 * merchant. They are written so that the moment credentials exist the checks run
 * the same way every time, and record the same evidence, instead of relying on a
 * human remembering what to try.
 *
 * Required environment:
 *   SHOPIFY_SHOP          your-store.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN   an Admin API access token for that store (offline)
 *   SHOPIFY_API_VERSION   optional, defaults to the app's version (2026-10)
 */
export const API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2026-10";

export interface AdminConfig {
  shop: string;
  token: string;
  version: string;
}

export function readAdminConfig(): AdminConfig {
  const shop = process.env.SHOPIFY_SHOP?.trim();
  const token = process.env.SHOPIFY_ADMIN_TOKEN?.trim();
  if (!shop || !token) {
    throw new Error(
      "These checks need a development store. Set SHOPIFY_SHOP and SHOPIFY_ADMIN_TOKEN " +
        "(an offline Admin API token from that store's custom app or from the installed app). " +
        "Nothing here touches production data; use a development store and test products only.",
    );
  }
  return { shop, token, version: API_VERSION };
}

export interface GraphqlResult<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  /** Cost/throttle information, when the caller asked for it. */
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      actualQueryCost?: number;
      throttleStatus?: {
        maximumAvailable?: number;
        currentlyAvailable?: number;
        restoreRate?: number;
      };
    };
  };
  status: number;
}

export async function adminGraphql<T>(
  config: AdminConfig,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<GraphqlResult<T>> {
  const response = await fetch(`https://${config.shop}/admin/api/${config.version}/graphql.json`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-access-token": config.token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as Omit<GraphqlResult<T>, "status">;
  return { ...body, status: response.status };
}

export async function adminRest<T>(
  config: AdminConfig,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`https://${config.shop}/admin/api/${config.version}/${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-shopify-access-token": config.token,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

export function log(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

export function heading(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`);
}

export function record<T>(label: string, value: T): void {
  process.stdout.write(`${label}: ${JSON.stringify(value, null, 2)}\n`);
}
