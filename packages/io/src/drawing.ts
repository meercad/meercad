/**
 * Technical drawing sheets: views of a part laid out in first-angle projection (ISO E: the view
 * from above sits below the front view, the view from the left to its right, the isometric view
 * in the remaining corner) on a standard sheet with a frame and a title block, overall dimensions,
 * at a standard scale. Written as SVG, PDF (vector, no dependencies) or DXF.
 *
 * Sheet coordinates are millimetres with the origin at the bottom left, y up.
 */

export type Pt = [number, number];
export interface SheetView {
  name: "front" | "back" | "top" | "bottom" | "left" | "right" | "iso";
  visible: Pt[][];
  hidden: Pt[][];
  min: Pt;
  max: Pt;
}
export type Paper = "A4" | "A3" | "A2";
export interface TitleBlock {
  title: string;
  drawnBy?: string;
  date?: string;
  material?: string;
  /** Drawing or part number. */
  number?: string;
}
export type LineKind = "visible" | "hidden" | "thin" | "frame";
export interface Sheet {
  width: number;
  height: number;
  scale: number;
  scaleLabel: string;
  lines: { pts: Pt[]; kind: LineKind }[];
  /** Filled triangles (dimension arrows). */
  fills: Pt[][];
  texts: { at: Pt; text: string; size: number; anchor: "start" | "middle" | "end"; angle?: number }[];
}

const PAPER: Record<Paper, [number, number]> = { A4: [297, 210], A3: [420, 297], A2: [594, 420] };
/** Standard scales (ISO 5455), largest first. */
const SCALES: [number, string][] = [
  [10, "10:1"], [5, "5:1"], [2, "2:1"], [1, "1:1"], [0.5, "1:2"], [0.2, "1:5"], [0.1, "1:10"], [0.05, "1:20"], [0.02, "1:50"], [0.01, "1:100"],
];
const TITLE_W = 180;
const TITLE_H = 32;
/** Room around each view for its dimensions, in sheet millimetres. */
const GAP = 22;

const fmt = (v: number) => (Math.abs(v - Math.round(v)) < 0.005 ? String(Math.round(v)) : v.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""));

