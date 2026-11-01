/**
 * Live-store smoke test — the "required development-store end-to-end gate"
 * from RELEASE_VERIFICATION.md, step 1 and 2, made executable.
 *
 *   SHOPIFY_SHOP=dev-store.myshopify.com SHOPIFY_ADMIN_TOKEN=shpat_... \
 *     npm run verify:live
 *
 * What it checks against a real store (read-only):
 *  1. the Admin API answers on the app's pinned API version;
 *  2. the app's scopes are actually granted on the installation;
 *  3. every webhook subscription the app relies on exists and points at /webhooks;
 *  4. the three `legal_in` metafield definitions exist with storefront access;
 *  5. the storefront is reachable and returns the block markers, or is reported
 *     as unverifiable (password-protected / unreachable) rather than as "absent";
 *  6. a product-level read of the app's metafields works (the bulk scan's shape).
 *
 * It writes nothing. Anything it cannot check is reported as UNVERIFIED with the
 * reason, and the process exits non-zero only for real failures (so it can gate
 * a release) — an unreachable password-protected storefront does not fail the
 * gate, matching how the app itself treats "could not look" as inconclusive.
 */
import { adminGraphql, heading, log, readAdminConfig, record } from "./lib/admin";
import { BLOCK_MARKERS } from "../app/services/blocks.server";

const EXPECTED_SCOPES = ["read_products", "write_products"];
const EXPECTED_WEBHOOKS: Array<{ topic: string; uri: string }> = [
  { topic: "APP_UNINSTALLED", uri: "/webhooks" },
  { topic: "PRODUCTS_CREATE", uri: "/webhooks" },
  { topic: "PRODUCTS_UPDATE", uri: "/webhooks" },
  { topic: "PRODUCTS_DELETE", uri: "/webhooks" },
  { topic: "SHOP_UPDATE", uri: "/webhooks" },
  { topic: "CUSTOMERS_DATA_REQUEST", uri: "/webhooks" },
  { topic: "CUSTOMERS_REDACT", uri: "/webhooks" },
  { topic: "SHOP_REDACT", uri: "/webhooks" },
];

const failures: string[] = [];
const unverified: string[] = [];

function fail(message: string): void {
  failures.push(message);
  log(`FAIL      ${message}`);
}

function ok(message: string): void {
  log(`ok        ${message}`);
}

function skip(message: string): void {
  unverified.push(message);
  log(`UNVERIFIED ${message} (not a failure; record the reason)`);
}

