/**
 * F8 — evidence exports. Four files, each carrying the disclaimer.
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { BlockStack, Button, Card, DataTable, InlineStack, Layout, Page, Text } from "@shopify/polaris";
import { requireAppContext } from "~/context.server";
import { loadScanReport } from "~/services/report.server";
import { AUDIT_RECORD_NOTE, DISCLAIMER, formatDateTime, formatShortDate } from "~/domain/copy";
import { ChecklistDisclaimer } from "~/components/ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireAppContext(request);
  const report = await loadScanReport(ctx);
  const changeLog = await ctx.repo.listChangeLog(ctx.shop.id, 50);
  return {
    scannedAt: report.scannedAt?.toISOString() ?? null,
    productCount: report.summary.totalProducts,
    passing: report.summary.passingProducts,
    changeCount: (await ctx.repo.listChangeLog(ctx.shop.id, 20_000)).length,
    recentChanges: changeLog.slice(0, 15).map((row) => [
      row.productHandle ?? row.productId,
      row.field,
      row.oldValue ?? "—",
      row.newValue ?? "—",
      formatDateTime(row.changedAt),
      row.source,
    ]),
    audit: (await ctx.repo.latestAuditRecord(ctx.shop.id))?.completedAt.toISOString() ?? null,
  };
}

export default function ExportsPage() {
  const data = useLoaderData<typeof loader>();
  return (
    <Page title="Evidence exports" subtitle="Keep a dated record of what you checked and what you changed.">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Download
                </Text>
                <InlineStack gap="300" wrap>
                  <Button url="/exports/scan.csv">Scan results (CSV)</Button>
                  <Button url="/exports/changelog.csv">Change log (CSV)</Button>
                  <Button url="/exports/scan-summary.pdf">Latest scan summary (PDF)</Button>
                  <Button url="/exports/audit.pdf" disabled={!data.audit}>
                    Self-audit record (PDF)
                  </Button>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  Every file carries: {DISCLAIMER} The self-audit PDF states that it is a record of your own
                  answers, not a certificate.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  What is in each file
                </Text>
                <Text as="p" variant="bodyMd">
                  Scan results: one row per product, with the pass, fail or not-applicable status of every product
                  check and the time of the scan.
                </Text>
                <Text as="p" variant="bodyMd">
                  Change log: every field the app wrote, with the old value, the new value, the time and the source
                  (bulk editor, CSV import or default).
                </Text>
                <Text as="p" variant="bodyMd">
                  Scan summary: the score, per-check counts, store-level checks, price history status and the
                  products with the most failing checks.
                </Text>
                <Text as="p" variant="bodyMd">
                  Self-audit record: the date and your answers, with the note that it is not a certificate.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {AUDIT_RECORD_NOTE}
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Recent changes
                </Text>
                {data.recentChanges.length === 0 ? (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    No changes recorded yet.
                  </Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                    headings={["Product", "Field", "Old value", "New value", "When", "Source"]}
                    rows={data.recentChanges}
                  />
                )}
                <Text as="p" variant="bodySm" tone="subdued">
                  {data.changeCount} change{data.changeCount === 1 ? "" : "s"} recorded in total.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Current state
                </Text>
                <Text as="p" variant="bodyMd">
                  {data.passing} of {data.productCount} products pass every product check.
                </Text>
                <Text as="p" variant="bodyMd">
                  Last scan: {data.scannedAt ? formatDateTime(new Date(data.scannedAt)) : "no scan yet"}.
                </Text>
                <Text as="p" variant="bodyMd">
                  Last self-audit: {data.audit ? formatShortDate(new Date(data.audit)) : "none recorded"}.
                </Text>
              </BlockStack>
            </Card>
            <ChecklistDisclaimer />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
