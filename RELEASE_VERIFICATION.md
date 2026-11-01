# Release status: what is fixed, what is verified, what is still blocked

Updated 30 October 2026, after the release-hardening pass and the defect-fix pass
that followed it. Read this as the authoritative status page. Anything described as **verified** was run in this
workspace on this date; anything described as **not verifiable here** needs a
Shopify development store, a Partner account, a lawyer, or a host, none of which
exist in this environment.

## One-paragraph summary

Every failure in the two reviews that could be fixed in code has been fixed and
covered by a test. From the first review: unfair scores from undetectable
storefront blocks, a non-durable job queue, placeholder configuration, a stale
API version, the dependency vulnerabilities, and the unverified layout-shift
behaviour of the prior-price block. From the second: the prior price vanishing
after 30 days of stable pricing, Block C showing a stale prior price after an
ended sale, one bulk operation per `products/update` delivery, a bulk operation
on every bulk-editor page load, the missing `shopify.web.toml`, a prior price
equal to the current price after a compare-at-only edit, and an in-process worker
that silently does nothing on a serverless host. Four items cannot be closed from
a build environment, and they
are the four the review called out as business risks: **nothing has been run
against Shopify**, **the three Day-1 spikes are still not run**, **no lawyer has
reviewed the rule table**, and **there is no host, cron, domain or credentials**.
Those are now executable or reviewable artifacts rather than prose, but they are
still not done, and the app must not be submitted until they are.

## The ten items from the review

