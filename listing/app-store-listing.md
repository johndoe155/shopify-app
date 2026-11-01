# App Store listing copy

The field values below are the single source of truth in
`listing/listing-fields.json`; `npm run check:listing` measures each one against
the current limits and fails if this file drifts from it. The limits were checked
against Shopify's documentation and the published field list on 30 October 2026
(sources and the one remaining human check are in `docs/LISTING_FACTS.md`).

Everything in this file is written to the audit's conclusions (items L2, L11, L15,
L16, L17, 19 and 22). In particular: no field says a whole regime starts on
1 January 2027, no field claims the app finds *every* missing declaration, and no
field describes the country-of-origin filter as a draft.

## Name (limit 30)

**India Legal Metrology & MRP** — 27 characters.

## Subtitle (limit 62)

**Check MRP, origin, unit price and prior price rules** — 51 characters, with
eleven characters of headroom so a later Shopify change or a mobile-card
truncation cannot cut the promise in half.

## App introduction (limit 100)

**Check listings against India's declaration, e-commerce and prior-price rules.**

## App details (limit 500)

**Scan your catalogue against a fixed checklist of Indian product declarations, fix the gaps in bulk, and show MRP, country of origin, unit sale price, the grievance officer and a 30-day prior price on your storefront. Core declarations and the 2020 e-commerce rules apply now. Informational only, not legal advice.**

## Feature list (five items, 80 characters each)

1. **Scan every product and variant against India's declaration checklist**
2. **Fix gaps in bulk by rule, vendor, product type, or CSV import**
3. **Show MRP, origin, net quantity and unit sale price on product pages**
4. **Grievance officer block with 48-hour and one-month timings**
5. **Prior price from a complete 30-day lookback, suppressed until then**

## Short description (app card)

> Check the declarations Indian consumer-protection and legal-metrology rules
> expect on an e-commerce listing, fix the gaps in bulk, and show them on your
> storefront.

## Full description

Check the declarations Indian consumer-protection and legal-metrology rules expect
on an e-commerce listing, fix the gaps in bulk, and show them on your storefront.

**Know what applies when.** The core Legal Metrology package declarations (MRP
inclusive of taxes, manufacturer and — where they apply — packer, importer and
seller, country of origin, net quantity, common name and the month and year of
manufacture) are in force now for covered pre-packaged commodities. The Consumer
Protection (E-Commerce) Rules, 2020 are in force now too: platform and
customer-care details, the grievance officer with acknowledgement within 48 hours
and redressal within one month, and the pre-purchase disclosure list. The Rule
6(11) unit sale price has applied since 1 January 2024. The 2026 e-commerce
amendment's prior-price provision and yearly self-audit wording carry a
commencement date this app shows as supplied rather than Gazette-verified, so the
app prints that caveat next to the date instead of calling it settled.


### What it does

**Scan your whole catalogue in one pass.** The app reads every product and
variant through Shopify's bulk operations API and checks each one against a fixed
checklist derived from the provisions above. You get a single score, a count for
every check, and a filterable list of the products that need work. A check the app
could not verify is reported as unverified and left out of the score rather than
counted as a failure.

**Fill the gaps in bulk.** Edit many products at once: apply a value to selected
rows, apply a default by vendor or product type, or export a CSV, edit it in a
spreadsheet and import it back. Every value is validated (MRP amount, net quantity
value and unit, MM/YYYY dates, country list, per-variant MRP) and every write is
logged with the old value, the new value and a timestamp.

**Show the declarations on your storefront.** Three theme app blocks, for Online
Store 2.0 themes:

- **Legal declarations** — MRP (or a per-variant MRP), manufacturer, packer where
  it differs, seller, country of origin with the wording printed on the pack, the
  importer for a package marked as imported, net quantity, the unit sale price,
  the common name, the month and year of manufacture and any best-before or use-by
  date. Only the fields you have filled in are shown.
- **Grievance officer** — name, designation, email, phone and address, with the
  statement that complaints are acknowledged within 48 hours and redressed within
  one month. The app keeps a complaint register so you have a record that those
  timings were met, which the block on its own cannot show.
- **Prior price** — the lowest price in the 30 days before the reduction was
  announced, shown when a product is on sale. The block publishes nothing until a
  complete 30-day lookback exists: a shorter history is not a prior price and is
  not labelled as one.

**Record a dark-pattern self-audit.** A 13-item yes/no checklist covering the
patterns named in the annexure to India's 2023 dark-pattern guidelines, with a
notes field for each. The app saves a dated record and reminds you in the app at
11 months; that cycle is the app's own policy, the guidelines set no cadence, and
the record is not a certificate.

