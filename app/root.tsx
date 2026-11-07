import type { HeadersFunction, LinksFunction, LoaderFunctionArgs } from "react-router";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData, useLocation, isRouteErrorResponse, useRouteError } from "react-router";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { boundary } from "@shopify/shopify-app-react-router/server";
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

/**
 * The loader above puts the Content-Security-Policy `frame-ancestors` header on
 * its own response, but a React Router document response only carries what the
 * route's `headers` export returns, so without this the header was dropped.
 */
export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

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

/**
 * Shopify's SDK throws Responses on purpose: the redirect out of the iframe for
 * re-authorisation or the billing confirmation is an HTML page with a script, not an
 * error. Printing that body as text is what produced the "malformed 200 response
 * with embedded script text" in QA, so those go to Shopify's own boundary, which
 * renders the body as markup. Plain statuses (404, 410) and ordinary exceptions
 * keep the friendly page.
 */
function looksLikeMarkup(data: unknown): data is string {
  return typeof data === "string" && /<\s*(!doctype|html|head|body|script|meta)\b/i.test(data);
}

export function ErrorBoundary() {
  const error = useRouteError();
  // Keep the embedded-app parameters (shop, host, embedded, id_token) on the way
  // back: a bare "/app" has no shop, so a full page load cannot authenticate.
  const { search } = useLocation();
  if (isRouteErrorResponse(error) && looksLikeMarkup(error.data)) {
    return boundary.error(error);
  }
  const title = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`.trim()
    : "Something went wrong";
  const message = isRouteErrorResponse(error)
    ? typeof error.data === "string" && error.data.length > 0
      ? error.data.slice(0, 300)
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
          <a href={`/app${search}`}>Back to the dashboard</a>
        </p>
      </div>
    </PolarisAppProvider>
  );
}
