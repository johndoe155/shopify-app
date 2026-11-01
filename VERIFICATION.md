# Verification report

> **Superseded in part.** See `RELEASE_VERIFICATION.md` for the current status of
> every open item, the *Review fixes, 30 October 2026* section below for the seven
> defects that pass repaired, and the *Review fixes, 31 October 2026* section for
> the compliance audit's four FAIL items, five pass-with-defect items and the
> smaller defects found while fixing them. Re-verified against the current tree:
> the suite is **456 tests in 28 files**, all passing.

Everything below was run in this workspace on 30 October 2026. Where a check
could not be run, it says so plainly instead of being marked as passing.

## Reproduce

```bash
npm install
npx prisma generate
npx tsc --noEmit            # clean
npm run lint                # ESLint --max-warnings=0 (clean), then the forbidden-word scan (77 files)
npx vitest run              # 28 files, 456 tests passing
npx react-router build      # succeeds

# demo instance (seeded shop, no Shopify store needed)
PORT=3200 DEMO_MODE=1 SHOPIFY_API_KEY=k SHOPIFY_API_SECRET=s \
  SHOPIFY_APP_URL=http://localhost:3200 node_modules/.bin/react-router-serve build/server/index.js
DEMO_URL=http://localhost:3200 npx tsx scripts/screenshots.ts   # /listing/screenshots
```

Demo instance state on 30 October 2026: 248 seeded products, 87 passing (35%),
Pro plan showing 248 / 5000 product usage, last scan 30 Oct 2026 06:57 UTC. The
demo runs the real scan service and the real prior-price publisher on first
request, so the numbers on screen come from the production code path, not from
fixtures. (The 31 October pass changed what the rules measure and seeded one
recorded price announcement, so a demo started now reports different numbers;
re-capture the demo state before quoting it.)

## Review fixes, 30 October 2026 — the seven defects

Each row is a defect the review reported, the root cause, the fix, and the test
that now fails if the defect returns. Nothing in this table is marked fixed on
the strength of reading the code: every "evidence" cell names a test that was
watched failing before the fix or asserts the exact reported scenario.

