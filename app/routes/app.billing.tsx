/**
 * F9 — plan selection, upgrade/downgrade and cancellation handling.
 * Plans come from `~/domain/plans`; Shopify Billing is the source of truth for
 * what the shop is actually paying. The app never upgrades a shop by itself.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { Badge, Banner, BlockStack, Box, Button, Card, InlineStack, Layout, Page, Text } from "@shopify/polaris";
import { requireAppContext } from "~/context.server";
import { PLANS, getPlan, usageFor, type BillingInterval, type PlanId } from "~/domain/plans";
import { billingPlanName, markSubscriptionCancelled, planDisplay } from "~/services/billing.server";
import { ChecklistDisclaimer } from "~/components/ui";
import { formatShortDate } from "~/domain/copy";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireAppContext(request);
  const usage = usageFor(ctx.shop.plan, ctx.shop.lastScanProductCount);
  const display = planDisplay(ctx.shop);
  return {
    demo: ctx.mode === "demo",
    currentPlan: ctx.shop.plan,
    display,
    trialEndsAt: ctx.shop.trialEndsAt?.toISOString() ?? null,
    usage: {
      message: usage.message,
      overLimit: usage.overLimit,
      used: usage.used,
      limit: usage.limit,
      upgradeTo: usage.upgradeTo,
    },
    plans: PLANS.map((plan) => ({
      id: plan.id,
      name: plan.name,
      monthlyUsd: plan.monthlyUsd,
      annualUsd: plan.annualUsd,
      productLimit: plan.productLimit,
      trialDays: plan.trialDays,
    })),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const ctx = await requireAppContext(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "select-plan") {
    const planId = String(form.get("planId") ?? "") as PlanId;
    const interval = (String(form.get("interval") ?? "monthly") as BillingInterval) ?? "monthly";
    if (!PLANS.some((plan) => plan.id === planId)) {
      return Response.json({ ok: false, message: "Unknown plan." }, { status: 400 });
    }

    if (planId === "free") {
      // Downgrading to free is handled by cancelling the subscription in Shopify.
      const shop = await markSubscriptionCancelled({ shop: ctx.shop, repo: ctx.repo });
      return Response.json({
        ok: true,
        message:
          "Your paid subscription will end when the current period ends. Nothing has been deleted, and you keep access until then.",
        plan: shop.plan,
      });
    }

    if (ctx.mode === "demo") {
      await ctx.repo.updateShop(ctx.shop.id, {
        plan: planId,
        planStatus: "ACTIVE",
        billingInterval: interval,
        subscriptionId: "gid://shopify/AppSubscription/demo",
      });
      return Response.json({
        ok: true,
        demo: true,
        message: `Preview mode: the ${getPlan(planId).name} plan is now selected. No charge was made, because no Shopify store is connected.`,
      });
    }

    if (!ctx.billing) {
      return Response.json({ ok: false, message: "Billing is not available in this context." }, { status: 400 });
    }

    // Shopify shows its charge confirmation screen. The plan changes only after
    // the merchant confirms the charge, so there is no auto-upgrade anywhere.
    await ctx.billing.request({
      plan: billingPlanName(planId, interval),
      isTest: process.env.NODE_ENV !== "production",
      returnUrl: `${new URL(request.url).origin}/app/billing`,
    });
    return Response.json({ ok: true });
  }

  if (intent === "cancel") {
    await markSubscriptionCancelled({ shop: ctx.shop, repo: ctx.repo });
    return Response.json({
      ok: true,
      message:
        "Recorded. To stop the charge, cancel the app subscription in Shopify admin (Settings → Apps and sales channels). Your data stays until you uninstall.",
    });
  }

  return Response.json({ ok: false, message: "Unknown action." }, { status: 400 });
}

export default function BillingPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | { ok?: boolean; message?: string; demo?: boolean }
    | undefined;

  return (
    <Page title="Plan and usage" subtitle="Every plan includes every feature. Plans differ only by product count.">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.message ? (
              <Banner tone={actionData.ok ? "success" : "critical"}>{actionData.message}</Banner>
            ) : null}

            <Card>
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Current plan
                  </Text>
                  <Badge tone={data.usage.overLimit ? "warning" : "success"}>{data.display.name}</Badge>
                </InlineStack>
                <Text as="p" variant="bodyMd">
                  {data.display.priceLabel} · status {data.display.status.toLowerCase()}
                  {data.trialEndsAt ? ` · trial ends ${formatShortDate(new Date(data.trialEndsAt))}` : ""}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {data.usage.message}
                </Text>
                {data.usage.overLimit && data.usage.upgradeTo ? (
                  <Text as="p" variant="bodyMd" tone="critical">
                    The plan that covers {data.usage.used} products is{" "}
                    {getPlan(data.usage.upgradeTo).name}. Nothing has been deleted — your data is all still here.
                  </Text>
                ) : null}
                {data.demo ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Preview mode: choosing a plan updates this screen only. No charge is created and no Shopify
                    subscription is started.
                  </Text>
                ) : null}
              </BlockStack>
            </Card>

            <InlineStack gap="300" wrap>
              {data.plans.map((plan) => {
                const current = plan.id === data.currentPlan;
                return (
                  <Box key={plan.id} minWidth="230px">
                    <Card>
                      <BlockStack gap="200">
                        <InlineStack align="space-between">
                          <Text as="h3" variant="headingMd">
                            {plan.name}
                          </Text>
                          {current ? <Badge tone="info">Current</Badge> : null}
                        </InlineStack>
                        <Text as="p" variant="headingLg">
                          {plan.monthlyUsd === 0 ? "$0" : `$${plan.monthlyUsd}/mo`}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {plan.productLimit === null ? "Unlimited products" : `Up to ${plan.productLimit} products`}
                          {plan.monthlyUsd > 0 ? ` · $${plan.annualUsd}/yr (10x monthly, 2 months free)` : ""}
                          {plan.trialDays > 0 ? ` · ${plan.trialDays}-day trial` : ""}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Everything: scan, bulk editor, theme blocks, self-audit, exports.
                        </Text>
                        {plan.monthlyUsd === 0 ? (
                          <Form method="post">
                            <input type="hidden" name="intent" value="select-plan" />
                            <input type="hidden" name="planId" value={plan.id} />
                            <Button submit disabled={current} variant="secondary">
                              {current ? "Active" : "Cancel paid plan"}
                            </Button>
                          </Form>
                        ) : (
                          <InlineStack gap="200">
                            <Form method="post">
                              <input type="hidden" name="intent" value="select-plan" />
                              <input type="hidden" name="planId" value={plan.id} />
                              <input type="hidden" name="interval" value="monthly" />
                              <Button submit disabled={current} variant={plan.id === "standard" ? "primary" : "secondary"}>
                                Choose monthly
                              </Button>
                            </Form>
                            <Form method="post">
                              <input type="hidden" name="intent" value="select-plan" />
                              <input type="hidden" name="planId" value={plan.id} />
                              <input type="hidden" name="interval" value="annual" />
                              <Button submit disabled={current} variant="secondary">
                                Choose annual
                              </Button>
                            </Form>
                          </InlineStack>
                        )}
                      </BlockStack>
                    </Card>
                  </Box>
                );
              })}
            </InlineStack>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Changing or cancelling
                </Text>
                <Text as="p" variant="bodyMd">
                  Upgrades and downgrades go through Shopify&apos;s charge confirmation screen. The plan changes
                  only after you confirm the charge. The app never upgrades you on its own.
                </Text>
                <Text as="p" variant="bodyMd">
                  To stop billing, cancel the subscription in Shopify admin. Nothing is deleted when you downgrade
                  or cancel; scanning and editing beyond a plan&apos;s product count are simply held until you
                  upgrade.
                </Text>
                <Form method="post">
                  <input type="hidden" name="intent" value="cancel" />
                  <Button submit variant="plain">
                    Record that I have cancelled in Shopify admin
                  </Button>
                </Form>
              </BlockStack>
            </Card>
            <ChecklistDisclaimer />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
