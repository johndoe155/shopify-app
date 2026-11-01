/**
 * Complaint register (R10).
 *
 * Audit item L12: the 2020 E-Commerce Rules require acknowledgement within 48
 * hours and redressal within one month of receipt. Displaying a grievance officer
 * block does not evidence either, so the app keeps an operational record and R10
 * reads it: a complaint left unacknowledged past 48 hours, or unresolved past a
 * month, fails the store check.
 *
 * The register stores only what the merchant types about their own complaint
 * handling. It deliberately does not read customer or order records — the app has
 * no customer scope.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  DataTable,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useState } from "react";
import { requireAppContext } from "~/context.server";
import { complaintEvidence } from "~/db/types";
import { formatDateTime, formatShortDate } from "~/domain/copy";
import { sanitizeText } from "~/domain/validation";
import { ChecklistDisclaimer } from "~/components/ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireAppContext(request);
  const rows = await ctx.repo.listComplaints(ctx.shop.id);
  const evidence = complaintEvidence(rows);
  return {
    rows: rows.map((row) => ({
      id: row.id,
      receivedAt: row.receivedAt.toISOString(),
      acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      channel: row.channel,
      reference: row.reference,
      summary: row.summary,
    })),
    evidence,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const ctx = await requireAppContext(request);
  const form = await request.formData();
  const get = (key: string) => String(form.get(key) ?? "").trim();

  const reference = sanitizeText(get("reference"), 120);
  if (!reference) {
    return { ok: false, errors: ["Enter a reference so the complaint can be identified."] };
  }
  const receivedAt = parseDate(get("receivedAt"));
  if (!receivedAt) {
    return { ok: false, errors: ["Enter the date the complaint was received."] };
  }
  const acknowledgedAt = parseDate(get("acknowledgedAt"));
  const resolvedAt = parseDate(get("resolvedAt"));
  if (acknowledgedAt && acknowledgedAt.getTime() < receivedAt.getTime()) {
    return { ok: false, errors: ["The acknowledgement date cannot be before the received date."] };
  }
  if (resolvedAt && acknowledgedAt && resolvedAt.getTime() < acknowledgedAt.getTime()) {
    return { ok: false, errors: ["The resolution date cannot be before the acknowledgement date."] };
  }

  await ctx.repo.createComplaint(ctx.shop.id, {
    receivedAt,
    acknowledgedAt,
    resolvedAt,
    channel: sanitizeText(get("channel"), 40) ?? "email",
    reference,
    summary: sanitizeText(get("summary"), 500),
  });

  return { ok: true, errors: [] as string[] };
}

function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

const CHANNELS = [
  { label: "Email", value: "email" },
  { label: "Phone", value: "phone" },
  { label: "Web form", value: "web_form" },
  { label: "Marketplace", value: "marketplace" },
  { label: "Post", value: "post" },
];

export default function ComplaintsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const [channel, setChannel] = useState("email");

  const rows = data.rows.map((row) => [
    row.reference,
    formatShortDate(new Date(row.receivedAt)),
    row.acknowledgedAt ? formatShortDate(new Date(row.acknowledgedAt)) : "not yet",
    row.resolvedAt ? formatShortDate(new Date(row.resolvedAt)) : "open",
    row.channel,
  ]);

  return (
    <Page
      title="Complaint register"
      subtitle="Evidence that complaints are acknowledged within 48 hours and redressed within one month."
      backAction={{ url: "/app/settings" }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData && !actionData.ok ? (
              <Banner tone="critical" title="The complaint was not saved">
                <BlockStack gap="100">
                  {actionData.errors.map((error) => (
                    <Text as="p" key={error} variant="bodySm">
                      {error}
                    </Text>
                  ))}
                </BlockStack>
              </Banner>
            ) : null}
            {actionData?.ok ? (
              <Banner tone="success" title="Complaint recorded">
                <Text as="p" variant="bodyMd">
                  R10 now has evidence for this complaint&apos;s acknowledgement and redressal timings.
                </Text>
              </Banner>
            ) : null}

            <Banner tone="info" title="Why this screen exists">
              <Text as="p" variant="bodyMd">
                The grievance officer block displays the officer&apos;s details. It does not show that complaints
                are answered in time, and neither the app nor Shopify can observe that automatically. Record
                each complaint here as it arrives; R10 fails while any complaint is past 48 hours without an
                acknowledgement or past one month without a resolution.
              </Text>
            </Banner>

            <Card>
              <Form method="post">
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Record a complaint
                </Text>
                <InlineStack gap="300" wrap>
                  <TextField
                    label="Reference"
                    name="reference"
                    autoComplete="off"
                    placeholder="Ticket or email subject"
                  />
                  <TextField label="Received on" name="receivedAt" type="date" autoComplete="off" />
                  <TextField label="Acknowledged on" name="acknowledgedAt" type="date" autoComplete="off" />
                  <TextField label="Resolved on" name="resolvedAt" type="date" autoComplete="off" />
                </InlineStack>
                <Select label="Channel" name="channel" options={CHANNELS} value={channel} onChange={setChannel} />
                <TextField label="Short summary" name="summary" autoComplete="off" multiline={2} />
                <Text as="p" variant="bodySm" tone="subdued">
                  Leave the acknowledgement or resolution date blank while it is still pending. Do not record
                  customer names, addresses or order details: the app is not designed to hold them.
                </Text>
                <Button submit variant="primary" loading={busy}>
                  Save complaint
                </Button>
              </BlockStack>
              </Form>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Complaint timings
                </Text>
                <InlineStack gap="400" wrap>
                  <Text as="p" variant="bodyMd">
                    Total recorded: {data.evidence.total}
                  </Text>
                  <Text as="p" variant="bodyMd">
                    Still open: {data.evidence.open}
                  </Text>
                  <Text as="p" variant="bodyMd">
                    Late acknowledgement: {data.evidence.overdueAcknowledgement}
                  </Text>
                  <Text as="p" variant="bodyMd">
                    Late resolution: {data.evidence.overdueResolution}
                  </Text>
                </InlineStack>
                {data.evidence.lastReceivedAt ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Most recent complaint received{" "}
                    {formatDateTime(new Date(data.evidence.lastReceivedAt))}.
                  </Text>
                ) : null}
                {rows.length === 0 ? (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    No complaints recorded yet. R10 passes on the timings while the register is empty, and says
                    so.
                  </Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "text"]}
                    headings={["Reference", "Received", "Acknowledged", "Resolved", "Channel"]}
                    rows={rows}
                  />
                )}
              </BlockStack>
            </Card>
            <ChecklistDisclaimer />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
