# Decisions

Where the brief was silent or where the specified behaviour could not be built
exactly as written, the simplest option consistent with the brief was chosen and
recorded here.

## Rules and content

**1. The rule table is drawn from the legal audit, and still not law.**
`app/domain/rules.config.json` carries `verifiedAgainstGazette: false` and the note
that the wording comes from the audit of 31 October 2026 rather than from a
Gazette copy read here. The Help page and the scan summary PDF both surface that
state, so the merchant is never shown a checklist that pretends to be verified.
Corrections belong in the JSON, not in code.

**2. Rules are data, evaluation is code.** Every rule's id, order, label, level,
applicability, pass condition and help text live in the JSON config, together
with the tunable parameters (30-day window, 12-month audit validity, 11-month
reminder, the India exception for R4). The engine only holds an evaluation
function per rule id. A rule id with no implementation is skipped rather than
reported as passing, so a typo in the config cannot silently create a pass.

**3. R4 is not applicable, not failing, while the country is unknown.** If
`country_of_origin` is empty, R3 already fails. Making R4 fail as well would
double-count one missing field in the per-rule counts, so R4 reports
`not_applicable` until a country is chosen.

**4. R7 is driven by the merchant's own date flag.** A product is "date
sensitive" only when `date_type` is not `none`; the app does not guess from the
product type or from FSSAI-style categories (FSSAI rules are out of scope).

## Storefront and metafields

**4b. A check that cannot look reports `inconclusive`, never `fail`.**
(Added 30 Oct 2026.) R10 and R11 depend on seeing a theme app block on the live
storefront. The earlier behaviour mapped "we could not read the storefront" onto
`fail`, which lowers a merchant's score for something the app never checked — the
worst kind of wrong answer for a product whose whole claim is honesty about
compliance. There is now a fourth `RuleStatus`, `inconclusive`, with three
consequences: the score is computed over products that could be fully checked
(`scorePercent = passing / (total - inconclusive)`), the dashboard counts and
filters unverified products separately, and the PDF summary states how many
products were left out and why. `passed` still means "every applicable rule
passed"; `status` carries the three-way roll-up (`fail` beats `inconclusive`
beats `pass`). The alternative — passing the check by default — was rejected: it
would tell a merchant a block is live when nobody looked.

**5. `read_themes` is not requested.** Block detection reads the public
storefront HTML instead and looks for the marker attribute each block renders
(`data-legal-in-block="declarations" | "grievance" | "prior-price"`). If the
storefront cannot be fetched (password-protected, DNS, network), the dashboard
falls back to a per-block manual confirmation stored on the Shop row. The rule
engine accepts `confirmed_manual` exactly like `detected`, and the messages
distinguish the two so the merchant knows which one applies.

**6. Prior price is published per product as JSON, not per variant.** Block C is
a product-page block, and one metafield write per product is a third of the writes
that one per variant would need. `legal_in.prior_price` holds
`{variants: [{variant_id, price, compare_at, prior_price, label, show}], tracked_since, history_complete, complete_by, window_days, updated_at}`,
and the block picks the entry for the selected variant. Products with no
reduced-price variant get no metafield at all.

**7. Shop settings are mirrored to a shop metafield.** `legal_in.settings` (JSON)
carries consumer care, grievance officer and policy values in snake_case, so the
Liquid is a plain lookup and no server call happens at render time. The database
remains the source of truth; a save that succeeds locally but fails to publish
reports that failure in the UI rather than silently pretending it worked.

**8. Empty blocks keep a hidden placement marker.** A block with no data omits
its visible content but retains a hidden marker for detection. A marker proves
placement on the sampled page only, not visibility on every template.

**8b. The prior-price block reserves its own height.** (Added 30 Oct 2026.) The
block used to toggle `hidden` (display:none) when the selected variant had no
prior price, which pulled the rest of the page up on a variant switch — the exact
layout shift F4 forbids. Now: each row has a fixed minimum height, the note is
clamped to two lines so the one-line and two-line variants occupy the same space,
and a variant with no prior price gets `legal-in--idle` (`visibility: hidden`),
which keeps the box in the flow. `hidden` is used only when the *product* has no
prior-price data at all, which is decided server-side and cannot change while the
merchant switches variants. This removes the known cause of shift but is not a
measurement on Dawn, Horizon or Refresh; that still needs a store.

