import { describe, expect, it } from "vitest";
import { AUDIT_ITEMS, auditReminderDue, summariseAudit, validateAuditSubmission } from "~/domain/self-audit";

function fullPayload(answer: "yes" | "no") {
  return Object.fromEntries(AUDIT_ITEMS.map((item) => [item.id, { answer, notes: "" }]));
}

describe("the thirteen items", () => {
  it("covers every pattern named in the guidelines, once each", () => {
    const patterns = AUDIT_ITEMS.map((item) => item.pattern);
    expect(patterns).toEqual([
      "False urgency",
      "Basket sneaking",
      "Confirm shaming",
      "Forced action",
      "Subscription trap",
      "Interface interference",
      "Bait and switch",
      "Drip pricing",
      "Disguised advertisement",
      "Nagging",
      "Trick question",
      "SaaS billing",
      "Rogue malwares",
    ]);
    expect(new Set(patterns).size).toBe(13);
  });

  it("has a one-line question and a notes hint for every item", () => {
    for (const item of AUDIT_ITEMS) {
      expect(item.question.length).toBeGreaterThan(20);
      expect(item.question).toContain("?");
      expect(item.notesHint.length).toBeGreaterThan(5);
    }
  });
});

describe("validation", () => {
  it("accepts a complete submission", () => {
    const result = validateAuditSubmission(fullPayload("no"));
    expect(result.ok).toBe(true);
    expect(result.answers).toHaveLength(13);
    expect(result.answers.every((answer) => answer.answer === false)).toBe(true);
  });

  it("rejects a submission with a missing answer", () => {
    const payload = fullPayload("yes") as Record<string, unknown>;
    delete payload[AUDIT_ITEMS[4]!.id];
    const result = validateAuditSubmission(payload);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("Subscription trap");
  });

  it("rejects a non yes/no answer", () => {
    const payload = fullPayload("yes") as Record<string, { answer: string; notes: string }>;
    payload[AUDIT_ITEMS[0]!.id] = { answer: "maybe", notes: "" };
    expect(validateAuditSubmission(payload).ok).toBe(false);
  });

  it("keeps notes and truncates absurd ones", () => {
    const payload = fullPayload("yes") as Record<string, { answer: string; notes: string }>;
    payload[AUDIT_ITEMS[0]!.id] = { answer: "yes", notes: "x".repeat(5000) };
    const result = validateAuditSubmission(payload);
    expect(result.answers[0]!.notes).toHaveLength(1000);
  });

  it("rejects a completely empty payload", () => {
    expect(validateAuditSubmission(null).errors).toHaveLength(13);
  });
});

describe("summary", () => {
  it("counts yes and no answers and lists the flagged patterns with notes", () => {
    const answers = AUDIT_ITEMS.map((item, index) => ({
      id: item.id,
      answer: index === 0 || index === 7,
      notes: index === 7 ? "Delivery fee appears at step 2." : "",
    }));
    const summary = summariseAudit(answers, new Date("2026-10-30T00:00:00.000Z"));
    expect(summary.total).toBe(13);
    expect(summary.yes).toBe(2);
    expect(summary.no).toBe(11);
    expect(summary.unanswered).toBe(0);
    expect(summary.flagged.map((entry) => entry.pattern)).toEqual(["False urgency", "Drip pricing"]);
    expect(summary.flagged[1]!.notes).toContain("Delivery fee");
  });

  it("reports unanswered items rather than assuming a no", () => {
    const summary = summariseAudit([], new Date());
    expect(summary.unanswered).toBe(13);
    expect(summary.no).toBe(0);
  });
});

describe("11-month reminder", () => {
  it("is not due before eleven months", () => {
    const completedAt = new Date("2026-01-01T00:00:00.000Z");
    expect(auditReminderDue(completedAt, new Date("2026-11-15T00:00:00.000Z"))).toBe(false);
  });

  it("is due at eleven months and after", () => {
    const completedAt = new Date("2026-01-01T00:00:00.000Z");
    expect(auditReminderDue(completedAt, new Date("2026-12-02T00:00:00.000Z"))).toBe(true);
  });

  it("never fires without a recorded audit", () => {
    expect(auditReminderDue(null, new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
  });
});