| # | Reported defect | Root cause | Fix | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Prior price disappears after 30 days of stable pricing (works on day 20 and 29, fails on day 31 and 45) | The window held only snapshots *strictly inside* `effectiveAt − 30d`; on a product whose price had not moved for a month the previous price had left the window, so there were no candidates | `priceInEffectAt` reconstructs the price in effect at `max(effectiveAt − 30d, trackingStart)` and that value joins the snapshot candidates; the minimum still excludes the current price and can never equal it (`app/domain/prior-price.ts`) | `tests/prior-price-publish.test.ts` — drops on day 20, 29, 31 and 45 through the real `recordPriceSnapshots` → `publishPriorPrices` → `runScan` path, asserting R11 `pass` and a stored `prior_price` of 300 with `show: true`, for all four days |
| 2 | Block C shows a stale prior price; a priced-up product keeps its old prior price | `publishPriorPrices` skipped any product that was not currently discounted and never deleted a metafield it had written earlier; the Liquid trusted the stored `show` flag | The publisher classifies every product as publish / clear / skip; an ended sale deletes the metafield (an explicitly empty payload if the delete fails) and returns `{published, cleared, skipped, failed}`. Payloads are `schema: 2` and carry their source prices; the block shows only when the stored price still equals the live price and the live compare-at is above it, hiding when the sale has ended — matching rule in `assets/prior-price.js` | `tests/prior-price-publish.test.ts` (ended sale → metafield deleted, R11 → `not_applicable`, already-cleared skipped, never-discounted writes nothing) and `tests/storefront-blocks.test.ts` (price edited since publish, stale `show:true` with a blank compare-at, compare-at == price) |
| 3 | Every `products/update` starts a full-catalogue bulk operation; one bulk op per shop; a 200-product bulk edit produces retries and failures | Nothing coordinated the bulk API: each webhook handler started its own operation, so a bulk edit raced N operations against a per-shop limit of one, and the losers errored and retried | `BulkOperationCoordinator` is a single-flight guard: concurrent callers share the running operation, a waiter adopts a newer id, `isAlreadyRunningError` becomes an adopt rather than a retry, and the publish is coalesced per 60-second window so 200 deliveries produce one publish carrying 200 ids | `tests/bulk-operations.test.ts` (9 tests) and `tests/webhook-pipeline.test.ts` (200 deliveries → exactly 1 publish with 200 productIds, claim order snapshots → rescans → publish, re-delivery idempotent) |
| 4 | The bulk editor runs a full bulk operation on every load, filter, paginate and save — no cross-request cache | The route called `getCatalogue()` per request with no snapshot, so navigation billed a bulk op each time | `app/services/catalogue-access.server.ts`: per-shop snapshot with a TTL (`CATALOGUE_CACHE_MS`, default 5 min), one in-flight read shared by concurrent requests, and `patchCatalogueProduct` so a save updates the snapshot instead of invalidating it | `tests/catalogue-cache.test.ts` (6 tests, counting source reads): 8 page loads → 1 read, 10 concurrent → 1 read, TTL expiry re-reads, per-shop isolation, a patch is visible without a re-read |
| 5 | `shopify.web.toml` missing | Never written; the CLI had no declared frontend/backend role and no webhook path, and no gate checked for it | File added with `roles = ["frontend","backend"]`, `webhooks_path = "/webhooks"`, `dev = "npm run dev:server"` (deliberately not `shopify app dev`, which would recurse) and `build = "npm run build"`; `scripts/check-config.ts` validates every field | `tests/web-config-gate.test.ts` (6 tests): the real config passes; a missing file, a missing role, a missing `[commands] dev` and a `webhooks_path` mismatch each exit non-zero with a message naming the field |
| 6 | A compare-at-only change can produce a prior price equal to the current price | The lowest candidate was taken without reference to the current price, and a compare-at edit re-dated the effective price while leaving an equal-priced snapshot as the only candidate | Candidates are filtered to prices strictly below the current price; compare-at changes no longer manufacture a candidate, so a compare-at-only edit publishes nothing rather than a false comparison | `tests/prior-price.test.ts` (never equals current price; compare-at-only change yields no prior price) and `tests/prior-price-publish.test.ts` |
| 7 | The in-process worker does not work on serverless | A `setInterval` started in a request handler is frozen once the response is sent, and nothing told the operator that | The worker detects its runtime and reports `queue.driver` on `/healthz`: `in-process-worker`, `external-tick` (Vercel, Lambda, Netlify, Cloudflare Pages, Deno Deploy, Azure Functions, or `JOBS_WORKER=tick`), `disabled` (`JOBS_WORKER=off`) or `none`; Cloud Run and Heroku are intentionally *not* treated as serverless; `POST /api/jobs/tick` is the documented driver there | `tests/job-runtime.test.ts` (10 tests) — driver per platform, the `JOBS_WORKER` overrides, the guarded start, and the `/healthz` payload |

**One test was flaky and is now deterministic.** `tests/webhook-pipeline.test.ts`
originally asserted that every price snapshot is claimed before any rescan, on 20
real webhook deliveries. That is not the contract the queue offers: claim order is
due time first and priority second, and `enqueueJob` stamps `runAt = new Date()` as
each row is inserted, so the three jobs one webhook writes are usually a
millisecond apart and are claimed in insertion order. The assertion therefore held
only when all 60 inserts landed inside one millisecond — it passed in the working
tree and failed in a clean extraction on the same machine.

The fix is in two parts, neither of which weakens the check:

- The test now pins `runAt` to a single instant, which is the condition it claims
  to test — a bulk edit's jobs all becoming due together. With the pin, the
  priority field alone decides the order, and the assertion is verified to bite:
  removing `a.priority - b.priority` from `MemoryRepository.claimDueJobs` makes it
  fail with `expected 'rescan-product' to be 'publish-prior-prices'`.