**9. No images, no web fonts, no external requests in the blocks.** Only one
scoped CSS file with `font: inherit`, fixed line heights and a flex layout with a
single mobile breakpoint. This avoids font and image shifts, but switching between
variants with and without content can change page height. No layout-shift guarantee
is made without measurements on real themes; see `VERIFICATION.md`.

## Plans, limits and billing

**10. Over the plan limit: scan is scoped, writes are paused, nothing is deleted.**
The brief says scanning and editing beyond the limit are gated with an upgrade
prompt. Blocking the scan entirely would mean a 240-product store on the free plan
never sees a score at all, which breaks F1's "the scan starts automatically". So
the scan covers the first *n* products the plan includes (n = 10 / 500 / 5,000 /
unlimited), the dashboard explains how many products are outside the plan and
which plan covers the catalogue, and metafield writes are refused while over the
limit. No rows are deleted; products outside the limit keep whatever results they
had.

**11. Annual billing is ten times the monthly price, on the same 30-day cycle
semantics.** Shopify's `BillingInterval.Annual` is used for the annual plans, and
the app's own price table computes `annualUsd = monthlyUsd * 10` so the two can
never disagree.

**12. Free plan downgrade is recorded, not performed.** Shopify cancels a
subscription through its own UI; the app cannot cancel on the merchant's behalf.
Choosing Free (or "record that I have cancelled") marks the stored status
`CANCELLED` and keeps access and data. The app never upserts a subscription or
moves a shop onto a paid plan by itself.

**13. Billing status is re-read on every admin page load.** `requireAppContext`
calls `syncPlanFromShopify`, which reads `currentAppInstallation.activeSubscriptions`
and updates the local plan. A read failure logs and falls back to the stored plan
rather than locking the merchant out.

## Writes, CSV and evidence

**14. CSV exports start with `#` comment lines.** CSV has no comment syntax, so
the disclaimer and the export timestamp are emitted as lines beginning with `#`
and the importer skips any such line. That gives a file that re-imports unchanged,
which is what the round-trip requirement needs. A byte-order mark is tolerated on
import; `₹`, commas and spaces are stripped from money values.

**15. Blank cells in an import mean "leave unchanged".** Clearing a field is done
in the editor, not by an empty cell. That makes partial spreadsheets safe: a
merchant who exports, edits three columns and re-imports cannot wipe the other
seven.

**16. Every write path produces its own change-log rows.** The log is written from
the *result* of the metafield write, so a failed batch produces no false entries.
Old and new values are stored as strings exactly as they were sent, `null` for
empty.

**17. The PDF writer is ~150 lines of our own code.** Two plain-text PDFs (scan
summary, self-audit record) did not justify a font-shipping dependency in a
feature whose whole job is producing a stable evidence file. Only the built-in
Helvetica faces are used and text is transliterated to WinAnsi, so the output is
byte-stable and testable. `tests/exports.test.ts` checks the xref offset, page
count and the presence of the disclaimers.

**18. The self-audit is described as a record everywhere it appears** — the page
banner, the PDF and the dashboard copy all use the same sentence from
`app/domain/copy.ts`. Nothing in the app scores the answers or calls the result a
certificate.

## Guardrails and the forbidden-words check

**19. The claim sentence is allow-listed, not exempted by file.** The check in
`tests/forbidden-words.test.ts` and `scripts/check-forbidden-words.ts` scans
`app/`, `extensions/` and `listing/`, and strips the exact negated sentences from
`app/domain/copy.ts` before matching. The declared words ("certified", "approved",
"guaranteed" and their close variants) are therefore blocked in positive use while
"does not guarantee compliance" is legal to write. Matching is done on a
whitespace-collapsed copy so a markdown file that wraps the sentence does not trip
the check. Business words that merely share a stem — "approve the charge" — were
rewritten as "confirm the charge" rather than added to the allow-list, to keep the
rule absolute.

**20. The word "approved" never appears in user-facing strings at all**, including
in the billing flow, where the copy now says "Shopify's charge confirmation
screen".

