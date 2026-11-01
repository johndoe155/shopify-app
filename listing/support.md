# Support

**Support email:** the address in the `SUPPORT_EMAIL` deployment variable. The
App Store listing, the app's Help page and the privacy policy must all show that
same address; the app hides the address rather than showing a placeholder, so do
not paste a stand-in into the dashboard.

Please include:

- your store domain (`your-store.myshopify.com`),
- the rule id from the checklist (R1 to R13) if the question is about a check,
- the page or export name,
- what you expected and what you saw.

## Response times

We aim to reply within two business days. Billing, data deletion and app-block
issues are handled first.

## Common requests

**"A rule looks wrong for my product."** Send the rule id and the source you are
working from. The checklist lives in `app/domain/rules.config.json`, so a
correction ships as a configuration change rather than a code release.

**"I want my data deleted now."** Email from the address on the Shopify account
and name the store. Data is deleted immediately rather than waiting for the
48-hour redaction webhook.

**"The block check says my block is not live, but I added it."** Open the theme
editor, confirm the block is in the template (not only in the block library),
then run "Check my storefront blocks" again. If your storefront is password
protected the app cannot read it, so tick the manual confirmation in Store
settings instead.

**"My prior price block is empty."** Price tracking starts on the install date and
a prior price is only published once a complete 30-day lookback exists. The block
therefore shows nothing for a reduction announced before that; it is not a
failure and there is nothing to fix. The dashboard shows the date from which a
complete lookback exists.

**"Why does the grievance block not prove we answered complaints?"** It shows the
officer's details and the 48-hour and one-month statement the rules require. It
cannot show that the timings were met, so the app keeps a complaint register you
fill in as complaints arrive, and the store check reads that register.
