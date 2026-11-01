/**
 * The three Day-1 spikes from the brief, as runnable commands.
 *
 *   npm run spike -- search-discovery
 *   npm run spike -- bulk-webhooks
 *   npm run spike -- metafields-rate
 *
 * They were never run because no development store existed. Each one is now a
 * script that does the measurement and prints a result block you can paste into
 * docs/SPIKES.md, so the work is reproducible instead of folklore. Nothing here
 * writes to a production store: spike 3 writes only to products you explicitly
 * pass in `--products=`, and refuses to run without that flag.
 *
 * Required: SHOPIFY_SHOP and SHOPIFY_ADMIN_TOKEN (see scripts/lib/admin.ts),
 * plus DATABASE_URL for spike 2, which reads the app's own webhook ledger.
 */
import { adminGraphql, heading, log, readAdminConfig, record } from "./lib/admin";

const command = process.argv[2];
const flag = (name: string): string | null => {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : null;
};

/**
 * Spike 1 — can `legal_in.country_of_origin` be used as a storefront filter in
 * Search & Discovery?
 *
 * The filter UI itself lives in the Shopify admin / Search & Discovery app, so a
 * script cannot click it. What a script can do is prove the two preconditions the
 * app controls, and print the exact manual steps plus the evidence to record:
 *   a. the metafield definition has storefront read access;
 *   b. the values on products are plain country names from one list (no free
 *      text), which is what makes a filter usable at all.
 */
async function spikeSearchDiscovery(): Promise<void> {
  const config = readAdminConfig();
  heading("Spike 1 - Search & Discovery filtering on country of origin");

  const definitions = await adminGraphql<{
    metafieldDefinitions: {
      edges: Array<{
        node: { key: string; access?: { storefront?: string }; type: { name: string } };
      }>;
    };
  }>(
    config,
    `#graphql
    query defs { metafieldDefinitions(first: 20, ownerType: PRODUCT, namespace: "legal_in") {
      edges { node { key access { storefront } type { name } } }
    } }`,
  );
  const country = (definitions.data?.metafieldDefinitions.edges ?? [])
    .map((edge) => edge.node)
    .find((node) => node.key === "country_of_origin");
  record("definition", country ?? "missing");
  if (!country) log("FAIL: country_of_origin definition missing - run the install flow first");
  else if (country.access?.storefront !== "PUBLIC_READ")
    log(
      `FAIL: storefront access is ${country.access?.storefront ?? "none"}; a filter cannot read it`,
    );

  const products = await adminGraphql<{
    products: {
      edges: Array<{
        node: { handle: string; metafields: { edges: Array<{ node: { value: string } }> } };
      }>;
    };
  }>(
    config,
    `#graphql
    query countryValues { products(first: 50, query: "status:active") {
      edges { node { handle metafields(first: 2, namespace: "legal_in", keys: ["country_of_origin"]) {
        edges { node { value } } } } }
    } }`,
  );
  const values = new Map<string, number>();
  for (const edge of products.data?.products.edges ?? []) {
    const value = edge.node.metafields.edges[0]?.node.value;
    if (!value) continue;
    values.set(value, (values.get(value) ?? 0) + 1);
  }
  record("distinct country values in the first 50 active products", Object.fromEntries(values));
  if (values.size < 2) {
    log(
      "NOTE: fewer than two distinct countries - populate a few imported products before judging the filter",
    );
  }

  log(`
Manual steps (record the outcome in docs/SPIKES.md):
  1. Admin > Online Store > Search & Discovery > Filters > Add filter > Product metafields > legal_in.country_of_origin.
  2. Save, open the storefront collection page, and confirm the filter appears.
  3. Filter by two different countries and confirm the result counts change.
  4. Enable "filter on product pages" and confirm behaviour there too.
  5. Record: does it appear? does it index new values immediately? any delay?
Fallback if it does not work: the app already ships step-by-step manual
instructions on the Help page and a countryFilterConfirmed flag on the shop, so
R3 and the storefront block are unaffected.`);
}

/**
 * Spike 2 — do `products/update` webhooks fire on bulk price edits, and how late?
 *
 * The script cannot operate Shopify's bulk editor, but it can answer the
 * question the app actually cares about from the app's own data: for each price
 * change the app has seen, was it a webhook or the nightly diff, and how far
 * behind was the nightly diff? Run it after a manual bulk edit session.
 */
