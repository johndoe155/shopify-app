# India Legal Metrology & MRP

A Shopify app for Indian merchants that scans every product against a fixed
checklist of listing declarations, lets the merchant fill the gaps in bulk, shows
the declarations, the grievance officer details and the 30-day prior price on the
storefront through theme app blocks, and keeps a dated evidence log.

Deterministic rules plus store data. No AI features. The app does not intentionally
access or store customer or order records, and it requests no customer or order
scope. Core Legal Metrology declarations, the Consumer Protection (E-Commerce)
Rules, 2020 and the Rule 6(11) unit sale price apply now; the 2026 amendment's
prior-price and self-audit wording carries a supplied 1 January 2027 date that is
not Gazette-verified here. The app does not guarantee compliance and it is not
legal advice.

## Quick start (no Shopify store needed)

```bash
npm install
npm run demo          # builds, then serves the admin UI at http://localhost:3000
```

Preview mode serves the whole app against a seeded in-memory store of 248
products, with a real scan and real rule evaluation. Nothing leaves the process
and no database is required. It is enabled only when `DEMO_MODE=1`.

## Quick start (real Shopify app)

```bash
npm install
cp .env.example .env          # fill in the values
npx prisma generate
npx prisma migrate deploy     # or `prisma migrate dev` locally
npm run dev                   # shopify app dev (tunnel + dev store)
```

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SHOPIFY_API_KEY` | yes | App client id from the Partner dashboard |
| `SHOPIFY_API_SECRET` | yes | Used for OAuth and webhook HMAC verification |
| `SHOPIFY_APP_URL` | yes | Public URL of the deployed app |
| `SCOPES` | no | Defaults to `read_products,write_products` (see `app/shopify.server.ts`) |
| `DATABASE_URL` | yes (except demo) | Postgres connection string |
| `JOBS_SECRET` | yes | Shared secret for `POST /api/jobs/nightly` and `POST /api/jobs/tick` |
| `SHOPIFY_API_VERSION` | no | Emergency pin for the Admin API version. Defaults to `2026-10` |
| `JOBS_WORKER` | no | `off` disables the in-process worker (use `npm run jobs:worker` or cron instead) |
| `JOBS_LEASE_MS`, `JOBS_POLL_MS`, `JOBS_CONCURRENCY` | no | Queue tuning; defaults 300000 ms lease, 15000 ms poll, concurrency 2 |
| `CATALOGUE_CACHE_MS` | no | How long a shop's product catalogue snapshot is reused before a bulk re-read. Default `300000` (5 min); `0` disables the cache |
| `DEMO_MODE_SECRET` | only for `npm run demo` | Opt-in that lets the unauthenticated preview store run under `NODE_ENV=production` |
| `SUPPORT_EMAIL` | no | Address shown on the Help page. Empty = the UI hides it instead of showing a placeholder |
| `SHOPIFY_APP_REVIEW_URL` | no | Review link for this app. Empty = the review prompt shows no button |
| `DEMO_MODE` | no | `1` serves the seeded preview store. Refused in production without `DEMO_MODE_SECRET` |
| `PORT` | no | Defaults to `3000` |

## Project layout

```
app/
  domain/           pure logic: rules engine, prior price, CSV, plans, PDF, validation
    rules.config.json   the twelve checks, editable without a code release
  services/         Shopify-facing work: bulk scan, metafield writes, price history, billing
  db/               Prisma schema access + a Repository port with Postgres and in-memory impls
  jobs/             in-process queue, handlers, nightly job
  routes/           React Router 7 routes (Polaris admin UI + webhooks + exports)
  demo/             seeded preview store (DEMO_MODE only)
extensions/
  legal-in-storefront/   theme app extension: declarations, grievance officer, prior price
