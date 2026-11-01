/**
 * Runtime configuration, in one place.
 *
 * Why this module exists: the app shipped with hard-coded placeholders — a
 * `support@example.com` address, a review button pointing at the generic
 * App Store home page, and `REPLACE_WITH_…` values in `shopify.app.toml`.
 * None of those were checked at runtime, so a misconfigured deployment could go
 * live and quietly show merchants a dead support address or a useless review
 * link.
 *
 * Now:
 *  - every value that is deployment-specific is read here, with one source of
 *    truth (environment variable -> optional safe default -> empty);
 *  - `PLACEHOLDERS` recognises the shapes a forgotten value takes;
 *  - `configProblems()` lists what is missing, and `assertRuntimeConfig()`
 *    refuses to serve *production* traffic while a placeholder is still in
 *    place. Development and demo mode only warn, so the preview app still runs;
 *  - anything that is genuinely optional (support address, review link) is
 *    hidden in the UI when it has not been configured, instead of rendering a
 *    fake value.
 */

/** Values shipped in the repo that must never reach production. */
export const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /REPLACE_WITH/i,
  /\breplace-with\b/i,
  /example\.com$/i,
  /^https?:\/\/apps\.shopify\.com\/?$/i,
  /^changeme$/i,
  /^todo$/i,
];

export function isPlaceholder(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export type AppConfig = {
  environment: "production" | "development" | "test";
  demoMode: boolean;
  /** Public URL of this app, or "" when not configured. */
  appUrl: string;
  apiKey: string;
  apiSecret: string;
  /** Shown on Help and in exports; "" means "not configured". */
  supportEmail: string;
  /**
   * The merchant-facing review link for *this* app. Left empty until the app id
   * is known, because the generic App Store home page is not a review link.
   */
  reviewUrl: string;
  /** Shared secret for /api/jobs/* endpoints. */
  jobsSecret: string;
  /**
   * Opt-in that makes DEMO_MODE safe to run with NODE_ENV=production (which is
   * what `npm run demo` does). A real deployment will not have it, so a preview
   * store can never be served there by accident.
   */
  demoModeSecret: string;
  databaseUrl: string;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv =
    env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development";
  const clean = (value: string | undefined): string => {
    const trimmed = (value ?? "").trim();
    return isPlaceholder(trimmed) ? "" : trimmed;
  };
  return {
    environment: nodeEnv,
    demoMode: env.DEMO_MODE === "1",
    appUrl: clean(env.SHOPIFY_APP_URL),
    apiKey: clean(env.SHOPIFY_API_KEY),
    apiSecret: clean(env.SHOPIFY_API_SECRET),
    supportEmail: clean(env.SUPPORT_EMAIL),
    reviewUrl: clean(env.SHOPIFY_APP_REVIEW_URL),
    jobsSecret: clean(env.JOBS_SECRET),
    demoModeSecret: clean(env.DEMO_MODE_SECRET),
    databaseUrl: clean(env.DATABASE_URL),
  };
}

/** Everything a production deployment needs, with a human-readable reason. */
export function configProblems(config: AppConfig = readConfig()): string[] {
  if (config.demoMode) return [];
  const problems: string[] = [];
  const required: Array<[keyof AppConfig, string]> = [
    ["apiKey", "SHOPIFY_API_KEY is missing or still a placeholder"],
    ["apiSecret", "SHOPIFY_API_SECRET is missing or still a placeholder"],
    ["appUrl", "SHOPIFY_APP_URL is missing or still a placeholder"],
    ["jobsSecret", "JOBS_SECRET is missing or still a placeholder"],
    ["databaseUrl", "DATABASE_URL is missing or still a placeholder"],
  ];
  for (const [key, message] of required) {
    if (!config[key]) problems.push(message);
  }
  if (config.appUrl && !/^https:\/\//.test(config.appUrl)) {
    problems.push("SHOPIFY_APP_URL must be an https URL");
  }
  if (config.supportEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.supportEmail)) {
    problems.push("SUPPORT_EMAIL is not a valid address");
  }
  return problems;
}

/**
 * Optional values that are missing but not fatal. Shown in the admin UI as a
 * setup reminder rather than a fake value.
 */
export function optionalGaps(config: AppConfig = readConfig()): string[] {
  const gaps: string[] = [];
  if (!config.supportEmail) gaps.push("SUPPORT_EMAIL (the support address on the Help page)");
  if (!config.reviewUrl)
    gaps.push("SHOPIFY_APP_REVIEW_URL (the review button is hidden until this is set)");
  return gaps;
}

let asserted = false;

/**
 * Fails fast in production instead of serving traffic with placeholders.
 *
 * Called from the root loader, so a misconfigured deployment shows a clear 500
 * with the exact variables to set rather than half-working.
 */
export function assertRuntimeConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (asserted) return;
  const config = readConfig(env);
  // Demo mode is a local preview: it serves seeded data with no Shopify session
  // and no authentication. Running it with NODE_ENV=production is legitimate for
  // `npm run demo`, so it requires an explicit opt-in (DEMO_MODE_SECRET) that a
  // real deployment does not have.
  if (config.demoMode && config.environment === "production" && !config.demoModeSecret) {
    throw new Error(
      "DEMO_MODE=1 with NODE_ENV=production requires DEMO_MODE_SECRET (the preview app is unauthenticated). " +
        "Unset DEMO_MODE to serve the real app, or run `npm run demo`, which sets both.",
    );
  }
  const problems = configProblems(config);
  // Only latch success: a failed check must fail every request, not just the
  // first one, so a misconfigured process cannot start serving on the next hit.
  if (problems.length === 0) {
    asserted = true;
    const gaps = optionalGaps(config);
    if (gaps.length > 0) {
      console.warn(`[config] optional values not set: ${gaps.join("; ")}`);
    }
    return;
  }
  if (config.environment !== "production") {
    console.warn(`[config] not production-ready: ${problems.join("; ")}`);
    return;
  }
  throw new Error(`Missing or placeholder configuration: ${problems.join("; ")}`);
}

/** Test seam. */
export function resetConfigAssertionForTests(): void {
  asserted = false;
}
