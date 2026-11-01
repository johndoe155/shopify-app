/**
 * F3 — bulk editor.
 *
 * One row per product, one column per field, with inline editing, multi-select
 * "apply value to selected rows", "apply default by vendor or product type",
 * CSV export/import matched on handle (with a preview before applying), and
 * per-row validation errors. Every write goes through applyLegalUpdates, so
 * every write lands in the change log with its old value.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation, useSearchParams, useSubmit } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  IndexTable,
  InlineStack,
  Layout,
  Modal,
  Page,
  Pagination,
  Select,
  Text,
  TextField,
  useIndexResourceState,
} from "@shopify/polaris";
import { useMemo, useState } from "react";
import { requireAppContext } from "~/context.server";
import { getCatalogue, patchCatalogueProduct } from "~/services/catalogue-access.server";
import { loadScanReport } from "~/services/report.server";
import { applyLegalUpdates, buildDefaultUpdates } from "~/services/legal-writes.server";
import { planCsvImport, buildLegalCsv } from "~/domain/csv";
import { canWriteProducts, usageFor } from "~/domain/plans";
import { countryNames } from "~/domain/countries";
import { formatInr } from "~/domain/copy";
import {
  LEGAL_FIELD_LABELS,
  NET_QUANTITY_UNITS,
  type LegalFields,
} from "~/domain/types";
import { LEGAL_METAFIELD_TO_FIELD, METAFIELD_TYPES } from "~/services/ports";
import { assessUnitSalePrice, formatUnitSalePrice } from "~/domain/unit-price";
import { ChecklistDisclaimer } from "~/components/ui";

const PAGE_SIZE = 25;

/**
 * Editable fields, in the order a declaration reads. Every field the rule engine
 * uses is editable here, so a merchant can fix a failing check without leaving
 * the app. The labels come from the domain, not from this screen.
 */
const FIELD_ORDER: Array<keyof LegalFields> = [
  "mrp",
  "variantMrp",
  "manufacturerName",
  "manufacturerAddress",
  "packerDiffersFromManufacturer",
  "packerName",
  "packerAddress",
  "sellerName",
  "sellerAddress",
  "countryOfOrigin",
  "countryOfOriginLabel",
  "isImportedPackage",
  "importerName",
  "importerAddress",
  "packageType",
  "netQuantityValue",
  "netQuantityUnit",
  "genericName",
  "genericNameOnLabel",
  "manufacturedDate",
  "expiryType",
  "expiryDate",
  "unitSalePrice",
];

const FIELD_OPTIONS = FIELD_ORDER.map((field) => ({ label: LEGAL_FIELD_LABELS[field], value: field }));

const PACKAGE_TYPE_OPTIONS = [
  { label: "Packaged (in scope)", value: "packaged" },
  { label: "Combination package", value: "combination" },
  { label: "Multi-piece package", value: "multi_piece" },
  { label: "Wholesale (out of scope)", value: "wholesale" },
  { label: "Outside Rules 3 and 26 scope", value: "excluded" },
];

const EXPIRY_TYPE_OPTIONS = [
  { label: "No best-before or use-by date", value: "none" },
  { label: "Best before", value: "best_before" },
  { label: "Use by", value: "use_by" },
];

const YES_NO_OPTIONS = [
  { label: "Not declared", value: "" },
  { label: "Yes", value: "true" },
  { label: "No", value: "false" },
];

const MULTILINE_FIELDS: ReadonlyArray<keyof LegalFields> = [
  "manufacturerAddress",
  "packerAddress",
  "sellerAddress",
  "importerAddress",
];

export interface EditableProduct {
  productId: string;
  handle: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  legal: LegalFields;
  failingRuleIds: string[];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireAppContext(request);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const missing = url.searchParams.get("missing") ?? "";

  // One catalogue snapshot per shop, reused across page loads, filters and
  // pagination (see catalogue-access.server.ts): the editor no longer runs a
  // bulk operation every time the merchant clicks next.
  const [catalogue, report] = await Promise.all([
    getCatalogue({ shopDomain: ctx.shopDomain, repo: ctx.repo, catalog: ctx.catalog, ttlMs: ctx.mode === "demo" ? 0 : undefined }),
    loadScanReport(ctx),
  ]);
  const failingByProduct = new Map(report.products.map((product) => [product.productId, product.failingRuleIds]));

