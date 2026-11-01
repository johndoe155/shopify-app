import type { LoaderFunctionArgs } from "react-router";
import { Link, Outlet, useLoaderData, useLocation } from "react-router";
import { Box, InlineStack, Text } from "@shopify/polaris";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { requireAppContext } from "~/context.server";
import { usageFor } from "~/domain/plans";
import { APP_NAME } from "~/domain/copy";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireAppContext(request);
  const usage = usageFor(ctx.shop.plan, ctx.shop.lastScanProductCount);
  return {
    demo: ctx.mode === "demo",
    apiKey: process.env.SHOPIFY_API_KEY ?? "",
    shopDomain: ctx.shopDomain,
    planName: usage.planName,
    usageMessage: usage.message,
    overLimit: usage.overLimit,
  };
}

const NAV = [
  { label: "Dashboard", path: "/app" },
  { label: "Bulk editor", path: "/app/bulk-editor" },
  { label: "Store settings", path: "/app/settings" },
  { label: "Self-audit", path: "/app/audit" },
  { label: "Complaints", path: "/app/complaints" },
  { label: "Price announcements", path: "/app/announcements" },
  { label: "Exports", path: "/app/exports" },
  { label: "Plan", path: "/app/billing" },
  { label: "Help", path: "/app/help" },
];

export default function AppLayout() {
  const data = useLoaderData<typeof loader>();
  const location = useLocation();

  const content = (
    <Box background="bg-surface-secondary" minHeight="100vh">
      <Box padding="400" background="bg-surface">
        <InlineStack align="space-between" blockAlign="center" gap="400" wrap>
          <InlineStack gap="300" blockAlign="center">
            <Text as="h1" variant="headingMd">
              {APP_NAME}
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">
              {data.shopDomain}
            </Text>
          </InlineStack>
          <InlineStack gap="300" blockAlign="center">
            <Text as="span" variant="bodySm" tone={data.overLimit ? "critical" : "subdued"}>
              {data.planName} plan
            </Text>
            <Link to="/app/billing" style={{ color: "#1a1a1a", fontSize: 14 }}>
              Change plan
            </Link>
          </InlineStack>
        </InlineStack>
        <Box paddingBlockStart="300">
          <InlineStack gap="400" wrap>
            {NAV.map((item) => {
              const active =
                item.path === "/app" ? location.pathname === "/app" : location.pathname.startsWith(item.path);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  style={{
                    fontSize: 14,
                    fontWeight: active ? 650 : 450,
                    color: active ? "#1a1a1a" : "#4a4a4a",
                    textDecoration: "none",
                    borderBottom: active ? "2px solid #1a1a1a" : "2px solid transparent",
                    paddingBottom: 6,
                  }}
                >
                  {item.label}
                </Link>
              );
            })}
          </InlineStack>
        </Box>
      </Box>
      <Box padding="400">
        <Outlet />
      </Box>
    </Box>
  );

  if (data.demo) return content;
  return (
    // App Bridge 4 no longer takes an `embedded` prop: the app is embedded by
    // virtue of being served inside the Shopify admin frame (which the CSP
    // frame-ancestors header in root.tsx governs).
    <ShopifyAppProvider apiKey={data.apiKey}>
      {content}
    </ShopifyAppProvider>
  );
}

import { useRouteError } from "react-router";
import type { HeadersFunction } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