- Both repositories now use the row id as the final tiebreak after
  `createdAt`, because `createdAt` has millisecond resolution and the three jobs of
  one webhook normally share it. V8's sort is stable, so this is not what fixed
  the test; it removes the dependence on sort stability in the in-memory repo and
  on the planner's row order in Postgres (`orderBy: [runAt, priority, createdAt,
  id]`), where it would otherwise be genuinely undefined. The `id` ordering is the
  same in both repositories so a test cannot pass on one and fail on the other.

The suite was then run three times — twice with `--sequence.shuffle` — with 308
tests passing each time, which is the evidence that it is order-independent rather
than merely lucky.

Two behaviours were added while fixing these and are recorded as decisions rather
than quietly introduced: the nightly handler now logs a warning when the
prior-price publish reports `failed > 0` (it retries next run, but a silent night
is not reported as clean), and a forced catalogue re-read after a write starts its
own bulk operation instead of adopting the one that just completed, because a
completed operation can serve data up to seven days old. See `DECISIONS.md`
#25–#31.

## Review fixes, 31 October 2026 — the compliance audit's open defects

A compliance review of the tree above scored 24 items: four FAIL (L5, L10, L11,
L13) and five pass-with-defect (L6, L16, L18, L22, L24, plus R10/R4). Each row
below is the defect, the root cause, the fix, and the test that fails if it
returns. Where a claim could not be verified locally it says so.

| Item | Defect | Root cause | Fix | Evidence |
| --- | --- | --- | --- | --- |
| L5 (FAIL) | R3 demanded the label wording only for imported packages in the config, but failed every package without one in code | The config and the rule disagreed, so either reading is a defect | The wording is required for every covered package; an imported package's wording must additionally name the country in full (`labelNamesCountry`). Config `applicability`, `passCondition` and the known gap rewritten to match | `tests/rules.test.ts` (R3 wording, imported wording that does not name the country), `tests/scan.test.ts` (an imported product labelled "Made in India" now fails), `tests/legal-basis.test.ts` |
| L6 (PASS†) | An unmarked India-origin package was reported as `not_applicable` without saying import status had been inferred | The inference was silent, and the config claimed the package was "reported rather than silently treated as domestic" | The message states the inference and tells the merchant to set the flag; status stays `not_applicable` so a missing flag does not drop the product from the score | `tests/rules.test.ts` (R4 messages) |
| L10 (FAIL) | R8 accepted the Rule 6(2) label contact's phone and email as the platform's customer care | Two duties were satisfied by one field | `hasPlatformContact` now rests on `platformCustomerCareUrl` alone | `tests/rules.test.ts` (R8 fails with a label phone/email and no platform contact) |
| L11 (FAIL) | A link that passed once passed for ever; the check never aged out and only ran on a button | Stored checks were treated as permanent evidence; nothing re-ran them | R9 treats a check older than `policyLinkMaxAgeDays` (7) as stale → `inconclusive`; the nightly job re-checks every link. Fetching is https-only with an SSRF guard, redirect re-validation, a 3-hop cap and a 256 KB body cap; the settings save compares resolved URLs | `tests/rules.test.ts` (stale → inconclusive, fresh → pass, window from config), `tests/policy-links.test.ts` (47 tests) |
| L13 (FAIL) | Nothing could set `discount_code` or `automatic_discount`; `conditions` was hard-coded `null`; the help page said codes "are not tracked here" | A checkout-level discount moves no variant price, so the derived mechanism could never name one — and the app had answered by excluding them instead of recording them | Announcement records (mechanism, date, price the shopper pays, conditions, variant) with a `Price announcements` screen, a `price_announcement` table (model, migration, memory and Prisma repositories) and a record that wins over the derived announcement; R11 says which of the two it used | `tests/price-announcements.test.ts` (18 tests) — including a reduction only a record can show: not scanned as reduced without one, R11 `pass` with one, and the consumer price in the published payload |
| L16 (PASS†) | "Available from install + 30 days" presented a computed threshold as a fixed date | Completeness is `effectiveAt − trackingStart ≥ 30 days`, a statement about a future announcement | The tracking note and R11 describe future announcements and say prices from before install are not backfilled | `tests/prior-price.test.ts`, `tests/rules.test.ts` (R11 incomplete lookback names the tracking start and the date a complete lookback exists from) |
| R10/R4 (PASS†) | One late complaint failed R10 for ever | The register had no window | Counted over `complaintEvidenceLookbackMonths` (12, configurable); older complaints stay in the register and are reported as outside the counted window | `tests/rules.test.ts` (R10 window) |
| L18 (PASS†) | "Stores no customer personal data" in `README.md`, `webhooks.server.ts` and the schema header, contradicting the privacy policy | The stronger claim survived in three places | Reworded in all three to what is true: no customer or order scope, no customer record read; the complaint register is merchant-typed and asks for no customer details | `tests/webhooks.test.ts` (the two privacy topics store nothing), `npm run check:words` |
| L22 (PASS†) | A "Release note for whoever submits this listing" block sat inside the listing description | Instructions were written where the copy is pasted from | Moved to a "Notes for the submitter (not part of the listing)" section after every field | `npm run check:listing`, `tests/listing-gate.test.ts` |
| L24 (PASS†) | `LISTING_FACTS.md` §3 cited blogs, listed the five export conditions as "etc.", and named no evidence to keep; `pricing.md` told a developer outside India to take local advice | Secondary sources were treated as primary, and the developer's own obligations were described as someone else's problem | §3 cites the IGST Act, the IGST (Amendment) Act, 2018 and CBIC Circular No. 202/14/2023-GST, lists all five section 2(6) conditions, adds the section 13(8)(b) intermediary risk and tabulates the evidence to preserve; blogs are demoted to commentary. `pricing.md` states that Indian GST and income-tax obligations are separate from the gross prices | `npm run check:listing`; sources checked against the instruments named |
| — | Legacy `importer_details` forced `isImportedPackage = true`, and a legacy `date_type` of `none` read differently in the CSV importer and the scan | Two copies of each legacy mapping, and an inference promoted into a declaration | Both call sites share `parseLegacyImporterDetails` / `parseLegacyDateFields`; the flag is left alone | `tests/csv.test.ts` (legacy import, `date_type` `none` and blank), `tests/blocks-and-catalog.test.ts` |
| — | The Rule 13 threshold only worked in one direction: 2 kg was read as 2,000 g and the merchant was asked to declare a price "per gram" | The threshold was read from the unit as typed, not from the quantity | `standardQuantityAndUnit` applies the threshold to the quantity in whatever unit it was entered; `standardUnitCorrection` also catches a large-unit quantity below the threshold | `tests/unit-price.test.ts` (24 tests) |
| — | The prior-price block never rendered on a real store | The payload is in rupees; Liquid and the product JSON give prices in paise. The comparison matched nothing, and the tests had assumed rupees on both sides | Both the Liquid and the client script convert the stored figure to paise before comparing; fixtures now use the units Shopify returns; the note reads "before the reduction was announced" | `tests/storefront-blocks.test.ts` (17 tests, including the client script with a paise product JSON) |

**Not verified locally.** The paise/rupee fix in the storefront block is the one
item above that was found by reading the code and the Shopify units rather than by
observing a store: no dev store was available, and the previous fixture agreed
with the previous code, so the defect was invisible to the suite. It is now
covered by tests that use the units Shopify actually returns, but a theme pass is
still worth doing.

## Section 13 checklist

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Fresh install on a dev store: welcome, auto scan, dashboard within targets | **Not verified** | No Partner account or dev store was available. The code path exists (`afterAuth` in `app/shopify.server.ts` → creates shop, metafield definitions, install-day price baseline, queues the scan; `app/routes/app.welcome.tsx`). The scan half is covered by `tests/scan.test.ts` (500 products scored in ~50 ms, target 60 s). OAuth, app install and the Shopify GraphQL bulk-operation wait were never exercised against Shopify. |
| 2 | Every rule R1–R13 passes and fails correctly on seeded data | **Verified (updated 31 Oct 2026)** | `tests/rules.test.ts`, 69 tests: pass, fail and not-applicable branches for R1–R13, including price above MRP, per-variant MRP, packer/seller separation, the imported-package flag, Rule 13 unit thresholds and count descriptors, label evidence for the common name, the manufacture/best-before split, prior-price suppression, accessible policy links, complaint timings and the conditional unit sale price. |
| 3 | Bulk edit 200 products in under 5 minutes; ChangeLog has old value, new value, timestamp | **Partly verified** | Write path, batching and logging: `tests/metafields.test.ts` (batches of 25, per-row errors, only changed fields written) and `tests/scan.test.ts` ("CSV import applied through the same write path … logs each change"). "Under 5 minutes of merchant effort" is a UX claim that needs a human on a real store; it was not timed. Real `metafieldsSet` rate-limit behaviour was not observed (spike 3 unresolved, see `DECISIONS.md`). |
| 4 | CSV export → edit → re-import round trip matches on handle | **Verified** | `tests/csv.test.ts`, 13 tests: round trip, unknown handle reported per row, blank cell = unchanged, comment header, handle matching case-insensitively. Live export checked: `/exports/scan.csv` returned 56,744 bytes with the disclaimer header and one row per product. |
| 5 | Blocks A, B, C render correctly on Dawn, Horizon and Refresh without layout shift | **Still not verified on a theme; the known cause of shift was removed in code, and Block C can no longer show a stale prior price** | No theme could be installed. What changed: the prior-price block now reserves its own height (fixed minimum heights per row, note clamped to two lines, idle state hides with `visibility` so the box stays in the flow). Variant switching therefore no longer changes the block's height by construction. Block C also stopped trusting the stored `show` flag: a `schema: 2` payload is only displayed when its stored price still matches the live price and the live compare-at is still above it, and a blank live compare-at (sale ended) hides the block instead of falling back to stored values. Five new cases in `tests/storefront-blocks.test.ts` (13 tests total) assert this, and `assets/prior-price.js` applies the same rule client-side so a variant switch cannot re-show what the server hid. Layout measurement on Dawn/Horizon/Refresh is still required. |
| 6 | Simulated price drop shows the lowest price from the preceding 30 days; a short history publishes nothing | **Verified (revised 31 Oct 2026)** | `tests/prior-price.test.ts` (32 tests) and `tests/prior-price-publish.test.ts` (15 tests). The window includes **the price in effect at the window start**, so a drop on day 31 or 45 publishes the price the variant was actually selling at, and a stable price never yields a prior price equal to the current price. A drop on day 20 or 29 is **suppressed**, because the 30 days before it were not fully tracked: no figure is labelled as a prior price, R11 says so, and the block shows nothing. Ended sales clear the metafield and move R11 to `not_applicable`. |
| 7 | Self-audit saves a dated record, shows the 11-month reminder logic, never claims certification | **Verified** | `tests/self-audit.test.ts`, 12 tests (13 items, dated `AuditRecord`, reminder at 11 months, no certificate language, review request only at first 100%). Seeded record dated 14 Nov 2025 renders with "This is a record of the answers you gave … It is not a certificate and it does not establish compliance" (screenshot 05, `/exports/audit.pdf`). |
| 8 | CSV and PDF exports contain the required disclaimers | **Verified** | `tests/exports.test.ts`, 8 tests. Live files: `/exports/scan.csv` starts with `# This tool checks listing data against a published checklist. It is not legal advice.`; `/exports/scan-summary.pdf` (6,547 bytes, 2 pages) and `/exports/audit.pdf` (2,986 bytes, 1 page) are valid PDF 1.4 documents containing the same sentence in their content streams. |
| 9 | Billing: trial, plan limits, upgrade prompt, no auto-upgrade, annual at 10× monthly | **Verified in code and tests, not against Shopify** | `tests/plans.test.ts`, 13 tests: 7-day trial, $0/$19/$39/$79, annual = 10× monthly, product-count gating, over-limit = writes paused and nothing deleted, no automatic upgrade. `scripts/mrr.ts` prints the MRR query. Actual charge approval, decline and downgrade flows require a store, so Shopify's Responses were never seen; a downgrade is recorded but not performed (`DECISIONS.md` #18). |
| 10 | Five app webhooks plus three privacy webhooks respond correctly; `shop/redact` deletes all shop data | **Verified at the handler level** | `tests/webhooks.test.ts` (15 tests) plus `tests/webhook-pipeline.test.ts` (2 tests: 200 `products/update` deliveries → 200 snapshot jobs, 200 rescan jobs, exactly one coalesced publish; re-delivery idempotent). Handler coverage: HMAC accept/reject/tampered/missing, `app/uninstalled`, `products/create|update|delete`, `customers/data_request`, `customers/redact` (stores nothing), `shop/redact` (deletes all shop data), unknown topic acknowledged, delivery idempotency. Delivery from Shopify to a public URL was never observed. |
| 11 | Forbidden-word scan finds none in user-facing strings | **Verified, and the gate proven to bite** | `npm run check:words` → "Checked 76 files: no forbidden words in user-facing strings." Injecting `"certified listings"` into a route made it exit 1 with the file and line; the probe was reverted and the scan is clean again. Negated uses such as "it does not guarantee compliance" are on an explicit allow-list rather than being silently permitted. |
| 12 | Spike outcomes documented, with the manual-instruction fallback implemented | **Documented, not run** | `DECISIONS.md` records all three spikes with their fallbacks. Spike 1's fallback is real code, not a note: the app detects the block in the storefront HTML when it can, and offers a manual confirmation tick in Store settings when it cannot (used by R11/R10). Spikes 1–3 were not executed because no dev store existed. |