| # | Item | Status now | Evidence |
| --- | --- | --- | --- |
| 1 | Never run against Shopify | **Open — cannot be closed here.** Made executable instead: `npm run verify:live` performs the read-only half of the dev-store gate (API reachability on the pinned version, granted scopes, all eight webhook subscriptions, `legal_in` definitions, storefront markers, product metafield reads) and prints UNVERIFIED rather than "absent" where it cannot look. | `scripts/live-smoke.ts`; run against a store to close |
| 1a | F1's "score in under 60 s" only measured on the fake | **Open.** The in-memory scan of 500 products still runs in ~50 ms and proves the rule engine, not a bulk operation. The 2,000-product number is now part of spike 3's extrapolation instead of being implied. | `tests/scan.test.ts`, `docs/SPIKES.md` |
| 2 | Three Day-1 spikes not run | **Open, now runnable.** `npm run spike -- search-discovery|bulk-webhooks|metafields-rate` measures each one, prints a result block, and refuses to write unless test products are named. Result tables are in `docs/SPIKES.md`. | `scripts/spikes.ts` |
| 3 | Theme blocks unverified; layout shift possible | **Partly fixed.** Height stability is now a property of the block rather than a hope: fixed minimum heights per row, the note clamped to two lines, and "no prior price for this variant" hides with `visibility` (keeping the box) instead of `display:none` — so variant switching no longer changes block height. Verified in LiquidJS/jsdom and asserted by tests; **still not measured on Dawn, Horizon or Refresh**, which remain blocked on a store. | `extensions/…/prior-price.liquid`, `assets/legal-in.css`, `assets/prior-price.js`, `tests/storefront-blocks.test.ts` |
| 4 | Scores can be wrong for merchants (no "inconclusive") | **Fixed.** `RuleStatus` has a fourth value, `inconclusive`. R10 and R11 report it when the storefront cannot be read, the score is computed over products that could be fully checked, and unverified products are shown in their own stat card, filter and column. A merchant with a correct block on a password-protected store is no longer scored as failing. | `app/domain/types.ts`, `app/domain/rules.ts`, `app/services/report.server.ts`, `app/routes/app._index.tsx`, `tests/rules.test.ts` (fairness tests) |
| 5 | Legal content unverified | **Partly closed by the audit; still needs a lawyer on two rows.** The 24-item audit of 31 October 2026 answered the content questions and the code now implements its answers: R13 is enabled and conditional, the country-of-origin filter is recorded as notified and deferred to 1 July 2027 (G.S.R. 128(E), then G.S.R. 312(E)), and the four-persons/imported-flag/date-split findings are in the data model. `verifiedAgainstGazette` stays `false` and the version stays `2026.1-draft`, because the 2026 commencement date and the tax treatment of an app charge are still unconfirmed. | `docs/LEGAL_REVIEW.md`, `app/domain/legal-basis.ts`, `app/domain/rules.config.json` |
| 6 | Background queue not durable | **Fixed.** Jobs are persisted to a `QueuedJob` table before they run, claimed with a lease, retried with persisted attempt counts, and recovered if a worker dies mid-job. Three drivers exist: the in-process worker (started on the first admin request), a standalone worker (`npm run jobs:worker`), and a cron tick (`POST /api/jobs/tick`). Migration included. Tests simulate a restart and a crash. | `prisma/schema.prisma`, `prisma/migrations/20261030120000_durable_job_queue/`, `app/jobs/queue.server.ts`, `app/jobs/worker.server.ts`, `tests/durable-queue.test.ts` |
| 7 | Placeholders and config | **Fixed in code, blocked on credentials.** One config module recognises placeholder shapes, hides unconfigured optional values instead of showing fakes (no more `support@example.com`, no more review button pointing at the App Store home page), and makes every missing required value fatal in production. `npm run check:config` is a release gate. The `shopify.app.toml` placeholders remain *by design* until `shopify app config link` runs — inventing a client id would be worse. | `app/config.server.ts`, `scripts/check-config.ts`, `tests/config.test.ts` |
| 8 | Stale API version (`October25`) | **Fixed at the root.** The pinned SDK (`@shopify/shopify-app-react-router` 1.x) could not name a version later than 2025-10, so the constant could not simply be bumped. Upgraded to 4.0.0 (all packages now on `@shopify/shopify-api` 15.x), app, `shopify.app.toml` and the extension are on **2026-10**, and `SHOPIFY_API_VERSION` allows an emergency pin. Retest against a store is part of the open dev-store gate. | `package.json`, `app/shopify.server.ts`, `shopify.app.toml`, `extensions/…/shopify.extension.toml` |
| 9 | 15 vulnerabilities incl. 2 critical, 6 high | **Fixed: 15 → 3, zero high or critical.** vitest 2→4 (both criticals), unused `zod` dependency removed (high), `deepmerge-ts` pinned to a patched major (high), `esbuild` under the CLI pinned (low). The remaining three are Polaris/deepmerge lows with no non-breaking fix; each dismissal is argued in `SECURITY.md`. | `SECURITY.md`, `npm audit --omit=dev` |
| 10 | Listing facts from memory | **Fixed where checkable.** Field limits are now machine-enforced (`npm run check:listing`), the subtitle was trimmed to 52/62 for headroom, and the facts — limits, revenue share, payout tax treatment, competitor scan — are written up with 17 sources in `docs/LISTING_FACTS.md`. Two things remain open and are labelled as such: confirming the limits inside the Partner dashboard, and applying a stop rule to the competitor scan. | `listing/listing-fields.json`, `scripts/check-listing.ts`, `docs/LISTING_FACTS.md` |

## The seven defects from the second review

All seven are fixed, each with a test that was observed failing first where that
was practical. Full detail — root cause, fix and evidence per row — is in
`VERIFICATION.md` under *Review fixes, 30 October 2026*.

