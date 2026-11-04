/**
 * F1 — welcome screen. States what applies now and what the 2027 supplied date
 * covers, starts the first scan,
 * and sends the merchant to the dashboard.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData } from "react-router";
import { BlockStack, Box, Button, Card, InlineStack, Layout, Page, Text } from "@shopify/polaris";
import { requireAppContext } from "~/context.server";
import { APP_NAME, PRICE_HISTORY_INSTALL_BY, formatShortDate } from "~/domain/copy";
import { ChecklistDisclaimer, DeadlineBanner } from "~/components/ui";
import { runScan } from "~/services/scan.server";
import { enqueueJob } from "~/jobs/worker.server";
import { installScanKey } from "~/services/install.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireAppContext(request);
  if (ctx.shop.onboardingCompletedAt) return redirect("/app");
  return {
    demo: ctx.mode === "demo",
    installedAt: ctx.shop.installedAt.toISOString(),
    installBy: formatShortDate(PRICE_HISTORY_INSTALL_BY),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const ctx = await requireAppContext(request);
  await ctx.repo.updateShop(ctx.shop.id, { onboardingCompletedAt: new Date() });
  if (ctx.mode === "demo") {
    await runScan({ shop: ctx.shop, repo: ctx.repo, catalog: ctx.catalog });
  } else {
    await enqueueJob("nightly-scan", { shopDomain: ctx.shopDomain }, installScanKey(ctx.shop));
  }
  return redirect("/app");
}

export default function Welcome() {
  const data = useLoaderData<typeof loader>();
  return (
    <Page title={`Welcome to ${APP_NAME}`}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <DeadlineBanner />
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  What this app does
                </Text>
                <Text as="p" variant="bodyMd">
                  It scans every product against a fixed checklist of listing declarations, lets you fill the gaps
                  in bulk, shows the declarations and grievance officer details on your storefront through theme
                  blocks, and keeps a dated evidence log.
                </Text>
                <Text as="p" variant="bodyMd">
                  Your first scan starts as soon as you continue. Price tracking starts today: install by{" "}
                  {data.installBy} and you will have a full 30 days of price history before the supplied 1 January
                  2027 date for the 2026 e-commerce amendment. The core declarations, the 2020 E-Commerce Rules and
                  the unit sale price duty apply now, so the scan starts against today&apos;s duties rather than
                  waiting for that date.
                </Text>
                <ChecklistDisclaimer />
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Three steps to get going
                </Text>
                <Text as="p" variant="bodyMd">
                  1. Let the scan run and read your score.
                </Text>
                <Text as="p" variant="bodyMd">
                  2. Fill the missing declarations in the bulk editor, or by CSV.
                </Text>
                <Text as="p" variant="bodyMd">
                  3. Add the three theme blocks in your theme editor, starting with the grievance officer block in
                  the footer.
                </Text>
              </BlockStack>
            </Card>
            <Box>
              <Form method="post">
                <InlineStack gap="300">
                  <Button submit variant="primary" size="large">
                    Start the scan
                  </Button>
                  <Button url="/app/help" variant="plain">
                    Read the checklist first
                  </Button>
                </InlineStack>
              </Form>
            </Box>
            <Text as="p" variant="bodySm" tone="subdued">
              Installed {new Date(data.installedAt).toDateString()}.
            </Text>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
