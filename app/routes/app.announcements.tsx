/**
 * Price announcements (R11, audit item L13).
 *
 * The prior price is the lowest price of the good during the 30 days before a
 * reduction was **announced**. The app derives that event when a variant price or
 * a compare-at price moves, because it sees both through the Admin API. It cannot
 * see a discount code or an automatic discount: those are applied at checkout, so
 * no variant price moves and nothing is written to the price history.
 *
 * Those two are therefore not excluded — the audit is explicit that a code or
 * automatic discount that announces a reduction may fall within the rule — they
 * are **recorded here**, with the date, the price the shopper pays, the mechanism
 * and the conditions. A reduction nobody records is still measured, from the
 * announcement the app can derive, and R11 says which of the two it used.
 *
 * The register stores what the merchant types about their own pricing. It does
 * not read customer or order records — the app has no customer scope.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import {
  Banner,
  BlockStack,
  Box,
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
import { useMemo, useState } from "react";
import { requireAppContext } from "~/context.server";
import { getCatalogue } from "~/services/catalogue-access.server";
import { publishPriorPrices } from "~/services/price-history.server";
import { publishWindowKey } from "~/services/webhooks.server";
import { enqueueJob } from "~/jobs/worker.server";
import {
  PRICE_ANNOUNCEMENT_MECHANISMS,
  PRICE_ANNOUNCEMENT_MECHANISM_LABELS,
  isPriceAnnouncementMechanism,
  type PriceAnnouncementMechanism,
} from "~/domain/types";
import { parseMoney, sanitizeText } from "~/domain/validation";
import { formatInr, formatShortDate } from "~/domain/copy";
import { ChecklistDisclaimer } from "~/components/ui";

interface ProductOption {
  productId: string;
  title: string;
  variants: Array<{ variantId: string; title: string; price: number; compareAtPrice: number | null }>;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireAppContext(request);
  const [announcements, products] = await Promise.all([
    ctx.repo.listPriceAnnouncements(ctx.shop.id),
    getCatalogue({
      shopDomain: ctx.shopDomain,
      repo: ctx.repo,
      catalog: ctx.catalog,
      ttlMs: ctx.mode === "demo" ? 0 : undefined,
    }),
  ]);

  const titles = new Map(products.map((product) => [product.productId, product.title]));
  const variantTitles = new Map<string, string>();
  for (const product of products) {
    for (const variant of product.variants) variantTitles.set(variant.variantId, variant.title);
  }

  return {
    demo: ctx.mode === "demo",
    today: new Date().toISOString().slice(0, 10),
    // Only products that can show a prior price: something is reduced on them, or
    // an announcement has already been recorded. A dropdown of every product in a
    // 5,000-product catalogue helps nobody.
    products: products
      .filter(
        (product) =>
          product.variants.some((variant) => variant.compareAtPrice !== null && variant.compareAtPrice > variant.price) ||
          announcements.some((row) => row.productId === product.productId),
      )
      .map((product) => ({
        productId: product.productId,
        title: product.title,
        variants: product.variants.map((variant) => ({
          variantId: variant.variantId,
          title: variant.title,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice,
        })),
      })) as ProductOption[],
    announcements: announcements.map((row) => ({
      id: row.id,
      productId: row.productId,
      productTitle: titles.get(row.productId) ?? row.productId,
      variantId: row.variantId,
      variantTitle: row.variantId ? (variantTitles.get(row.variantId) ?? row.variantId) : null,
      announcedAt: row.announcedAt.toISOString(),
      consumerPrice: row.consumerPrice,
      mechanism: row.mechanism,
      conditions: row.conditions,
    })),
    mechanisms: PRICE_ANNOUNCEMENT_MECHANISMS.map((mechanism) => ({
      value: mechanism,
      label: PRICE_ANNOUNCEMENT_MECHANISM_LABELS[mechanism],
    })),
  };
}

function parseDateInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function action({ request }: ActionFunctionArgs) {
  const ctx = await requireAppContext(request);
  const form = await request.formData();
  const get = (key: string) => String(form.get(key) ?? "").trim();
  const intent = get("intent");

  if (intent === "delete") {
    const id = get("id");
    if (!id) return { ok: false, errors: ["The announcement could not be identified."] };
    const removed = await ctx.repo.deletePriceAnnouncement(ctx.shop.id, id);
    if (!removed) return { ok: false, errors: ["That announcement was already removed."] };
    await refreshPriorPrices(ctx.shopDomain, ctx);
    return { ok: true, errors: [] as string[] };
  }

  const productId = get("productId");
  const variantId = get("variantId");
  if (!productId) return { ok: false, errors: ["Choose the product the reduction was announced on."] };

  const announcedAt = parseDateInput(get("announcedAt"));
  if (!announcedAt) return { ok: false, errors: ["Enter the date the reduction was announced."] };
  // A date in the future cannot be an announcement that has happened. Rejecting it
  // here is better than storing it and letting R11 report it as invalid later.
  const tomorrow = new Date();
  tomorrow.setUTCHours(0, 0, 0, 0);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (announcedAt.getTime() >= tomorrow.getTime()) {
    return { ok: false, errors: ["The announcement date cannot be in the future."] };
  }

  const mechanism = get("mechanism");
  if (!isPriceAnnouncementMechanism(mechanism)) {
    return { ok: false, errors: ["Choose how the reduction reaches the shopper."] };
  }

  const money = parseMoney(get("consumerPrice"));
  if (!money.ok) return { ok: false, errors: [money.error] };
  if (money.value === null) {
    return { ok: false, errors: ["Enter the price the shopper pays."] };
  }

  const conditions = sanitizeText(get("conditions"), 300);
  if (mechanism === "discount_code" && !conditions) {
    return {
      ok: false,
      errors: ["Record the code and any conditions, so the announcement says what was actually offered."],
    };
  }

  // The consumer price has to be a reduction of the price the app can see. For a
  // code or an automatic discount it must sit below the selling price; for a
  // variant or compare-at change it cannot be above it.
  const products = await getCatalogue({
    shopDomain: ctx.shopDomain,
    repo: ctx.repo,
    catalog: ctx.catalog,
    ttlMs: ctx.mode === "demo" ? 0 : undefined,
  });
  const product = products.find((candidate) => candidate.productId === productId);
  if (!product) return { ok: false, errors: ["That product is no longer in your catalogue."] };
  const variant = variantId
    ? product.variants.find((candidate) => candidate.variantId === variantId)
    : product.variants[0];
  if (variantId && !variant) return { ok: false, errors: ["That variant is no longer on the product."] };
  const sellingPrice = variant?.price ?? null;
  if (sellingPrice !== null && money.value > sellingPrice) {
    return {
      ok: false,
      errors: [
        `The price the shopper pays (${formatInr(money.value)}) is above the selling price (${formatInr(
          sellingPrice,
        )}). A reduction cannot be more expensive than the price it reduces.`,
      ],
    };
  }
  if (
    sellingPrice !== null &&
    (mechanism === "discount_code" || mechanism === "automatic_discount") &&
    money.value >= sellingPrice
  ) {
    return {
      ok: false,
      errors: [
        `A discount code or automatic discount must put the price the shopper pays below the selling price (${formatInr(
          sellingPrice,
        )}). If the reduction is the selling price itself, choose "Selling price reduced on the variant".`,
      ],
    };
  }

  await ctx.repo.recordPriceAnnouncement(ctx.shop.id, {
    productId,
    variantId: variantId || null,
    announcedAt,
    consumerPrice: money.value,
    mechanism,
    conditions,
  });
  await refreshPriorPrices(ctx.shopDomain, ctx, [productId]);

  return { ok: true, errors: [] as string[] };
}

/**
 * Publishes the metafield again so the storefront block picks the announcement
 * up. Demo mode writes it inline (there is no worker); live mode uses the same
 * coalesced job the webhook path uses, so recording ten announcements does not
 * start ten catalogue reads.
 */
