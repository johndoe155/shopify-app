# Legal review record

**Status: the substantive questions below have been answered by the audit in
`India Legal Metrology & MRP — Audit Results` (24 items, sections A–C), and the
code has been changed to match it. `verifiedAgainstGazette` stays `false` and the
checklist version stays `2026.1-draft`, because two things are still not settled
by that audit and must not be papered over:**

1. the commencement date of the 2026 instruments (the audit records it as
   *supplied*, not Gazette-verified), and
2. the tax treatment of an app charge.

Everything else is now a recorded decision rather than an open question, so this
file is a record of what was decided and why, plus the two rows that still need a
lawyer's sign-off.

## Why the code changed rather than the wording

The earlier draft of this file asked a reviewer 18 questions and deferred the
answers. The audit answered them, and several answers required code changes: a
disabled rule had to be enabled, a rule had to change what it measures, a
parameter had to be replaced, and a label had to be deleted. Wording alone could
not fix, for example, "importer details are required unless the country is India"
(item L6) or "a partial 30-day history may be labelled as a prior price" (L16).

## Decisions, item by item

| # | Question that was open | Decision (audit section) | Where it lives now |
| --- | --- | --- | --- |
| L1 | Is the unit sale price required on an e-commerce listing? | Yes. Rule 6(11) requires it in the applicable standard unit, rounded to two decimal places, with the Rule 6(11) proviso and the Rules 3/26 package scope as the only exclusions modelled. R13 is enabled and conditional, not blanket. | `app/domain/unit-price.ts`, R13 in `rules.config.json` |
| L2 | Is 1 January 2027 the commencement date for everything? | No. Core Legal Metrology declarations and the 2020 E-Commerce Rules are operative now; the unit sale price has applied since 1 January 2024; only the 2026 prior-price and self-audit wording carries the supplied 2027 date. The single global effective date was removed. | `app/domain/legal-basis.ts`, `components/ui.tsx`, help and listing copy |
| L3 | Is "no variant above MRP" the right condition? | It is one condition, not the whole of R1. R1 now also checks whether the rule applies to the package at all, and MRP is stored per package: a per-variant map where variants are separately priced packages, with the Rules 3/26 exclusions available. | `variantMrp`, `packageType`, R1 |
| L4 | Manufacturer *or* packer? | Four separate persons: manufacturer, packer (only where different), importer and seller/dealer. A single "manufacturer / packer" row is not enough. | `packerDiffersFromManufacturer`, `packerName`, `sellerName`, R2 and R4 |
| L5 | Is a country name enough where the pack says "Made in India"? | No. The canonical country and the exact wording on the pack are both stored; neither is described as a statutory list. | `countryOfOriginLabel`, R3 |
| L6 | Are importer details not required for Indian-origin goods? | The country code was only a proxy. An explicit imported-package flag decides whether importer details are required. | `isImportedPackage`, R4 |
| L7 | Is the unit list complete? | `cm` was missing; the count descriptors (number, unit, piece, pair, set) are permitted where goods are sold by number; `pcs` is normalised to `piece`. Rule 13 thresholds decide the standard unit. | `NET_QUANTITY_UNITS`, `app/domain/unit-price.ts`, R5 |
| L8 | Is a generic name needed when the title names the commodity? | The title is not evidence. The declaration is a package-label duty, so the app asks whether the common name is on the pack. | `genericNameOnLabel`, R6 |
| L9 | Is the app's own "date-sensitive" flag defensible? | No. The trigger was removed. The month and year of manufacture or pre-packing is a separate declaration from any best-before or use-by date, and category exceptions are handled by the merchant's declared values. | `manufacturedDate` + `expiryType`/`expiryDate`, R7 |
| L10 | Is name + phone + email all required? | Name and address are required; telephone and email only where available. That is a package-label duty and is distinct from the e-commerce entity's platform customer care. | Store settings, `consumerCareAddress`, R8 |
| L11 | Are six policy items the right set? | No. Ten disclosures, including payment modes, grievance redressal, other pre-purchase information and best-before/use-before information, and a link only counts if it is accessible. | `POLICY_FIELDS`, `policy-links.server.ts`, R9 |
| L12 | Is storefront display enough? | Display is required, and it is not evidence that the 48-hour and one-month duties were met. The app keeps a complaint register and R10 reads it. | `app/routes/app.complaints.tsx`, R10 |
| L13 | Is the prior price the lowest price in 30 days, and do codes count? | The computation stands; what was missing is the announcement event. Each entry records when the reduction was announced, the consumer-facing price, the mechanism and any conditions, and codes are not categorically excluded. | `app/domain/prior-price.ts`, `resolveAnnouncementMechanism` |
| L14 | Is a 12-month cycle with an 11-month reminder statutory? | The 13 pattern names are correct (Annexure 1). The cycle is this app's own policy and is labelled as such; no certificate is issued. | `app/domain/self-audit.ts`, `app/routes/app.audit.tsx` |
| L15 | Is the country-of-origin filter a draft? | It was notified by G.S.R. 128(E) and deferred by G.S.R. 312(E) to 1 July 2027. It is deferred, not a draft, and the app says so. | `legal-basis.ts`, help page, `knownGaps` |
| L16 | May a partial 30-day history be labelled as a prior price? | No. The statutory prior price is published only from a complete lookback; until then the entry is suppressed and the tracking messages carry no amount. | `app/domain/prior-price.ts`, both blocks, `prior-price.js` |
| L17 | Is the disclaimer sufficient? | It must say informational, may be incomplete, not a legal opinion, no certification and no guarantee. | `DISCLAIMER` in `app/domain/copy.ts` |
| L18 | Does the privacy description match the app? | "Does not intentionally access or store customer or order records" replaces "no customer data at all", and merchant/admin data, processors, retention, deletion, security and incidents are disclosed. | `listing/privacy-policy.md` |
| 19 | Is a marketplace the only model in scope? | No. The 2020 E-Commerce Rules cover D2C/inventory sellers too, so the out-of-scope statement was narrowed to marketplace-only listings and platform duties. | listing copy, help page |
| 20 | Is there a map from each check to its provision? | Yes; it is shown on the help page and in the rule config. | `rules.config.json`, `app/domain/legal-basis.ts` |
| 21 | Which parameters need to change? | `priorPriceWindowDays`, `auditValidityMonths` and `auditReminderMonths` stay. `importerRequiredUnlessCountryCode` and `dateSensitiveWhenDateTypeIsNot` were removed because the fields they keyed on no longer exist. | `rules.config.json` |
| 22 | Which listing claims are not permitted? | No "finds every missing declaration", no "1 January 2027 deadline" for everything, no "draft filter", no prior price from under 30 days, no "zero personal data". The listing gate was corrected so the required corrective sentence ("does not guarantee") is not itself rejected. | `listing/*`, `scripts/check-listing.ts` |
| 23 | Should verification be flipped on? | No. `verifiedAgainstGazette` stays `false` and the version stays `2026.1-draft`. | `rules.config.json` |
| 24 | Are the pricing figures net or gross? | Gross. Shopify takes 2.9% per charge and 15% of revenue above USD 1,000,000 lifetime (0% below); taxes are separate and no GST position is asserted. | `listing/pricing.md` |

