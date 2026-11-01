import type { LoaderFunctionArgs } from "react-router";
import { login } from "~/shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  return login(request);
}
