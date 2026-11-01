/**
 * Help: every rule with its pass condition and help text (from the JSON config,
 * so corrected wording shows up here automatically), the known limitations, how
 * to add the theme blocks and the country-of-origin filter, and FAQs.
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { BlockStack, Box, Card, Divider, InlineStack, Layout, Page, Text } from "@shopify/polaris";
import { requireAppContext } from "~/context.server";
import { RULES_CONFIG, ruleEntries } from "~/domain/rules";
import { INSTRUMENTS } from "~/domain/legal-basis";
import { commencementDisclaimer, regimeSummaries } from "~/domain/legal-basis";
import {
  COUNTRY_FILTER_DATE,
  commencementLine,
  countryFilterStatus,
  countdownLabel,
} from "~/domain/copy";
import { readConfig } from "~/config.server";
import { ChecklistDisclaimer } from "~/components/ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireAppContext(request);
  return {
    demo: ctx.mode === "demo",
    version: RULES_CONFIG.version,
    verified: RULES_CONFIG.verifiedAgainstGazette,
    verificationNote: RULES_CONFIG.verificationNote,
    rules: ruleEntries().map((rule) => ({
      id: rule.id,
      label: rule.label,
      level: rule.level,
      applicability: rule.applicability,
      passCondition: rule.passCondition,
      helpText: rule.helpText,
      // Audit item 20: every check names the provision it rests on.
      provisions: (rule.sources ?? []).map(
        (id) => INSTRUMENTS.find((instrument) => instrument.id === id)?.shortName ?? id,
      ),
      commencement: rule.commencement ?? null,
    })),
    supportEmail: readConfig().supportEmail,
    countryFilterFallback: !ctx.shop.countryFilterConfirmed,
    // Audit L2/L15: nothing on this page may present 1 January 2027 as the date the
    // whole regime starts, and the country filter is 1 July 2027.
    regimes: regimeSummaries(),
    commencement: commencementDisclaimer(),
    commencementLine: commencementLine(),
    countdown: countdownLabel(),
    countryFilter: countryFilterStatus(),
    countryFilterDate: COUNTRY_FILTER_DATE.toISOString(),
  };
}

export default function HelpPage() {
  const data = useLoaderData<typeof loader>();
  return (
    <Page title="Help" subtitle={`Checklist version ${data.version}`}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  How the checks work
                </Text>
                <Text as="p" variant="bodyMd">
                  Each check is either a product check or a store check. The scan runs the product checks on every
                  product; the store checks are evaluated from your settings, the storefront block check and your
                  self-audit record. A product counts as passing when every applicable product check passes.
                </Text>
                {!data.verified ? (
                  <Text as="p" variant="bodySm" tone="caution">
                    {data.verificationNote}
                  </Text>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  What applies when
                </Text>
                <Text as="p" variant="bodyMd">
                  {data.commencementLine}
                </Text>
                {data.regimes.map((regime) => (
                  <BlockStack key={regime.id} gap="050">
                    <Text as="h3" variant="headingSm">
                      {regime.title}
                    </Text>
                    <Text as="p" variant="bodySm">
                      {regime.body}
                    </Text>
                    {regime.effectiveFrom ? (
                      <Text as="p" variant="bodySm" tone="subdued">
                        Date shown: {new Date(regime.effectiveFrom).toLocaleDateString("en-GB", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })}
                        {regime.verified ? "" : " (supplied, not Gazette-verified)"}
                        {regime.id === "ecom_2026" ? ` · ${data.countdown}` : ""}
                      </Text>
                    ) : null}
                    <Divider />
                  </BlockStack>
                ))}
                <Text as="p" variant="bodySm" tone="caution">
                  {data.commencement}
                </Text>
              </BlockStack>
            </Card>

            {data.rules.map((rule) => (
              <Card key={rule.id}>
                <BlockStack gap="200">
                  <InlineStack gap="200">
                    <Text as="h3" variant="headingSm">
                      {rule.id} · {rule.label}
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {rule.level === "product" ? "Product check" : "Store check"}
                    </Text>
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Applies to: {rule.applicability}
                  </Text>
                  <Text as="p" variant="bodyMd">
                    Passes when: {rule.passCondition}
                  </Text>
                  {rule.provisions.length > 0 ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Provision{rule.provisions.length === 1 ? "" : "s"}: {rule.provisions.join("; ")}
                      {rule.commencement ? ` · ${rule.commencement}` : ""}
                    </Text>
                  ) : null}
                  <Text as="p" variant="bodySm">
                    {rule.helpText}
                  </Text>
                </BlockStack>
              </Card>
            ))}

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Known limitations of the prior price
                </Text>
                <Text as="p" variant="bodyMd">
                  Automatic discounts and discount codes are applied at checkout, so no variant price changes and
                  the app cannot see that a reduction was announced. That does not put them outside the rule:
                  record the announcement on the Price announcements screen, with its date, the price the shopper
                  pays and the conditions, and the prior price is measured from it. If you discount through a code
                  and never record it, the prior price shown is measured from the price change this app did see,
                  and the scan says that is what it did.
                </Text>
                <Text as="p" variant="bodyMd">
                  Multi-currency markets use the base price only. Prices in other presentment currencies are not
                  tracked separately.
                </Text>
                <Text as="p" variant="bodyMd">
                  History starts on the day the app is installed. Until a complete 30-day lookback exists, no
                  prior price is published for a reduction: a shorter history is not a statutory prior price and
                  is not labelled as one. The reports say which reductions are waiting and from which date a
                  complete lookback exists.
                </Text>
                <Text as="p" variant="bodyMd">
                  Where a reduction is announced, the app records the mechanism (variant price, compare-at price,
                  automatic discount or discount code) and the consumer-facing price, so the announcement is
                  documented rather than assumed. The mechanism and the price the shopper pays are published with
                  the prior price, and the record is kept for as long as the app is installed.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Add the theme blocks
                </Text>
                <Text as="p" variant="bodyMd">
                  Online Store 2.0 themes only. In your theme editor, open a product template and choose Add block →
                  Apps → Legal declarations, and again for Prior price. Add the Grievance officer block to the
                  footer or to a page.
                </Text>
                <Text as="p" variant="bodyMd">
                  After adding them, open the dashboard and choose &quot;Check my storefront blocks&quot;. If your
                  storefront is password protected, tick the confirmation boxes in Store settings instead.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Country-of-origin filter
                </Text>
                <Text as="p" variant="bodyMd">
                  {data.countryFilter}
                </Text>
                <Text as="p" variant="bodyMd">
                  The country of origin lives in the <code>legal_in.country_of_origin</code> metafield, which is
                  readable by the storefront. To let shoppers filter by it: open Shopify Search &amp; Discovery →
                  Filters → Add filter → Metafield → Legal metrology → Country of origin, and add it to your
                  collection and search pages.
                </Text>
                {data.countryFilterFallback ? (
                  <Text as="p" variant="bodySm" tone="caution">
                    These are manual steps: the app cannot add the filter for you. Tick the confirmation box in the
                    dashboard once the filter is live.
                  </Text>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  FAQ
                </Text>
                <Divider />
                <Text as="p" variant="bodyMd">
                  <strong>Does this make my store compliant?</strong> No. It summarises what the checklist finds
                  so you can prepare. It is informational, may be incomplete, does not guarantee compliance, does
                  not certify anything and is not legal advice.
                </Text>
                <Divider />
                <Text as="p" variant="bodyMd">
                  <strong>Where is the data stored?</strong> In this app&apos;s own database, per shop: your
                  settings, product declarations you edit, price snapshots and the complaint register you type
                  yourself. The app does not intentionally access or store customer or order records, and it has no
                  customer or order scope. Uninstalling stops access; a shop redaction request deletes everything
                  for that shop.
                </Text>
                <Divider />
                <Text as="p" variant="bodyMd">
                  <strong>Can I edit a product after my plan limit?</strong> Scanning and editing stop at your
                  plan&apos;s product count. Nothing is deleted, and the dashboard tells you which plan covers your
                  catalogue size.
                </Text>
                <Divider />
                <Text as="p" variant="bodyMd">
                  <strong>How do I undo a bulk edit?</strong> Every write is in the change log with the old value.
                  Download it from Exports before making large changes.
                </Text>
                <Divider />
                <Text as="p" variant="bodyMd">
                  <strong>Something looks wrong in the checklist.</strong>{" "}
                  {data.supportEmail ? (
                    <>
                      Email <a href={`mailto:${data.supportEmail}`}>{data.supportEmail}</a> with the rule id and what
                      the published rule says.
                    </>
                  ) : (
                    <>Contact the app developer with the rule id and what the published rule says. (This deployment has
                    not set a support address.)</>
                  )}
                </Text>
              </BlockStack>
            </Card>
            <Box paddingBlockEnd="800">
              <ChecklistDisclaimer />
            </Box>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
