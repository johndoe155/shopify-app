/**
 * Dashboard (F2 + section 8). Score, per-rule counts, filterable failing list,
 * store-level rule status, the history-incomplete flag, the 11-month audit
 * reminder, the countdown and the plan/usage indicator.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useLoaderData, useNavigation, useSearchParams, useSubmit } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  DataTable,
  InlineStack,
  Layout,
  Page,
  Pagination,
  ProgressBar,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useCallback, useState } from "react";
import { requireAppContext } from "~/context.server";
import { loadScanReport, filterFailingProducts } from "~/services/report.server";
import { INCONCLUSIVE_FILTER } from "~/domain/filters";
import { readConfig } from "~/config.server";
import { usageFor } from "~/domain/plans";
import { auditReminderDue } from "~/domain/self-audit";
import { RULES_CONFIG, ruleEntries } from "~/domain/rules";
import {
  formatDateTime,
  formatShortDate,
  countdownLabel,
  PRICE_HISTORY_INSTALL_BY,
} from "~/domain/copy";
import {
  ChecklistDisclaimer,
  DeadlineBanner,
  InconclusiveNotice,
  RuleResultList,
  StatCard,
  scoreBadge,
} from "~/components/ui";
import { detectStorefrontBlocks } from "~/services/blocks.server";
import { getCatalogue } from "~/services/catalogue-access.server";
import { runScan } from "~/services/scan.server";
import { publishPriorPrices } from "~/services/price-history.server";
import { enqueueJob } from "~/jobs/worker.server";
import { toStoreFacts } from "~/db/types";

const PAGE_SIZE = 25;

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireAppContext(request);
  const url = new URL(request.url);
  // First visit after an install or a reinstall: show the welcome screen, whose
  // "Start the scan" button records that onboarding is done. Nothing else linked
  // to /app/welcome, so no install ever saw it. The query string is kept because
  // it carries the embedded-app parameters (shop, host, embedded, id_token).
  if (!ctx.shop.onboardingCompletedAt) {
    return redirect(`/app/welcome${url.search}`);
  }
  const report = await loadScanReport(ctx);
  const now = new Date();
  const audit = await ctx.repo.latestAuditRecord(ctx.shop.id);
  const usage = usageFor(ctx.shop.plan, ctx.shop.lastScanProductCount || report.summary.totalProducts);
  const blocks = toStoreFacts(ctx.shop, ctx.shop.blocksDetected).blocks;

  const ruleId = url.searchParams.get("rule");
  const query = url.searchParams.get("q") ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const failing = filterFailingProducts(report.products, { ruleId, query });
  const pageCount = Math.max(1, Math.ceil(failing.length / PAGE_SIZE));

  return {
    demo: ctx.mode === "demo",
    shopDomain: ctx.shopDomain,
    score: report.summary.scorePercent,
    rawScore: report.summary.rawScorePercent,
    passing: report.summary.passingProducts,
    failing: report.summary.failingProducts,
    inconclusive: report.summary.inconclusiveProducts,
    scoredProducts: report.summary.scoredProducts,
    totalProducts: report.summary.totalProducts,
    byRule: report.summary.byRule,
    storeResults: report.storeResults,
    scannedAt: report.scannedAt,
    priceHistory: {
      complete: report.priceHistory.complete,
      completeBy: report.priceHistory.completeBy.toISOString(),
      daysTracked: report.priceHistory.daysTracked,
    },
    usage: {
      planName: usage.planName,
      message: usage.message,
      overLimit: usage.overLimit,
      percentUsed: usage.percentUsed,
      limit: usage.limit,
      used: usage.used,
    },
    auditReminderDue: auditReminderDue(audit?.completedAt ?? null, now),
    auditCompletedAt: audit?.completedAt?.toISOString() ?? null,
    // Only prompt when everything was actually checked: a 100% score that leaves
    // products unverified is not the moment to ask for a review.
    reviewPrompt:
      report.summary.scorePercent === 100 &&
      report.summary.inconclusiveProducts === 0 &&
      report.summary.totalProducts > 0 &&
      !ctx.shop.reviewPromptShown,
    blocks,
    countdown: countdownLabel(now),
    installBy: formatShortDate(PRICE_HISTORY_INSTALL_BY),
    ruleFilter: ruleId,
    query,
    page,
    pageCount,
    failingProducts: failing.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((product) => ({
      handle: product.handle,
      title: product.title,
      vendor: product.vendor,
      status: product.status,
      failingRuleIds: product.failingRuleIds,
      inconclusiveRuleIds: product.inconclusiveRuleIds,
    })),
    failingCount: failing.length,
    rulesVersion: RULES_CONFIG.version,
    reviewUrl: readConfig().reviewUrl,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const ctx = await requireAppContext(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "rescan") {
    if (ctx.mode === "demo") {
      await runScan({ shop: ctx.shop, repo: ctx.repo, catalog: ctx.catalog });
      await publishPriorPrices({ shop: ctx.shop, repo: ctx.repo, catalog: ctx.catalog, writer: ctx.writer });
    } else {
      // A fresh key per click: two clicks queue two scans, and each individual
      // job is still idempotent by key. The job is persisted (durable queue) before
      // this action returns.
      await enqueueJob("nightly-scan", { shopDomain: ctx.shopDomain }, `manual-scan:${ctx.shopDomain}:${Date.now()}`);
    }
    return Response.json({ ok: true });
  }

  if (intent === "check-blocks") {
    // Cached snapshot first: a block check should not cost a bulk operation if
    // the catalogue was read moments ago (see catalogue-access.server.ts).
    const products = await getCatalogue({
      shopDomain: ctx.shopDomain,
      repo: ctx.repo,
      catalog: ctx.catalog,
      ttlMs: ctx.mode === "demo" ? 0 : undefined,
    });
    const detection = await detectStorefrontBlocks({
      shopDomain: ctx.shopDomain,
      productHandle: products.find((product) => product.status === "ACTIVE")?.handle ?? null,
    });
    await ctx.repo.setDetectedBlocks(ctx.shop.id, detection.blocks, new Date());
    if (detection.reachable) {
      return Response.json({ ok: true, blocks: detection.blocks });
    }
    return Response.json(
      {
        ok: false,
        message:
          "We could not load your storefront, so the block check could not run. Confirm the blocks in Store settings, or check again once the storefront is public.",
      },
      { status: 200 },
    );
  }

  if (intent === "confirm-block") {
    const block = String(form.get("block") ?? "");
    const value = form.get("value") === "true";
    const patch =
      block === "declarations"
        ? { confirmDeclarationsBlock: value }
        : block === "grievance"
          ? { confirmGrievanceBlock: value }
          : block === "priorPrice"
            ? { confirmPriorPriceBlock: value }
            : null;
    if (patch) await ctx.repo.updateShop(ctx.shop.id, patch);
    return Response.json({ ok: true });
  }

  if (intent === "review-shown") {
    await ctx.repo.updateShop(ctx.shop.id, { reviewPromptShown: true, reviewPromptShownAt: new Date() });
    return Response.json({ ok: true });
  }

  if (intent === "complete-onboarding") {
    await ctx.repo.updateShop(ctx.shop.id, { onboardingCompletedAt: new Date() });
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, message: "Unknown action." }, { status: 400 });
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const submit = useSubmit();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [query, setQuery] = useState(data.query);

  const onFilter = useCallback(
    (value: string) => {
      const next = new URLSearchParams(searchParams);
      if (value) next.set("rule", value);
      else next.delete("rule");
      next.delete("page");
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const ruleOptions = [
    { label: "All products needing attention", value: "" },
    ...(data.inconclusive > 0
      ? [{ label: "Awaiting verification (not counted as failures)", value: INCONCLUSIVE_FILTER }]
      : []),
    ...ruleEntries().map((rule) => ({ label: `${rule.id} ${rule.label}`, value: rule.id })),
  ];

  const perRuleRows = data.byRule.map((rule) => [
    rule.ruleId,
    rule.label,
    rule.level === "product" ? "Product" : "Store",
    String(rule.fail),
    String(rule.inconclusive),
    String(rule.pass),
    String(rule.notApplicable),
  ]);

  return (
    <Page
      title="Listing checks"
      subtitle={
        data.scannedAt
          ? `Last scan ${formatDateTime(new Date(data.scannedAt))} · checklist ${data.rulesVersion}`
          : "No scan has completed yet."
      }
      primaryAction={{
        content: busy ? "Working…" : "Rescan catalogue",
        onAction: () => submit({ intent: "rescan" }, { method: "post" }),
        loading: busy,
      }}
      secondaryActions={[
        { content: "Bulk editor", url: "/app/bulk-editor" },
        { content: "Check my storefront blocks", onAction: () => submit({ intent: "check-blocks" }, { method: "post" }) },
      ]}
    >
      <BlockStack gap="400">
        <DeadlineBanner />
        <InconclusiveNotice count={data.inconclusive} />
        <Text as="p" variant="bodySm" tone="subdued">
          Install by {data.installBy} to have a full 30 days of price history in place before the supplied 2026
          commencement date. The core declarations and the 2020 E-Commerce Rules apply now, not from that date.
        </Text>

        {data.usage.overLimit ? (
          <Banner tone="warning" title={`You are over your ${data.usage.planName} plan limit`}>
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                {data.usage.message}
              </Text>
              <Link to="/app/billing">See plans</Link>
            </BlockStack>
          </Banner>
        ) : null}

        {!data.priceHistory.complete ? (
          <Banner tone="warning" title="Price history is incomplete">
            <Text as="p" variant="bodyMd">
              Price tracking started on install. A complete 30-day lookback exists from{" "}
              {formatShortDate(new Date(data.priceHistory.completeBy))}. Until then no prior price is published
              for reductions made in the meantime: a shorter history does not meet the lookback the rule
              describes, so the block shows nothing rather than a partial figure.
            </Text>
          </Banner>
        ) : null}

        {data.auditReminderDue ? (
          <Banner tone="info" title="Time to repeat the dark-pattern self-audit" action={{ content: "Open self-audit", url: "/app/audit" }}>
            <Text as="p" variant="bodyMd">
              The last self-audit was recorded on{" "}
              {data.auditCompletedAt ? formatShortDate(new Date(data.auditCompletedAt)) : "an earlier date"}. It is
              due again at 12 months.
            </Text>
          </Banner>
        ) : null}

        {data.reviewPrompt ? (
          <Banner
            tone="success"
            title="Every product now passes the checklist"
            action={
              // No invented review link: the button appears only when the
              // deployment has set SHOPIFY_APP_REVIEW_URL, because the generic
              // App Store home page is not a review link for this app.
              data.reviewUrl
                ? { content: "Leave a review", url: data.reviewUrl, external: true }
                : undefined
            }
          >
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                This is shown once. Reviews are never incentivised.
              </Text>
              <Form method="post">
                <input type="hidden" name="intent" value="review-shown" />
                <Button submit variant="plain">
                  Don&apos;t show this again
                </Button>
              </Form>
            </BlockStack>
          </Banner>
        ) : null}

        <Layout>
          <Layout.Section>
            <BlockStack gap="300">
              <InlineStack gap="300" wrap>
                <Box minWidth="220px">
                  <StatCard
                    label="Products passing every check"
                    value={`${data.passing} / ${data.totalProducts}`}
                    helpText={`${data.score}% of the catalogue`}
                    tone={data.score === 100 ? "success" : "critical"}
                  />
                </Box>
                <Box minWidth="220px">
                  <StatCard
                    label="Products failing at least one check"
                    value={data.failing}
                    tone={data.failing > 0 ? "critical" : "success"}
                  />
                </Box>
                <Box minWidth="220px">
                  <StatCard
                    label="Awaiting verification"
                    value={data.inconclusive}
                    helpText={
                      data.inconclusive > 0
                        ? "A check could not be verified. Left out of the score; not a failure."
                        : "Every applicable check could be verified."
                    }
                    tone={data.inconclusive > 0 ? "warning" : "success"}
                  />
                </Box>
                <Box minWidth="220px">
                  <StatCard
                    label={`${data.usage.planName} plan usage`}
                    value={data.usage.limit === null ? `${data.usage.used} / unlimited` : `${data.usage.used} / ${data.usage.limit}`}
                    helpText={data.usage.overLimit ? "Scanning and editing are limited to the plan's product count." : data.usage.message}
                    tone={data.usage.overLimit ? "warning" : undefined}
                  />
                </Box>
              </InlineStack>

              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Catalogue score
                    </Text>
                    {scoreBadge(data.score)}
                  </InlineStack>
                  <ProgressBar progress={data.score} size="large" tone={data.score === 100 ? "success" : "primary"} />
                  <Text as="p" variant="bodySm" tone="subdued">
                    {data.inconclusive > 0
                      ? `The score is ${data.passing} of ${data.scoredProducts} products that could be fully checked. ${data.inconclusive} product${data.inconclusive === 1 ? "" : "s"} with a check the app could not verify ${data.inconclusive === 1 ? "is" : "are"} left out of the score, so an unverifiable block check cannot lower it.`
                      : `The score is ${data.passing} of ${data.totalProducts} products.`}
                  </Text>
                  <ChecklistDisclaimer />
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Store-level checks
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              These are evaluated from your store settings, the storefront block check and your self-audit record.
            </Text>
            <RuleResultList results={data.storeResults} />
            <InlineStack gap="200" wrap>
              <Button url="/app/settings">Store settings</Button>
              <Button url="/app/audit">Self-audit</Button>
              <Button onClick={() => submit({ intent: "check-blocks" }, { method: "post" })}>Check storefront blocks</Button>
            </InlineStack>
            <InlineStack gap="300" wrap>
              <Text as="p" variant="bodySm" tone="subdued">Unknown means the sampled pages could not verify placement, not that the block is absent. Check each relevant template and confirm it in Store settings.</Text>
              <Badge tone={data.blocks.grievance === "unknown" ? "attention" : data.blocks.grievance === "not_found" ? "critical" : "success"}>
                {`Grievance block: ${data.blocks.grievance.replace("_", " ")}`}
              </Badge>
              <Badge tone={data.blocks.declarations === "unknown" ? "attention" : data.blocks.declarations === "not_found" ? "critical" : "success"}>
                {`Declarations block: ${data.blocks.declarations.replace("_", " ")}`}
              </Badge>
              <Badge tone={data.blocks.priorPrice === "unknown" ? "attention" : data.blocks.priorPrice === "not_found" ? "critical" : "success"}>
                {`Prior price block: ${data.blocks.priorPrice.replace("_", " ")}`}
              </Badge>
            </InlineStack>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                If we cannot load your storefront (for example, it is password protected), confirm here instead.
              </Text>
              <Form method="post">
                <input type="hidden" name="intent" value="confirm-block" />
                <input type="hidden" name="block" value="grievance" />
                <input type="hidden" name="value" value={data.blocks.grievance === "confirmed_manual" ? "false" : "true"} />
                <Button submit variant="plain">
                  {data.blocks.grievance === "confirmed_manual"
                    ? "I have removed the grievance block"
                    : "I have added the grievance officer block"}
                </Button>
              </Form>
            </BlockStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Failing checks by rule
            </Text>
            <DataTable
              columnContentTypes={["text", "text", "text", "numeric", "numeric", "numeric", "numeric"]}
              headings={["Rule", "Check", "Level", "Failing", "Unverified", "Passing", "Not applicable"]}
              rows={perRuleRows}
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
              <Text as="h2" variant="headingMd">
                Products to fix ({data.failingCount})
              </Text>
              <InlineStack gap="200" blockAlign="end">
                <Box minWidth="240px">
                  <Select label="Filter by rule" labelHidden options={ruleOptions} value={data.ruleFilter ?? ""} onChange={onFilter} />
                </Box>
                <Box minWidth="240px">
                  <Form method="get">
                    <TextField
                      label="Search products"
                      labelHidden
                      name="q"
                      value={query}
                      onChange={setQuery}
                      autoComplete="off"
                      placeholder="Search title, handle or vendor"
                      connectedRight={<Button submit>Search</Button>}
                    />
                    {data.ruleFilter ? <input type="hidden" name="rule" value={data.ruleFilter} /> : null}
                  </Form>
                </Box>
              </InlineStack>
            </InlineStack>

            {data.failingProducts.length === 0 ? (
              <Text as="p" variant="bodyMd" tone="subdued">
                Nothing to show. Either every product passes, or the filter is too narrow.
              </Text>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text"]}
                headings={["Product", "Vendor", "Failing checks"]}
                rows={data.failingProducts.map((product) => [
                  <Link key={product.handle} to={`/app/bulk-editor?q=${encodeURIComponent(product.handle)}`}>
                    {product.title}
                  </Link>,
                  product.vendor ?? "—",
                  [
                    product.failingRuleIds.join(", "),
                    product.inconclusiveRuleIds.length > 0
                      ? `${product.inconclusiveRuleIds.join(", ")} (unverified)`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · "),
                ])}
              />
            )}

            {data.pageCount > 1 ? (
              <InlineStack align="center">
                <Pagination
                  hasPrevious={data.page > 1}
                  onPrevious={() => {
                    const next = new URLSearchParams(searchParams);
                    next.set("page", String(data.page - 1));
                    setSearchParams(next);
                  }}
                  hasNext={data.page < data.pageCount}
                  onNext={() => {
                    const next = new URLSearchParams(searchParams);
                    next.set("page", String(data.page + 1));
                    setSearchParams(next);
                  }}
                />
                <Text as="span" variant="bodySm" tone="subdued">
                  Page {data.page} of {data.pageCount}
                </Text>
              </InlineStack>
            ) : null}
            <ButtonGroup>
              <Button url="/app/bulk-editor">Fix in bulk</Button>
              <Button url="/app/exports">Download evidence</Button>
            </ButtonGroup>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
