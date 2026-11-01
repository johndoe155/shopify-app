/**
 * Evidence exports (F8).
 * Every CSV and PDF built here carries the disclaimer and, for the self-audit,
 * the "record of your own answers" note.
 */
import {
  AUDIT_RECORD_NOTE,
  CLAIMS,
  DISCLAIMER,
  formatDateTime,
  formatShortDate,
} from "./copy";
import { regimeSummaries } from "./legal-basis";
import { AUDIT_CERTIFICATE_NOTE } from "./self-audit";
import { renderPdf, type PdfBlock } from "./pdf";
import { AUDIT_ITEMS, summariseAudit, type AuditAnswer } from "./self-audit";
import type { RuleResult, ScanOutcome } from "./types";
import type { ScanSummary } from "./rules";

export interface ScanSummaryPdfInput {
  shopDomain: string;
  generatedAt: Date;
  scannedAt: Date | null;
  summary: ScanSummary;
  storeResults: RuleResult[];
  worstProducts: ScanOutcome[];
  priceHistory: {
    trackingStart: Date;
    completeBy: Date;
    complete: boolean;
  };
  rulesVersion: string;
  rulesVerified: boolean;
}

export function buildScanSummaryPdf(input: ScanSummaryPdfInput): Buffer {
  const { summary } = input;
  const blocks: PdfBlock[] = [
    { style: "title", text: "Listing checks summary" },
    { style: "body", text: `Store: ${input.shopDomain}` },
    { style: "body", text: `Generated: ${formatDateTime(input.generatedAt)}` },
    {
      style: "body",
      text: `Last scan: ${input.scannedAt ? formatDateTime(input.scannedAt) : "no scan recorded yet"}`,
    },
    { style: "body", text: `Checklist version: ${input.rulesVersion}` },
    {
      style: "small",
      text: input.rulesVerified
        ? "Checklist verified against the published rules."
        : "Checklist drawn from published summaries and not yet verified against the Gazette text.",
    },
    { style: "spacer" },
    { style: "heading", text: "Score" },
    {
      style: "body",
      text: `${summary.passingProducts} of ${summary.scoredProducts} products that could be fully checked pass every product check (${summary.scorePercent}%).`,
    },
    ...(summary.inconclusiveProducts > 0
      ? [
          {
            style: "small" as const,
            text: `${summary.inconclusiveProducts} product${
              summary.inconclusiveProducts === 1 ? "" : "s"
            } left out of the score: a check could not be verified from the storefront. These are listed separately and are not counted as failures.`,
          },
        ]
      : []),
    { style: "spacer" },
    { style: "heading", text: "What applies when" },
    ...regimeSummaries().map(
      (regime): PdfBlock => ({
        style: "small" as const,
        text: `${regime.title}: ${regime.body}`,
      }),
    ),
    { style: "spacer" },
    { style: "heading", text: "Product checks" },
  ];

  for (const rule of summary.byRule.filter((r) => r.level === "product")) {
    blocks.push({
      style: "body",
      text: `${rule.ruleId} ${rule.label} - passing ${rule.pass}, failing ${rule.fail}${
        rule.inconclusive > 0 ? `, unverified ${rule.inconclusive}` : ""
      }, not applicable ${rule.notApplicable}`,
    });
  }

  blocks.push({ style: "spacer" }, { style: "heading", text: "Store checks" });
  for (const result of input.storeResults) {
    blocks.push({
      style: "body",
      text: `${result.ruleId} ${
        result.status === "pass"
          ? "passing"
          : result.status === "fail"
            ? "failing"
            : result.status === "inconclusive"
              ? "unverified"
              : "not applicable"
      } - ${result.message}`,
    });
  }

  blocks.push(
    { style: "spacer" },
    { style: "heading", text: "Price history" },
    {
      style: "body",
      // Audit item L16: a partial history is never described as a prior price. The
      // export says what is suppressed, not what is "labelled instead".
      text: input.priceHistory.complete
        ? `Full 30-day price history is being tracked from ${formatShortDate(input.priceHistory.trackingStart)}, so prior prices can be computed from a complete lookback.`
        : `Price tracking started on ${formatShortDate(input.priceHistory.trackingStart)} and a complete 30-day lookback is available from ${formatShortDate(input.priceHistory.completeBy)}. Until then no prior price is published for the affected reductions.`,
    },
  );

  if (input.worstProducts.length > 0) {
    blocks.push({ style: "spacer" }, { style: "heading", text: "Products with the most failing checks" });
    for (const product of input.worstProducts.slice(0, 20)) {
      blocks.push({
        style: "body",
        text: `${product.title} (${product.handle}) - failing: ${product.failingRuleIds.join(", ")}`,
      });
    }
  }

  blocks.push(
    { style: "spacer" },
    { style: "rule" },
    { style: "body", text: DISCLAIMER },
    { style: "small", text: CLAIMS },
  );

  return renderPdf(blocks, { title: "Listing checks summary" });
}

export interface AuditPdfInput {
  shopDomain: string;
  completedAt: Date;
  answers: AuditAnswer[];
  recordId: string;
}

export function buildAuditPdf(input: AuditPdfInput): Buffer {
  const summary = summariseAudit(input.answers, input.completedAt);
  const notesById = new Map(input.answers.map((a) => [a.id, a]));

  const blocks: PdfBlock[] = [
    { style: "title", text: "Dark-pattern self-audit record" },
    { style: "body", text: `Store: ${input.shopDomain}` },
    { style: "body", text: `Completed: ${formatDateTime(input.completedAt)}` },
    { style: "body", text: `Record reference: ${input.recordId}` },
    { style: "spacer" },
    { style: "body", text: AUDIT_RECORD_NOTE },
    { style: "small", text: AUDIT_CERTIFICATE_NOTE },
    { style: "spacer" },
    { style: "heading", text: "Answers" },
  ];

  for (const item of AUDIT_ITEMS) {
    const answer = notesById.get(item.id);
    const value = answer ? (answer.answer ? "Yes" : "No") : "Not answered";
    blocks.push({ style: "body", text: `${item.pattern}: ${value}` });
    if (answer?.notes) {
      blocks.push({ style: "small", text: `Notes: ${answer.notes}` });
    }
  }

  blocks.push(
    { style: "spacer" },
    {
      style: "body",
      text: `Questions answered: ${summary.total - summary.unanswered} of ${summary.total}. Answered yes: ${summary.yes}. Answered no: ${summary.no}.`,
    },
    { style: "spacer" },
    { style: "rule" },
    { style: "body", text: DISCLAIMER },
    { style: "small", text: CLAIMS },
  );

  return renderPdf(blocks, { title: "Dark-pattern self-audit record" });
}
