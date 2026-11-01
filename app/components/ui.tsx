/**
 * Small shared UI pieces. Every screen that shows a score renders
 * <ChecklistDisclaimer /> so the disclaimer cannot be forgotten.
 */
import { Badge, Banner, BlockStack, Box, Card, InlineStack, Text } from "@shopify/polaris";
import {
  DISCLAIMER,
  PRICE_HISTORY_INSTALL_BY,
  commencementLine,
  countdownLabel,
  formatShortDate,
} from "~/domain/copy";
import type { RuleResult, RuleStatus } from "~/domain/types";

export function ChecklistDisclaimer() {
  return (
    <Box paddingBlockStart="200">
      <Text as="p" variant="bodySm" tone="subdued">
        {DISCLAIMER}
      </Text>
    </Box>
  );
}

/**
 * Audit item L2: there is no single commencement date for the regime. The core
 * Legal Metrology declarations and the 2020 E-Commerce Rules are operative now;
 * the unit sale price has applied since 1 January 2024; only the 2026 prior-price
 * and self-audit provisions carry the supplied 1 January 2027 date, and that date
 * is not Gazette-verified here. The banner therefore says all of that instead of
 * implying nothing applies yet.
 */
export function DeadlineBanner({ now }: { now?: Date }) {
  const date = now ?? new Date();
  return (
    <Banner tone="info" title="Some duties apply now, and the 2026 changes are still to come">
      <BlockStack gap="200">
        <Text as="p" variant="bodyMd">
          {commencementLine()}
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {countdownLabel(date)} Installing by {formatShortDate(PRICE_HISTORY_INSTALL_BY)} gives the prior price
          block a full 30 days of price history on that supplied date. Until a complete lookback exists the block
          publishes nothing rather than a shorter-period figure.
        </Text>
      </BlockStack>
    </Banner>
  );
}

export function statusBadge(status: RuleStatus) {
  if (status === "pass") return <Badge tone="success">Pass</Badge>;
  if (status === "fail") return <Badge tone="critical">Fail</Badge>;
  if (status === "inconclusive") return <Badge tone="attention">Unverified</Badge>;
  return <Badge>Not applicable</Badge>;
}

/**
 * Shown wherever a score is displayed when at least one check could not be
 * determined. It explains, in the merchant's words, why the score is not
 * lowered by a check the app could not look at.
 */
export function InconclusiveNotice({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Banner tone="warning" title={`${count} product${count === 1 ? "" : "s"} left out of the score`}>
      <BlockStack gap="200">
        <Text as="p" variant="bodyMd">
          A check on these products could not be verified, usually because the storefront block could not be seen
          (a password-protected or unreachable storefront). They are not counted as failures and do not lower your
          score. Confirm the blocks in Store settings, or check again once the storefront is public.
        </Text>
      </BlockStack>
    </Banner>
  );
}

export function scoreBadge(percent: number) {
  if (percent >= 100) return <Badge tone="success">{"100%"}</Badge>;
  if (percent >= 80) return <Badge tone="warning">{`${percent}%`}</Badge>;
  return <Badge tone="critical">{`${percent}%`}</Badge>;
}

export function RuleResultList({ results }: { results: RuleResult[] }) {
  return (
    <BlockStack gap="200">
      {results.map((result) => (
        <InlineStack key={result.ruleId} gap="200" align="start" blockAlign="start" wrap>
          <Box minWidth="34px">
            <Text as="span" variant="bodySm" fontWeight="medium">
              {result.ruleId}
            </Text>
          </Box>
          {statusBadge(result.status)}
          <Box maxWidth="560px">
            <Text
              as="span"
              variant="bodySm"
              tone={result.status === "fail" ? "critical" : result.status === "inconclusive" ? "caution" : "subdued"}
            >
              {result.message}
            </Text>
          </Box>
        </InlineStack>
      ))}
    </BlockStack>
  );
}

export function StatCard({
  label,
  value,
  helpText,
  tone,
}: {
  label: string;
  value: string | number;
  helpText?: string;
  tone?: "success" | "critical" | "warning";
}) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="span" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <InlineStack gap="200" blockAlign="center">
          <Text as="p" variant="headingLg">
            {value}
          </Text>
          {tone === "success" ? <Badge tone="success">Good</Badge> : null}
          {tone === "critical" ? <Badge tone="critical">Action needed</Badge> : null}
          {tone === "warning" ? <Badge tone="warning">Check</Badge> : null}
        </InlineStack>
        {helpText ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {helpText}
          </Text>
        ) : null}
      </BlockStack>
    </Card>
  );
}