prisma/            schema and migrations
tests/             vitest: unit + integration
listing/           App Store copy, privacy policy, pricing, screenshots, field limits
docs/              legal review pack, listing/tax/competitor research, spike runbooks
scripts/           release gates, live-store smoke test, spikes, worker, seed, MRR
shopify.web.toml   CLI config: frontend + backend roles, webhooks_path, dev/build commands
```

## How the pieces fit

**Scan (F2).** `ShopifyCatalogSource` starts a GraphQL bulk operation, polls it,
downloads the JSONL result and maps products, variants and `legal_in.*`
metafields. The rule engine (R1–R7, R11) runs per product; results are stored one
row per (product, rule). Re-scanning a product on `products/update` replaces only
that product's rows. The nightly job repairs anything a missed webhook left behind.

**One bulk operation per shop, and the catalogue is cached.** A bulk operation is
the expensive, rate-limited resource in this app, so `BulkOperationCoordinator`
allows exactly one at a time per shop: a second caller waits for the running one
(or adopts a newer one that appeared) instead of starting another, and a read
that must be fresh after a write starts its own operation rather than adopting
the one that just finished — a completed operation serves data that can be up to
seven days old. On top of that, `app/services/catalogue-access.server.ts` keeps a
per-shop snapshot with a TTL (`CATALOGUE_CACHE_MS`, default five minutes), shares
one in-flight read between concurrent requests, and lets a write patch the
snapshot in place. A bulk edit of 200 products is therefore one read, not 200.

**Bulk editor (F3).** Every write goes through `applyLegalUpdates`, which
validates the patch, diffs it against the current metafield values, writes in
batches of 25 (`metafieldsSet`), and records one change-log row per field actually
written. CSV import is matched on product handle and shows a preview before
anything is written. Loads, filters, pagination and the refresh after a save all
read the cached catalogue snapshot (below), so browsing does not bill a bulk
operation.

**Storefront blocks (F4).** Three Liquid blocks read only metafields — the
product's `legal_in.*` values and the shop-level `legal_in.settings` JSON — so no
server call happens at render time. Each block renders a
`data-legal-in-block="…"` marker, which is how the app checks whether a block is
live without asking for the `read_themes` scope.

**Prior price (F5 + section 6).** Every variant price change (webhook) and a
nightly diff write a `PriceSnapshot`. The prior price is the lowest price in the
30 days before the reduction was **announced**, **including the price that was in
effect at the start of that window** — so a product whose price has not moved for
a month still shows the price it was sold at for those 30 days, instead of
showing nothing. It is never allowed to equal the current price. The computed
value plus the tracking start date is published to `legal_in.prior_price` (JSON,
`schema: 4`) per product, so the block needs no server call. The payload carries
the price and compare-at it was computed from, the price the shopper pays and the
mechanism, and the block re-checks them against the live product — converting the
payload's rupees to the paise Liquid returns: if the price has been edited since,
or the sale has ended, the block hides rather than showing a figure that is no
longer true. Ended sales have the metafield **deleted**, not left behind. A short
history is never labelled as a prior price: until a complete 30-day lookback
exists the entry is suppressed and the block shows nothing.

**Price announcements (section 6, audit item L13).** A discount code or an
automatic discount is applied at checkout, so no variant price changes and
nothing above can see that a reduction was announced. Those reductions are not
excluded — they are **recorded**, on `Price announcements`: the product or
variant, the date, the price the shopper pays, the mechanism and any conditions.
A recorded announcement wins over the one derived from the price snapshots, the
30-day lookback is measured from it, and R11 says in its result which of the two
it used.

**Self-audit (F7).** Thirteen yes/no items with notes, saved as a dated
`AuditRecord`. The dashboard shows a reminder at eleven months. The record is the
merchant's own answers and says so.

## Jobs and the durable queue

Background work (scans, per-product rescans after a webhook, price snapshots,
block checks) is **persisted before it runs**. Every job is a row in the
`QueuedJob` table with a unique dedupe key, an attempt count and a lease, so a
restart, a deploy or a crash cannot silently drop work: an abandoned job's lease
expires and it is recovered.

Three ways to drive it, pick one. The app detects which driver it is in and
reports it at `/healthz` (`queue.driver`), because an in-process interval is the
wrong driver on a serverless host:

```bash
# 1. in-process worker (default): starts on the first admin request
#    every JOBS_POLL_MS, and is unref'd so it never holds a process open
#    set JOBS_WORKER=off to disable it

# 2. dedicated worker process
npm run jobs:worker

# 3. cron / serverless: drain on a schedule
* * * * * curl -fsS -X POST https://your-app.example/api/jobs/tick \
  -H "x-jobs-secret: $JOBS_SECRET"
```

On a serverless host the in-process worker does not work: the process is frozen
as soon as the response is sent, so the interval never fires. The worker therefore
detects the environment instead of pretending. `queue.driver` on `/healthz` is one
of:

| Driver | When | What to do |
| --- | --- | --- |
| `in-process-worker` | a long-lived process (VM, container, Heroku, Cloud Run) | nothing — it drains the queue itself |
| `external-tick` | Vercel, AWS Lambda, Netlify, Cloudflare Pages, Deno Deploy, Azure Functions, or `JOBS_WORKER=tick` | schedule `POST /api/jobs/tick` (once a minute is plenty) |
| `disabled` | `JOBS_WORKER=off` | run `npm run jobs:worker` or the tick |
| `none` | the worker was never started in this process | check the host |

The nightly job is still triggered on its own schedule and is idempotent per shop
per day (a `JobRun` row keyed by `nightly:<shop>:<date>`):

```bash
0 2 * * * curl -fsS -X POST https://your-app.example/api/jobs/nightly \
  -H "x-jobs-secret: $JOBS_SECRET"

