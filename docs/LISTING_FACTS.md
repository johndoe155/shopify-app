# Listing, pricing and tax facts — checked, not remembered

Compiled 30 October 2026. Every claim here has a source next to it. Anything I
could not check is listed as unchecked rather than filled in from memory. This
file exists because the earlier listing copy carried limits and economics "from
memory of the public docs", which is exactly the kind of thing that gets a
submission rejected or a margin model wrong.

`npm run check:listing` enforces the field limits below. `verifiedInPartnerDashboard`
in `listing/listing-fields.json` stays `false` until a human re-reads the live
Partner dashboard form, because Shopify can change the form without changing the
docs.

---

## 1. App Store listing field limits

| Field | Limit used | Source | Confidence |
| --- | --- | --- | --- |
| App name | 30 characters | Shopify docs, "Best practices for apps in the Shopify App Store": *"Use 30 characters or fewer, which is the maximum length that an app name can be."* [1] | High — Shopify's own docs |
| App card subtitle | 62 characters | Consistently reported across 2026 ASO references and the Partner dashboard field list [2][3][4] | Medium — third-party sources agree, not Shopify docs |
| App introduction | 100 characters | Same sources as subtitle [2][4] | Medium |
| App details | 500 characters | Same sources [4] | Medium |
| Feature list | 5 items × 80 characters | Same sources [4] | Medium |
| Search terms | 5 terms | Same sources [4] | Medium |
| Google SEO title / meta description | 60 / 160 characters (off-platform) | [4] | Low — not a Partner dashboard field, affects Google results only |

What this means for the copy:

- The name (27 characters) is verified against Shopify's own documentation.
- The **62-character subtitle is corroborated but not verified from the Partner
  dashboard**, so the primary subtitle is now 52 characters with ten characters
  of headroom. A field that lands exactly on the limit is one Shopify edit away
  from a rejection, and mobile cards truncate earlier than the form does.