export function layoutSheet(views: readonly SheetView[], o: { paper?: Paper; title: TitleBlock; scale?: number }): Sheet {
  const [W, H] = PAPER[o.paper ?? "A4"];
  const sheet: Sheet = { width: W, height: H, scale: 1, scaleLabel: "1:1", lines: [], fills: [], texts: [] };
  // Frame: 20 mm on the left for filing, 10 mm elsewhere; the views keep clear of the title block's strip.
  const fx0 = 20, fy0 = 10, fx1 = W - 10, fy1 = H - 10;
  const area = { x0: fx0 + 4, y0: fy0 + TITLE_H + 4, x1: fx1 - 4, y1: fy1 - 4 };
  const get = (n: SheetView["name"]) => views.find((v) => v.name === n);
  const front = get("front"), top = get("top"), left = get("left"), iso = get("iso");
  const w = (v?: SheetView) => (v ? v.max[0] - v.min[0] : 0);
  const h = (v?: SheetView) => (v ? v.max[1] - v.min[1] : 0);
  // Grid of two columns and two rows (model sizes), each cell padded for dimensions.
  const c0 = Math.max(w(front), w(top)), c1 = Math.max(w(left), w(iso));
  const r0 = Math.max(h(front), h(left)), r1 = Math.max(h(top), h(iso));
  const cols = (c0 > 0 ? 1 : 0) + (c1 > 0 ? 1 : 0), rows = (r0 > 0 ? 1 : 0) + (r1 > 0 ? 1 : 0);
  const availW = area.x1 - area.x0 - GAP * (cols + 1), availH = area.y1 - area.y0 - GAP * (rows + 1);
  const fit = Math.min(availW / Math.max(c0 + c1, 1e-9), availH / Math.max(r0 + r1, 1e-9));
  const [scale, label] = o.scale ? [o.scale, SCALES.find((s) => s[0] === o.scale)?.[1] ?? `${fmt(o.scale)}:1`] : (SCALES.find((s) => s[0] <= fit) ?? SCALES[SCALES.length - 1]!);
  sheet.scale = scale;
  sheet.scaleLabel = label;
  // Cell centres: row 0 on top.
  const x0 = area.x0 + GAP + (scale * c0) / 2;
  const x1 = area.x0 + GAP + scale * c0 + (c0 > 0 ? GAP : 0) + (scale * c1) / 2;
  const y0 = area.y1 - GAP - (scale * r0) / 2;
  const y1 = area.y1 - GAP - scale * r0 - (r0 > 0 ? GAP : 0) - (scale * r1) / 2;
  // Views that share an axis share its offset, so they line up (projection lines).
  const mid = (v: SheetView, k: 0 | 1) => (v.min[k] + v.max[k]) / 2;
  const ox = front ? x0 - scale * mid(front, 0) : top ? x0 - scale * mid(top, 0) : x0;
  const oy = front ? y0 - scale * mid(front, 1) : left ? y0 - scale * mid(left, 1) : y0;
  const place = (v: SheetView | undefined, px: number, py: number) => {
    if (!v) return null;
    const map = (p: Pt): Pt => [px + scale * p[0], py + scale * p[1]];
    for (const l of v.visible) sheet.lines.push({ pts: l.map(map), kind: "visible" });
    if (v.name !== "iso") for (const l of v.hidden) sheet.lines.push({ pts: l.map(map), kind: "hidden" });
    return { min: map(v.min), max: map(v.max), v };
  };
  const pf = place(front, ox, oy);
  const pt = place(top, ox, top ? y1 - scale * mid(top, 1) : 0);
  const pl = place(left, left ? x1 - scale * mid(left, 0) : 0, oy);
  place(iso, iso ? x1 - scale * mid(iso, 0) : 0, iso ? y1 - scale * mid(iso, 1) : 0);
  // Overall dimensions: width under the front view, height to its left, depth to the left of the top view.
  if (pf) {
    dimension(sheet, [pf.min[0], pf.min[1]], [pf.max[0], pf.min[1]], -10, w(front), "h");
    dimension(sheet, [pf.min[0], pf.min[1]], [pf.min[0], pf.max[1]], -10, h(front), "v");
  }
  if (pt) dimension(sheet, [pt.min[0], pt.min[1]], [pt.min[0], pt.max[1]], -10, h(top), "v");
  if (!pf && pl) dimension(sheet, [pl.min[0], pl.min[1]], [pl.max[0], pl.min[1]], -10, w(left), "h");
  frame(sheet, fx0, fy0, fx1, fy1);
  titleBlock(sheet, fx1, fy0, o.title, label);
  return sheet;
}

/** A dimension between two sheet points: extension lines, a line with arrows `off` mm away, the value. */
function dimension(s: Sheet, a: Pt, b: Pt, off: number, value: number, dir: "h" | "v"): void {
  const ext = (p: Pt, q: Pt) => s.lines.push({ pts: [p, q], kind: "thin" });
  const arrow = (tip: Pt, back: Pt) => {
    const d: Pt = [back[0] - tip[0], back[1] - tip[1]];
    const l = Math.hypot(d[0], d[1]) || 1;
    const u: Pt = [d[0] / l, d[1] / l];
    const n: Pt = [-u[1], u[0]];
    s.fills.push([tip, [tip[0] + u[0] * 3 + n[0] * 0.6, tip[1] + u[1] * 3 + n[1] * 0.6], [tip[0] + u[0] * 3 - n[0] * 0.6, tip[1] + u[1] * 3 - n[1] * 0.6]]);
  };
  if (dir === "h") {
    const y = Math.min(a[1], b[1]) + off;
    ext([a[0], a[1] - 1], [a[0], y - 2]);
    ext([b[0], b[1] - 1], [b[0], y - 2]);
    s.lines.push({ pts: [[a[0], y], [b[0], y]], kind: "thin" });
    arrow([a[0], y], [b[0], y]);
    arrow([b[0], y], [a[0], y]);
    s.texts.push({ at: [(a[0] + b[0]) / 2, y + 1], text: fmt(value), size: 3.5, anchor: "middle" });
  } else {
    const x = Math.min(a[0], b[0]) + off;
    ext([a[0] - 1, a[1]], [x - 2, a[1]]);
    ext([b[0] - 1, b[1]], [x - 2, b[1]]);
    s.lines.push({ pts: [[x, a[1]], [x, b[1]]], kind: "thin" });
    arrow([x, a[1]], [x, b[1]]);
    arrow([x, b[1]], [x, a[1]]);
    s.texts.push({ at: [x - 1, (a[1] + b[1]) / 2], text: fmt(value), size: 3.5, anchor: "middle", angle: 90 });
  }
}