## Second pass: the four FAIL items and the five pass-with-defect items

A compliance review of the code above found four items that failed their own
description (L5, L10, L11, L13) and five that passed with a defect (L6, L16, L18,
L22, L24, plus R10/R4). Each was fixed at the root rather than reworded, and the
fix is covered by tests. Nothing here changes the two open items below: the 2026
commencement is still *supplied*, and no tax position is asserted.

| Item | Finding | What was wrong | Fix |
| --- | --- | --- | --- |
| L5 (FAIL) | R3 country-of-origin wording | The config said the wording printed on the pack is required only where the package is imported, while `checkR3` failed *every* package with an empty wording. Two contradictory rules, and an imported package could pass with a wording that did not name the country. | The wording is required for every covered package — the app cannot see the pack, so what the merchant records is its only evidence — and an imported package's wording must additionally name the country in full (`labelNamesCountry`). Config `applicability`, `passCondition` and the known gap were rewritten to match the code. |
| L6 (PASS†) | R4 import status | An unmarked India-origin package was reported as `not_applicable` without saying that import status had been *inferred* from the country of origin. | The result now states the inference and tells the merchant to set the flag. It stays `not_applicable` rather than `inconclusive` so a missing flag does not drop the product out of the score; the config wording was corrected to describe that. |
| L10 (FAIL) | R8 platform customer care | The Rule 6(2) label contact's phone and email satisfied the 2020 Rules' *platform* customer-care duty — two different duties, satisfied by one field. | `hasPlatformContact` is now based on `platformCustomerCareUrl` alone (plus a dedicated platform phone/email if one is ever added). The label contact's phone and email no longer pass R8, and the message says the two are separate. |
| L11 (FAIL) | R9 link checks | A link was checked only when a merchant pressed the button, and a check never aged out, so a link that broke the next day still passed. Fetching a merchant-supplied URL also had no SSRF guard and no body cap, and the settings save compared the resolved URL against the raw one, so a relative link lost its check on every save. | R9 treats a check older than `policyLinkMaxAgeDays` (7) as stale and reports `inconclusive`; the nightly job re-checks every link. Fetching is https-only, refuses private, loopback, link-local, CGNAT and reserved ranges, resolves the hostname and checks *every* address it returns, re-validates each redirect hop, caps redirects at 3 and the body at 256 KB. The settings save compares resolved URLs. Both the age window and the freshness behaviour are configurable and tested. |
| L13 (FAIL) | R11 announcement event | `conditions: null` was hard-coded, nothing could ever set `discount_code` or `automatic_discount`, so the code branch was dead — and the help page said codes "are not tracked here", which is exactly the exclusion the audit removed. | Announcement records: mechanism, date, price the shopper pays, conditions and variant, written through a new `Price announcements` screen and stored by a new `price_announcement` table (Prisma model, migration, memory repository). The record wins over the announcement derived from snapshots, the publisher writes a payload for a reduction it cannot see, and R11 says which of the two it used. Help and listing copy rewritten. |
| L16 (PASS†) | Prior-price wording | The tracking note and R11 said a prior price is "available from" install + 30 days, as though the date were fixed. Completeness is `effectiveAt − trackingStart ≥ 30 days`, which is a statement about a *future* announcement. | The note and R11 now describe future announcements and say prices from before install are not backfilled. Nothing is published until a complete lookback exists. |
| R10/R4 (PASS†) | Complaint register | One late complaint failed R10 permanently, with no way to clear it and no window in the rule. | The register is counted over `complaintEvidenceLookbackMonths` (12, configurable). Older complaints stay in the register and are reported as outside the counted window; R10 names the window in both its pass and fail messages. |
| L18 (PASS†) | Privacy wording | "Stores no customer personal data" still appeared in `README.md`, `webhooks.server.ts` and the Prisma schema header, and contradicted the privacy policy. | Reworded in all three: the app requests no customer or order scope and reads no customer record; what a merchant types into the complaint register is stored, which is why that field asks for no customer details. The webhook response says the same. |
| L22 (PASS†) | Listing instructions | A "Release note for whoever submits this listing" block sat inside the description field, so it would have been pasted into the App Store listing. | Moved to a "Notes for the submitter (not part of the listing)" section after every field, with the two other pre-submission checks beside it. |
| L24 (PASS†) | Tax and pricing facts | `docs/LISTING_FACTS.md` §3 cited two blog posts for the export-of-services rules, listed the five section 2(6) conditions as "etc.", and said nothing about the evidence to keep. `listing/pricing.md` told a developer outside India to take local advice. | §3 now cites the IGST Act, the IGST (Amendment) Act, 2018 and CBIC Circular No. 202/14/2023-GST, lists all five conditions, adds the intermediary risk under section 13(8)(b), and tabulates the evidence to preserve (payout statements, invoices, FIRC/eFIRA, the LUT, contracting documents, returns). The blogs are demoted to commentary. `pricing.md` states that Indian GST and income-tax obligations are separate from the gross prices listed. |