# one shop only
curl -fsS -X POST "https://your-app.example/api/jobs/nightly?shop=store.myshopify.com" \
  -H "x-jobs-secret: $JOBS_SECRET"
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | `shopify app dev` (tunnel, dev store, hot reload) |
| `npm run demo` | Build and serve the seeded preview app |
| `npm run build` | Production build |
| `npm run check:config` | Release gate: fails on placeholder or missing configuration in `shopify.app.toml`, `shopify.web.toml`, `.env.example`, `app/` and the submission copy in `listing/` |
| `npm run check:listing` | Release gate: App Store field limits and banned listing language |
| `npm run audit:prod` | `npm audit` over production dependencies, failing on high/critical |
| `npm run release:check` | Everything above in one command |
| `npm run verify:live` | Read-only smoke test against a real dev store (`SHOPIFY_SHOP`, `SHOPIFY_ADMIN_TOKEN`) |
| `npm run spike -- <name>` | Runs one of the three Day-1 spikes (see `docs/SPIKES.md`) |
| `npm run jobs:worker` | Standalone durable-queue worker |
| `npm start` | Serve the production build |
| `npm test` | Full vitest suite (unit + integration) |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run lint` | ESLint plus the forbidden-words check |
| `npm run check:words` | Only the forbidden-words check |
| `npm run seed -- store.myshopify.com` | Seed a dev store's settings, price history and scan results |
| `npm run mrr` | MRR report (annual counted as price / 12) |
| `npm run screenshots` | Capture `listing/screenshots` from the running preview app |

## Database

Postgres. `prisma/migrations` holds the initial migration and the ones added
later: the durable job queue (`20261030120000`) and price announcements
(`20261031160000`). Sessions live in the same database through
`@shopify/shopify-app-session-storage-prisma`.

Deleting a shop's data: the `shop/redact` webhook calls `repo.deleteShopData`,
which deletes the shop row; scan results, price snapshots, price announcements,
audit records, change log entries and job runs cascade. Sessions and webhook
delivery keys are deleted explicitly.

## Webhooks

All eight topics POST to `/webhooks`. The route reads the raw body, verifies
`X-Shopify-Hmac-Sha256` in constant time, claims the delivery in the
`WebhookDelivery` ledger (idempotency), then dispatches. `customers/data_request`
and `customers/redact` return 200 without reading the payload: the app requests
no customer or order scope and reads no customer record. What a merchant types
into the complaint register is stored, so the register asks for no customer names,
addresses or order details — see `listing/privacy-policy.md`.

## How a blocked check is reported

R10 and R11 depend on seeing a theme app block on the live storefront. When the
storefront cannot be read (password-protected, unreachable, or the block is on a
template the sampler did not see), those rules report **`inconclusive`**, not
`fail`. Inconclusive products are excluded from the score denominator, counted
separately on the dashboard, and listed under their own filter, so a merchant who
installed a block correctly never sees a lower score because the app could not
look. `pass`, `fail`, `not_applicable` and `inconclusive` are the only four
states; there is no path where "we could not tell" is recorded as a failure.

## Before you ship

1. **Legal review.** Have a qualified Indian lawyer or chartered accountant work
   through `docs/LEGAL_REVIEW.md` against the Gazette text, then set
   `verifiedAgainstGazette` to `true` in `app/domain/rules.config.json`. R13
   (unit sale price) stays disabled until that review answers L1.
2. **Credentials and host.** `shopify app config link`, then set every variable
   in `.env.example` in your secret manager and run `npm run check:config` — it
   must exit 0, which means no placeholders remain.
3. **Support and review links.** Set `SUPPORT_EMAIL` and
   `SHOPIFY_APP_REVIEW_URL`. Without them the app hides those elements rather
   than showing a fake address or a link to the App Store home page.
4. **The development-store gate** in `RELEASE_VERIFICATION.md`: `npm run
   verify:live`, then OAuth, webhooks, billing, the three themes, and the three
   spikes in `docs/SPIKES.md`. Several items can only be checked there.
5. **Listing facts.** Confirm the field limits in the Partner dashboard and set
   `verifiedInPartnerDashboard: true` in `listing/listing-fields.json`; the
   research (limits, revenue share, payout tax, competitors) is in
   `docs/LISTING_FACTS.md`.