**20d. The release gates are themselves tested.** (Added 30 Oct 2026.) A gate that
has never failed is an assumption. `tests/listing-gate.test.ts` copies the real
`listing/` directory into a temp folder, breaks exactly one thing (an over-limit
field, trailing whitespace, a superlative, markdown drift, too many features or
search terms) and asserts `scripts/check-listing.ts` exits non-zero and names the
problem. `npm run check:config` was extended the same way it was first built: it
now also scans `listing/` for stand-in email addresses and the generic App Store
URL, because that copy is pasted into the Partner dashboard by hand and nothing
else looked at it. `listing/support.md` therefore refers to the `SUPPORT_EMAIL`
deployment variable instead of quoting a fake address a human might copy.

**20e. The install-by date is derived, not typed.** (Added 30 Oct 2026.) The
dashboard carried `installBy: "2 Dec 2026"` as a string literal while
`app/domain/copy.ts` already computed `PRICE_HISTORY_INSTALL_BY` as 30 days before
the rules take effect, and `tests/copy.test.ts` pins that arithmetic. The route
now formats the constant, so changing the rules date cannot leave the banner
telling merchants the wrong deadline.

## Architecture and dependencies

**20b. Configuration is validated at boot, and nothing deployment-specific has a
fake default.** (Added 30 Oct 2026.) The app previously read
`SUPPORT_EMAIL ?? "support@example.com"` and linked the review button to
`https://apps.shopify.com/` — both plausible enough to ship by accident.
`app/config.server.ts` now owns every deployment value, recognises the shapes a
forgotten value takes (`REPLACE_WITH…`, `example.com`, the App Store home page),
treats a recognised placeholder exactly like an empty value, hides optional
values in the UI when unset, and throws on the first production request while a
required value is missing. `npm run check:config` is the matching release gate.
Demo mode is allowed under `NODE_ENV=production` only with `DEMO_MODE_SECRET`,
which `npm run demo` sets for itself; a real deployment has no such value.

**20c. The Admin API version is bumped by upgrading the SDK, not the constant.**
(Added 30 Oct 2026.) `ApiVersion.October25` could not simply be changed: the
pinned `@shopify/shopify-app-react-router` 1.x bundled `@shopify/shopify-api`
13.x, whose enum ends at `2025-10`. Upgrading the SDK to 4.0.0 moved the whole
tree to `@shopify/shopify-api` 15.x, which knows `2026-10`; the app, `shopify.app.toml`
and the theme extension now all name 2026-10, and `SHOPIFY_API_VERSION` exists for
an emergency pin. The upgrade also removed the dual-major `Session` cast that
`app/shopify.server.ts` used to need.

**21. Repository port with two implementations.** The Postgres implementation
(`PrismaRepository`) is production; the in-memory one (`MemoryRepository`) backs
the tests and preview mode. That is what makes the scan, the batching and the
webhook handlers integration-testable without a dev store.

**22. Session storage is resolved lazily.** `app/shopify.server.ts` wraps
`PrismaSessionStorage` behind a lazy accessor so importing the module in preview
mode or in tests does not require `DATABASE_URL`. The Shopify packages in this
dependency tree type `Session` from two different `@shopify/shopify-api` majors
(the app SDK wants 13.x, the Prisma session storage adapter wants 15.x), so the
adapter is held behind a small structural interface and cast once at the boundary.

**23. The queue is durable, and the in-process queue is only an executor.**
(Revised 30 Oct 2026; the earlier note claimed restarts were covered by cron,
which was not true — queued work lived in memory and was lost.) Every job is now
written to `QueuedJob` before it runs, claimed with a lease, retried with a
persisted attempt count, and recovered by a lease sweep if the worker dies
mid-job. Concurrency is 2 and handlers stay idempotent: the nightly scan claims a
`JobRun` keyed by shop and date, and a per-product rescan replaces only that
product's rows, which is what makes at-least-once delivery safe. Three drivers
share one implementation: the in-process worker (started on the first admin
request), `npm run jobs:worker`, and `POST /api/jobs/tick` for cron or serverless
hosts. `tests/durable-queue.test.ts` simulates a restart (queued in one process,
run in the next) and a crash (claimed, abandoned, recovered), because those are
exactly the two cases the old design got wrong.

