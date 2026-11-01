# Security posture

Last reviewed: 31 October 2026 (second pass: SSRF and resource-exhaustion
controls added to the policy-link checker). `npm run audit:prod` is part of
`npm run release:check`, so a newly published high or critical advisory in a
production dependency fails the release gate.

## Dependency audit: 15 findings → 3

At the start of this review `npm audit` reported **15 vulnerabilities — 2
critical, 6 high, 3 moderate, 4 low** (production-only: 5 high, 3 low). All of
the high and critical findings are now resolved, and none were dismissed without
a reason.

| Finding | Severity | What was done |
| --- | --- | --- |
| `vitest` / `tinypool` / `@vitest/mocker` / `vite` / `vite-node` / `esbuild` (dev only) | 2 critical, 3 high, 2 moderate, dev-tooling | **Upgraded** `vitest` 2 → 4 (major, tested: 222 tests pass), which also lifts the bundled `vite`/`vite-node`/`tinypool` versions out of the vulnerable ranges. |
| `zod` (production dependency) | high — memory exhaustion on oversized constrained collections | **Removed.** `zod` was declared but never imported anywhere in `app/`, `tests/` or `scripts/`; the app's validation is hand-written in `app/domain/validation.ts`. Deleting an unused dependency is strictly safer than upgrading it. |
| `prisma` → `@prisma/config` → `deepmerge-ts` (production path) | high — stack exhaustion merging recursive object graphs | **Pinned via `overrides`** to `deepmerge-ts@^8`. Bumping Prisma to 7 (the only other fix) is a breaking generator/driver-adapter migration with no runtime benefit for a vulnerability that is reachable only through the CLI's config loader. Verified after the override: `prisma validate`, `prisma generate` and `prisma migrate deploy`'s schema parsing all succeed. |
| `@shopify/cli` → `esbuild` (dev only) | low — arbitrary file read from the dev server on Windows | **Pinned via a scoped `overrides` entry** (`@shopify/cli` → `esbuild@^0.28.2`), because the upstream fix only lands in a CLI major. `shopify version` and `shopify app build` were re-run after the pin. |
| `@shopify/polaris` → `@shopify/polaris-tokens` → `deepmerge` (production) | 3 low — prototype poisoning in `mergeObject()` | **Accepted, for now.** There is no non-breaking fix: the only advisory-clean version is Polaris 11, and the app is on 13. Reachability is limited to Polaris's own token merging at build time with first-party token data — no merchant or attacker input reaches `deepmerge`. Tracked below. |

## Upgraded for support, not only for vulnerabilities

- `@shopify/shopify-app-react-router` 1.2.1 → **4.0.0**, which moves the whole
  dependency tree onto `@shopify/shopify-api` 15.x. That was the *root cause* of
  the stale API version: the pinned SDK could not name a version later than
  `2025-10`, so bumping the `ApiVersion` constant alone was impossible. With the
  upgrade the app talks to **2026-10** (`shopify.app.toml`,
  `extensions/…/shopify.extension.toml` and `app/shopify.server.ts` all agree),
  and the dual-major `Session` type hack in `shopify.server.ts` is gone.
- The only code change the SDK major required was dropping the removed
  `embedded` prop from `AppProvider` (App Bridge 4 makes embedding implicit).

## Application-level security controls (unchanged, re-verified by tests)

| Control | Where | Test |
| --- | --- | --- |
| Webhook HMAC verified in constant time before the body is parsed | `app/services/webhooks.server.ts`, `app/routes/webhooks.tsx` | `tests/webhooks.test.ts` (accept, reject, tampered, missing) |
| Webhook idempotency ledger keyed by shop + topic + event id | `WebhookDelivery` table, `claimWebhookDelivery` | `tests/webhooks.test.ts` |
| Least-privilege scopes: `read_products,write_products` only, no `read_themes` | `shopify.app.toml`, `app/shopify.server.ts` | `npm run verify:live` prints granted scopes |
| Scheduled-job endpoints require `JOBS_SECRET` (header or bearer) | `app/routes/api.jobs.nightly.tsx`, `app/routes/api.jobs.tick.tsx` | manual/gate |
| No customer or order records accessed or stored (no customer/order scope is requested); `customers/data_request` and `customers/redact` acknowledge without reading the payload | `app/routes/webhooks.tsx` | `tests/webhooks.test.ts` |
| `shop/redact` deletes the shop and everything that references it, including queued jobs and sessions | `PrismaRepository.deleteShopData` | `tests/webhooks.test.ts` |
| Production refuses to start with placeholder or missing configuration | `app/config.server.ts`, `npm run check:config` | `tests/config.test.ts` |
| Merchant-supplied URLs are fetched under an SSRF guard: https only, no private/loopback/link-local/CGNAT/reserved address, the hostname is resolved and **every** address it returns is checked, each redirect hop is re-validated, at most 3 hops | `app/services/policy-links.server.ts` | `tests/policy-links.test.ts` |
| A fetched page is read through the stream and capped at 256 KB | `app/services/policy-links.server.ts` (`MAX_BODY_BYTES`) | `tests/policy-links.test.ts` |
| Preview mode (unauthenticated) cannot be enabled in production without an explicit opt-in | `app/config.server.ts` | `tests/config.test.ts` |

## Open items

1. **Polaris/deepmerge low-severity finding** (3 advisories). Revisit when
   Polaris 14 ships or when Shopify's web-component Polaris becomes viable for
   this app; the current Polaris React package is deprecated upstream.
2. **Audit results drift.** Advisories are published continuously; the gate in
   `release:check` is the durable control, not this document.
3. **No penetration test, no dependency scanning in CI, no secret scanning.**
   These need a repository with CI, which does not exist yet.
4. **Webhook replay window.** The app verifies the HMAC but does not reject
   deliveries older than a threshold; Shopify's own retry semantics make a strict
   window risky, and the idempotency ledger covers the replay case that matters.
   Revisit if the app ever acts on attacker-controlled topics.
5. **Rate limiting.** The public endpoints (`/webhooks`, `/api/jobs/*`,
   `/healthz`) have no per-IP limiter; all but `/healthz` require a signature or a
   shared secret, so this is a hosting-layer concern (put the deployment behind
   the platform's limiter).
6. **DNS rebinding in the link checker (residual, accepted).** The policy-link
   checker resolves a hostname and checks every address it returns *before*
   fetching, which is what makes a name pointed at 127.0.0.1 or
   169.254.169.254 a refusal rather than a request. Node's `fetch` does not
   expose a way to pin the connection to the address that was validated, so a
   name that resolves differently between the check and the connect — a
   short-TTL DNS rebinding answer — could still reach an address that was not
   checked. Closing that needs a custom `https` agent with a validating
   `lookup` at connect time. The exposure is a blind GET from a merchant-typed
   URL, not a data path: nothing is written and the response body is capped and
   discarded after a content check.

## Reporting a vulnerability

Until a real support address is configured (`SUPPORT_EMAIL`), there is no public
security contact. Set one before submitting the app, and add it here.