## Section 14 — what could not be verified

1. **Gazette wording and effective dates.** The rule text comes from the audit of
   31 October 2026 and lives in `app/domain/rules.config.json`, so a correction is
   a configuration edit; the supplied 1 January 2027 date is presented as supplied,
   not verified. Both are listed as open rows in `docs/LEGAL_REVIEW.md`.
2. **Competitor check.** Not performed. Nothing in the app depends on it, but
   positioning in `listing/app-store-listing.md` is unbenchmarked.
3. **App Store field limits and review turnaround.** The listing copy was written
   to the commonly documented limits (27-character name, 62-character subtitle)
   from memory of the public docs, not fetched and re-checked today. Verify in
   Partner Dashboard before submitting.
4. **Spike 1 — Search & Discovery filtering on `country_of_origin`.** Unresolved.
   Nothing in v1 depends on it: the filter is a convenience, and the manual
   instructions are on the dashboard.
5. **Spike 2 — `products/update` reliability on bulk edits.** Unresolved, so the
   nightly diff exists as the backstop and does not trust webhooks alone.
6. **Spike 3 — `metafieldsSet` 25-per-batch limits.** Unresolved; batches are
   deliberately small with per-row error capture so a throttled call costs one
   batch, not one import.
7. **Revenue share and tax treatment** of app payouts for the developer's country.
   Not researched. Pricing in `listing/pricing.md` is gross of Shopify's cut.