**24. Preview mode exists so the product can be reviewed without a store.**
`DEMO_MODE=1` swaps in the in-memory repository and a fake catalogue; it runs the
real scan, real rule engine and real write path. It is off unless the variable is
set, and it is what produced the App Store screenshots.

**25. The prior price is a window plus a boundary price, not a list of in-window snapshots.**
(Fixed 30 Oct 2026.) The old rule looked only at snapshots strictly inside the 30
days before the current price took effect. On a product whose price had not moved
for a month, the previous price fell *outside* that window, so the block showed
nothing — exactly when the previous price was the same for the whole 30 days and
therefore the most defensible figure to state. The rule now evaluates two things:
every snapshot inside `max(effectiveAt − 30d, trackingStart)` **and** the price
that was in effect at the window start, reconstructed from the last snapshot on
or before that instant. The prior price is the lowest of those candidates
excluding the current price, and it can never equal the current price. The
`tracked_since` date on the payload is still the install baseline, but it no
longer labels a figure: a value is published only when the 30 days before the
announcement were fully tracked, so a drop on day 20 or 29 is suppressed and a
drop on day 31 or 45 publishes. Verified in
`tests/prior-price-publish.test.ts`.

**26. "Clear the prior price" is a write, not an omission.** The publisher used to
skip products that were not currently discounted and never removed a metafield it
had written before, so an ended sale left Block C showing a prior price against a
full-price item — a statement the merchant could be held to. Now every product in
the run is classified as *publish*, *clear* or *skip*: an ended sale deletes the
metafield (falling back to writing an explicitly empty payload if the delete
fails), a product that was already cleared is skipped so a nightly run does not
rewrite the same nothing, and a product that has never been discounted and has no
metafield is skipped untouched. `publishPriorPrices` returns
`{published, cleared, skipped, failed}`, and the nightly handler logs a warning
when `failed > 0` rather than reporting a clean night.

**27. The block decides, the payload only informs.** Liquid used to trust
`show` from the metafield, so a payload written before the merchant edited the
price could display a stale prior price until the next publish. Payloads are now
`schema: 2` and carry the price and compare-at they were computed from. The block
shows only when `entry.show` **and** the stored price still equals the live
product price **and** the live compare-at is above it. A live price with a blank
compare-at means the sale ended, so the block hides — it does **not** fall back to
the stored pair. The stored-pair fallback exists only for a product object with no
live price at all (e.g. a theme that renders the block without a product). `assets/prior-price.js`
applies the identical rule on the client, so switching variants cannot re-show
what the server hid. Five cases are covered in `tests/storefront-blocks.test.ts`.

**28. One bulk operation per shop, ever, with one caller waiting on it.**
`BulkOperationCoordinator` is a single-flight guard around the Admin GraphQL bulk
API. Concurrent callers at the same scope share the in-flight operation; a caller
that needs fresh data after a write asks for a forced re-read, which starts a new
operation instead of adopting the just-finished one (adopting a completed
operation serves data that is up to seven days stale). If a newer operation is
already running, the waiter adopts it rather than failing. A `products/update`
webhook therefore cannot fan out into one bulk operation per delivery: 200
deliveries produce one catalogue read, and `isAlreadyRunningError` turns the
remaining races into an adopt instead of a retry storm.

**29. The catalogue is cached per shop, not per request.** Every bulk-editor
load, filter change, pagination step and post-save refresh used to start a bulk
operation. `app/services/catalogue-access.server.ts` keeps a per-shop snapshot
with a TTL (`CATALOGUE_CACHE_MS`, default five minutes), shares one in-flight read
between concurrent requests, and exposes `patchCatalogueProduct` so a write
updates the snapshot in place instead of invalidating it. Eight page loads and ten
concurrent requests each produce exactly one read; the demo passes `ttlMs: 0` so
screenshots and manual review always see current data.

