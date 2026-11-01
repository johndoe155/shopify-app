/**
 * Evidence downloads (F8). Every file carries the disclaimer.
 *   /exports/scan.csv          scan results, one row per product
 *   /exports/changelog.csv     the change log
 *   /exports/scan-summary.pdf  latest scan summary
 *   /exports/audit.pdf         self-audit record
 */
import type { LoaderFunctionArgs } from "react-router";
import { requireAppContext } from "~/context.server";
import { loadScanReport } from "~/services/report.server";
import { buildChangeLogCsv, buildScanCsv, type ScanExportRow } from "~/domain/csv";
import { buildAuditPdf, buildScanSummaryPdf } from "~/domain/exports";
import { ruleEntries } from "~/domain/rules";
import { formatShortDate } from "~/domain/copy";
import type { AuditAnswer } from "~/domain/self-audit";

function fileResponse(body: string | Buffer, contentType: string, filename: string): Response {
  return new Response(typeof body === "string" ? body : new Uint8Array(body), {
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const ctx = await requireAppContext(request);
  const kind = params.kind ?? "";
  const stamp = new Date().toISOString().slice(0, 10);
  const ruleIds = ruleEntries()
    .filter((rule) => rule.level === "product")
    .map((rule) => rule.id);

  if (kind === "scan.csv") {
    const report = await loadScanReport(ctx);
    const rows: ScanExportRow[] = report.products.map((product) => ({
      productId: product.productId,
      handle: product.handle,
      title: product.title,
      vendor: product.vendor,
      productType: product.productType,
      passing: product.passed,
      status: product.status,
      failingRuleIds: product.failingRuleIds,
      inconclusiveRuleIds: product.inconclusiveRuleIds,
      ruleStatuses: Object.fromEntries(product.results.map((result) => [result.ruleId, result.status])),
      scannedAt: product.scannedAt ?? report.scannedAt ?? new Date(),
    }));
    return fileResponse(buildScanCsv(rows, ruleIds), "text/csv; charset=utf-8", `listing-checks-${stamp}.csv`);
  }

  if (kind === "changelog.csv") {
    const rows = await ctx.repo.listChangeLog(ctx.shop.id, 20_000);
    const csv = buildChangeLogCsv(
      rows.map((row) => ({
        productId: row.productId,
        handle: row.productHandle,
        field: row.field,
        oldValue: row.oldValue,
        newValue: row.newValue,
        changedAt: row.changedAt,
        source: row.source,
      })),
    );
    return fileResponse(csv, "text/csv; charset=utf-8", `change-log-${stamp}.csv`);
  }

  if (kind === "scan-summary.pdf") {
    const report = await loadScanReport(ctx);
    const pdf = buildScanSummaryPdf({
      shopDomain: ctx.shopDomain,
      generatedAt: new Date(),
      scannedAt: report.scannedAt,
      summary: report.summary,
      storeResults: report.storeResults,
      // Only real failures belong in the "worst products" list. A product whose
      // only open item is an unverifiable check is reported in the summary note.
      worstProducts: report.outcomes.filter((outcome) => outcome.status === "fail"),
      priceHistory: {
        trackingStart: report.priceHistory.trackingStart,
        completeBy: report.priceHistory.completeBy,
        complete: report.priceHistory.complete,
      },
      rulesVersion: report.rulesConfig.version,
      rulesVerified: report.rulesConfig.verifiedAgainstGazette,
    });
    return fileResponse(pdf, "application/pdf", `listing-checks-summary-${stamp}.pdf`);
  }

  if (kind === "audit.pdf") {
    const record = await ctx.repo.latestAuditRecord(ctx.shop.id);
    if (!record) {
      return new Response("No self-audit has been recorded for this store yet.", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const answers = ((record.answers as { answers?: AuditAnswer[] } | null)?.answers ?? []) as AuditAnswer[];
    const pdf = buildAuditPdf({
      shopDomain: ctx.shopDomain,
      completedAt: record.completedAt,
      answers,
      recordId: record.id,
    });
    return fileResponse(pdf, "application/pdf", `self-audit-${formatShortDate(record.completedAt).replace(/ /g, "-")}.pdf`);
  }

  return new Response("Unknown export", { status: 404 });
}