8. **Theme app extension validation.** The local Shopify CLI `app build` theme check
   was run after fixing missing schema translations; `app dev` and `app deploy`
   have not been run with a real app or store.
9. **No dev-store end-to-end test at all.** This is the largest gap and is stated
   once here rather than repeated per row: OAuth, webhook delivery, GraphQL bulk
   operations, theme editor rendering and billing approvals are code-reviewed and
   unit-tested but never executed against Shopify.

## Test inventory

**456 tests in 28 files**, all passing (`npx vitest run`, ~23 s). Files added by the
30 October review pass are marked ● and files that grew in that pass +; files
added by the 31 October compliance pass are marked ◆ and files that grew ◆+.

| File | Tests | Covers |
|---|---|---|
| `rules.test.ts` ◆+ | 72 | R1–R12 pass/fail/not-applicable/inconclusive, summary counting |
| `prior-price.test.ts` + ◆+ | 32 | window start, effective-at, boundary price, short history, labels, never-equals-current |
| `validation.test.ts` ◆+ | 30 | money, text, address, date, unit, enum parsing |
| `prior-price-publish.test.ts` + | 15 | day 20/29/31/45 drops end-to-end through `recordPriceSnapshots` → `publishPriorPrices` → `runScan`; ended sale clears the metafield |
| `webhooks.test.ts` + | 15 | HMAC, six app topics, three privacy topics, idempotency |
| `config.test.ts` | 13 | env parsing and the demo/production guard |
| `csv.test.ts` ◆+ | 15 | export, round trip, per-row errors, blank = unchanged |
| `metafields.test.ts` | 13 | payload shape, 25-row batches, only-changed writes |
| `plans.test.ts` | 13 | trial, limits, annual 10×, no auto-upgrade, MRR |
| `storefront-blocks.test.ts` + ◆+ | 17 | LiquidJS render of all three blocks; Block C stale-price cases (on sale, sale ended with stale `show:true`, price edited since publish, compare-at == price, thin product object) |
| `self-audit.test.ts` | 12 | 13 items, dated record, 11-month reminder, no certificate |
| `blocks-and-catalog.test.ts` | 10 | block detection, catalogue parsing, variant prices |
| `job-runtime.test.ts` ● | 10 | queue driver detection per platform, `JOBS_WORKER` overrides, `/healthz` status, guarded start |
| `scan.test.ts` ◆+ | 10 | full scan, idempotency, rescan, 500-product timing, snapshots |
| `bulk-operations.test.ts` ● | 9 | single-flight, adopt, follow-newer-id, `isAlreadyRunningError`, forced re-read does not adopt a finished operation |
| `copy.test.ts` | 8 | Indian rupee grouping, date formats, countdown, fixed disclaimer |
| `durable-queue.test.ts` | 8 | restart, crash-and-recover, lease expiry, priority ordering, `mergeJobProductIds` |
| `exports.test.ts` | 8 | CSV and PDF disclaimers, contents |
| `report.test.ts` | 8 | `inconclusive` through the dashboard model, CSV and PDF |
| `catalogue-cache.test.ts` ● | 6 | 8 page loads → 1 source read, 10 concurrent → 1 read, TTL expiry, per-shop isolation, patch visible without a re-read |
| `forbidden-words.test.ts` | 6 | forbidden-word detector and allow-list |
| `listing-gate.test.ts` | 6 | the listing gate is itself tested against broken copies of `listing/` |
| `web-config-gate.test.ts` ● | 6 | `shopify.web.toml` gate: real config passes; missing file, missing role, missing `[commands] dev`, `webhooks_path` mismatch each fail with a named message |
| `webhook-pipeline.test.ts` ● | 2 | 200 `products/update` deliveries → 1 coalesced publish; claim order snapshots → rescans → publish; re-delivery idempotent |
| `policy-links.test.ts` ◆ | 47 | R9 link fetching: https-only, private/loopback/link-local/CGNAT/reserved ranges, IPv4-mapped and 6to4 forms, hostname resolution and every address it returns, redirect re-validation, redirect cap, 256 KB body cap, empty and password-page detection |
| `unit-price.test.ts` ◆ | 24 | Rule 13 standard-unit thresholds in both directions, count units, two-decimal rounding, the Rule 6(11) proviso, wholesale and excluded packages, Rule 13 correction messages |
| `price-announcements.test.ts` ◆ | 18 | the announcement register (record, replace, list, delete, shop deletion), resolution order (per-variant over product-wide, recorded over derived, future-dated reported), R11 on a reduction only a record can show, and the published consumer price |
| `legal-basis.test.ts` ◆ | 17 | no instrument claims an unverified commencement, the 2026 amendment stays unverified, the country filter stays deferred with G.S.R. 312(E) controlling, unit sale price stays 2024, every rule has an instrument behind it |

Release gates and the demo were exercised in the same pass: `npm run lint` clean
on `app/`, `tests/` and `scripts/` (ESLint `--max-warnings=0`, then 77 files
scanned for forbidden words),
`npx tsc --noEmit` exit 0, `npx react-router build` succeeds, and the demo server
answered 200 on `/app`, `/app/bulk-editor` (plus `?page=2`, `?page=3&missing=mrp`,
`?q=soap`), `/app/settings`, `/app/audit`, `/app/exports`, `/app/billing`,
`/app/help`, `/preview/storefront`, `/healthz`, `/exports/scan.csv` (56,744
bytes), `/exports/scan-summary.pdf` and `/exports/audit.pdf`.

## Honest summary

The product logic — rules, scan, bulk write path, prior price, self-audit,
billing limits, webhooks, exports — is implemented and tested. The part of the
product that only exists on Shopify's side (install, GraphQL batch timing,
webhooks, theme rendering, charges) has never been exercised. Treat a dev-store
pass as the first task after this handover, not as a formality.