**30. `shopify.web.toml` exists and is gated.** Its absence is not a cosmetic
problem: without it the CLI cannot tell a frontend role from a backend one, and
the webhook path is undeclared. The file now declares both roles,
`webhooks_path = "/webhooks"`, `dev = "npm run dev:server"` (not `shopify app dev`,
which would recurse) and `build = "npm run build"`. `scripts/check-config.ts`
validates all of it, and `tests/web-config-gate.test.ts` proves the gate fails
with a named message when a role, a block or the webhook path is missing.

**31. The queue driver is detected, not assumed.** An in-process
`setInterval` started from a request handler does nothing useful on a
serverless platform — the process is frozen the moment the response is sent. The
worker now reports its driver as `in-process-worker`, `external-tick`, `disabled`
or `none`, choosing `external-tick` on Vercel, AWS Lambda, Netlify, Cloudflare
Pages, Deno Deploy and Azure Functions (`FUNCTIONS_WORKER_RUNTIME`), or when
`JOBS_WORKER=tick` is set; `/healthz` publishes the value. Cloud Run (`K_SERVICE`)
and Heroku (`DYNO`) are deliberately *not* treated as serverless, because they
keep a process alive and the in-process worker is the better driver there. On a
serverless host the documented driver is `POST /api/jobs/tick` on a schedule.

**32. Claim order is due time, then priority, then insertion, then id — and the tests pin the clock.**
(Fixed 30 Oct 2026.) `claimDueJobs` orders by `runAt`, then `priority`, then
`createdAt`. Because `enqueueJob` stamps `runAt = new Date()` at insert, priority
only decides between jobs that became due at the same instant — which is the right
semantics (a job that is due sooner should not wait behind a job that is due later
just because its priority number is smaller) but made one test ambiguous: it
asserted that 20 webhooks' snapshots all preceded their rescans, which is only true
if all 60 rows landed in the same millisecond. The test now pins `runAt` so the
priority ordering is what it measures, and both repositories use the row id as a
final tiebreak so rows created in the same millisecond are handed out in a stable
order instead of one that depends on sort stability (in memory) or on the database
planner (Postgres). The test was confirmed to fail when the priority component is
removed, so it is checking the ordering rather than passing by accident.

## Spikes (brief section 7): outcomes

All three spikes need a Shopify dev store, which this build environment does not
have. Each is implemented with a fallback so the corresponding feature works even
if the spike fails, and each is now a runnable command
(`npm run spike -- <name>`) with a result table in `docs/SPIKES.md`. Running them
is still outstanding; the fallbacks are what the app relies on until they are.

