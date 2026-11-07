import type { Config } from "@react-router/dev/config";

/**
 * React Router 7.12+ rejects an action (POST) request with `400 Bad Request` when
 * its `Origin` header does not match the host the server believes it is serving.
 * Behind Render's proxy and inside the Shopify admin iframe that check can fail
 * for every form post, so "Start the scan" never reaches the route's action.
 *
 * These are the hosts allowed to submit actions: the app's own public host and
 * the Shopify admin it is embedded in. Hosts only, no scheme. The list is baked in
 * at build time, so SHOPIFY_APP_URL is only a bonus when it is set during the build.
 */
const appHost = (() => {
  try {
    return new URL(process.env.SHOPIFY_APP_URL ?? "").host;
  } catch {
    return "";
  }
})();

export default {
  ssr: true,
  allowedActionOrigins: [
    ...new Set(["india-legal-mrp.onrender.com", appHost, "admin.shopify.com"].filter(Boolean)),
  ],
} satisfies Config;
