import type { LinksFunction, LoaderFunctionArgs } from "react-router";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData, isRouteErrorResponse, useRouteError } from "react-router";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { addDocumentResponseHeaders } from "~/shopify.server";
import { isDemoMode } from "~/context.server";
import { assertRuntimeConfig } from "~/config.server";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: polarisStyles }];

export async function loader({ request }: LoaderFunctionArgs) {
  // Fails fast in production when a required variable is missing or still a
  // placeholder, instead of serving a half-configured app. Warns elsewhere.
  assertRuntimeConfig();
  // Adds the Content-Security-Policy frame-ancestors header Shopify requires.
  if (!isDemoMode()) {
    const headers = new Headers();
    addDocumentResponseHeaders(request, headers);
    return Response.json({ demo: false }, { headers });
  }
  return Response.json({ demo: true });
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>India Legal Metrology &amp; MRP</title>
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const { demo } = useLoaderData<typeof loader>();
  return (
    <PolarisAppProvider i18n={en}>
      {demo ? <DemoBanner /> : null}
      <Outlet />
    </PolarisAppProvider>
  );
}

function DemoBanner() {
  return (
    <div
      style={{
        background: "#1a1a1a",
        color: "#fff",
        padding: "6px 16px",
        fontSize: 12,
        textAlign: "center",
        fontFamily: "Inter, -apple-system, sans-serif",
      }}
    >
      Preview mode: a seeded sample of 248 products. No Shopify store is connected and no data leaves this
      process.
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const title = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : "Something went wrong";
  const message = isRouteErrorResponse(error)
    ? typeof error.data === "string"
      ? error.data
      : "That page could not be loaded."
    : error instanceof Error
      ? error.message
      : "An unexpected error occurred.";
  return (
    <PolarisAppProvider i18n={en}>
      <div style={{ padding: 40, fontFamily: "Inter, -apple-system, sans-serif" }}>
        <h1 style={{ fontSize: 20, fontWeight: 650 }}>{title}</h1>
        <p style={{ color: "#6d7175", maxWidth: 560 }}>{message}</p>
        <p>
          <a href="/app">Back to the dashboard</a>
        </p>
      </div>
    </PolarisAppProvider>
  );
}
