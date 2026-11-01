/**
 * Dummy environment for the test process.
 *
 * `app/shopify.server.ts` (and anything that imports it, e.g. the reporting
 * service) validates its configuration at import time, so it needs the Shopify
 * variables to exist even though every test uses fakes. These are inert values:
 * nothing in the suite authenticates, opens a database connection or calls
 * Shopify. Individual tests that assert on configuration still pass their own
 * environment object to `readConfig`/`assertRuntimeConfig`.
 */
const TEST_ENV: Record<string, string> = {
  NODE_ENV: "test",
  SHOPIFY_API_KEY: "test-api-key",
  SHOPIFY_API_SECRET: "test-api-secret",
  SHOPIFY_APP_URL: "https://legal-mrp.test",
  SCOPES: "read_products,write_products",
  DATABASE_URL: "postgresql://user:pass@127.0.0.1:5432/legal_mrp_test",
  JOBS_SECRET: "test-jobs-secret-value",
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  if (!process.env[key]) process.env[key] = value;
}
