/**
 * exportPdf.ts — client-side PDF export of a ScanReport using jsPDF.
 * Renders the headline score, five sub-scores, all report sections, and the source appendix
 * as a clean, selectable-text PDF document.
 */
import { jsPDF } from "jspdf";
import type { ScanReport, Evidence } from "./schema";
import { SCORE_DEFINITIONS } from "./analyze";

const PAGE_W = 210;
const MARGIN = 20;
const CONTENT_W = PAGE_W - MARGIN * 2;
const PAGE_BOTTOM = 280;

function ensureSpace(doc: jsPDF, y: number, needed: number): number {
  if (y + needed > PAGE_BOTTOM) {
    doc.addPage();
    return MARGIN;
  }
  return y;
}

function scoreRgb(v: number): [number, number, number] {
  if (v >= 7) return [52, 211, 153];   // green
  if (v >= 5) return [250, 204, 21];   // yellow
  if (v >= 3) return [251, 146, 60];   // orange
  return [248, 113, 113];              // red
}

function drawScoreBar(doc: jsPDF, x: number, y: number, value: number, width: number, inverted = false) {
  const barH = 3;
  doc.setFillColor(230, 230, 230);
  doc.rect(x, y, width, barH, "F");
  const pct = value / 10;
  const colorValue = inverted ? 10 - value : value;
  doc.setFillColor(...scoreRgb(colorValue));
  doc.rect(x, y, width * pct, barH, "F");
}

function inlineCitations(text: string, sourceIds: number[]): string {
  if (sourceIds.length === 0) return text;
  return `${text} [${sourceIds.join(", ")}]`;
}

function wrapAndPrint(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  maxW: number,
  fontSize: number,
  opts?: { bold?: boolean; color?: [number, number, number] },
): number {
  doc.setFontSize(fontSize);
  doc.setFont("helvetica", opts?.bold ? "bold" : "normal");
  if (opts?.color) doc.setTextColor(...opts.color);
  else doc.setTextColor(30, 30, 30);

  const lines = doc.splitTextToSize(text, maxW) as string[];
  const lineH = fontSize * 0.45;
  for (const line of lines) {
    y = ensureSpace(doc, y, lineH + 1);
    doc.text(line, x, y);
    y += lineH;
  }
  return y;
}

function sectionHeading(doc: jsPDF, y: number, index: string, title: string): number {
  y = ensureSpace(doc, y, 14);
  y += 4;
  doc.setDrawColor(180, 180, 180);
  doc.line(MARGIN, y, MARGIN + CONTENT_W, y);
  y += 6;
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 30, 30);
  doc.text(`${index}  ${title}`, MARGIN, y);
  y += 7;
  return y;
}

function printEvidenceList(doc: jsPDF, items: Evidence[], y: number): number {
  for (const item of items) {
    const text = inlineCitations(item.text, item.sourceIds);
    y = ensureSpace(doc, y, 8);
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(30, 30, 30);
    doc.text("•", MARGIN + 2, y);
    y = wrapAndPrint(doc, text, MARGIN + 7, y, CONTENT_W - 7, 9);
    y += 2;
  }
  return y;
}