| # | Defect | Status | Fix |
| --- | --- | --- | --- |
| 1 | Prior price vanished after 30 days of stable pricing (day 20/29 worked, day 31/45 did not) | **Fixed** | The window now includes the price in effect at the window start, reconstructed from history, and never yields a prior price equal to the current price. Drops on day 20, 29, 31 and 45 are asserted end-to-end. |
| 2 | Block C could show a stale prior price | **Fixed** | Publisher clears the metafield when a sale ends instead of skipping; payloads are `schema: 2` and the block re-checks the stored price and compare-at against the live product before showing anything. Liquid and `prior-price.js` agree. |
| 3 | Every `products/update` started its own bulk operation; 200-product edits produced retries | **Fixed** | `BulkOperationCoordinator` (single flight, adopt-newer); 200 deliveries → one coalesced publish carrying 200 ids, with snapshots claimed before the publish. |
| 4 | Bulk editor ran a bulk operation on every load, filter, pagination and save | **Fixed** | Per-shop catalogue snapshot with a TTL and shared in-flight read; writes patch the snapshot. 8 loads and 10 concurrent requests each cost one read. |
| 5 | `shopify.web.toml` missing | **Fixed** | Added with both roles, `webhooks_path`, and non-recursive dev command; validated by `scripts/check-config.ts` and a 6-case self-test. |
| 6 | A compare-at-only change could yield prior price == current price | **Fixed** | Candidates are strictly below the current price, and a compare-at edit does not create one. |
| 7 | The in-process worker does not work on serverless | **Fixed** | Runtime detection with `external-tick` on serverless platforms, reported at `/healthz`; `POST /api/jobs/tick` documented as the driver there. |

## The compliance-audit pass (31 October 2026)

A compliance review scored 24 items against the code and the listing: four FAIL
(L5, L10, L11, L13) and five pass-with-defect (L6, L16, L18, L22, L24, plus
R10/R4). All are fixed at the root, each with a test, plus the smaller defects
found while fixing them. Full detail is in `VERIFICATION.md` under *Review fixes,
31 October 2026* and in `docs/LEGAL_REVIEW.md` under *Second pass*.

| Item | One-line status |
| --- | --- |
| L5 — R3 label wording | **Fixed.** Required for every covered package; an imported package's wording must name the country in full. Config and code now agree. |
| L6 — R4 import status | **Fixed.** The result states the inference instead of implying a declaration; the flag is no longer forced from a legacy field. |
| L10 — R8 platform contact | **Fixed.** The platform duty needs the platform's own contact; the pack-label phone and email no longer satisfy it. |
| L11 — R9 link checks | **Fixed.** A check older than 7 days is stale (`inconclusive`), the nightly job re-checks every link, and fetching a merchant URL is now https-only with an SSRF guard, redirect re-validation and a 256 KB cap. |
| L13 — R11 announcement | **Fixed.** Announcement records with a mechanism, date, consumer price and conditions; a `Price announcements` screen; a new `price_announcement` table with a migration. Codes and automatic discounts are recorded, not excluded. |
| L16 — prior-price wording | **Fixed.** No fixed "available from" date: the note and R11 describe future announcements. |
| R10/R4 — complaint window | **Fixed.** A 12-month lookback window, configurable; older complaints stay in the register and are reported as uncounted. |
| L18 — privacy wording | **Fixed.** All three places reworded to match the privacy policy. |
| L22 — listing instructions | **Fixed.** Moved out of the description into a submitter-only section. |
| L24 — tax and pricing facts | **Fixed.** Primary instruments (IGST Act, 2018 amendment, CBIC Circular 202/14/2023-GST), all five export conditions, the evidence to preserve, and pricing that names the developer's own Indian GST and income-tax obligations. |

Smaller defects fixed in the same pass: a legacy `importer_details` field no
longer forces the imported-package flag and a legacy `date_type` of `none` now
reads the same in the CSV importer and the scan; the Rule 13 standard-unit
threshold is applied in both directions (2 kg is no longer priced "per gram"); and
the prior-price block converts the payload's rupees to the paise Liquid returns,
which is why it never rendered on a real store.

**Two things this pass could not do.** The paise/rupee fix was found by reading
Shopify's units, not by watching a store: no dev store exists here. And the tax
section is still research, not advice — `docs/LISTING_FACTS.md` §3 says so, and
item 5 of *Still blocked* still needs a chartered accountant.

