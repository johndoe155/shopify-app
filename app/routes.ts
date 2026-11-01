import type { RouteConfig } from "@react-router/dev/routes";
import { index, route } from "@react-router/dev/routes";

export default [
  index("routes/index.tsx"),
  route("auth/login", "routes/auth.login.tsx"),
  route("auth/*", "routes/auth.$.tsx"),
  route("webhooks", "routes/webhooks.tsx"),
  route("exports/:kind", "routes/exports.$kind.tsx"),
  route("api/jobs/nightly", "routes/api.jobs.nightly.tsx"),
  route("healthz", "routes/healthz.tsx"),
  route("preview/storefront", "routes/preview.storefront.tsx"),
  route("app", "routes/app.tsx", [
    index("routes/app._index.tsx"),
    route("welcome", "routes/app.welcome.tsx"),
    route("bulk-editor", "routes/app.bulk-editor.tsx"),
    route("settings", "routes/app.settings.tsx"),
    route("audit", "routes/app.audit.tsx"),
    route("complaints", "routes/app.complaints.tsx"),
    route("announcements", "routes/app.announcements.tsx"),
    route("exports", "routes/app.exports.tsx"),
    route("billing", "routes/app.billing.tsx"),
    route("help", "routes/app.help.tsx"),
  ]),
] satisfies RouteConfig;
