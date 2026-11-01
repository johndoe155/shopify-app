/**
 * Release gate: no placeholders may reach a production deployment.
 *
 *   npm run check:config           # report, exit 1 on any placeholder
 *   npm run check:config -- --soft # report only (never fails)
 *
 * What it checks
 *  - `shopify.app.toml`: client_id, application_url and redirect_urls.
 *  - `shopify.web.toml`: present, with a "frontend" role (and "backend" for this
 *    single-process app) and a `[commands] dev` entry. Without it `shopify app dev`
 *    cannot start the app at all, which the previous release did not check.
 *  - `.env.example`: shipped values must not look real, and every required
 *    variable must be listed.
 *  - the app source: no hard-coded placeholder strings in `app/`, which would
 *    override a valid environment variable with a fake value.
 *
 * This is deliberately separate from `npm run lint`: a developer machine keeps
 * the placeholders until `shopify app config link` has run, but a release must
 * not.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isPlaceholder, PLACEHOLDER_PATTERNS } from "../app/config.server";

const root = process.cwd();
const soft = process.argv.includes("--soft");
const problems: string[] = [];

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

// --- shopify.app.toml -------------------------------------------------------
try {
  const toml = read("shopify.app.toml");
  const checks: Array<[RegExp, string]> = [
    [/^client_id\s*=\s*"(.*)"/m, "client_id"],
    [/^application_url\s*=\s*"(.*)"/m, "application_url"],
  ];
  for (const [pattern, name] of checks) {
    const match = toml.match(pattern);
    const value = match?.[1] ?? "";
    if (!value || isPlaceholder(value) || value.includes("REPLACE_WITH")) {
      problems.push(
        `shopify.app.toml: ${name} is "${value || "(missing)"}" - run \`shopify app config link\``,
      );
    }
  }
  const redirects = toml.match(/^redirect_urls\s*=\s*\[(.*)\]/m)?.[1] ?? "";
  if (!redirects || /REPLACE_WITH/.test(redirects)) {
    problems.push("shopify.app.toml: redirect_urls still contains a placeholder host");
  }
} catch {
  problems.push("shopify.app.toml is missing");
}

// --- shopify.web.toml -------------------------------------------------------
// Shopify CLI needs at least one shopify.web.toml with the "frontend" role; this
// app serves its own webhooks and job endpoints, so it must also declare
// "backend". `[commands] dev` is the only required command.
try {
  const web = read("shopify.web.toml");
  const rolesMatch = web.match(/^roles\s*=\s*\[([^\]]*)\]/m);
  const roles = (rolesMatch?.[1] ?? "")
    .split(",")
    .map((role) => role.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  if (!roles.includes("frontend")) {
    problems.push('shopify.web.toml: roles must include "frontend" (Shopify CLI refuses to start otherwise)');
  }
  if (!roles.includes("backend")) {
    problems.push('shopify.web.toml: roles must include "backend" (this app serves /webhooks and /api/jobs/* itself)');
  }
  const devCommand = web.match(/^\s*dev\s*=\s*"([^"]*)"/m)?.[1] ?? "";
  if (!devCommand.trim()) {
    problems.push("shopify.web.toml: [commands] dev is missing; `shopify app dev` has nothing to run");
  }
  const webhooksPath = web.match(/^\s*webhooks_path\s*=\s*"([^"]*)"/m)?.[1] ?? "";
  const appToml = read("shopify.app.toml");
  const subscriptionUri = appToml.match(/^uri\s*=\s*"([^"]*)"/m)?.[1] ?? "";
  if (webhooksPath && subscriptionUri && webhooksPath !== subscriptionUri) {
    problems.push(
      `shopify.web.toml: webhooks_path "${webhooksPath}" does not match the webhook uri "${subscriptionUri}" in shopify.app.toml`,
    );
  }
} catch {
  problems.push(
    "shopify.web.toml is missing: Shopify CLI cannot start the app without it (roles + [commands] dev)",
  );
}

// --- .env.example -----------------------------------------------------------
const REQUIRED_ENV = [
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_URL",
  "DATABASE_URL",
  "JOBS_SECRET",
];
try {
  const envExample = read(".env.example");
  const declared = new Set(
    envExample
      .split("\n")
      .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
      .filter((name): name is string => Boolean(name)),
  );
  for (const name of REQUIRED_ENV) {
    if (!declared.has(name)) problems.push(`.env.example is missing ${name}`);
  }
  // Nothing in the example file should look like a working credential.
  for (const line of envExample.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (!match) continue;
    const [, name, value] = match;
    const suspicious = value && !/^(0|1|\*|)$/.test(value) && !/^\d+$/.test(value);
    if (name !== "DATABASE_URL" && suspicious && isPlaceholder(value)) {
      // Placeholders in the example are expected; listed for the report only.
      continue;
    }
  }
} catch {
  problems.push(".env.example is missing");
}

// --- source scan ------------------------------------------------------------
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir))) {
    const path = join(root, dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (["node_modules", "build", ".git", "tests", "scripts"].includes(entry)) continue;
      out.push(...walk(relative(root, path)));
    } else if (/\.(ts|tsx|liquid|js)$/.test(entry)) {
      out.push(relative(root, path));
    }
  }
  return out;
}

const wordPatterns = PLACEHOLDER_PATTERNS.filter((pattern) => !pattern.source.includes("https?"));
// app/config.server.ts defines the patterns themselves, so it is not scanned.
const SOURCE_SCAN_SKIP = new Set(["app/config.server.ts"]);

for (const file of walk("app")) {
  if (SOURCE_SCAN_SKIP.has(file)) continue;
  const source = read(file);
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    // Comment lines are explanatory, not values.
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    for (const pattern of wordPatterns) {
      if (pattern.test(line)) {
        problems.push(
          `${file}:${index + 1} contains a placeholder value: ${trimmed.slice(0, 100)}`,
        );
      }
    }
  });
}

// --- listing copy -----------------------------------------------------------
// The submission-facing text under `listing/` is pasted into the Partner
// dashboard by hand, so nothing else checks it. A stand-in address or hostname
// here becomes a real App Store listing that support mail bounces off.
function walkListing(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir))) {
    const path = join(root, dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      out.push(...walkListing(relative(root, path)));
    } else if (/\.(md|json|txt)$/.test(entry)) {
      out.push(relative(root, path));
    }
  }
  return out;
}

const LISTING_PATTERNS: Array<[RegExp, string]> = [
  [/@example\.(com|org|net)/i, "a stand-in email address"],
  [/REPLACE_WITH/i, "a REPLACE_WITH placeholder"],
  [/https:\/\/apps\.shopify\.com\/\s*["'`]/i, "the generic App Store URL instead of this app's listing"],
];

for (const file of walkListing("listing")) {
  const source = read(file);
  source.split("\n").forEach((line, index) => {
    for (const [pattern, label] of LISTING_PATTERNS) {
      if (pattern.test(line)) {
        problems.push(`${file}:${index + 1} contains ${label}: ${line.trim().slice(0, 100)}`);
      }
    }
  });
}

// --- report -----------------------------------------------------------------
if (problems.length === 0) {
  console.log("Config check: no placeholders found. Safe to deploy.");
  process.exit(0);
}

console.log(`Config check: ${problems.length} placeholder(s) still in place:`);
for (const problem of problems) console.log(`  - ${problem}`);
if (soft) {
  console.log("(--soft: exiting 0)");
  process.exit(0);
}
console.log(
  "\nThese must be resolved before release: link the real app with `shopify app config link` and set the\n" +
    "environment variables in your secret manager. Run with --soft for an informational report.",
);
process.exit(1);