  let rows: EditableProduct[] = catalogue.map((product) => ({
    productId: product.productId,
    handle: product.handle,
    title: product.title,
    vendor: product.vendor,
    productType: product.productType,
    legal: product.legal,
    failingRuleIds: failingByProduct.get(product.productId) ?? [],
  }));

  if (query) {
    rows = rows.filter(
      (row) =>
        row.title.toLowerCase().includes(query) ||
        row.handle.toLowerCase().includes(query) ||
        (row.vendor ?? "").toLowerCase().includes(query),
    );
  }
  if (missing) {
    const field = missing as keyof LegalFields;
    rows = rows.filter((row) => {
      const value = row.legal[field];
      return value === null || value === undefined || value === "";
    });
  }

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const usage = usageFor(ctx.shop.plan, catalogue.length);

  return {
    demo: ctx.mode === "demo",
    rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    totalRows: rows.length,
    page,
    pageCount,
    query: url.searchParams.get("q") ?? "",
    missing,
    canWrite: canWriteProducts(ctx.shop.plan, catalogue.length),
    usageMessage: usage.message,
    planName: usage.planName,
    vendors: [...new Set(catalogue.map((product) => product.vendor ?? "").filter(Boolean))].sort(),
    productTypes: [...new Set(catalogue.map((product) => product.productType ?? "").filter(Boolean))].sort(),
    fields: FIELD_OPTIONS,
  };
}

type ActionPayload = {
  ok: boolean;
  intent: string;
  message: string;
  written?: number;
  productsChanged?: number;
  errors?: Array<{ productId: string; field: string; message: string }>;
  preview?: {
    summary: ReturnType<typeof planCsvImport>["summary"];
    errors: Array<{ rowNumber: number; handle: string | null; field: string; message: string }>;
  };
};

/**
 * Mirrors a successful write into the cached snapshot the loader reads, using the
 * same metafield mapping and types the writer uses, so a boolean is not stored as
 * the string "false" and the per-variant map stays an object.
 */