| Spike | Status | Fallback implemented |
| --- | --- | --- |
| 1. Is `legal_in.country_of_origin` selectable in Search & Discovery filters? | Not run — needs a dev store (`npm run spike -- search-discovery` checks the preconditions) | Manual, step-by-step instructions on the Help page, plus a `countryFilterConfirmed` flag on the shop for the dashboard |
| 2. Do `products/update` webhooks fire on bulk price edits? | Not run (`npm run spike -- bulk-webhooks` reads the app's own ledgers) | Nightly price diff always runs and repairs missed webhooks |
| 3. Do batches of 25 `metafieldsSet` stay inside the rate limit on 2,000 products? | Not run (`npm run spike -- metafields-rate --products=…` measures cost and throttle) | Batching (25), bounded concurrency (2), retry with exponential backoff; constants are in `app/services/metafields.server.ts` |

## Presentation details worth knowing

**Indian digit grouping everywhere.** Money in the UI and in the preview storefront
is formatted by `formatInr` in `app/domain/copy.ts` (`Intl.NumberFormat("en-IN")`),
so a price reads ₹1,167.98 rather than ₹1167.98. CSV exports keep raw numbers
without separators so they re-import cleanly; PDFs print `Rs.` because the
built-in Helvetica encoding has no rupee glyph.

**The demo price history contains a dip, not a single step.** The seeded shop has
an install-day snapshot at the old selling price, a 4% dip ten days ago and the
current price eight days ago. The prior price therefore shows the dip, which is
what the rule actually computes (lowest recorded price in the 30 days before the
current price took effect), rather than simply repeating the compare-at figure.

## Second pass: the audit's FAIL and pass-with-defect items

**The country-of-origin wording is kept for every package, not only imported
ones (L5).** The config said the wording printed on the pack mattered only where
the package was imported, while the rule failed every package that had none. Both
cannot be true. The fix keeps the wording for every package — the app cannot see
the pack, so what the merchant records is the only evidence of what is printed —
and adds the real audit requirement on top: for an imported package the wording
must name the country in full, so a code, an abbreviation or a city fails. The
match is word-boundary based on a normalised string, so "Made in India" passes for
India and "Made in China" fails for it.

**An inference is reported as an inference, and never as a declaration (L6).**
R4 infers import status from the country of origin where the flag is unset, and
now says so in the result. It stays `not_applicable` rather than becoming
`inconclusive`, because `inconclusive` removes the product from the score and a
merchant would then be punished for a flag they were never asked to set. The same
principle removed the legacy `importer_details` shortcut: it used to force
`isImportedPackage = true`, which turned a value written by an earlier release
into something the rule engine reported as the merchant's own declaration.

**Two duties need two fields (L10).** The Rule 6(2) package-label contact and the
2020 Rules' platform customer care are different duties owed to different people.
R8 now accepts only the platform's own contact for the platform duty; the label
telephone and email no longer satisfy it, and the message says why.

**A link check is evidence about a moment, not about a URL (L11).** Passing a link
check once and remembering it forever is how a broken policy page keeps passing.
R9 now treats a check older than `policyLinkMaxAgeDays` (7 days, configurable) as
no check at all, and the nightly job re-checks every link so a working page stays
current without anyone pressing a button. Because the checker fetches URLs typed
by a merchant, it now refuses non-https schemes, refuses private, loopback,
link-local, CGNAT and reserved address ranges, resolves the host and checks every
address it returns (a name pointed at 127.0.0.1 is the hole every SSRF filter gets
caught on), re-validates after each redirect, caps redirects at three and the body
at 256 KB. See `SECURITY.md` for the residual risk that remains.

**Codes and automatic discounts are recorded, not excluded (L13).** A discount
code is applied at checkout, so no variant price moves and the app cannot see that
a reduction was announced — but the audit is explicit that such a reduction may
fall within the rule, so it must not be written off. Announcement records carry
the mechanism, the date, the price the shopper pays, the conditions and the
variant; a record wins over the announcement derived from snapshots; and R11 says
in its pass message which of the two it used. A reduction nobody records is still
measured, so the merchant is never told a gap is fine when it is merely
unmeasured. One record per product-and-variant: two would make "the 30 days before
the announcement" ambiguous.

**A window, not a permanent mark (R10).** A single late complaint used to fail R10
for ever, with no way to clear it. The register is now counted over
`complaintEvidenceLookbackMonths` (12, configurable): older complaints stay in the
register and are reported as outside the counted window rather than silently
dropped, and the rule names the window in both outcomes.

**Money in the storefront block is compared in one unit (storefront).** The
published payload is written in rupees; Liquid and the product JSON give prices in
paise. Comparing them directly matched nothing, so the prior-price block never
rendered on a real store — the tests had assumed rupees on both sides. Both the
Liquid and the client script now convert the stored figure to paise before
comparing, and the fixtures use the units Shopify actually returns.

**The Rule 13 threshold belongs to the quantity, not to the unit it was typed in
(unit price).** Reading the threshold from the unit as typed only worked in one
direction: 2 kg was converted down to 2,000 g and the merchant was asked to
declare a price "per gram", a thousand times too small, which is a false R13
failure on a correct declaration. The threshold is now applied to the quantity
whatever unit it was entered in, and the Rule 13 correction also catches a
quantity typed in the larger unit but below the threshold (0.5 l must be declared
as 500 ml).

## Deliberately not built

AI features, multi-language UI, countries other than India, FSSAI rules, GST,
marketplace integrations, email digests, and any in-app marketing beyond the
single review prompt. Reading a discount code from Shopify is **not** built
either, and cannot be: a code is applied at checkout and moves no variant price.
What is built instead is the merchant's own record of it (`Price announcements`),
which is the only place the mechanism, the date and the price the shopper pays can
come from. The review prompt is shown once,
only after the score first reaches 100%, and the flag is stored so it never
returns.