### Smaller defects fixed in the same pass

- The legacy `importer_details` metafield and CSV column forced `isImportedPackage = true`, promoting an inference into what the rule engine reports as a merchant's declaration. Both call sites now parse the details through one shared helper and leave the flag alone (R4 infers from the country and says so).
- A legacy `date_type` of `none` (or blank) mapped to a manufacture date in the CSV importer but was ignored by the scan, so the same declaration read differently depending on the path. Both use `parseLegacyDateFields` now.
- The Rule 13 standard-unit threshold was only applied in one direction: a quantity entered in the *larger* unit (2 kg) was converted down to grams and the merchant was asked to declare a price "per gram", a thousand times too small. The threshold is now applied to the quantity whatever unit it was entered in, and `standardUnitCorrection` also catches a large-unit quantity below the threshold (0.5 l → 500 ml).
- The prior-price block compared the payload price, written in rupees, against `variant.price`, which Liquid and the product JSON give in paise. It matched nothing, so the block never showed a prior price on a real store. Both the Liquid and the script convert before comparing, and the note now reads "in the 30 days before the reduction was announced".
- New unit tests for `unit-price.ts`, `policy-links.server.ts` and `legal-basis.ts` (the three untested modules), plus tests for the announcement register, the resolution order and the paise/rupee comparison in the storefront block.

