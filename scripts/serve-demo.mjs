#!/usr/bin/env node
/**
 * Starts the built app in preview mode (DEMO_MODE=1) so the finished UI can be
 * reviewed, screenshotted and clicked through without a Shopify store, a tunnel
 * or a database.
 *
 *   npm run demo            # build, then serve on http://0.0.0.0:3000
 *   PORT=4000 npm run demo
 */
import { spawn } from "node:child_process";

process.env.DEMO_MODE = "1";
process.env.PORT = process.env.PORT ?? "3000";
process.env.HOST = process.env.HOST ?? "0.0.0.0";
// Dummy values: the SDK validates its config at import time, but in preview mode
// no Shopify request is ever made.
process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY ?? "preview-mode-key";
process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET ?? "preview-mode-secret";
process.env.SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL ?? `http://localhost:${process.env.PORT}`;
process.env.NODE_ENV = "production";
// Explicit opt-in for serving the preview store in a production build. A real
// deployment does not have this value, so DEMO_MODE cannot be left on there.
process.env.DEMO_MODE_SECRET = process.env.DEMO_MODE_SECRET ?? "local-preview-only";

const child = spawn("node_modules/.bin/react-router-serve", ["build/server/index.js"], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => process.exit(code ?? 0));