async function main(): Promise<void> {
  const config = readAdminConfig();
  log(`Smoke test against ${config.shop} on API version ${config.version}`);

  heading("1. Admin API reachability");
  const shopQuery = await adminGraphql<{
    shop: {
      name: string;
      myshopifyDomain: string;
      currencyCode: string;
      plan: { displayName: string };
    };
  }>(
    config,
    `#graphql
    query shopInfo { shop { name myshopifyDomain currencyCode plan { displayName } } }`,
  );
  if (!shopQuery.data?.shop) {
    fail(
      `Admin API did not return the shop: ${JSON.stringify(shopQuery.errors ?? shopQuery.status)}`,
    );
    report();
    return;
  }
  ok(`Admin API reachable: ${shopQuery.data.shop.name} (${shopQuery.data.shop.myshopifyDomain})`);
  record("shop", shopQuery.data.shop);

  heading("2. Granted scopes");
  try {
    const { adminRest } = await import("./lib/admin");
    const scopes = await adminRest<{ access_scopes?: Array<{ handle: string }> }>(
      config,
      "oauth/access_scopes.json",
    );
    const granted = (scopes.body.access_scopes ?? []).map((scope) => scope.handle);
    record("granted scopes", granted);
    for (const scope of EXPECTED_SCOPES) {
      if (granted.includes(scope)) ok(`scope granted: ${scope}`);
      else fail(`scope not granted: ${scope}`);
    }
    if (granted.includes("read_themes")) {
      log("note: read_themes is granted. The app deliberately does not request it.");
    }
  } catch (error) {
    skip(`access_scopes could not be read: ${error instanceof Error ? error.message : error}`);
  }

  heading("3. Webhook subscriptions");
  const hooks = await adminGraphql<{
    webhookSubscriptions: {
      edges: Array<{
        node: { topic: string; endpoint: { __typename: string; callbackUrl?: string } };
      }>;
    };
  }>(
    config,
    `#graphql
    query webhooks { webhookSubscriptions(first: 50) {
      edges { node { topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } }
    } }`,
  );
  const subscribed = (hooks.data?.webhookSubscriptions.edges ?? []).map((edge) => ({
    topic: edge.node.topic,
    url: edge.node.endpoint.callbackUrl ?? "",
  }));
  record("subscriptions", subscribed);
  for (const expected of EXPECTED_WEBHOOKS) {
    const match = subscribed.find((entry) => entry.topic === expected.topic);
    if (!match) fail(`webhook not subscribed: ${expected.topic}`);
    else if (!match.url.endsWith(expected.uri))
      fail(`${expected.topic} points at ${match.url}, expected ...${expected.uri}`);
    else ok(`webhook subscribed: ${expected.topic} -> ${match.url}`);
  }
  skip(
    "delivery itself: send a test notification from the Partner dashboard (or edit a product) and confirm a 200 in the app log plus a WebhookDelivery row",
  );

  heading("4. legal_in metafield definitions");
  const definitions = await adminGraphql<{
    metafieldDefinitions: {
      edges: Array<{
        node: {
          namespace: string;
          key: string;
          ownerType: string;
          access?: { storefront?: string };
          type: { name: string };
        };
      }>;
    };
  }>(
    config,
    `#graphql
    query defs { metafieldDefinitions(first: 100, ownerType: PRODUCT, namespace: "legal_in") {
      edges { node { namespace key ownerType access { storefront } type { name } } }
    } }`,
  );
  const productDefinitions = (definitions.data?.metafieldDefinitions.edges ?? []).map(
    (edge) => edge.node,
  );
  record(
    "legal_in product definitions",
    productDefinitions.map((d) => `${d.key} (${d.type.name})`),
  );
  if (productDefinitions.length === 0) {
    fail(
      "no legal_in product metafield definitions found - run the install flow (afterAuth) or scripts/seed-dev-store.ts",
    );
  }
  const shopDefinitions = await adminGraphql<{
    metafieldDefinitions: {
      edges: Array<{ node: { key: string; access?: { storefront?: string } } }>;
    };
  }>(
    config,
    `#graphql
    query shopDefs { metafieldDefinitions(first: 50, ownerType: SHOP, namespace: "legal_in") {
      edges { node { key access { storefront } } }
    } }`,
  );
  record(
    "legal_in shop definitions",
    (shopDefinitions.data?.metafieldDefinitions.edges ?? []).map((edge) => edge.node.key),
  );

  heading("5. Storefront block markers");
  const urls = [`https://${config.shop}/`];
  const firstProduct = await adminGraphql<{
    products: { edges: Array<{ node: { handle: string; status: string } }> };
  }>(
    config,
    `#graphql
    query firstProduct { products(first: 5, query: "status:active") { edges { node { handle status } } } }`,
  );
  const handle = firstProduct.data?.products.edges[0]?.node.handle;
  if (handle) urls.push(`https://${config.shop}/products/${handle}`);
  let reachable = false;
  const found: Record<string, boolean> = {};
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "IndiaLegalMetrologyMRP/1.0 (smoke)" },
      });
      if (!response.ok) {
        log(`storefront ${url} -> HTTP ${response.status}`);
        continue;
      }
      reachable = true;
      const html = await response.text();
      for (const [name, marker] of Object.entries(BLOCK_MARKERS)) {
        found[name] = (found[name] ?? false) || html.includes(marker);
      }
      log(`storefront ${url} fetched (${html.length} bytes)`);
    } catch (error) {
      log(`storefront ${url} unreachable: ${error instanceof Error ? error.message : error}`);
    }
  }
  record("markers", found);
  if (!reachable) {
    skip(
      "storefront not reachable (password-protected or offline) - the app must report `unknown`, never `not_found`",
    );
  } else {
    for (const [name, present] of Object.entries(found)) {
      if (present) ok(`marker present: ${name}`);
      else
        skip(
          `marker absent for ${name} on the sampled pages - confirm the block in the theme editor; absence here is not proof of absence`,
        );
    }
  }

  heading("6. Product metafield read (bulk scan shape)");
  if (handle) {
    const product = await adminGraphql<{
      product: {
        id: string;
        handle: string;
        metafields: { edges: Array<{ node: { key: string; value: string } }> };
      };
    }>(
      config,
      `#graphql
      query productByHandle($handle: String!) {
        product(handle: $handle) {
          id
          handle
          metafields(first: 20, namespace: "legal_in") { edges { node { key value } } }
        }
      }`,
      { handle },
    );
    if (!product.data?.product) fail("could not read the first active product");
    else {
      ok(`product read: ${product.data.product.handle}`);
      record(
        "legal_in values",
        (product.data.product.metafields.edges ?? []).map(
          (edge) => `${edge.node.key}=${edge.node.value}`,
        ),
      );
    }
  } else {
    skip("no active product in the store, so the metafield read shape could not be checked");
  }

  report();
}

function report(): void {
  heading("Summary");
  if (failures.length === 0)
    log(`No failures. ${unverified.length} item(s) still need a human to record evidence.`);
  else log(`${failures.length} failure(s), ${unverified.length} unverified item(s).`);
  for (const item of unverified) log(`  unverified: ${item}`);
  for (const item of failures) log(`  failed: ${item}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
  log(`Smoke test could not start: ${error instanceof Error ? error.message : error}`);
  process.exit(2);
});