One defect was found by this packaging pass rather than by the review: the
webhook pipeline test was timing-dependent and failed on a clean extraction of the
archive while passing in the working tree. It asserted a stronger ordering contract
than `claimDueJobs` offers. Both the test and the tiebreak now make it
deterministic, and the assertion was verified to fail when the priority ordering is
removed. Detail in `VERIFICATION.md` and `DECISIONS.md` #32. The suite was run
three times, twice shuffled, with 308 tests passing each time.

What did **not** change: nothing about these fixes was verified against a real
store. The storefront block rules were verified in LiquidJS and jsdom, the bulk
coordination against a fake catalogue that enforces Shopify's one-operation-per-shop
limit, and the queue against the in-memory repository. The dev-store gate below is
still the first task after handover.

## Local verification performed (30 Oct 2026)

Node 20.20.2 in this sandbox (the project declares `>=22`; see the note below),
npm 10.8.2.

| Check | Command | Result |
| --- | --- | --- |
| Types | `npm run typecheck` | clean, strict, `noUncheckedIndexedAccess` |
| Lint | `npm run lint` | ESLint `--max-warnings=0` clean; forbidden-word scan clean (71 files at 30 October 2026, 77 after the compliance pass) |
| Unit + integration | `npm test` | **308 tests, 24 files, all passing** at 30 October 2026 (was 237/18 before the defect-fix pass, and 196/14 before the hardening pass). Re-run after the 31 October compliance pass: **456 tests, 28 files, all passing**. |
| Production build | `npm run build` | client + SSR succeed, no server-only-module leakage |
| Theme extension | `shopify app build` | Theme Check passes, extension bundles |
| Listing gate | `npm run check:listing` | name 27/30, subtitle 52/62, intro 91/100, details 337/500 |
| Config gate | `npm run check:config` | 3 placeholders, all in `shopify.app.toml` (expected until linked); also validates `shopify.web.toml` (roles, `webhooks_path`, `[commands] dev`/`build`) and scans `listing/` for stand-in addresses and the generic App Store URL |
| Gate self-tests | `npm test -- listing-gate` | 6 negative cases prove `check-listing` fails on over-limit fields, whitespace, superlatives and markdown drift |
| Dependency audit | `npm audit --omit=dev` | 3 low, 0 high, 0 critical |
| Preview app | `PORT=3301 node scripts/serve-demo.mjs` | `/app`, `/app/settings`, `/app/help`, `/app/exports`, `/app/audit`, `/app/billing`, `/app/bulk-editor`, `/preview/storefront`, `/healthz` all 200; `/exports/scan.csv` 56,744 bytes; scan-summary PDF 6,575 bytes; dashboard renders the new "Awaiting verification" card |

**Node version note.** The sandbox default is Node 20.20.2 while `package.json`
declares `>=22`. Both were exercised: `tsc --noEmit`, `vitest run` (237 tests) and
`react-router build` were re-run under Node 22.23.4 (fetched with `npx node@22`)
and pass. The defect-fix pass was re-verified on the sandbox default (Node
20.20.2): types, lint, 308 tests and the production build all clean, and the demo
served every route. The `>=22` engine is still only *tested*, not the default in
this environment.

## Still blocked (in priority order)