function frame(s: Sheet, x0: number, y0: number, x1: number, y1: number): void {
  s.lines.push({ pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], kind: "frame" });
}

/** Title block in the bottom right corner: title, number, scale, material, drawn by, date, projection. */
function titleBlock(s: Sheet, right: number, bottom: number, t: TitleBlock, scale: string): void {
  const x0 = right - TITLE_W, y0 = bottom, x1 = right, y1 = bottom + TITLE_H;
  const thin = (pts: Pt[]) => s.lines.push({ pts, kind: "thin" });
  s.lines.push({ pts: [[x0, y0], [x0, y1], [x1, y1]], kind: "frame" });
  // Rows: title (14 high), then two rows of fields (9 each).
  thin([[x0, y0 + 18], [x1, y0 + 18]]);
  thin([[x0, y0 + 9], [x1, y0 + 9]]);
  const cols = [x0, x0 + 45, x0 + 90, x0 + 135, x1];
  for (const x of cols.slice(1, -1)) thin([[x, y0], [x, y0 + 18]]);
  const field = (col: number, row: number, label: string, value: string) => {
    const x = cols[col]! + 1.5, y = y0 + (row === 0 ? 9 : 0);
    s.texts.push({ at: [x, y + 6.2], text: label, size: 1.8, anchor: "start" });
    s.texts.push({ at: [x, y + 1.8], text: value, size: 3, anchor: "start" });
  };
  field(0, 0, "Scale", scale);
  field(1, 0, "Material", t.material ?? "");
  field(2, 0, "Number", t.number ?? "");
  field(3, 0, "Sheet", "1 / 1");
  field(0, 1, "Drawn by", t.drawnBy ?? "");
  field(1, 1, "Date", t.date ?? "");
  field(2, 1, "Projection", "ISO E (first angle)");
  field(3, 1, "Units", "mm");
  s.texts.push({ at: [x0 + 2, y0 + 23], text: t.title, size: 6, anchor: "start" });
  s.texts.push({ at: [x1 - 2, y0 + 20], text: "meerCAD", size: 2, anchor: "end" });
}

// ---------------------------------------------------------------- writers

const STYLE: Record<LineKind, { width: number; dash?: [number, number] }> = {
  visible: { width: 0.5 },
  hidden: { width: 0.35, dash: [3, 1.5] },
  thin: { width: 0.25 },
  frame: { width: 0.7 },
};

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function writeSheetSvg(s: Sheet): string {
  const y = (v: number) => (s.height - v).toFixed(3);
  const x = (v: number) => v.toFixed(3);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${s.width}mm" height="${s.height}mm" viewBox="0 0 ${s.width} ${s.height}">`, `<rect width="${s.width}" height="${s.height}" fill="#fff"/>`];
  for (const l of s.lines) {
    const st = STYLE[l.kind];
    out.push(`<polyline fill="none" stroke="#000" stroke-width="${st.width}" stroke-linecap="round" stroke-linejoin="round"${st.dash ? ` stroke-dasharray="${st.dash.join(" ")}"` : ""} points="${l.pts.map((p) => `${x(p[0])},${y(p[1])}`).join(" ")}"/>`);
  }
  for (const f of s.fills) out.push(`<polygon fill="#000" points="${f.map((p) => `${x(p[0])},${y(p[1])}`).join(" ")}"/>`);
  for (const t of s.texts) {
    const rot = t.angle ? ` transform="rotate(${-t.angle} ${x(t.at[0])} ${y(t.at[1])})"` : "";
    out.push(`<text x="${x(t.at[0])}" y="${y(t.at[1])}" font-family="Helvetica, Arial, sans-serif" font-size="${t.size}" text-anchor="${t.anchor}"${rot}>${esc(t.text)}</text>`);
  }
  out.push("</svg>");
  return out.join("\n") + "\n";
}

/** Average Helvetica glyph width as a share of the font size, for anchoring text in the PDF. */
const HELVETICA = 0.55;
const PT = 72 / 25.4;