**Keep evidence.** Export scan results and the change log as CSV, and the latest
scan summary and self-audit record as PDFs. Every export carries the disclaimer,
and the self-audit PDF states that it is a record of your own answers, not a
certificate.

### What it does not do

- It does not make your store compliant. It checks listing data against a
  published checklist so you can prepare. It is informational, may be incomplete,
  does not guarantee compliance, does not certify anything and is not legal
  advice.
- It does not intentionally access or store customer or order records, and it
  requests no customer or order scope.
- It does not cover marketplace-only listings or a marketplace's own platform
  duties. The Consumer Protection (E-Commerce) Rules, 2020 apply to your own
  direct-to-consumer store as well as to marketplaces, so a single-store app is
  within their scope; what this app does not do is act for a marketplace.
- It does not touch GST invoicing or FSSAI labelling.

### Good to know

- Works with any product type: beauty and personal care, food and wellness,
  home and kitchen, accessories, small electronics.
- Discount codes and automatic discounts are applied at checkout, so no variant
  price changes and the app cannot see that a reduction was announced. Record
  those announcements with the date, the price the shopper pays and the
  conditions, and the prior price is measured from them. Where the app sees the
  announcement itself it records the mechanism and the consumer-facing price.
  Multi-currency markets use the base price only.
- The searchable country-of-origin filter was notified by G.S.R. 128(E) and
  deferred by G.S.R. 312(E) to 1 July 2027. The app explains the steps to add it
  in Shopify Search & Discovery; it is preparation today, not an enforceable
  duty.
- Installing early still matters for one reason the app can be precise about:
  the prior-price block needs a complete 30-day lookback before it can show a
  prior price at all.

## Pricing summary (matches `/listing/pricing.md`)

| Plan | Price | Products |
| --- | --- | --- |
| Free | $0 | up to 10 |
| Standard | $19/mo | up to 500 |
| Pro | $39/mo | up to 5,000 |
| Scale | $79/mo | unlimited |

Annual billing is available on paid plans at ten times the monthly price. Every
plan includes every feature; plans differ only by product count. Paid plans
include a 7-day trial.

## Search terms (five, chosen for the Partner dashboard)

1. legal metrology
2. MRP compliance
3. country of origin
4. prior price
5. grievance officer

Long-tail phrases (India e-commerce rules, packaged commodities, dark patterns,
importer details) belong in the description body, not in the five search-term
fields.

## Required claims language (must appear in the listing)

> This app checks listing data against a published checklist. It is informational,
> may be incomplete, does not guarantee compliance, does not certify anything and
> is not legal advice.

The same sentence appears in the app footer of every screen that shows a score, in
every CSV and PDF export, and in the privacy policy.

## Screenshots

Five screenshots. Real captures live in `/listing/screenshots`, and the shot
list is in `/listing/screenshots/shot-list.md`.

1. Dashboard — score, per-check counts, failing products.
2. Bulk editor — multi-select and apply a value across rows.
3. Product page — legal declarations block.
4. Footer — grievance officer block.
5. Self-audit — the 13-item checklist.

## App review notes for the reviewer

- The app requests `read_products` and `write_products` only. It has no customer
  or order scope and does not intentionally access or store customer or order
  records.
- The app writes to merchant-owned metafields in the `legal_in` namespace and to
  a shop-level JSON metafield for storefront display.
- The theme app extension is required for the two storefront-facing checks
  (grievance officer block live, prior price block live). On themes that do not
  support app blocks, those checks fall back to a manual confirmation the
  merchant makes in Store settings.
- Billing uses the Shopify Billing API with the four plans listed above.

## Notes for the submitter (not part of the listing)

Nothing below this line belongs in the Partner dashboard form. It is here so the
instructions travel with the copy instead of living in someone's inbox.

> Release note for whoever submits this listing: the supplied 2026 commencement
> date and each rule wording still need sign-off from an Indian lawyer, and the
> country-of-origin filter date comes from G.S.R. 128(E) as deferred by
> G.S.R. 312(E) (see `docs/LISTING_FACTS.md`). Keep the wording above as it is
> until that sign-off lands.

Two other things to check before submitting:

- The feature list, pricing and search terms above are the values measured by
  `npm run check:listing`; if a field is edited here, edit
  `listing/listing-fields.json` with it.
- `verifiedInPartnerDashboard` in `listing/listing-fields.json` is still `false`
  until a human has re-read the live form.
