import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";

/** Starts (and completes) the OAuth flow for the embedded app. */
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return null;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
