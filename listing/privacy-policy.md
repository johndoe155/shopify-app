# Privacy policy — India Legal Metrology & MRP

Last updated: 30 October 2026

## Summary

This app helps merchants check their product listings against a published
checklist of Indian e-commerce listing declarations. **It does not intentionally
access or store customer or order records.** This app checks listing data against
a published checklist; it is informational, may be incomplete, does not guarantee
compliance, does not certify anything and is not legal advice.

## What we store

We store data about the store that installed the app, and only that:

| Data | Why |
| --- | --- |
| Shop domain, install date, uninstall date | To know which store the data belongs to and when price tracking started |
| Plan, subscription status, billing interval | To enforce the plan's product limit and show your plan |
| Store settings you type in: the Rule 6(2) contact name, address, phone and email; the platform customer-care link; grievance officer name, designation, email and phone; the ten pre-purchase disclosures (return, refund, exchange, warranty, delivery, return shipping cost, payment modes, grievance redressal, other information, best-before/use-before) as links or text; the storefront block confirmations | To publish them to your storefront blocks and to run the store checks |
| Policy-link check results (URL, HTTP status, time checked) | To report whether a disclosure link answered, which the accessibility check requires |
| The complaint register you type yourself (reference, dates, channel, summary) | To record whether the 48-hour acknowledgement and one-month redressal timings were met. You are asked not to enter customer names, addresses or order details |
| Product metafields in the `legal_in` namespace (MRP, per-variant MRP, manufacturer, packer, seller, country of origin and the wording on the pack, imported-package flag, importer, net quantity, unit sale price, common name, manufacture date, best-before/use-by, prior price) | To check listings and render the blocks. These are merchant-owned metafields written into your own store |
| Scan results per product and check | To show your dashboard and produce exports |
| Variant price snapshots (price, compare-at price, timestamp) | To compute the prior price from a complete 30-day lookback |
| Price announcements you record yourself (product or variant, the date the reduction was announced, the price the shopper pays, the mechanism — variant price, compare-at price, discount code or automatic discount — and any conditions) | A discount code or an automatic discount is applied at checkout, so no variant price changes and this app cannot see that a reduction was announced. Recording it is what lets the prior price be measured from the announcement |
| Change log entries (product, field, old value, new value, timestamp, source) | To give you an evidence trail |
| Self-audit answers and the date | To keep your dated record and remind you at 11 months |

## What we never store or read

- **No customer or order records**: the app does not intentionally access or
  store customer names, emails, phone numbers, addresses, order history, payment
  details or browsing behaviour. It requests no customer or order scope
  (`read_customers`, `read_orders`, `read_all_orders` are not requested, and
  nothing in the app reads an order).
- The `customers/data_request` and `customers/redact` webhooks are answered with
  HTTP 200 and an empty body because we hold nothing to return or erase. We do
  not read the payload of those webhooks.
- Merchant and staff data: the app stores the shop domain, the installing staff
  member's session, the settings listed above and the exports you generate. It
  does not build profiles of staff or track them across other apps.

## Where the data lives

Data is stored in a Postgres database operated by the app developer, in the
region configured for the deployment. Shopify session tokens are stored in the
same database so the app can call the Admin API on your behalf.

## Processors we rely on

| Processor | What it receives | Why |
| --- | --- | --- |
| The application host configured for this deployment | All app data in transit | To run the app |
| The managed Postgres provider configured for this deployment | All app data at rest | To store it |
| Shopify | Admin API requests, billing | To read and write product data and to charge for the subscription |

There are no analytics, advertising or tracking services and no data brokers. A
deployment that adds another processor must list it in this table before it goes
live.

## Retention

- Product data, scan results, price snapshots, price announcements, change log,
  complaint register and self-audit records: kept while the app is installed.
- After uninstall: kept until the shop-redaction request so that a reinstall
  keeps your history, then deleted.
- Policy-link check results: replaced on each check; a link you remove is deleted
  with the next save.
- Sessions: removed on uninstall.

## Security

- Requests from the Shopify admin are authenticated with Shopify session tokens
  and verified by the app's authentication middleware; webhooks are verified by
  HMAC before they are read.
- Data is sent over HTTPS only. Access to the production database is limited to
  the deployment's own credentials.
- The app requests the smallest scope it can work with (`read_products`,
  `write_products`) and holds no customer or order scope, so a breach of this
  database cannot expose customer or order records that were never collected.

## Incidents

If a security incident affects merchant data, affected merchants are contacted at
the store's contact address recorded in Shopify admin, with what happened, what
data was involved and what was done, without undue delay after the app operator
becomes aware of it. The same notification is given to Shopify. This section is
the app's own commitment; it is not a quoted statutory wording.

## Deletion

- **Uninstalling** marks the shop inactive and removes its sessions. Merchant
  data is retained until a redaction request so a reinstall keeps your history.
- **`shop/redact`** (sent by Shopify 48 hours after uninstall) deletes every row
  for that shop: settings, policy-link check results, scan results, price
  snapshots, change log, complaint register, self-audit records and sessions.
  This is a hard delete with cascading deletes in the database.
- You can ask for earlier deletion by emailing the support address below.

## Your responsibilities

The app records what you enter and what it reads from your listings. It does not
verify that the values you enter are correct, and it does not give legal advice.
A qualified person should review your declarations.

## Contact

Support: see `/listing/support.md`.