async function refreshPriorPrices(
  shopDomain: string,
  ctx: Awaited<ReturnType<typeof requireAppContext>>,
  productIds?: string[],
): Promise<void> {
  if (ctx.mode === "demo") {
    await publishPriorPrices({
      shop: ctx.shop,
      repo: ctx.repo,
      catalog: ctx.catalog,
      writer: ctx.writer,
      productIds,
    });
    return;
  }
  await enqueueJob(
    "publish-prior-prices",
    { shopDomain, productIds: productIds ?? [] },
    publishWindowKey(shopDomain),
  );
}

export default function AnnouncementsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const [productId, setProductId] = useState(data.products[0]?.productId ?? "");
  const [variantId, setVariantId] = useState("");
  const [mechanism, setMechanism] = useState<PriceAnnouncementMechanism>("discount_code");

  const selected = useMemo(
    () => data.products.find((product) => product.productId === productId) ?? null,
    [data.products, productId],
  );
  const variantOptions = useMemo(() => {
    const options = [{ label: "Every variant of this product", value: "" }];
    return [
      ...options,
      ...(selected?.variants ?? []).map((variant) => ({
        label: `${variant.title} — ₹${variant.price.toFixed(2)}`,
        value: variant.variantId,
      })),
    ];
  }, [selected]);

  const rows = data.announcements.map((row) => [
    row.productTitle,
    row.variantTitle ?? "every variant",
    formatShortDate(new Date(row.announcedAt)),
    `₹${row.consumerPrice.toFixed(2)}`,
    PRICE_ANNOUNCEMENT_MECHANISM_LABELS[row.mechanism as PriceAnnouncementMechanism] ?? row.mechanism,
    row.conditions ?? "—",
    row.id,
  ]);

  return (
    <Page
      title="Price announcements"
      subtitle="Record a price reduction the app cannot see, so the prior price is measured from the announcement"
      backAction={{ url: "/app/settings" }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData && !actionData.ok ? (
              <Banner tone="critical" title="The announcement was not saved">
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
              <Banner tone="success" title="Announcement recorded">
                <Text as="p" variant="bodyMd">
                  R11 now measures the 30-day lookback from this announcement, and the prior price is published
                  again with the mechanism and the price the shopper pays.
                </Text>
              </Banner>
            ) : null}

            <Banner tone="info" title="Why this screen exists">
              <Text as="p" variant="bodyMd">
                A discount code or an automatic discount is applied at checkout, so no variant price changes and
                the app cannot see that a reduction was announced. That does not put it outside the rule: it
                means the announcement has to be recorded here, with the date, the price the shopper pays and
                the conditions. Without a record, the prior price is measured from the price change the app can
                see, and R11 says that is what it did.
              </Text>
            </Banner>

            <Card>
              <Form method="post">
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Record an announcement
                  </Text>
                  <input type="hidden" name="intent" value="record" />
                  <Select
                    label="Product"
                    name="productId"
                    options={data.products.map((product) => ({ label: product.title, value: product.productId }))}
                    value={productId}
                    onChange={(value) => {
                      setProductId(value);
                      setVariantId("");
                    }}
                  />
                  <Select
                    label="Variant"
                    name="variantId"
                    options={variantOptions}
                    value={variantId}
                    onChange={setVariantId}
                  />
                  <InlineStack gap="300" wrap>
                    <Box>
                      <TextField
                        label="Announced on"
                        name="announcedAt"
                        type="date"
                        autoComplete="off"
                        max={data.today}
                      />
                    </Box>
                    <Box>
                      <TextField
                        label="Price the shopper pays"
                        name="consumerPrice"
                        autoComplete="off"
                        prefix="₹"
                        helpText="The price after the reduction, inclusive of taxes."
                      />
                    </Box>
                  </InlineStack>
                  <Select
                    label="How the reduction reaches the shopper"
                    name="mechanism"
                    options={data.mechanisms}
                    value={mechanism}
                    onChange={(value) => setMechanism(value as PriceAnnouncementMechanism)}
                  />
                  <TextField
                    label="Conditions"
                    name="conditions"
                    autoComplete="off"
                    multiline={2}
                    placeholder="Code MONSOON, minimum basket ₹999, one per customer"
                    helpText={
                      mechanism === "discount_code"
                        ? "Required for a discount code: the code itself and any conditions."
                        : "The code, a minimum basket, the market — anything a shopper has to meet."
                    }
                  />
                  <Text as="p" variant="bodySm" tone="subdued">
                    Recording a new announcement for the same product and variant replaces the previous one: a
                    variant has one current announcement, and two would make &quot;the 30 days before the
                    announcement&quot; ambiguous.
                  </Text>
                  <Button submit variant="primary" loading={busy} disabled={data.products.length === 0}>
                    Save announcement
                  </Button>
                  {data.products.length === 0 ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Nothing is reduced in this store yet, so there is no reduction to announce. Put a variant
                      on sale, or set a compare-at price, and it will appear above.
                    </Text>
                  ) : null}
                </BlockStack>
              </Form>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Recorded announcements
                </Text>
                {rows.length === 0 ? (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    No announcements recorded. The prior price is measured from the price changes this app
                    records itself, and R11 says so.
                  </Text>
                ) : (
                  <BlockStack gap="300">
                    <DataTable
                      columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                      headings={["Product", "Variant", "Announced", "Price paid", "Mechanism", "Conditions"]}
                      rows={rows.map((row) => row.slice(0, 6) as string[])}
                    />
                    {data.announcements.map((row) => (
                      <InlineStack key={row.id} gap="200" align="start">
                        <Form method="post">
                          <input type="hidden" name="intent" value="delete" />
                          <input type="hidden" name="id" value={row.id} />
                          <Button submit variant="plain" tone="critical" loading={busy}>
                            Remove
                          </Button>
                        </Form>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {row.productTitle}
                          {row.variantTitle ? ` · ${row.variantTitle}` : ""} · announced{" "}
                          {formatShortDate(new Date(row.announcedAt))}
                        </Text>
                      </InlineStack>
                    ))}
                  </BlockStack>
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