1. **A development store.** Closes items 1, 2, 3 and the retest half of 8. Start
   with `npm run verify:live`, then the manual gate in
   [Required development-store gate](#required-development-store-gate).
2. **A lawyer or chartered accountant.** Closes item 5. Use
   `docs/LEGAL_REVIEW.md`; do not set `verifiedAgainstGazette` to `true` until
   every row has an answer.
3. **A host, a domain, cron and Partner credentials.** Nothing in the repo can
   supply these. Until they exist: `REPLACE_WITH_*` stays in
   `shopify.app.toml`, `JOBS_SECRET` stays unset, and the app is not deployable.
4. **A Partner dashboard session.** Confirms the listing field limits and sets
   `verifiedInPartnerDashboard: true`.

## Required development-store gate

Record the date, environment, theme and version, screenshots, request ids and
outcomes for each step. Test store, test billing only. Never log access tokens.

1. `npm ci`, `npx prisma generate`, `npx prisma migrate deploy`, then
   `shopify app config link` and `shopify app dev`; install through OAuth.
   Confirm session persistence, the automatic first scan (F1), and
   uninstall/reinstall.
2. `npm run verify:live` — expect no failures. Then send a real webhook test
   notification and confirm a 200 plus a `WebhookDelivery` row, and confirm the
   **durable queue** by restarting the process mid-scan and checking the job
   resumes and completes (this is the new behaviour that has never been seen
   against a real store).
3. Billing: approve, decline, cancel and return URL on a test charge; confirm the
   trial, plan limits and the re-read after reload.
4. Themes: Dawn, Horizon and Refresh, current versions recorded. Add blocks A/B/C
   to product and footer templates; test desktop and mobile, variant deep links,
   discounted and undiscounted variants, zero and short history, async variant
   switching, quick views, and a product with >50 variants. Measure layout
   movement on load and on variant switching — the block now reserves its own
   space, but the measurement is the proof. **Confirm block C actually renders a
   prior price on a discounted variant**: the payload is published in rupees and
   Liquid returns paise, and the conversion that fixes that comparison is the one
   change in the compliance pass that has never run against a real store.
   Then record a discount-code announcement on `Price announcements` and confirm
   the prior price is measured from the date you recorded rather than from the
   last variant-price change.
5. Password-protected store: confirm the dashboard shows **Awaiting verification**
   (not a failure), that manual confirmation clears it, and that the score is not
   depressed while the block is unverified.
6. Spikes 1–3 from `docs/SPIKES.md`, with the result tables filled in.

## What this pass deliberately did not do

- It did not invent credentials, a client id, a host, a support address or a
  review URL. Those are deployment facts, and a plausible-looking fake is worse
  than an obvious gap — so the app now *fails in production* rather than shipping
  one.
- It did not set `verifiedAgainstGazette` to `true`, and it did not present the
  checklist as Gazette-verified. R13 is enabled, and the two rows the audit did
  not settle (commencement, tax) are named in `docs/LEGAL_REVIEW.md`.
- It did not claim zero layout shift on real themes, and it did not claim the app
  is production-ready. The score-in-under-60-seconds claim still rests on the
  in-memory fake.

## Delivered archive

`india-legal-mrp-full.zip` is the complete project: every source file, test,
migration, config, hidden dotfile (`.env.example`, `.eslintrc.cjs`, `.prettierrc`,
`.gitignore`), doc, theme extension, listing asset and release script — 143 files,
2.8 MB, with `ARCHIVE-MANIFEST.txt` at the root listing each file and its SHA-256
so the archive can be checked against the tree it came from. Only `node_modules`,
`build`, `.cache` and a real `.env` are excluded: they are derived or secret, and
`npm ci` reproduces the dependency tree exactly from the committed lockfile in
about ten seconds. It was verified the way it will be used:
extracted to an empty directory, `npm ci` run from its own lockfile (473
packages, no lockfile drift), `npx prisma generate`, then every gate repeated
there — `tsc --noEmit` clean, `eslint --max-warnings=0` clean, forbidden-word scan
clean over 77 files, **456 tests in 28 files passing**, `npm run build`
succeeding, `check:config` reporting only the three `shopify.app.toml`
placeholders that require a linked Partner app, `check:listing` within every field
limit, and the demo booting from the extracted tree with `/app`,
`/app/bulk-editor`, `/app/settings`, `/app/exports`, `/app/audit`, `/app/billing`,
`/app/help`, `/preview/storefront`, `/healthz`, `/exports/scan.csv` and
`/exports/scan-summary.pdf` all 200. The archive is complete and self-sufficient,
not a copy of a working folder that happens to run.
