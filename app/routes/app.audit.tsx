/**
 * F7 — dark-pattern self-audit: 13 yes/no items, one per pattern in India's 2023
 * dark patterns guidelines, each with a notes field. Saves a dated record and
 * reminds the merchant at 11 months (the banner lives on the dashboard).
 * The record is the merchant's own answers. It is never a certificate.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Divider,
  InlineStack,
  Layout,
  Page,
  RadioButton,
  Text,
  TextField,
} from "@shopify/polaris";
import { useState } from "react";
import { requireAppContext } from "~/context.server";
import {
  AUDIT_CERTIFICATE_NOTE,
  AUDIT_CYCLE_IS_PRODUCT_POLICY,
  AUDIT_ITEMS,
  summariseAudit,
  validateAuditSubmission,
  type AuditAnswer,
} from "~/domain/self-audit";
import { AUDIT_RECORD_NOTE, formatDateTime, formatShortDate } from "~/domain/copy";
import { ChecklistDisclaimer } from "~/components/ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireAppContext(request);
  const record = await ctx.repo.latestAuditRecord(ctx.shop.id);
  const answers = ((record?.answers as { answers?: AuditAnswer[] } | null)?.answers ?? []) as AuditAnswer[];
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  return {
    items: AUDIT_ITEMS.map((item) => ({
      ...item,
      answer: byId.get(item.id)?.answer === true ? "yes" : byId.get(item.id)?.answer === false ? "no" : "",
      notes: byId.get(item.id)?.notes ?? "",
    })),
    lastRecord: record
      ? {
          completedAt: record.completedAt.toISOString(),
          id: record.id,
          summary: summariseAudit(answers, record.completedAt),
        }
      : null,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const ctx = await requireAppContext(request);
  const form = await request.formData();
  const payload: Record<string, { answer: string; notes: string }> = {};
  for (const item of AUDIT_ITEMS) {
    payload[item.id] = {
      answer: String(form.get(`${item.id}_answer`) ?? ""),
      notes: String(form.get(`${item.id}_notes`) ?? ""),
    };
  }
  const validation = validateAuditSubmission(payload);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  const completedAt = new Date();
  const record = await ctx.repo.saveAuditRecord(ctx.shop.id, { answers: validation.answers }, completedAt);
  return { ok: true, errors: [], completedAt: record.completedAt.toISOString(), id: record.id };
}

export default function AuditPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const [answers, setAnswers] = useState<Record<string, string>>(
    Object.fromEntries(data.items.map((item) => [item.id, item.answer])),
  );

  return (
    <Page
      title="Dark-pattern self-audit"
      subtitle="Thirteen yes/no questions, one per pattern named in India's 2023 dark patterns guidelines."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.ok ? (
              <Banner tone="success" title="Self-audit saved">
                <Text as="p" variant="bodyMd">
                  Recorded on {formatDateTime(new Date(actionData.completedAt ?? Date.now()))}. The app will remind
                  you at 11 months; that reminder and the 12-month cycle are this app&apos;s own policy, not a period
                  set by the dark-pattern guidelines, and the record is not a certificate.
                </Text>
              </Banner>
            ) : null}
            {actionData && !actionData.ok ? (
              <Banner tone="critical" title="Answer every question">
                <BlockStack gap="100">
                  {actionData.errors.map((error) => (
                    <Text as="p" key={error} variant="bodySm">
                      {error}
                    </Text>
                  ))}
                </BlockStack>
              </Banner>
            ) : null}

            <Banner tone="info" title="What this record is">
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd">
                  {AUDIT_RECORD_NOTE}
                </Text>
                <Text as="p" variant="bodySm">
                  {AUDIT_CERTIFICATE_NOTE}
                </Text>
              </BlockStack>
            </Banner>

            <Form method="post">
              <BlockStack gap="400">
                {data.items.map((item, index) => (
                  <Card key={item.id}>
                    <BlockStack gap="200">
                      <Text as="h2" variant="headingSm">
                        {index + 1}. {item.pattern}
                      </Text>
                      <Text as="p" variant="bodyMd">
                        {item.question}
                      </Text>
                      <InlineStack gap="400">
                        <RadioButton
                          label="Yes"
                          name={`${item.id}_answer`}
                          value="yes"
                          id={`${item.id}-yes`}
                          checked={answers[item.id] === "yes"}
                          onChange={() => setAnswers((current) => ({ ...current, [item.id]: "yes" }))}
                        />
                        <RadioButton
                          label="No"
                          name={`${item.id}_answer`}
                          value="no"
                          id={`${item.id}-no`}
                          checked={answers[item.id] === "no"}
                          onChange={() => setAnswers((current) => ({ ...current, [item.id]: "no" }))}
                        />
                      </InlineStack>
                      <TextField
                        label="Notes"
                        name={`${item.id}_notes`}
                        value={item.notes}
                        autoComplete="off"
                        multiline={2}
                        helpText={item.notesHint}
                        onChange={() => undefined}
                        readOnly={false}
                      />
                    </BlockStack>
                  </Card>
                ))}
                <InlineStack gap="200">
                  <Button submit variant="primary" loading={busy}>
                    Save self-audit
                  </Button>
                  <Button url="/app" variant="plain">
                    Back to dashboard
                  </Button>
                </InlineStack>
              </BlockStack>
            </Form>
            <ChecklistDisclaimer />
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingSm">
                Latest record
              </Text>
              {data.lastRecord ? (
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd">
                    Completed {formatShortDate(new Date(data.lastRecord.completedAt))}
                  </Text>
                  <Text as="p" variant="bodySm">
                    {data.lastRecord.summary.yes} answered yes, {data.lastRecord.summary.no} answered no.
                  </Text>
                  <Divider />
                  <Text as="p" variant="bodySm" tone="subdued">
                    {AUDIT_RECORD_NOTE}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {AUDIT_CERTIFICATE_NOTE}
                  </Text>
                  <Button url="/exports/audit.pdf">Download this record (PDF)</Button>
                </BlockStack>
              ) : (
                <Text as="p" variant="bodySm" tone="subdued">
                  No self-audit recorded yet. Store check R12 stays failing until one is saved.
                  {AUDIT_CYCLE_IS_PRODUCT_POLICY
                    ? " The 12-month validity shown elsewhere is this app's reminder policy, not a statutory cadence."
                    : ""}
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
