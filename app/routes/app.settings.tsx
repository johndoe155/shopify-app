/**
 * F6 — store settings.
 *
 * The screen follows the audit's separation of duties rather than the old
 * two-name/phone/email form:
 *  - the Rule 6(2) package-label contact (name **and** address) is separate from
 *    the e-commerce entity's platform customer care (L10);
 *  - the disclosure set is the full 2020 Rules list, not six items (L11);
 *  - policy links can be checked for accessibility here, which is what R9 reads
 *    (L11);
 *  - the storefront block confirmations stay, because a block that cannot be
 *    detected is unverified rather than failing.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  InlineStack,
  Layout,
  Link,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { useState } from "react";
import { requireAppContext } from "~/context.server";
import { saveShopSettings } from "~/services/shop-settings.server";
import { POLICY_FIELDS } from "~/domain/policies";
import { checkPolicyLinks, summarisePolicyChecks } from "~/services/policy-links.server";
import { toStoreFacts } from "~/db/types";
import { ChecklistDisclaimer } from "~/components/ui";
import { formatDateTime } from "~/domain/copy";
import type { ShopSettingsInput } from "~/services/shop-settings.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireAppContext(request);
  const shop = ctx.shop;
  const blocks = toStoreFacts(shop, shop.blocksDetected).blocks;
  return {
    demo: ctx.mode === "demo",
    values: {
      storeName: shop.storeName ?? "",
      consumerCareAddress: shop.consumerCareAddress ?? "",
      consumerCarePhone: shop.consumerCarePhone ?? "",
      consumerCareEmail: shop.consumerCareEmail ?? "",
      platformCustomerCareUrl: shop.platformCustomerCareUrl ?? "",
      grievanceName: shop.grievanceName ?? "",
      grievanceDesignation: shop.grievanceDesignation ?? "",
      grievanceEmail: shop.grievanceEmail ?? "",
      grievancePhone: shop.grievancePhone ?? "",
      ...Object.fromEntries(
        POLICY_FIELDS.flatMap((field) => [
          [`${field.key}Url`, (shop as unknown as Record<string, string | null>)[`${field.key}Url`] ?? ""],
          [`${field.key}Text`, (shop as unknown as Record<string, string | null>)[`${field.key}Text`] ?? ""],
        ]),
      ),
      confirmDeclarationsBlock: shop.confirmDeclarationsBlock,
      confirmGrievanceBlock: shop.confirmGrievanceBlock,
      confirmPriorPriceBlock: shop.confirmPriorPriceBlock,
    } as unknown as ShopSettingsInput,
    policyFields: POLICY_FIELDS,
    checks: Object.fromEntries(
      Object.entries(shop.policyLinkChecks ?? {}).map(([key, check]) => [
        key,
        { ok: check.ok, status: check.status, checkedAt: new Date(check.checkedAt).toISOString() },
      ]),
    ),
    summary: summarisePolicyChecks(shop.policyLinkChecks ?? {}),
    blocks,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const ctx = await requireAppContext(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "save");

  if (intent === "check-links") {
    // R9 only accepts a link that answered successfully when last checked, so the
    // check is stored rather than assumed.
    const checks = await checkPolicyLinks({ shop: ctx.shop, shopDomain: ctx.shopDomain });
    await ctx.repo.updateShop(ctx.shop.id, { policyLinkChecks: checks });
    return {
      ok: true,
      intent,
      errors: [] as Array<{ field: string; message: string }>,
      policySummary: summarisePolicyChecks(checks),
      checks: Object.fromEntries(
        Object.entries(checks).map(([key, check]) => [
          key,
          { ok: check.ok, status: check.status, checkedAt: check.checkedAt.toISOString() },
        ]),
      ),
    };
  }

  const get = (key: string) => String(form.get(key) ?? "");
  const bool = (key: string) => form.get(key) === "on" || form.get(key) === "true";

  const input: ShopSettingsInput = {
    storeName: get("storeName"),
    consumerCareAddress: get("consumerCareAddress"),
    consumerCarePhone: get("consumerCarePhone"),
    consumerCareEmail: get("consumerCareEmail"),
    platformCustomerCareUrl: get("platformCustomerCareUrl"),
    grievanceName: get("grievanceName"),
    grievanceDesignation: get("grievanceDesignation"),
    grievanceEmail: get("grievanceEmail"),
    grievancePhone: get("grievancePhone"),
    ...(Object.fromEntries(
      POLICY_FIELDS.flatMap((field) => [
        [`${field.key}Url`, get(`${field.key}Url`)],
        [`${field.key}Text`, get(`${field.key}Text`)],
      ]),
    ) as Omit<
      ShopSettingsInput,
      | "storeName"
      | "consumerCareAddress"
      | "consumerCarePhone"
      | "consumerCareEmail"
      | "platformCustomerCareUrl"
      | "grievanceName"
      | "grievanceDesignation"
      | "grievanceEmail"
      | "grievancePhone"
      | "confirmDeclarationsBlock"
      | "confirmGrievanceBlock"
      | "confirmPriorPriceBlock"
    >),
    confirmDeclarationsBlock: bool("confirmDeclarationsBlock"),
    confirmGrievanceBlock: bool("confirmGrievanceBlock"),
    confirmPriorPriceBlock: bool("confirmPriorPriceBlock"),
  };

  const result = await saveShopSettings({ shop: ctx.shop, repo: ctx.repo, writer: ctx.writer, input });
  return {
    ok: result.errors.length === 0,
    intent,
    errors: result.errors,
    mirrored: result.mirrored,
    mirrorError: result.mirrorError,
    policySummary: null,
    checks: null,
  };
}

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const busy = navigation.state === "submitting";

  const [values, setValues] = useState<Record<string, string | boolean>>(data.values as never);
  const set = (key: string) => (value: string | boolean) =>
    setValues((current) => ({ ...current, [key]: value }));
  const text = (key: string) => String(values[key] ?? "");

  return (
    <Page
      title="Store settings"
      subtitle="The package-label contact, the platform customer-care details and the pre-purchase disclosures for the whole store."
    >
      <Form method="post">
        <input type="hidden" name="intent" value="save" />
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {actionData?.ok && actionData.intent === "save" ? (
                <Banner tone="success" title="Settings saved">
                  <Text as="p" variant="bodyMd">
                    {actionData.mirrored
                      ? "The storefront settings metafield has been updated."
                      : actionData.mirrorError
                        ? `Saved in the app, but the storefront copy was not updated: ${actionData.mirrorError}`
                        : "Saved."}
                  </Text>
                </Banner>
              ) : null}
              {actionData && !actionData.ok && actionData.errors.length > 0 ? (
                <Banner tone="critical" title="Some fields need fixing">
                  <BlockStack gap="100">
                    {actionData.errors.map((error) => (
                      <Text as="p" key={`${error.field}-${error.message}`} variant="bodySm">
                        {error.message}
                      </Text>
                    ))}
                  </BlockStack>
                </Banner>
              ) : null}

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Package-label contact
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Rule 6(2) requires the name and address of the person or office contactable for
                    consumer complaints. Telephone and e-mail are required only if available, so they are
                    recorded separately from the name and address.
                  </Text>
                  <TextField
                    label="Name of the person or office"
                    name="storeName"
                    value={text("storeName")}
                    onChange={set("storeName")}
                    autoComplete="off"
                  />
                  <TextField
                    label="Address"
                    name="consumerCareAddress"
                    value={text("consumerCareAddress")}
                    onChange={set("consumerCareAddress")}
                    autoComplete="off"
                    multiline={2}
                    helpText="Full address, as it would appear on the package."
                  />
                  <InlineStack gap="300" wrap>
                    <Box minWidth="260px">
                      <TextField
                        label="Telephone (if available)"
                        name="consumerCarePhone"
                        value={text("consumerCarePhone")}
                        onChange={set("consumerCarePhone")}
                        autoComplete="off"
                        helpText="Include the country code."
                      />
                    </Box>
                    <Box minWidth="260px">
                      <TextField
                        label="E-mail (if available)"
                        name="consumerCareEmail"
                        type="email"
                        value={text("consumerCareEmail")}
                        onChange={set("consumerCareEmail")}
                        autoComplete="off"
                      />
                    </Box>
                  </InlineStack>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Platform customer care
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    The 2020 E-Commerce Rules separately require the e-commerce entity to publish its own
                    customer-care details. This is a different duty from the package-label contact above.
                  </Text>
                  <TextField
                    label="Customer-care page link"
                    name="platformCustomerCareUrl"
                    value={text("platformCustomerCareUrl")}
                    onChange={set("platformCustomerCareUrl")}
                    autoComplete="off"
                    placeholder="/pages/contact or https://…"
                  />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Grievance officer
                  </Text>
                  <TextField label="Name" name="grievanceName" value={text("grievanceName")} onChange={set("grievanceName")} autoComplete="off" />
                  <TextField label="Designation" name="grievanceDesignation" value={text("grievanceDesignation")} onChange={set("grievanceDesignation")} autoComplete="off" />
                  <TextField label="Email" name="grievanceEmail" type="email" value={text("grievanceEmail")} onChange={set("grievanceEmail")} autoComplete="off" />
                  <TextField label="Phone" name="grievancePhone" value={text("grievancePhone")} onChange={set("grievancePhone")} autoComplete="off" />
                  <Text as="p" variant="bodySm" tone="subdued">
                    The grievance officer block shows these details plus the statement that complaints are
                    acknowledged within 48 hours and redressed within one month. The complaint register
                    records whether those timings are actually met, which is what R10 checks.
                  </Text>
                  <Button url="/app/complaints">Open the complaint register</Button>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Pre-purchase disclosures
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    The 2020 E-Commerce Rules require more than returns and refunds. Each item needs your own
                    text or a link that loads successfully; a link is only accepted once it has been checked.
                  </Text>
                  <InlineStack gap="200" align="start">
                    <Button
                      onClick={() => submit({ intent: "check-links" }, { method: "post" })}
                      loading={busy && navigation.formData?.get("intent") === "check-links"}
                    >
                      Check the policy links
                    </Button>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {actionData?.policySummary ?? data.summary}
                    </Text>
                  </InlineStack>
                  {POLICY_FIELDS.map((policy) => {
                    const check = (actionData?.checks ?? data.checks)[policy.key as string];
                    return (
                      <BlockStack key={policy.key} gap="200">
                        <InlineStack gap="200" wrap>
                          <Text as="h3" variant="headingSm">
                            {policy.label}
                          </Text>
                          {policy.required ? null : (
                            <Text as="span" variant="bodySm" tone="subdued">
                              (only where relevant)
                            </Text>
                          )}
                        </InlineStack>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {policy.description}
                        </Text>
                        <TextField
                          label="Policy page link"
                          name={`${policy.key}Url`}
                          value={text(`${policy.key}Url`)}
                          onChange={set(`${policy.key}Url`)}
                          autoComplete="off"
                          placeholder="/pages/returns or https://…"
                        />
                        <TextField
                          label="Or write the terms"
                          name={`${policy.key}Text`}
                          value={text(`${policy.key}Text`)}
                          onChange={set(`${policy.key}Text`)}
                          autoComplete="off"
                          multiline={2}
                        />
                        {check ? (
                          <Text as="p" variant="bodySm" tone={check.ok ? "success" : "critical"}>
                            {check.ok
                              ? `Link answered successfully (HTTP ${check.status ?? "200"}) when checked on ${formatDateTime(new Date(check.checkedAt))}.`
                              : `Link did not answer successfully (${check.status ?? "no response"}) when checked on ${formatDateTime(new Date(check.checkedAt))}.`}
                          </Text>
                        ) : text(`${policy.key}Url`) ? (
                          <Text as="p" variant="bodySm" tone="caution">
                            This link has not been checked, so R9 reports it as unverified until you run the
                            check.
                          </Text>
                        ) : null}
                        <Divider />
                      </BlockStack>
                    );
                  })}
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Storefront block confirmations
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    We check a sample of public storefront pages. A missing marker is inconclusive; check each
                    relevant template and confirm the blocks here if automatic detection cannot verify them.
                    Until a block is either detected or confirmed, the checks that depend on it are shown as
                    &quot;unverified&quot; and are left out of your score — an unverified block is not counted as a
                    failure.
                  </Text>
                  <Checkbox
                    label="The legal declarations block is on my product pages (Rule 6(10) online display)"
                    name="confirmDeclarationsBlock"
                    checked={Boolean(values.confirmDeclarationsBlock)}
                    onChange={set("confirmDeclarationsBlock")}
                  />
                  <Checkbox
                    label="The grievance officer block is on my storefront"
                    name="confirmGrievanceBlock"
                    checked={Boolean(values.confirmGrievanceBlock)}
                    onChange={set("confirmGrievanceBlock")}
                  />
                  <Checkbox
                    label="The prior price block is on my product pages"
                    name="confirmPriorPriceBlock"
                    checked={Boolean(values.confirmPriorPriceBlock)}
                    onChange={set("confirmPriorPriceBlock")}
                  />
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Price reductions this app cannot see
                  </Text>
                  <Text as="p" variant="bodyMd">
                    A discount code or an automatic discount is applied at checkout, so no variant price changes
                    and nothing is written to the price history. That does not put it outside the rule: record
                    the announcement — the date, the price the shopper pays and the conditions — and the
                    prior price is measured from it.
                  </Text>
                  <Link url="/app/announcements">Record a price announcement</Link>
                </BlockStack>
              </Card>
              <ChecklistDisclaimer />
            </BlockStack>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingSm">
                  What the storefront shows
                </Text>
                <Text as="p" variant="bodySm">
                  These details are published to a shop metafield, so the theme blocks render without calling
                  this server. Update the settings here and the blocks pick it up on the next page load.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Block status: declarations {String(data.blocks.declarations).replace("_", " ")}, grievance{" "}
                  {String(data.blocks.grievance).replace("_", " ")}, prior price{" "}
                  {String(data.blocks.priorPrice).replace("_", " ")}.
                </Text>
                <InlineStack gap="200">
                  <Button submit variant="primary" loading={busy && navigation.formData?.get("intent") !== "check-links"}>
                    Save settings
                  </Button>
                  <Button url="/app" variant="plain">
                    Back to dashboard
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Form>
    </Page>
  );
}
