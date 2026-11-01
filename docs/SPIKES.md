# The three Day-1 spikes — runbook and result log

The brief said to resolve three unknowns before building features. They were not
resolved, because there was no development store. That has not changed here: this
environment still has no store, no Partner account and no credentials, and I will
not pretend otherwise.

What changed is that they are no longer *stories*. Each spike is a command that
does the measurement and prints a block to paste below, and the fallback for each
is already implemented in the app. Fill the result tables in as you run them.

```bash
export SHOPIFY_SHOP=your-dev-store.myshopify.com
export SHOPIFY_ADMIN_TOKEN=shpat_...            # offline Admin API token
export DATABASE_URL=postgresql://...            # only spike 2 needs this

npm run spike -- search-discovery
npm run spike -- bulk-webhooks
npm run spike -- metafields-rate --products=gid://shopify/Product/1,gid://shopify/Product/2 --batch=25
```

Spikes 1 and 2 read; spike 3 writes a throwaway `legal_in_spike.rate_probe`
metafield to the products you list and deletes it in the same run. Point them at
test products, never at a live store's catalogue.

---

## Spike 1 — Is `country_of_origin` usable as a storefront filter?

**Question.** Can Search & Discovery filter on the app's `legal_in.country_of_origin`
product metafield, so a shopper can filter by country of origin?

**Status: not run.** Partial preconditions are checkable by script and are
printed by `npm run spike -- search-discovery`: the definition exists, its
storefront access is `PUBLIC_READ`, and the values on products are plain country
names from a single list (free text would make a filter useless).

**Fallback already in the app.** Nothing depends on the spike:
- R3 checks the value, not the filter.
- The Help page carries manual, step-by-step filter instructions.
- `countryFilterConfirmed` on the shop lets the dashboard know the merchant has
  done it.

**Result log**

| Check | Result | Date | Notes |
| --- | --- | --- | --- |
| Definition present with `PUBLIC_READ` | | | |
| Filter appears in Search & Discovery | | | |
| Filter appears on collection page | | | |
| Filter works on product page (if enabled) | | | |
| New values indexed immediately? | | | |
| Limitations / gotchas | | | |

---

## Spike 2 — Does `products/update` fire on bulk price edits?

**Question.** When a merchant changes prices in Shopify's bulk editor, does the
app receive `products/update` for every affected product, how quickly, and are
there duplicates or omissions? The nightly diff is the backstop; this measures
how much it has to repair.

**Status: not run.** `npm run spike -- bulk-webhooks` reports what the app's own
ledgers already say — `WebhookDelivery` counts per topic and `PriceSnapshot`
counts per source — so after a manual bulk-edit session the answer falls out of
the data. It prints a FAIL if price changes are arriving *only* via the nightly
diff.

**Fallback already in the app.** The nightly job diffs every variant price
regardless of webhooks, and the durable queue (added in this review) means a
price-snapshot job queued by a webhook still runs after a restart.

**What the app now does with the answer either way.** The spike originally had a
second half that mattered more than the delivery counts: what happens to the
catalogue read when 200 products change at once. Both outcomes are now safe
without knowing the result.

- *If* the webhooks fire in bulk (what the spike expects): 200 `products/update`
  deliveries queue 200 price-snapshot jobs and 200 per-product rescans, and the
  prior-price publish is coalesced by a 60-second window, so 200 deliveries
  produce **exactly one** publish carrying 200 product ids. Claim order is
  snapshots → rescans → publish (priority 50 / 60 / 70), so a publish never reads
  history that is about to be rewritten. Re-delivery of the same webhook is
  idempotent. Covered by `tests/webhook-pipeline.test.ts`.
- *If* they fire partially or not at all (the case the spike is meant to detect):
  the nightly diff still repairs every missed price, and the catalogue read is a
  single-flight bulk operation per shop, so a burst of webhooks cannot start a
  burst of bulk operations. Concurrent callers share the in-flight operation;
  when a newer operation is already running, the waiter adopts it instead of
  retrying. Covered by `tests/bulk-operations.test.ts` and
  `tests/catalogue-cache.test.ts`.

The two failure modes the spike was written to expose — a retry storm of bulk
operations, and a publish racing the snapshots it publishes — are therefore
closed by construction. Running the spike now tells us the *delivery* numbers to
expect in support, not whether the app survives them.

**Procedure.** Note prices and time → change 20+ prices in the bulk editor → wait
10 minutes → re-run the spike → compare counts → repeat once with the bulk
editor's "edit variants" dialog to see whether the two paths differ.

**Result log**

| Metric | Result | Date | Notes |
| --- | --- | --- | --- |
| Products changed | | | |
| `products/update` deliveries received | | | |
| Max delivery delay | | | |
| Duplicates | | | |
| Omissions (caught only by nightly diff) | | | |
| Editor/API path used | | | |

---

## Spike 3 — Does 25-per-batch `metafieldsSet` hold up on 2,000 products?

**Question.** On a catalogue of ~2,000 products (4,000+ variants), do batches of
25 stay inside the Admin API rate limit, or do they throttle; and if they
throttle, does the app recover without a merchant-visible failure?

**Status: not run.** The script measures GraphQL cost, throttle status, latency
and `userErrors` per batch, and extrapolates the wall-clock time for 2,000
products. Run it at `--batch=1`, `--batch=25` and `--batch=50` to compare cost
per field, then once under a deliberately throttled store.

**Fallback already in the app.** `app/services/metafields.server.ts` batches at
25, bounds concurrency at 2, retries with exponential backoff, and captures
per-field errors so a throttled batch costs one batch, not one import.

**Result log**

| Batch size | Batches | Slowest batch (ms) | Cost/field | Throttled? | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | |
| 25 | | | | | | |
| 50 | | | | | | |
| 25 under load | | | | | | |

**Extrapolation to 2,000 products (fill in):** ______ minutes, with ______ retries.

---

## What these spikes cannot settle

Even when all three are green, they say nothing about OAuth, install/uninstall,
theme rendering on Dawn/Horizon/Refresh, or billing approval. Those are covered by
`npm run verify:live` (read-only checks against a real store) and the manual
gate in `RELEASE_VERIFICATION.md`. Theme rendering in particular cannot be
simulated: LiquidJS and jsdom are not Shopify's runtime and are not a browser.