export function exportReportPdf(report: ScanReport): void {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = MARGIN;

  // Title
  doc.setFontSize(22);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 30, 30);
  doc.text(`Blindspot: ${report.industry}`, MARGIN, y);
  y += 8;

  // Date
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(120, 120, 120);
  const date = new Date(report.generatedAt);
  doc.text(`Generated ${date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`, MARGIN, y);
  y += 10;

  // Opportunity Score
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 30, 30);
  doc.text(`Opportunity Score: ${report.opportunityScore}/100`, MARGIN, y);
  y += 10;

  // Sub-scores — one per row so multi-line reasons don't collide
  const barW = CONTENT_W * 0.6;
  for (let i = 0; i < SCORE_DEFINITIONS.length; i++) {
    const def = SCORE_DEFINITIONS[i];
    const score = report.scores[def.key as keyof ScanReport["scores"]];

    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(60, 60, 60);

    // Measure reason height first so we can ensureSpace for the whole block
    let reasonLines: string[] = [];
    if (score.reason) {
      doc.setFontSize(7.5);
      reasonLines = doc.splitTextToSize(score.reason, barW) as string[];
      doc.setFontSize(9);
    }
    const blockH = 8 + reasonLines.length * 3.5 + 2;
    y = ensureSpace(doc, y, blockH);

    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(60, 60, 60);
    doc.text(`${def.name}: ${score.value.toFixed(1)}/10`, MARGIN, y);

    drawScoreBar(doc, MARGIN, y + 2, score.value, barW, def.key === "softwareMaturity");

    if (reasonLines.length > 0) {
      doc.setFontSize(7.5);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100, 100, 100);
      let ry = y + 8;
      for (const line of reasonLines) {
        doc.text(line, MARGIN, ry);
        ry += 3.5;
      }
      y = ry + 2;
    } else {
      y += 10;
    }
  }
  y += 2;

  // 01 — Industry Snapshot
  y = sectionHeading(doc, y, "01", "Industry Snapshot");
  y = wrapAndPrint(doc, report.snapshot, MARGIN, y, CONTENT_W, 9.5);
  y += 4;

  // 02 — Current Software Ecosystem
  y = sectionHeading(doc, y, "02", "Current Software Ecosystem");
  if (report.softwareEcosystem.summary) {
    y = wrapAndPrint(doc, report.softwareEcosystem.summary, MARGIN, y, CONTENT_W, 9, { color: [80, 80, 80] });
    y += 3;
  }
  for (const v of report.softwareEcosystem.vendors) {
    const text = inlineCitations(`${v.name} — ${v.note}`, v.sourceIds);
    y = ensureSpace(doc, y, 8);
    doc.text("•", MARGIN + 2, y);
    y = wrapAndPrint(doc, text, MARGIN + 7, y, CONTENT_W - 7, 9);
    y += 2;
  }
  y += 2;

  // 03 — Bottlenecks
  y = sectionHeading(doc, y, "03", "Bottlenecks");
  y = printEvidenceList(doc, report.bottlenecks, y);

  // 04 — Underserved Niches
  y = sectionHeading(doc, y, "04", "Underserved Niches");
  y = printEvidenceList(doc, report.underservedNiches, y);

  // 05 — Opportunity Thesis
  y = sectionHeading(doc, y, "05", "Opportunity Thesis");
  for (const para of report.opportunityThesis.split("\n\n")) {
    y = wrapAndPrint(doc, para, MARGIN, y, CONTENT_W, 9.5);
    y += 4;
  }

  // 06 — Adjacent Markets
  y = sectionHeading(doc, y, "06", "Adjacent Markets");
  y = printEvidenceList(doc, report.adjacentMarkets, y);

  // 07 — Next Steps
  y = sectionHeading(doc, y, "07", "Next Steps");
  y = printEvidenceList(doc, report.nextSteps, y);

  // Sources appendix
  y = sectionHeading(doc, y, "--", "Sources");
  for (const s of report.sources) {
    y = ensureSpace(doc, y, 7);
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(80, 80, 80);
    doc.text(`[${s.id}]`, MARGIN, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(50, 50, 50);
    const srcText = `${s.title} — ${s.domain}`;
    const truncated = srcText.length > 100 ? srcText.slice(0, 97) + "..." : srcText;
    doc.text(truncated, MARGIN + 8, y);

    doc.setTextColor(100, 100, 180);
    y += 3.5;
    const urlTrunc = s.url.length > 110 ? s.url.slice(0, 107) + "..." : s.url;
    doc.textWithLink(urlTrunc, MARGIN + 8, y, { url: s.url });
    y += 4.5;
  }

  const slug = report.industry.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
  doc.save(`blindspot-${slug}.pdf`);
}