- Listing language: Shopify rejects superlatives ("the first", "the best", "the
  only") and unsubstantiated guarantee claims [5]. `scripts/check-listing.ts`
  blocks those words mechanically.

**Still unchecked:** the exact per-field validation behaviour in the Partner
dashboard on 30 Oct 2026 (the form was not available to this build). Log in, open
the listing form, compare each field, then set `verifiedInPartnerDashboard: true`.

---

## 2. Revenue share and payouts (business model check)

| Item | 2026 value | Source |
| --- | --- | --- |
| Revenue share, first USD 1,000,000 of **lifetime** gross app revenue (earned from 1 Jan 2025) | 0% | Shopify changelog, "Update to Shopify's app developer revenue share" [6]; corroborated by [7][8][9] |
| Revenue share above USD 1,000,000 lifetime | 15% | [6][7] |
| Payment processing fee | 2.9% on all app billing, plus applicable taxes | [7][9] |
| Registration for App Store distribution | one-time USD 19 | [9] |
| High-volume carve-out | 15% from the first dollar for developers with ≥ USD 20M prior-year App Store earnings or ≥ USD 100M gross company revenue | [6][7] |
| Refunds | revenue share is calculated on gross sales; refunds are not deducted | [9] |

Consequences for `listing/pricing.md`, which quotes gross prices:

- The free tier and the USD 19–79 plans sit far below the USD 1M lifetime
  threshold, so the realistic take-rate near launch is the **2.9% processing fee
  only** — the 15% tier is a later-stage problem, not a day-one one.
- The lifetime (not annual) threshold matters if a second app is ever launched:
  it aggregates at the partner level across associated accounts [6].
- Prices in `listing/pricing.md` should therefore be described as gross of a 2.9%
  processing fee, with the 15% share modelled at scale. That distinction was
  missing before this review.

## 3. Tax treatment of app payouts for an Indian developer (unresearched before)

The statutory text is cited from the instruments themselves, not from summaries of
them: the IGST Act, the 2018 amendment that rewrote the definition, and the CBIC
circular that interprets sub-clause (iv) [10][11][12]. Sources 18 and 19 are
commentary and are not relied on for any statutory point.

**What "export of services" requires.** Section 2(6) of the IGST Act, 2017 as
amended by the IGST (Amendment) Act, 2018 with effect from 1 February 2019 defines
it by five conditions that must all hold **together** [10][11]:

1. the supplier of service is located in India;
2. the recipient of service is located outside India;
3. the place of supply of service is outside India — worked out under section 13
   of the IGST Act, whose default rule (section 13(2)) is the location of the
   recipient of the service;
4. the payment for the service has been received by the supplier in convertible
   foreign exchange, **or in Indian rupees wherever permitted by the Reserve Bank
   of India** — CBIC Circular No. 202/14/2023-GST dated 27 October 2023 confirms
   that export proceeds paid in INR from the Special Rupee Vostro Account of a
   correspondent bank, opened under the RBI mechanism for INR trade settlement,
   satisfy this sub-clause [12]; and
5. the supplier of service and the recipient of service are not merely
   establishments of a distinct person, in accordance with Explanation 1 to
   section 8.

Fail any one and the supply is not an export of services: it is an ordinary
domestic supply of software/IT services (SAC 9983), at 18% GST.

**What qualifying gets you.** A qualifying export is zero-rated under section 16
of the IGST Act: supply under a letter of undertaking (LUT, Form GST RFD-11)
without paying IGST and then claim a refund of unutilised input tax credit, or
pay IGST and claim a refund of the tax paid [10][12]. Indian (domestic) customers
are the other side of the same coin: 18% GST on the supply.

**What to keep.** The position rests entirely on documents, so the following are
the evidence set, not an optional extra:

| Record | Which condition it speaks to |
| --- | --- |
| Shopify Partner payout statements for every payout round, showing the gross charge, the processing fee, the revenue share and the net remitted | the gross-to-net trail everything else is measured from |
| The invoices or billing records for each charge, showing who was billed and in which currency | (ii) who the recipient actually is, and (iv) |
| Remittance evidence: FIRC/eFIRA or the bank realisation certificate for each inward remittance | (iv) convertible foreign exchange |
| The LUT (Form GST RFD-11) and its acknowledgement, or the IGST-paid-and-refunded trail | the zero-rating route actually used |
| The contracting documents: the developer/Partner agreement with the entity that pays | (ii), (iii) and (v) |
| GSTR-1 and GSTR-3B filings and any refund applications (RFD-01) | the return-side record that matches the payouts |

**Unresolved and needs a chartered accountant, not a document:**

1. Shopify is the merchant's payment processor, and the developer is paid by
   Shopify (an overseas entity). Whether a given payout round is an export of
   services under section 2(6) — in particular the "recipient of service" test
   when Shopify bills and remits on behalf of merchants in many countries — has
   to be confirmed for the actual contracting entity and invoicing flow.
2. Whether the developer is an **intermediary** within section 2(13) of the IGST
   Act. Section 13(8)(b) puts the place of supply of an intermediary's services
   at the location of the supplier, that is India, which would defeat condition
   (iii) even where the counterparty is abroad and payment arrives in foreign
   exchange.
3. Whether GST should be charged to Indian merchants installing the app, and how
   Shopify's billing surfaces that. Tax collection on app charges is a Partner
   dashboard setting, not something the app code controls.
4. Income-tax treatment — whether the app business falls under presumptive
   taxation (section 44ADA for a profession, 44AD for a business, with turnover
   limits each Finance Act resets), and any FEMA/ODI filings if a foreign entity
   is used — is a **separate** question from GST, and is out of scope for this
   review.

Treat section 3 as **a research trail, not tax advice**. `listing/pricing.md`
states the part that is not in doubt from the listing side: the prices are gross
amounts, and the developer's own Indian GST and income-tax obligations are
separate from them.

---

## 4. Competitor scan (Day 0 step 1 — the "stop rule" was never applied)

The competitor check the brief asked for was never run, so this is a first pass,
not a full benchmark. What a targeted search on 30 Oct 2026 shows:

- The Indian legal-metrology guidance that dominates search results is
  **content and consultancy**, not Shopify apps: law-firm and consultancy blogs,
  the Department of Consumer Affairs' own answers, and label-design agencies
  [13][14][15][16].
- No Shopify app surfaced in these searches that is positioned specifically as
  an India legal-metrology / packaged-commodities listing checker with storefront
  blocks and a prior-price tracker. That is a *negative* signal only — the App
  Store search itself was not available from this environment, and "no result in
  a web search" is not "no competitor".
- Adjacent competition that a merchant will compare against: manual labelling
  consultancies (which solve the pack, not the listing), generic bulk-product
  editors (which solve editing, not the checklist), and discount/compare-at apps
  (which display a "was" price without computing the 30-day prior price).

Stop rule, applied honestly: the positioning above is **not** a validated
differentiation. Before spending on build-out beyond the current scope, run the
App Store search for "legal metrology", "MRP", "country of origin" and "prior
price" from a Partner account, record install counts and review counts for the
top ten results, and only then decide whether the niche is empty or merely
invisible to web search.

---

## 5. Rule-content findings that came out of this research

These are the concrete legal-content questions a reviewer must answer. The rule
table itself is unchanged except for the disabled R13 entry (see
`docs/LEGAL_REVIEW.md`).

1. **Unit sale price.** Published summaries state unit sale price has been a
   mandatory declaration since 2022–2024 [15][16], while at least one source
   states it is *not* required on e-commerce listings [16]. The audit resolved
   this: Rule 6(11) applies, and R13 now ships as an enabled conditional rule
   with the Rule 6(11) proviso and the Rules 3/26 scope as its exemptions.
2. **The country-of-origin filter was notified and then deferred, not left as a
   draft.** G.S.R. 128(E) notified it from 1 July 2026 and G.S.R. 312(E)
   substitutes/defers it to 1 July 2027, which is the date the app shows. This
   corrects the earlier note here, which described the filter as a draft; the
   Department of Consumer Affairs released a draft on 10 November 2025 proposing
   the same filter [13], and the notified G.S.R.s above are what control the
   date. The app's storefront filter instruction is therefore described as
   preparation for a deferred requirement, not as a draft or as a live duty.
3. **The supplied 1 January 2027 date and the Consumer Protection (E-Commerce) Amendment
   Rules, 2026 wording are still unverified against the Gazette.** This is the
   single largest business risk in the product: wrong rules mean wrong advice.
4. Source agreement on the *core* declarations (MRP inclusive of all taxes,
   manufacturer/packer/importer name and address, country of origin, common or
   generic name, net quantity, month and year of manufacture, best before/use by,
   consumer care details) is strong across independent summaries [13][14][15][16],
   which is reassuring for R1–R9 but is not a substitute for the Gazette text.

---

## Sources

1. Shopify — Best practices for apps in the Shopify App Store (app name: 30 characters or fewer): https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices
2. AppJubilee — Shopify App Listing Optimization Checklist (30-char name, 60-char subtitle guidance): https://blog.appjubilee.io/shopify-app-listing-optimization-checklist/
3. Convert2x — Shopify App Store SEO (name 30, subtitle 62, introduction 100, details 500, features 5×80): https://convert2x.com/shopify-app-seo
4. Shopify App Store Listing Optimization field reference (limits table): https://github.com/dm-jakaria/Shopify-App-Store-Listing-Optimization
5. Shopify App Store requirements — truthful listing content, no superlatives: https://shinedezigninfonet.com/blog/understanding-shopify-app-store-guidelines-what-you-need-to-know/
6. Shopify changelog — Update to Shopify's app developer revenue share (lifetime USD 1M exemption, 15% above): https://shopify.dev/changelog/update-to-shopifys-app-developer-revenue-share
7. WeekOne Labs — Official Shopify App Store developer revenue share 2026 (0% to $1M, then 15%, 2.9% processing): https://weekonelabs.com/blog/shopify-app-revenue-benchmarks-2026
8. Business Insider — Shopify alters revenue share exemption: https://www.businessinsider.com/shopify-alters-revenue-share-exemption-impacting-app-developers-plans-2025-4
9. imisofts — Shopify app development cost 2026 (USD 19 registration, 2.9% processing, gross-of-refunds revenue share): https://imisofts.com/blog/shopify-app-development-cost-2026/
10. GST Council (Ministry of Finance, Government of India) — Integrated Goods and Services Tax Act, 2017: https://www.gstcouncil.gov.in/sites/default/files/2024-03/annexure-5-igst-act_2017.pdf
11. GST Council — Integrated Goods and Services Tax (Amendment) Act, 2018 (No. 32 of 2018), which amends clause (6) of section 2 with effect from 1 February 2019: https://www.gstcouncil.gov.in/sites/default/files/2024-03/annexure-5-igst-amendment-act_2018_1.pdf
12. CBIC Circular No. 202/14/2023-GST dated 27 October 2023 (clarification relating to export of services — sub-clause (iv) of section 2(6) of the IGST Act, 2017), reproduced by the GST Council: https://gstcouncil.gov.in/sites/default/files/gst-knowledge/Recent-Amendment.pdf
13. ExactWhy — Legal metrology rules for Indian Shopify stores (mandatory declarations; draft country-of-origin filter of 10 Nov 2025): https://exactwhy.com/blogs/news/legal-metrology-ecommerce-india
14. Legal Metrology India — Legal metrology compliance for e-commerce in India: https://legalmetrologyindia.com/blog/legal-metrology-compliance-for-e-commerce-in-india/
15. Skatt — Legal metrology registration and MRP display on e-commerce listings: https://www.skatt.in/blog/legal-metrology-registration-kerala/
16. Dasha Patmaja — Legal Metrology (Packaged Commodities) Rules: the nine mandatory declarations, and the note that unit sale price is not required on e-commerce listings: https://dashapatmaja.in/blogs/legal-metrology-packaged-commodity-rules-india/
17. Confetti — Packaging labelling requirements in India 2026 (unit sale price and category-specific marks): https://confetti.design/blog/packaging-labeling-requirements-india
18. Xflow — GST on software services, SAC 9983, 18% domestic / zero-rated export under LUT (secondary commentary; the statutory points in section 3 are cited from [10][11][12] instead): https://www.xflowpay.com/blog/gst-on-software-services
19. TaxClue — GST on IT and software services, export under LUT, ITC refunds (secondary commentary, same status): https://taxclue.in/gst-on-it-services

Sources 10–12 are the primary instruments. Where a blog and an instrument
disagree, the instrument wins; nothing in this file rests on 18 or 19 alone.