function applyToSnapshot(
  shopDomain: string,
  catalogue: ReturnType<typeof getCatalogue> extends Promise<infer T> ? T : never,
  result: { changes: Array<{ productId: string; field: string; newValue: string | null }> },
) {
  for (const change of result.changes) {
    const product = catalogue.find((candidate) => candidate.productId === change.productId);
    if (!product) continue;
    const field = LEGAL_METAFIELD_TO_FIELD[change.field as keyof typeof LEGAL_METAFIELD_TO_FIELD];
    if (!field) continue;
    const type = METAFIELD_TYPES[change.field as keyof typeof METAFIELD_TYPES];
    const raw = change.newValue;
    let value: unknown = raw;
    if (raw === null || raw === "") {
      value = type === "boolean" ? false : null;
    } else if (type === "number_decimal") {
      value = Number(raw);
    } else if (type === "boolean") {
      value = raw === "true";
    } else if (type === "json") {
      try {
        value = JSON.parse(raw);
      } catch {
        value = null;
      }
    }
    patchCatalogueProduct(shopDomain, change.productId, {
      legal: { [field]: value } as never,
    });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const ctx = await requireAppContext(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  // Reads the same cached snapshot the loader used. A `save-row` or import does
  // not force a fresh bulk operation; the writes below patch the snapshot.
  const catalogue = await getCatalogue({
    shopDomain: ctx.shopDomain,
    repo: ctx.repo,
    catalog: ctx.catalog,
    ttlMs: ctx.mode === "demo" ? 0 : undefined,
  });
  const canWrite = canWriteProducts(ctx.shop.plan, catalogue.length);

  const guard = (): ActionPayload | null =>
    canWrite
      ? null
      : {
          ok: false,
          intent,
          message: `${usageFor(ctx.shop.plan, catalogue.length).message} Upgrade to keep editing. Nothing has been deleted.`,
        };

  if (intent === "save-row") {
    const blocked = guard();
    if (blocked) return blocked;
    const productId = String(form.get("productId") ?? "");
    const values: Record<string, unknown> = {};
    for (const field of FIELD_OPTIONS) {
      const raw = form.get(field.value);
      if (raw === null) continue;
      values[field.value] = String(raw);
    }
    const result = await applyLegalUpdates({
      shop: ctx.shop,
      repo: ctx.repo,
      writer: ctx.writer,
      products: catalogue,
      updates: [{ productId, values: values as Partial<LegalFields> }],
      source: "bulk_editor",
    });
    applyToSnapshot(ctx.shopDomain, catalogue, result);
    return {
      ok: result.validationErrors.length === 0 && result.errors.length === 0,
      intent,
      message: `${result.written} field${result.written === 1 ? "" : "s"} saved.`,
      written: result.written,
      productsChanged: result.productsChanged,
      errors: [
        ...result.validationErrors,
        ...result.errors.map((error) => ({ productId: error.ownerId, field: error.key, message: error.message })),
      ],
    } satisfies ActionPayload;
  }

  if (intent === "apply-selected" || intent === "apply-default") {
    const blocked = guard();
    if (blocked) return blocked;
    const field = String(form.get("field") ?? "") as keyof LegalFields;
    const value = String(form.get("value") ?? "");
    const onlyMissing = form.get("onlyMissing") === "true";

    let updates;
    if (intent === "apply-selected") {
      const ids = JSON.parse(String(form.get("productIds") ?? "[]")) as string[];
      updates = ids.map((productId) => ({ productId, values: { [field]: value } as Partial<LegalFields> }));
    } else {
      updates = buildDefaultUpdates(catalogue, {
        groupBy: String(form.get("groupBy") ?? "vendor") as "vendor" | "productType",
        groupValue: String(form.get("groupValue") ?? ""),
        field,
        value,
        onlyMissing,
      });
    }

    const result = await applyLegalUpdates({
      shop: ctx.shop,
      repo: ctx.repo,
      writer: ctx.writer,
      products: catalogue,
      updates,
      source: intent === "apply-default" ? "apply_default" : "bulk_editor",
    });
    applyToSnapshot(ctx.shopDomain, catalogue, result);
    return {
      ok: result.validationErrors.length === 0 && result.errors.length === 0,
      intent,
      message: `${result.written} field${result.written === 1 ? "" : "s"} written across ${result.productsChanged} product${
        result.productsChanged === 1 ? "" : "s"
      }.`,
      written: result.written,
      productsChanged: result.productsChanged,
      errors: [
        ...result.validationErrors,
        ...result.errors.map((error) => ({ productId: error.ownerId, field: error.key, message: error.message })),
      ],
    } satisfies ActionPayload;
  }

  if (intent === "import-preview" || intent === "import-apply") {
    const csv = String(form.get("csv") ?? "");
    const preview = planCsvImport(
      csv,
      catalogue.map((product) => ({
        handle: product.handle,
        title: product.title,
        productType: product.productType,
        legal: product.legal,
      })),
    );

    if (intent === "import-preview") {
      return {
        ok: preview.errors.length === 0,
        intent,
        message:
          preview.summary.productsToChange === 0
            ? "No changes found in this file."
            : `${preview.summary.productsToChange} products would change across ${preview.summary.changesByField.length} fields.`,
        preview: { summary: preview.summary, errors: preview.errors.slice(0, 50) },
      } satisfies ActionPayload;
    }

    const blocked = guard();
    if (blocked) return blocked;

    const result = await applyLegalUpdates({
      shop: ctx.shop,
      repo: ctx.repo,
      writer: ctx.writer,
      products: catalogue,
      updates: preview.rows.map((row) => ({ productId: findProductId(catalogue, row.handle), values: row.values })),
      source: "csv_import",
    });
    applyToSnapshot(ctx.shopDomain, catalogue, result);
    return {
      ok: preview.errors.length === 0 && result.errors.length === 0,
      intent,
      message: `${result.written} fields written across ${result.productsChanged} products. ${preview.errors.length} row${
        preview.errors.length === 1 ? "" : "s"
      } skipped.`,
      written: result.written,
      productsChanged: result.productsChanged,
      errors: [
        ...preview.errors.map((error) => ({
          productId: error.handle ?? "",
          field: error.field,
          message: `Row ${error.rowNumber}: ${error.message}`,
        })),
        ...result.validationErrors,
      ],
      preview: { summary: preview.summary, errors: preview.errors.slice(0, 50) },
    } satisfies ActionPayload;
  }

  if (intent === "export-csv") {
    const csv = buildLegalCsv(
      catalogue.map((product) => ({
        handle: product.handle,
        title: product.title,
        productType: product.productType,
        legal: product.legal,
      })),
    );
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="legal-fields-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  return { ok: false, intent, message: "Unknown action." } satisfies ActionPayload;
}

function findProductId(catalogue: Array<{ productId: string; handle: string }>, handle: string): string {
  return catalogue.find((product) => product.handle === handle)?.productId ?? "";
}

function ValueInput({
  field,
  value,
  onChange,
}: {
  field: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const label = LEGAL_FIELD_LABELS[field as keyof LegalFields] ?? field;

  if (field === "countryOfOrigin") {
    return (
      <Select
        label={label}
        name="countryOfOrigin"
        options={[{ label: "Choose a country", value: "" }, ...countryNames().map((name) => ({ label: name, value: name }))]}
        value={value}
        onChange={onChange}
      />
    );
  }
  if (field === "netQuantityUnit") {
    return (
      <Select
        label={label}
        name="netQuantityUnit"
        options={[{ label: "Choose a unit", value: "" }, ...NET_QUANTITY_UNITS.map((unit) => ({ label: unit, value: unit }))]}
        value={value}
        onChange={onChange}
      />
    );
  }
  if (field === "packageType") {
    return <Select label={label} name="packageType" options={PACKAGE_TYPE_OPTIONS} value={value || "packaged"} onChange={onChange} />;
  }
  if (field === "expiryType") {
    return <Select label={label} name="expiryType" options={EXPIRY_TYPE_OPTIONS} value={value || "none"} onChange={onChange} />;
  }
  if (field === "packerDiffersFromManufacturer" || field === "isImportedPackage") {
    return <Select label={label} name={field} options={YES_NO_OPTIONS} value={value} onChange={onChange} />;
  }
  if (field === "genericNameOnLabel") {
    return (
      <Select
        label={label}
        name="genericNameOnLabel"
        options={[
          { label: "No — only the online title has it", value: "false" },
          { label: "Yes, printed on the pack", value: "true" },
        ]}
        value={value === "true" ? "true" : "false"}
        onChange={onChange}
        helpText="Rule 6(1)(b) is a package-label duty, so the online title alone is not evidence."
      />
    );
  }
  if (field === "variantMrp") {
    return (
      <TextField
        label={label}
        name={field}
        value={value}
        onChange={onChange}
        autoComplete="off"
        multiline={2}
        helpText='JSON map of variant id to price, for variants that are separately priced packages: {"gid://shopify/ProductVariant/1": 249}'
      />
    );
  }
  if (field === "unitSalePrice") {
    return (
      <TextField
        label={label}
        name={field}
        value={value}
        onChange={onChange}
        autoComplete="off"
        helpText="Price per kg, litre, metre or number, rounded to two decimal places. Rule 6(11)."
      />
    );
  }
  return (
    <TextField
      label={label}
      name={field}
      value={value}
      onChange={onChange}
      autoComplete="off"
      multiline={MULTILINE_FIELDS.includes(field as keyof LegalFields) ? 2 : undefined}
      helpText={
        field === "manufacturedDate" || field === "expiryDate"
          ? "MM/YYYY"
          : field === "countryOfOriginLabel"
            ? "The exact wording on the pack, for example 'Made in India'."
            : undefined
      }
    />
  );
}

/** R13 at a glance: the declared unit price next to what the rule expects. */
function unitPriceCell(legal: LegalFields): string {
  const assessment = assessUnitSalePrice({
    mrp: legal.mrp,
    netQuantityValue: legal.netQuantityValue,
    netQuantityUnit: legal.netQuantityUnit,
    packageType: legal.packageType,
  });
  const declared = legal.unitSalePrice === null ? "missing" : formatUnitSalePrice(legal.unitSalePrice);
  if (!assessment.applicable) return declared === "missing" ? "not required" : declared;
  return `${declared} (expected ${formatUnitSalePrice(assessment.expected)})`;
}

export default function BulkEditor() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ActionPayload | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const [searchParams, setSearchParams] = useSearchParams();
  const busy = navigation.state === "submitting";

  const [field, setField] = useState<string>("countryOfOrigin");
  const [value, setValue] = useState("");
  const [groupBy, setGroupBy] = useState<"vendor" | "productType">("vendor");
  const [groupValue, setGroupValue] = useState(data.vendors[0] ?? "");
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [editing, setEditing] = useState<EditableProduct | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [csv, setCsv] = useState("");
  const [search, setSearch] = useState(data.query);

  const rows = useMemo(
    () =>
      data.rows.map((row) => ({
        id: row.productId,
        ...row,
      })),
    [data.rows],
  );
  const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(rows);

  const openEditor = (row: EditableProduct) => {
    setEditing(row);
    const initial: Record<string, string> = {};
    for (const field of FIELD_ORDER) {
      const value = row.legal[field];
      if (value === null || value === undefined) initial[field] = "";
      else if (typeof value === "boolean") initial[field] = value ? "true" : "false";
      else if (typeof value === "object") initial[field] = JSON.stringify(value);
      else initial[field] = String(value);
    }
    setEditValues(initial);
  };

  const groupOptions =
    groupBy === "vendor"
      ? data.vendors.map((vendor) => ({ label: vendor, value: vendor }))
      : data.productTypes.map((type) => ({ label: type, value: type }));

  return (
    <Page
      title="Bulk editor"
      subtitle={`${data.totalRows} products in this view · ${data.planName} plan`}
      primaryAction={{ content: "Export CSV", onAction: () => submit({ intent: "export-csv" }, { method: "post" }) }}
      secondaryActions={[{ content: "Back to dashboard", url: "/app" }]}
    >
      <BlockStack gap="400">
        {actionData?.message ? (
          <Banner tone={actionData.ok ? "success" : "warning"} title={actionData.ok ? "Saved" : "Some rows were not saved"}>
            <BlockStack gap="100">
              <Text as="p" variant="bodyMd">
                {actionData.message}
              </Text>
              {(actionData.errors ?? []).slice(0, 12).map((error, index) => (
                <Text as="p" key={`${error.productId}-${error.field}-${index}`} variant="bodySm" tone="critical">
                  {error.productId} · {error.field}: {error.message}
                </Text>
              ))}
            </BlockStack>
          </Banner>
        ) : null}

        {!data.canWrite ? (
          <Banner tone="warning" title="Editing is paused at your plan limit">
            <Text as="p" variant="bodyMd">
              {data.usageMessage} Nothing has been deleted.{" "}
              <a href="/app/billing">See plans</a>
            </Text>
          </Banner>
        ) : null}

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Apply a value to selected rows
                </Text>
                <InlineStack gap="300" align="start" blockAlign="end" wrap>
                  <Box minWidth="220px">
                    <Select
                      label="Field"
                      options={FIELD_OPTIONS.map((option) => ({ label: option.label, value: option.value }))}
                      value={field}
                      onChange={setField}
                    />
                  </Box>
                  <Box minWidth="260px">
                    <ValueInput field={field} value={value} onChange={setValue} />
                  </Box>
                  <Button
                    disabled={selectedResources.length === 0 || !value || !data.canWrite}
                    onClick={() =>
                      submit(
                        {
                          intent: "apply-selected",
                          field,
                          value,
                          productIds: JSON.stringify(selectedResources),
                        },
                        { method: "post" },
                      )
                    }
                  >
                    {`Apply to ${selectedResources.length} selected`}
                  </Button>
                </InlineStack>
                <Divider />
                <Text as="h2" variant="headingMd">
                  Apply a default by vendor or product type
                </Text>
                <InlineStack gap="300" align="start" blockAlign="end" wrap>
                  <Box minWidth="170px">
                    <Select
                      label="Group by"
                      options={[
                        { label: "Vendor", value: "vendor" },
                        { label: "Product type", value: "productType" },
                      ]}
                      value={groupBy}
                      onChange={(next) => {
                        setGroupBy(next as "vendor" | "productType");
                        setGroupValue(next === "vendor" ? (data.vendors[0] ?? "") : (data.productTypes[0] ?? ""));
                      }}
                    />
                  </Box>
                  <Box minWidth="220px">
                    <Select label="Group" options={groupOptions} value={groupValue} onChange={setGroupValue} />
                  </Box>
                  <Box minWidth="200px">
                    <Select
                      label="Field"
                      options={FIELD_OPTIONS.map((option) => ({ label: option.label, value: option.value }))}
                      value={field}
                      onChange={setField}
                    />
                  </Box>
                  <Box minWidth="240px">
                    <ValueInput field={field} value={value} onChange={setValue} />
                  </Box>
                  <Box minWidth="150px">
                    <Select
                      label="Apply to"
                      options={[
                        { label: "Only empty", value: "true" },
                        { label: "Every product", value: "false" },
                      ]}
                      value={onlyMissing ? "true" : "false"}
                      onChange={(next) => setOnlyMissing(next === "true")}
                    />
                  </Box>
                  <Button
                    disabled={!groupValue || !value || !data.canWrite}
                    onClick={() =>
                      submit(
                        { intent: "apply-default", groupBy, groupValue, field, value, onlyMissing: String(onlyMissing) },
                        { method: "post" },
                      )
                    }
                  >
                    Apply to group
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <Card padding="0">
          <BlockStack gap="0">
            <Box padding="300">
              <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
                <Text as="h2" variant="headingMd">
                  Products
                </Text>
                <Form method="get">
                  <InlineStack gap="200" blockAlign="end">
                    <Box minWidth="220px">
                      <TextField
                        label="Search"
                        labelHidden
                        name="q"
                        value={search}
                        onChange={setSearch}
                        autoComplete="off"
                        placeholder="Search title, handle or vendor"
                      />
                    </Box>
                    <Button submit>Search</Button>
                  </InlineStack>
                </Form>
              </InlineStack>
            </Box>
            <IndexTable
              resourceName={{ singular: "product", plural: "products" }}
              itemCount={rows.length}
              selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              headings={[
                { title: "Product" },
                { title: "MRP" },
                { title: "Country" },
                { title: "Net quantity" },
                { title: "Manufactured" },
                { title: "Unit price" },
                { title: "Checks" },
                { title: "" },
              ]}
            >
              {rows.map((row, index) => (
                <IndexTable.Row id={row.id} key={row.id} position={index} selected={selectedResources.includes(row.id)}>
                  <IndexTable.Cell>
                    <BlockStack gap="050">
                      <Text as="span" variant="bodyMd" fontWeight="medium">
                        {row.title}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {row.handle} · {row.vendor ?? "no vendor"}
                      </Text>
                    </BlockStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{row.legal.mrp === null ? "—" : formatInr(row.legal.mrp)}</IndexTable.Cell>
                  <IndexTable.Cell>{row.legal.countryOfOrigin ?? "—"}</IndexTable.Cell>
                  <IndexTable.Cell>
                    {row.legal.netQuantityValue === null ? "—" : `${row.legal.netQuantityValue} ${row.legal.netQuantityUnit ?? ""}`}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <BlockStack gap="050">
                      <Text as="span" variant="bodySm">
                        {row.legal.manufacturedDate ?? "missing"}
                      </Text>
                      {row.legal.expiryType === "none" ? null : (
                        <Text as="span" variant="bodySm" tone="subdued">
                          {row.legal.expiryType.replace("_", "-")} {row.legal.expiryDate ?? "missing"}
                        </Text>
                      )}
                    </BlockStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{unitPriceCell(row.legal)}</IndexTable.Cell>
                  <IndexTable.Cell>
                    {row.failingRuleIds.length === 0 ? (
                      <Badge tone="success">Pass</Badge>
                    ) : (
                      <Badge tone="critical">{row.failingRuleIds.join(", ")}</Badge>
                    )}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Button variant="plain" onClick={() => openEditor(row)}>
                      Edit
                    </Button>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
            <Box padding="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="p" variant="bodySm" tone="subdued">
                  Showing {data.rows.length} of {data.totalRows} products · writes are batched 25 at a time and
                  every change is logged.
                </Text>
                {data.pageCount > 1 ? (
                  <Pagination
                    hasPrevious={data.page > 1}
                    hasNext={data.page < data.pageCount}
                    onPrevious={() => {
                      const next = new URLSearchParams(searchParams);
                      next.set("page", String(data.page - 1));
                      setSearchParams(next);
                    }}
                    onNext={() => {
                      const next = new URLSearchParams(searchParams);
                      next.set("page", String(data.page + 1));
                      setSearchParams(next);
                    }}
                  />
                ) : null}
              </InlineStack>
            </Box>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              CSV import
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Export first, edit in a spreadsheet, then import. Rows are matched on the product handle. Blank cells
              are left unchanged. You will see a summary before anything is written.
            </Text>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={async (event) => {
                const file = event.currentTarget.files?.[0];
                if (!file) return;
                setCsv(await file.text());
              }}
            />
            <InlineStack gap="200">
              <Button
                disabled={!csv}
                onClick={() => submit({ intent: "import-preview", csv }, { method: "post" })}
                loading={busy && navigation.formData?.get("intent") === "import-preview"}
              >
                Preview import
              </Button>
              <Button
                variant="primary"
                disabled={!csv || !data.canWrite}
                onClick={() => submit({ intent: "import-apply", csv }, { method: "post" })}
                loading={busy && navigation.formData?.get("intent") === "import-apply"}
              >
                Apply import
              </Button>
              <Button onClick={() => submit({ intent: "export-csv" }, { method: "post" })}>Export current values</Button>
            </InlineStack>
            {actionData?.preview ? (
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd">
                  {actionData.preview.summary.productsToChange} products would change,{" "}
                  {actionData.preview.summary.productsUnchanged} unchanged, {actionData.preview.summary.invalidRows}{" "}
                  rows with errors.
                </Text>
                {actionData.preview.summary.changesByField.map((entry) => (
                  <Text as="p" key={entry.field} variant="bodySm" tone="subdued">
                    {entry.field}: {entry.count} change{entry.count === 1 ? "" : "s"}
                  </Text>
                ))}
                {actionData.preview.errors.slice(0, 10).map((error, index) => (
                  <Text as="p" key={index} variant="bodySm" tone="critical">
                    Row {error.rowNumber}
                    {error.handle ? ` (${error.handle})` : ""}: {error.message}
                  </Text>
                ))}
              </BlockStack>
            ) : null}
          </BlockStack>
        </Card>
        <ChecklistDisclaimer />
      </BlockStack>

      {editing ? (
        <Modal
          open
          onClose={() => setEditing(null)}
          title={editing.title}
          primaryAction={{
            content: "Save row",
            onAction: () => {
              submit(
                { intent: "save-row", productId: editing.productId, ...editValues },
                { method: "post" },
              );
              setEditing(null);
            },
          }}
          secondaryActions={[{ content: "Cancel", onAction: () => setEditing(null) }]}
        >
          <Modal.Section>
            <BlockStack gap="300">
              <Text as="p" variant="bodySm" tone="subdued">
                Only filled fields are written. Anything left blank stays as it is.
              </Text>
              {FIELD_OPTIONS.map((option) => (
                <ValueInput
                  key={option.value}
                  field={option.value}
                  value={editValues[option.value] ?? ""}
                  onChange={(next) => setEditValues((current) => ({ ...current, [option.value]: next }))}
                />
              ))}
            </BlockStack>
          </Modal.Section>
        </Modal>
      ) : null}
    </Page>
  );
}
