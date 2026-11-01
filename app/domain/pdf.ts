/**
 * A very small PDF writer.
 *
 * The app needs two PDFs (scan summary, self-audit record) with plain text only.
 * Writing the ~150 lines of PDF machinery here keeps the dependency surface of
 * a legal-evidence feature at zero and makes the output testable byte for byte.
 * Only the built-in Helvetica fonts are used, and text is transliterated to
 * WinAnsi-safe characters, so no font files ship with the app.
 */

export type PdfBlockStyle = "title" | "heading" | "body" | "small" | "spacer" | "rule";

export interface PdfBlock {
  style: PdfBlockStyle;
  text?: string;
}

const PAGE_WIDTH = 595.28; // A4 portrait, points
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const STYLE: Record<PdfBlockStyle, { size: number; leading: number; bold: boolean }> = {
  title: { size: 18, leading: 24, bold: true },
  heading: { size: 12.5, leading: 18, bold: true },
  body: { size: 10, leading: 14, bold: false },
  small: { size: 8.5, leading: 12, bold: false },
  spacer: { size: 10, leading: 10, bold: false },
  rule: { size: 10, leading: 10, bold: false },
};

/** Escapes PDF string syntax and replaces characters the standard fonts cannot encode. */
export function pdfEscape(text: string): string {
  return text
    .replace(/[₹]/g, "Rs.")
    .replace(/[–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\x20-\x7E\n]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** Greedy word wrap using Helvetica average advance width (~0.52 em). */
export function wrapText(text: string, size: number, width = CONTENT_WIDTH): string[] {
  const maxChars = Math.max(10, Math.floor(width / (size * 0.52)));
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

interface RenderedLine {
  text: string;
  size: number;
  bold: boolean;
  y: number;
}

interface Page {
  lines: RenderedLine[];
  rules: number[]; // y positions of horizontal rules
}

function layout(blocks: PdfBlock[]): Page[] {
  const pages: Page[] = [];
  let page: Page = { lines: [], rules: [] };
  let y = PAGE_HEIGHT - MARGIN;

  const newPage = () => {
    pages.push(page);
    page = { lines: [], rules: [] };
    y = PAGE_HEIGHT - MARGIN;
  };

  for (const block of blocks) {
    const style = STYLE[block.style];
    if (block.style === "spacer") {
      y -= style.leading;
      continue;
    }
    if (block.style === "rule") {
      if (y < MARGIN + 20) newPage();
      page.rules.push(y);
      y -= 10;
      continue;
    }
    const text = block.text ?? "";
    const wrapped = wrapText(text, style.size);
    for (const line of wrapped) {
      if (y < MARGIN + style.leading) newPage();
      page.lines.push({ text: line, size: style.size, bold: style.bold, y });
      y -= style.leading;
    }
  }
  pages.push(page);
  return pages;
}

function contentStream(page: Page): string {
  const parts: string[] = [];
  for (const line of page.lines) {
    parts.push(
      `BT /${line.bold ? "F2" : "F1"} ${line.size} Tf 1 0 0 1 ${MARGIN} ${line.y.toFixed(2)} Tm (${pdfEscape(
        line.text,
      )}) Tj ET`,
    );
  }
  for (const ruleY of page.rules) {
    parts.push(
      `0.6 w 0.6 0.6 0.6 RG ${MARGIN} ${ruleY.toFixed(2)} m ${(PAGE_WIDTH - MARGIN).toFixed(2)} ${ruleY.toFixed(
        2,
      )} l S`,
    );
  }
  return parts.join("\n");
}

/** Renders blocks into a PDF file as a Buffer. */
export function renderPdf(blocks: PdfBlock[], meta: { title: string; author?: string } = { title: "Export" }): Buffer {
  const pages = layout(blocks);
  const objects: string[] = [];
  const pageObjectNumbers: number[] = [];

  // 1: Catalog, 2: Pages, 3: Font F1, 4: Font F2, then per page: page object + content object.
  const firstPageObject = 5;
  pages.forEach((_, index) => pageObjectNumbers.push(firstPageObject + index * 2));

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjectNumbers
    .map((n) => `${n} 0 R`)
    .join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  pages.forEach((page, index) => {
    const pageObj = firstPageObject + index * 2;
    const contentObj = pageObj + 1;
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH.toFixed(2)} ${PAGE_HEIGHT.toFixed(
        2,
      )}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObj} 0 R >>`;
    const stream = contentStream(page);
    objects[contentObj] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });

  const info = `<< /Title (${pdfEscape(meta.title)}) /Producer (India Legal Metrology and MRP app) ${
    meta.author ? `/Author (${pdfEscape(meta.author)})` : ""
  } >>`;

  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  const maxObject = objects.length - 1;
  for (let i = 1; i <= maxObject; i += 1) {
    const body = objects[i];
    if (body === undefined) continue;
    offsets[i] = Buffer.byteLength(pdf, "latin1");
    pdf += `${i} 0 obj\n${body}\nendobj\n`;
  }
  const infoNumber = maxObject + 1;
  offsets[infoNumber] = Buffer.byteLength(pdf, "latin1");
  pdf += `${infoNumber} 0 obj\n${info}\nendobj\n`;

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  const total = infoNumber + 1;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i += 1) {
    const offset = offsets[i] ?? 0;
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += xref;
  pdf += `trailer\n<< /Size ${total} /Root 1 0 R /Info ${infoNumber} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
