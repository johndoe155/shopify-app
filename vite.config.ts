import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactRouter()],
  resolve: {
    alias: { "~": fileURLToPath(new URL("./app", import.meta.url)) },
  },
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
    allowedHosts: true,
    fs: { strict: false },
  },
  ssr: {
    // Prisma and the Shopify SDK are Node-only; keep them external to the SSR bundle.
    external: ["@prisma/client", ".prisma/client"],
  },
});