/** A one-page vector PDF (PDF 1.4) with the sheet's lines, arrows and text in Helvetica. */
export function writeSheetPdf(s: Sheet): Uint8Array {
  const n = (v: number) => (v * PT).toFixed(2);
  const ops: string[] = ["1 J 1 j"];
  for (const l of s.lines) {
    const st = STYLE[l.kind];
    ops.push(`${n(st.width)} w ${st.dash ? `[${n(st.dash[0])} ${n(st.dash[1])}] 0 d` : "[] 0 d"}`);
    ops.push(l.pts.map((p, i) => `${n(p[0])} ${n(p[1])} ${i ? "l" : "m"}`).join(" ") + " S");
  }
  for (const f of s.fills) ops.push(f.map((p, i) => `${n(p[0])} ${n(p[1])} ${i ? "l" : "m"}`).join(" ") + " h f");
  for (const t of s.texts) {
    const width = t.text.length * t.size * HELVETICA;
    const shift = t.anchor === "middle" ? -width / 2 : t.anchor === "end" ? -width : 0;
    const a = ((t.angle ?? 0) * Math.PI) / 180;
    const [c, si] = [Math.cos(a), Math.sin(a)];
    const x = t.at[0] + c * shift, y = t.at[1] + si * shift;
    ops.push(`BT /F1 ${n(t.size)} Tf ${c.toFixed(4)} ${si.toFixed(4)} ${(-si).toFixed(4)} ${c.toFixed(4)} ${n(x)} ${n(y)} Tm (${pdfText(t.text)}) Tj ET`);
  }
  const content = ops.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(s.width)} ${n(s.height)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(pdf, (ch) => ch.charCodeAt(0) & 255);
}

/** Text for a PDF string in WinAnsi: brackets and backslashes escaped, Latin-1 characters as octal codes, others as "?". */
function pdfText(t: string): string {
  return [...t]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (ch === "(" || ch === ")" || ch === "\\") return `\\${ch}`;
      if (code >= 32 && code < 127) return ch;
      if (code >= 160 && code < 256) return `\\${code.toString(8).padStart(3, "0")}`;
      return "?";
    })
    .join("");
}

/** AutoCAD R12 DXF: lines on the layers VISIBLE, HIDDEN (dashed), THIN and FRAME, texts on TEXT. */
export function writeSheetDxf(s: Sheet): string {
  const out: (string | number)[] = [0, "SECTION", 2, "HEADER", 9, "$INSUNITS", 70, 4, 0, "ENDSEC"];
  out.push(0, "SECTION", 2, "TABLES");
  out.push(0, "TABLE", 2, "LTYPE", 70, 2);
  out.push(0, "LTYPE", 2, "CONTINUOUS", 70, 0, 3, "Solid", 72, 65, 73, 0, 40, 0);
  out.push(0, "LTYPE", 2, "DASHED", 70, 0, 3, "Dashed", 72, 65, 73, 2, 40, 4.5, 49, 3, 49, -1.5);
  out.push(0, "ENDTAB", 0, "TABLE", 2, "LAYER", 70, 5);
  for (const [name, lt] of [["VISIBLE", "CONTINUOUS"], ["HIDDEN", "DASHED"], ["THIN", "CONTINUOUS"], ["FRAME", "CONTINUOUS"], ["TEXT", "CONTINUOUS"]]) out.push(0, "LAYER", 2, name!, 70, 0, 62, 7, 6, lt!);
  out.push(0, "ENDTAB", 0, "ENDSEC", 0, "SECTION", 2, "ENTITIES");
  const r = (v: number) => Number(v.toFixed(4));
  for (const l of s.lines) {
    const layer = l.kind.toUpperCase();
    for (let i = 1; i < l.pts.length; i++) out.push(0, "LINE", 8, layer, 10, r(l.pts[i - 1]![0]), 20, r(l.pts[i - 1]![1]), 30, 0, 11, r(l.pts[i]![0]), 21, r(l.pts[i]![1]), 31, 0);
  }
  for (const t of s.texts) {
    const h = t.anchor === "middle" ? 1 : t.anchor === "end" ? 2 : 0;
    out.push(0, "TEXT", 8, "TEXT", 10, r(t.at[0]), 20, r(t.at[1]), 30, 0, 40, t.size, 1, t.text, 50, t.angle ?? 0, 72, h, 11, r(t.at[0]), 21, r(t.at[1]), 31, 0);
  }
  out.push(0, "ENDSEC", 0, "EOF");
  return out.join("\n") + "\n";
}