async function spikeBulkWebhooks(): Promise<void> {
  heading("Spike 2 - products/update reliability on bulk edits");
  if (!process.env.DATABASE_URL) {
    log("FAIL: DATABASE_URL is required to read the app's own webhook and price ledgers.");
    return;
  }
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const deliveries = await prisma.webhookDelivery.groupBy({
      by: ["topic"],
      where: { receivedAt: { gte: since } },
      _count: { _all: true },
    });
    record("webhook deliveries in the last 7 days, by topic", deliveries);

    const snapshots = await prisma.priceSnapshot.groupBy({
      by: ["source"],
      where: { observedAt: { gte: since } },
      _count: { _all: true },
    });
    record("price snapshots by source", snapshots);

    const webhookSnapshots = snapshots.find((row) => row.source === "webhook")?._count._all ?? 0;
    const nightlySnapshots =
      snapshots.find((row) => row.source === "nightly_diff")?._count._all ?? 0;
    if (webhookSnapshots === 0 && nightlySnapshots > 0) {
      log(
        "FAIL: price changes are only being picked up by the nightly diff. Either the webhook subscription is missing or bulk edits do not fire products/update.",
      );
    } else if (webhookSnapshots > 0) {
      log(
        `ok: ${webhookSnapshots} price change(s) arrived by webhook (nightly diff: ${nightlySnapshots}).`,
      );
    }
    log(`
Procedure for a controlled run (do this on a dev store):
  1. Note a set of variant prices and the current time.
  2. Change 20+ prices in Shopify's bulk editor (not the API).
  3. Wait 10 minutes, then re-run this command and compare the counts.
  4. Record: how many products changed, how many webhooks arrived, max delay,
     duplicates, and whether a manual rescan was needed.
The nightly diff is the backstop either way; this spike measures how much it has
to repair.`);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Spike 3 — do batches of 25 `metafieldsSet` stay inside the rate limit on a
 * couple of thousand products?
 *
 * This one can be run for real from a script. It writes to the products named in
 * `--products=` (comma-separated GIDs) and reports GraphQL cost, throttle status,
 * latency and any userErrors, batch by batch.
 */
async function spikeMetafieldsRate(): Promise<void> {
  const config = readAdminConfig();
  heading("Spike 3 - metafieldsSet batch size and rate limits");
  const productIds = (flag("products") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (productIds.length === 0) {
    log(
      "Refusing to run: pass --products=gid://shopify/Product/1,gid://shopify/Product/2,... (test products only). " +
        "The script writes a throwaway metafield to each product to measure cost, and deletes it afterwards.",
    );
    return;
  }
  const batchSize = Number(flag("batch") ?? 25);
  log(`Using ${productIds.length} product(s), batches of ${batchSize}. API ${config.version}.`);

  const results: Array<{
    batch: number;
    ms: number;
    cost?: number;
    available?: number;
    errors: number;
  }> = [];
  for (let index = 0; index < productIds.length; index += batchSize) {
    const batch = productIds.slice(index, index + batchSize);
    const metafields = batch.map((ownerId) => ({
      ownerId,
      namespace: "legal_in_spike",
      key: "rate_probe",
      type: "single_line_text_field",
      value: new Date().toISOString(),
    }));
    const started = Date.now();
    const response = await adminGraphql<{
      metafieldsSet: { metafields: Array<{ id: string }>; userErrors: Array<{ message: string }> };
    }>(
      config,
      `#graphql
      mutation setMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message }
        }
      }`,
      { metafields },
    );
    const ms = Date.now() - started;
    const cost = response.extensions?.cost;
    results.push({
      batch: index / batchSize + 1,
      ms,
      cost: cost?.actualQueryCost ?? cost?.requestedQueryCost,
      available: cost?.throttleStatus?.currentlyAvailable,
      errors: response.errors?.length ?? response.data?.metafieldsSet.userErrors.length ?? 0,
    });
    log(
      `batch ${index / batchSize + 1}: ${batch.length} fields in ${ms}ms, cost ${cost?.actualQueryCost ?? "?"} , ` +
        `available ${cost?.throttleStatus?.currentlyAvailable ?? "?"}, errors ${response.errors?.length ?? 0}`,
    );
    for (const error of response.errors ?? []) log(`  graphql error: ${error.message}`);

    // Clean up the probe so the run leaves no trace on the test products.
    await adminGraphql(
      config,
      `#graphql
      mutation deleteProbe($metafields: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $metafields) { deletedMetafields { key } } }`,
      {
        metafields: batch.map((ownerId) => ({
          ownerId,
          namespace: "legal_in_spike",
          key: "rate_probe",
        })),
      },
    );
  }

  const slowest = results.reduce<{ batch: number; ms: number } | null>(
    (worst, row) => (worst === null || row.ms > worst.ms ? row : worst),
    null,
  );
  const totalErrors = results.reduce((sum, row) => sum + row.errors, 0);
  record("summary", {
    batches: results.length,
    slowestBatchMs: slowest?.ms,
    totalErrors,
    extrapolatedMinutesFor2000Products: slowest
      ? Number((((2000 / batchSize) * slowest.ms) / 60000).toFixed(2))
      : null,
  });
  log(`
Now run the same thing at batches of 1 and 50 to compare cost per field, and once
with --batch=25 against a store that is already throttled (or with a tight
concurrency load) to see the retry path. Record: cost per field, latency, whether
throttling produced partial writes, and whether the app's retry (2 concurrent,
exponential backoff) recovered without a merchant-visible failure.`);
}

const commands: Record<string, () => Promise<void>> = {
  "search-discovery": spikeSearchDiscovery,
  "bulk-webhooks": spikeBulkWebhooks,
  "metafields-rate": spikeMetafieldsRate,
};

async function main(): Promise<void> {
  if (!command || !(command in commands)) {
    log("Usage: npm run spike -- <search-discovery|bulk-webhooks|metafields-rate>");
    process.exit(1);
  }
  await commands[command]!();
}

void main().catch((error: unknown) => {
  log(`Spike could not run: ${error instanceof Error ? error.message : error}`);
  process.exit(2);
});
