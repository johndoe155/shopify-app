/**
 * F7 — dark-pattern self-audit.
 *
 * One item per pattern named in Annexure 1 of the Guidelines for Prevention and
 * Regulation of Dark Patterns, 2023. Each question is phrased so that answering
 * "yes" means the pattern may be present. The app records the merchant's answers;
 * it never scores them, never issues a certificate and never states that the store
 * is compliant.
 *
 * Audit item L14: the thirteen pattern names are correct. The 12-month validity
 * period and the 11-month reminder are **this app's product policy** — the 2023
 * Guidelines prescribe no cadence — and the later "yearly self-audit plus
 * prominent certificate" wording belongs to the 2026 E-Commerce amendment, whose
 * commencement is unverified, so it is not implemented as a statutory feature.
 */

/** The audit cycle is a product policy period; the labels say so wherever shown. */
export const AUDIT_CYCLE_IS_PRODUCT_POLICY = true;

/**
 * Wording for the record and the certificate question. The app deliberately does
 * not issue a certificate: the 2026 E-Commerce amendment's certificate wording has
 * an unverified commencement (audit items L14 and 23).
 */
export const AUDIT_CERTIFICATE_NOTE =
  "This app does not issue a compliance certificate. The 2026 E-Commerce amendment's yearly self-audit and certificate wording is not applied while its commencement is unverified.";

export interface AuditItem {
  id: string;
  pattern: string;
  question: string;
  notesHint: string;
}

export const AUDIT_ITEMS: readonly AuditItem[] = [
  {
    id: "false_urgency",
    pattern: "False urgency",
    question: "Do you use countdown timers or 'only X left' messages that are not based on real, live data?",
    notesHint: "Where the timer or counter appears, and whether it is driven by real stock or time data.",
  },
  {
    id: "basket_sneaking",
    pattern: "Basket sneaking",
    question: "Does anything get added to the cart at checkout without the shopper choosing it, such as a donation, tip, or extra item?",
    notesHint: "What is pre-added, and how the shopper can remove it.",
  },
  {
    id: "confirm_shaming",
    pattern: "Confirm shaming",
    question: "Does any decline or exit option use guilt-inducing wording, such as 'No thanks, I don't want to save money'?",
    notesHint: "Which popup or step uses the wording.",
  },
  {
    id: "forced_action",
    pattern: "Forced action",
    question: "Must a shopper subscribe to a newsletter, create an account, or buy an extra item to complete an action they wanted?",
    notesHint: "Which flow forces the extra step.",
  },
  {
    id: "subscription_trap",
    pattern: "Subscription trap",
    question: "Is it hard to cancel or pause a subscription, or is the cancellation path hidden behind several steps or a phone call?",
    notesHint: "Where cancellation lives and how many steps it takes.",
  },
  {
    id: "interface_interference",
    pattern: "Interface interference",
    question: "Is any important option, price or condition made hard to see through small text, low contrast or a hidden position on the page?",
    notesHint: "Which page and which element.",
  },
  {
    id: "bait_and_switch",
    pattern: "Bait and switch",
    question: "Has a product, price or offer ever changed after the shopper clicked, so they end up with something different from what was advertised?",
    notesHint: "Which promotion and what changed.",
  },
  {
    id: "drip_pricing",
    pattern: "Drip pricing",
    question: "Are fees such as delivery, handling or packaging added late in checkout rather than shown with the first price?",
    notesHint: "Which fees are added, and at which step.",
  },
  {
    id: "disguised_advertisement",
    pattern: "Disguised advertisement",
    question: "Are paid placements or sponsored products shown in a way that looks like ordinary editorial content or a neutral recommendation?",
    notesHint: "Where the placement appears and whether it is labelled.",
  },
  {
    id: "nagging",
    pattern: "Nagging",
    question: "Does the store repeatedly interrupt the shopper with popups, prompts or requests that they have already dismissed?",
    notesHint: "Which popups repeat and how often.",
  },
  {
    id: "trick_question",
    pattern: "Trick question",
    question: "Does any step use confusing or double-negative language, or a pre-ticked box, so the shopper ends up choosing something they did not intend?",
    notesHint: "Which step uses it.",
  },
  {
    id: "saas_billing",
    pattern: "SaaS billing",
    question: "For any subscription product you sell, does billing continue or escalate in a way the shopper was not shown clearly at signup?",
    notesHint: "Which plan and what the shopper sees at signup.",
  },
  {
    id: "rogue_malwares",
    pattern: "Rogue malwares",
    question: "Does your store use any script, app or plugin that downloads unwanted software or interferes with the shopper's device?",
    notesHint: "Which app or script, and what it does.",
  },
] as const;

export interface AuditAnswer {
  id: string;
  /** true = the merchant answered yes (the pattern may be present). */
  answer: boolean;
  notes: string;
}

export interface AuditSubmission {
  answers: AuditAnswer[];
  completedAt: Date;
}

export interface AuditValidation {
  ok: boolean;
  errors: string[];
  answers: AuditAnswer[];
}

/** Every one of the 13 items must be answered; notes are always optional. */
export function validateAuditSubmission(payload: unknown): AuditValidation {
  const errors: string[] = [];
  const answers: AuditAnswer[] = [];
  const record =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

  for (const item of AUDIT_ITEMS) {
    const raw = record[item.id];
    const entry = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const answer = entry?.answer;
    if (answer !== "yes" && answer !== "no") {
      errors.push(`Answer yes or no for "${item.pattern}".`);
      continue;
    }
    const notes = typeof entry?.notes === "string" ? entry.notes.slice(0, 1000).trim() : "";
    answers.push({ id: item.id, answer: answer === "yes", notes });
  }
  return { ok: errors.length === 0, errors, answers };
}

export interface AuditSummary {
  completedAt: Date;
  total: number;
  yes: number;
  no: number;
  unanswered: number;
  flagged: Array<{ pattern: string; notes: string }>;
}

export function summariseAudit(answers: AuditAnswer[], completedAt: Date): AuditSummary {
  const byId = new Map(answers.map((a) => [a.id, a]));
  let yes = 0;
  let no = 0;
  const flagged: Array<{ pattern: string; notes: string }> = [];
  for (const item of AUDIT_ITEMS) {
    const answer = byId.get(item.id);
    if (!answer) continue;
    if (answer.answer) {
      yes += 1;
      flagged.push({ pattern: item.pattern, notes: answer.notes });
    } else {
      no += 1;
    }
  }
  return {
    completedAt,
    total: AUDIT_ITEMS.length,
    yes,
    no,
    unanswered: AUDIT_ITEMS.length - yes - no,
    flagged,
  };
}

/**
 * 11-month in-app reminder. Product policy (UX), not a statutory cadence; see the
 * audit's L14 finding before changing the default.
 */
export function auditReminderDue(completedAt: Date | null, now: Date, reminderMonths = 11): boolean {
  if (!completedAt) return false;
  const due = new Date(completedAt.getTime());
  due.setUTCMonth(due.getUTCMonth() + reminderMonths);
  return now.getTime() >= due.getTime();
}