## What still needs a human

| # | Item | What is needed | Effect while open |
| --- | --- | --- | --- |
| A | Commencement of the Consumer Protection (E-Commerce) (Amendment) Rules, 2026 | A Gazette copy with a legible G.S.R. number and commencement clause. The app shows the date as *supplied* and prints the caveat beside it. | The prior-price regime is presented as coming, not as settled. `verifiedAgainstGazette` stays `false`. |
| B | Tax treatment of an app charge | A chartered accountant's confirmation of the GST position for the developer's registration and place of supply — in particular the "recipient of service" test when Shopify bills and remits on behalf of merchants, and whether the developer is an intermediary under section 13(8)(b) of the IGST Act. | The pricing file states gross amounts and the Shopify deductions, records that Indian GST and income-tax obligations are separate from them, and asserts no GST position. `docs/LISTING_FACTS.md` §3 is a research trail, not advice. |

## Rules as implemented

| Rule | Provision | What it checks |
| --- | --- | --- |
| R1 | LM 2(m), 6(1)(e), 18(2) | MRP declared and inclusive of taxes; no selling price above the MRP for the package being sold |
| R2 | LM 6(1)(a), 6(10) | Manufacturer name and address; packer and seller named separately where they apply |
| R3 | LM 6(1)(aa), 6(1)(b) + e-commerce Rules | Country of origin declared, with the wording printed on the pack |
| R4 | LM 6(1)(a) | Importer name and address for a package marked as imported |
| R5 | LM 6(1)(c), 13 + 6(11) | Net quantity in the standard unit for the commodity |
| R6 | LM 6(1)(b) | Common or generic name, and whether it is on the pack |
| R7 | LM 6(1)(d), 6(1)(da), 26 | Month and year of manufacture or pre-packing, and any best-before/use-by date |
| R8 | CP(E-Commerce) 2020, 4(2)(d), 4(4), 4(5) | Rule 6(2) contact name and address; platform customer care |
| R9 | CP 5(3)(c), 6(5)(d), 7(1)(a) | The ten pre-purchase disclosures, with accessible links |
| R10 | CP 4(2)(d), 4(4), 4(5) | Grievance officer block live, and complaint timings within 48 hours and one month |
| R11 | CP 2026 prior-price provision (≈ 4(13)) | Stored announcement event, visible prior price, a complete lookback, variant identity |
| R12 | Dark Patterns Guidelines 2023, clauses 3–7 and Annexure 1 | The 13-pattern self-audit, with no certificate |
| R13 | LM 6(11) + Rules 3, 26 | Unit sale price where it applies, at two decimal places |

## Sign-off

| Field | Value |
| --- | --- |
| Reviewer name | *not yet reviewed* |
| Firm / qualification | |
| Date | |
| Documents reviewed (Gazette text, versions/dates) | |
| Commencement of the 2026 instruments confirmed (item A) | |
| Tax position on app charges confirmed (item B) | |
| `verifiedAgainstGazette` set to `true` on | |
| `rules.config.json` version after sign-off | |

Until that table is filled, the honest description of the product is: **a
checklist built from the audit's reading of the provisions, which a lawyer has
not yet confirmed against the Gazette.** The app says exactly that on the Help
page and in every export.
