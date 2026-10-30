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
  name: "front" | "back" | "top" | "bottom" | "left" | "right" | "iso" | "section";
  visible: Pt[][];
  hidden: Pt[][];
  min: Pt;
  max: Pt;
  /** Section view: cut faces as edges (any order), hatched on the sheet. */
  sections?: Pt[][][];
  /** Section view: the cutting plane's place across the top view (its y). */
  cutAt?: number;
  /** Section view: the part of each cut face; parts are hatched alternately at 45° and 135°. */
  sectionParts?: number[];
  /** Round faces seen end-on: centre lines for all, diameter callouts for holes. */
  circles?: { c: Pt; r: number; hole?: boolean }[];
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
export type LineKind = "visible" | "hidden" | "thin" | "frame" | "chain";
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

/** A line of the parts list printed above the title block. */
export interface SheetBomRow {
  pos: number;
  qty: number;
  name: string;
  material?: string;
}
const BOM_ROW = 5.5;

/** Words printed on the sheet (title block field names, parts list header), for other languages. */
export const SHEET_LABELS = {
  scale: "Scale",
  material: "Material",
  number: "Number",
  sheet: "Sheet",
  drawnBy: "Drawn by",
  date: "Date",
  projection: "Projection",
  firstAngle: "ISO E (first angle)",
  units: "Units",
  pos: "Pos",
  qty: "Qty",
  name: "Name",
};
export type SheetLabels = typeof SHEET_LABELS;

export function layoutSheet(views: readonly SheetView[], o: { paper?: Paper; title: TitleBlock; scale?: number; bom?: readonly SheetBomRow[]; labels?: Partial<SheetLabels> }): Sheet {
  const words: SheetLabels = { ...SHEET_LABELS, ...o.labels };
  const [W, H] = PAPER[o.paper ?? "A4"];
  const sheet: Sheet = { width: W, height: H, scale: 1, scaleLabel: "1:1", lines: [], fills: [], texts: [] };
  // Frame: 20 mm on the left for filing, 10 mm elsewhere; the views keep clear of the title block's strip.
  const fx0 = 20, fy0 = 10, fx1 = W - 10, fy1 = H - 10;
  const bomH = o.bom?.length ? (o.bom.length + 1) * BOM_ROW : 0;
  const area = { x0: fx0 + 4, y0: fy0 + TITLE_H + bomH + 4, x1: fx1 - 4, y1: fy1 - 4 };
  const get = (n: SheetView["name"]) => views.find((v) => v.name === n);
  const front = get("front"), top = get("top"), left = get("left"), iso = get("iso"), sec = get("section");
  const w = (v?: SheetView) => (v ? v.max[0] - v.min[0] : 0);
  const h = (v?: SheetView) => (v ? v.max[1] - v.min[1] : 0);
  // Grid of two columns and two rows (model sizes), each cell padded for dimensions. A section goes
  // in a third column beside the front view or in a third row below the view from above, whichever
  // allows the larger scale; either way it lines up with the front view.
  const c0 = Math.max(w(front), w(top)), c1 = Math.max(w(left), w(iso));
  const r0 = Math.max(h(front), h(left)), r1 = Math.max(h(top), h(iso));
  const fitFor = (cs: number[], rs: number[]) => {
    const cols = cs.filter((c) => c > 0).length, rows = rs.filter((r) => r > 0).length;
    const availW = area.x1 - area.x0 - GAP * (cols + 1), availH = area.y1 - area.y0 - GAP * (rows + 1);
    return Math.min(availW / Math.max(cs.reduce((a, b) => a + b, 0), 1e-9), availH / Math.max(rs.reduce((a, b) => a + b, 0), 1e-9));
  };
  const beside = fitFor([c0, c1, w(sec)], [Math.max(r0, h(sec)), r1]);
  const below = fitFor([Math.max(c0, w(sec)), c1], [r0, r1, h(sec)]);
  const secBelow = !!sec && below > beside;
  const fit = sec ? Math.max(beside, below) : fitFor([c0, c1], [r0, r1]);
  const [scale, label] = o.scale ? [o.scale, SCALES.find((s) => s[0] === o.scale)?.[1] ?? `${fmt(o.scale)}:1`] : (SCALES.find((s) => s[0] <= fit) ?? SCALES[SCALES.length - 1]!);
  sheet.scale = scale;
  sheet.scaleLabel = label;
  const cc0 = secBelow ? Math.max(c0, w(sec)) : c0;
  const rr0 = secBelow ? r0 : Math.max(r0, h(sec));
  // Cell centres: row 0 on top.
  const x0 = area.x0 + GAP + (scale * cc0) / 2;
  const x1 = area.x0 + GAP + scale * cc0 + (cc0 > 0 ? GAP : 0) + (scale * c1) / 2;
  const x2 = area.x0 + GAP + scale * (cc0 + c1) + (cc0 > 0 ? GAP : 0) + (c1 > 0 ? GAP : 0) + (scale * w(sec)) / 2;
  const y0 = area.y1 - GAP - (scale * rr0) / 2;
  const y1 = area.y1 - GAP - scale * rr0 - (rr0 > 0 ? GAP : 0) - (scale * r1) / 2;
  const y2 = area.y1 - GAP - scale * (rr0 + r1) - (rr0 > 0 ? GAP : 0) - (r1 > 0 ? GAP : 0) - (scale * h(sec)) / 2;
  // Views that share an axis share its offset, so they line up (projection lines).
  const mid = (v: SheetView, k: 0 | 1) => (v.min[k] + v.max[k]) / 2;
  const ox = front ? x0 - scale * mid(front, 0) : top ? x0 - scale * mid(top, 0) : x0;
  const oy = front ? y0 - scale * mid(front, 1) : left ? y0 - scale * mid(left, 1) : y0;
  const place = (v: SheetView | undefined, px: number, py: number) => {
    if (!v) return null;
    const map = (p: Pt): Pt => [px + scale * p[0], py + scale * p[1]];
    for (const l of v.visible) sheet.lines.push({ pts: l.map(map), kind: "visible" });
    if (v.name !== "iso") for (const l of v.hidden) sheet.lines.push({ pts: l.map(map), kind: "hidden" });
    if (v.circles?.length) holeMarks(sheet, v.circles.map((c) => ({ c: map(c.c), r: c.r * scale, d: c.r * 2, hole: c.hole !== false })));
    return { min: map(v.min), max: map(v.max), v };
  };
  const pf = place(front, ox, oy);
  const pt = place(top, ox, top ? y1 - scale * mid(top, 1) : 0);
  const pl = place(left, left ? x1 - scale * mid(left, 0) : 0, oy);
  place(iso, iso ? x1 - scale * mid(iso, 0) : 0, iso ? y1 - scale * mid(iso, 1) : 0);
  // Beside the front view it shares the height axis, below the top view the width axis.
  const ps = place(sec, sec ? (secBelow ? ox : x2 - scale * mid(sec, 0)) : 0, sec ? (secBelow ? y2 - scale * mid(sec, 1) : oy) : 0);
  if (ps && sec) {
    const map = (p: Pt): Pt => [ps.min[0] + scale * (p[0] - sec.min[0]), ps.min[1] + scale * (p[1] - sec.min[1])];
    (sec.sections ?? []).forEach((face, i) => hatch(sheet, face.map((l) => l.map(map)), (sec.sectionParts?.[i] ?? 0) % 2 === 1));
    sheet.texts.push({ at: [(ps.min[0] + ps.max[0]) / 2, ps.max[1] + 4], text: "A-A", size: 5, anchor: "middle" });
    // The cutting plane across the view from above, with the viewing direction and its letter.
    if (pt && top && sec.cutAt !== undefined) {
      const y = pt.min[1] + scale * (sec.cutAt - top.min[1]);
      const [xa, xb] = [pt.min[0] - 6, pt.max[0] + 6];
      sheet.lines.push({ pts: [[xa, y], [xb, y]], kind: "chain" });
      for (const x of [xa, xb]) {
        sheet.lines.push({ pts: [[x, y], [x + (x === xa ? 5 : -5), y]], kind: "frame" });
        sheet.lines.push({ pts: [[x, y], [x, y + 6]], kind: "thin" });
        sheet.fills.push([[x, y + 8], [x - 0.9, y + 5], [x + 0.9, y + 5]]);
        sheet.texts.push({ at: [x + (x === xa ? -2.5 : 2.5), y + 4], text: "A", size: 5, anchor: "middle" });
      }
    }
  }
  // Overall dimensions: width under the front view, height to its left, depth to the left of the top view.
  if (pf) {
    dimension(sheet, [pf.min[0], pf.min[1]], [pf.max[0], pf.min[1]], -10, w(front), "h");
    dimension(sheet, [pf.min[0], pf.min[1]], [pf.min[0], pf.max[1]], -10, h(front), "v");
  }
  if (pt) dimension(sheet, [pt.min[0], pt.min[1]], [pt.min[0], pt.max[1]], -10, h(top), "v");
  if (!pf && pl) dimension(sheet, [pl.min[0], pl.min[1]], [pl.max[0], pl.min[1]], -10, w(left), "h");
  frame(sheet, fx0, fy0, fx1, fy1);
  titleBlock(sheet, fx1, fy0, o.title, label, words);
  if (o.bom?.length) bomTable(sheet, fx1, fy0 + TITLE_H, o.bom, words);
  return sheet;
}

/** 45° hatching (135° with `other`), 2.5 mm apart, inside a cut face given by its edges (filled by parity). */
function hatch(s: Sheet, edges: Pt[][], other = false): void {
  const segs = edges.flatMap((l) => l.slice(1).map((b, k) => [l[k]!, b] as const));
  if (!segs.length) return;
  const k = other ? -1 : 1;
  const d = (p: Pt) => (p[0] - k * p[1]) / Math.SQRT2;
  const along = (p: Pt) => (k * p[0] + p[1]) / Math.SQRT2;
  const ds = segs.flatMap(([a, b]) => [d(a), d(b)]);
  const [lo, hi] = [Math.min(...ds), Math.max(...ds)];
  for (let c = Math.ceil(lo / 2.5) * 2.5 + 1e-7; c < hi; c += 2.5) {
    const hits: Pt[] = [];
    for (const [a, b] of segs) {
      const [da, db] = [d(a) - c, d(b) - c];
      if (da > 0 === db > 0) continue;
      const t = da / (da - db);
      hits.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    hits.sort((p, q) => along(p) - along(q));
    for (let i = 0; i + 1 < hits.length; i += 2) s.lines.push({ pts: [hits[i]!, hits[i + 1]!], kind: "thin" });
  }
}

/**
 * Centre lines through round features seen end-on (one cross per centre, past the largest circle)
 * and a diameter callout per size, with a leader to its first circle: "2× Ø4.5".
 */
function holeMarks(s: Sheet, circles: { c: Pt; r: number; d: number; hole: boolean }[]): void {
  const centres: { c: Pt; r: number }[] = [];
  for (const k of circles) {
    const hit = centres.find((x) => Math.hypot(x.c[0] - k.c[0], x.c[1] - k.c[1]) < 1e-3);
    if (hit) hit.r = Math.max(hit.r, k.r);
    else centres.push({ c: k.c, r: k.r });
  }
  for (const { c, r } of centres) {
    const e = r + 2;
    s.lines.push({ pts: [[c[0] - e, c[1]], [c[0] + e, c[1]]], kind: "chain" });
    s.lines.push({ pts: [[c[0], c[1] - e], [c[0], c[1] + e]], kind: "chain" });
  }
  const sizes = new Map<string, { c: Pt; r: number }[]>();
  for (const k of circles.filter((x) => x.hole)) {
    const label = fmt(k.d);
    sizes.set(label, [...(sizes.get(label) ?? []), k]);
  }
  let n = 0;
  for (const [label, list] of sizes) {
    const first = list[0]!;
    // Up and to the right of the first circle, each size further out so the labels stay apart.
    const a = Math.PI / 4;
    const edge: Pt = [first.c[0] + first.r * Math.cos(a), first.c[1] + first.r * Math.sin(a)];
    const reach = 7 + 7 * n++;
    const knee: Pt = [edge[0] + reach * Math.cos(a), edge[1] + reach * Math.sin(a)];
    const text = `${list.length > 1 ? `${list.length}× ` : ""}Ø${label}`;
    const end: Pt = [knee[0] + text.length * 2, knee[1]];
    s.lines.push({ pts: [edge, knee, end], kind: "thin" });
    s.fills.push([edge, [edge[0] + 2.2 * Math.cos(a) - 0.5 * Math.sin(a), edge[1] + 2.2 * Math.sin(a) + 0.5 * Math.cos(a)], [edge[0] + 2.2 * Math.cos(a) + 0.5 * Math.sin(a), edge[1] + 2.2 * Math.sin(a) - 0.5 * Math.cos(a)]]);
    s.texts.push({ at: [knee[0] + 0.5, knee[1] + 0.8], text, size: 3, anchor: "start" });
  }
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
function titleBlock(s: Sheet, right: number, bottom: number, t: TitleBlock, scale: string, w: SheetLabels): void {
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
  field(0, 0, w.scale, scale);
  field(1, 0, w.material, t.material ?? "");
  field(2, 0, w.number, t.number ?? "");
  field(3, 0, w.sheet, "1 / 1");
  field(0, 1, w.drawnBy, t.drawnBy ?? "");
  field(1, 1, w.date, t.date ?? "");
  field(2, 1, w.projection, w.firstAngle);
  field(3, 1, w.units, "mm");
  s.texts.push({ at: [x0 + 2, y0 + 23], text: t.title, size: 6, anchor: "start" });
  s.texts.push({ at: [x1 - 2, y0 + 20], text: "meerCAD", size: 2, anchor: "end" });
}

/** The parts list as a table on top of the title block, header at the bottom (ISO 7573). */
function bomTable(s: Sheet, right: number, bottom: number, rows: readonly SheetBomRow[], w: SheetLabels): void {
  const x0 = right - TITLE_W;
  const cols = [x0, x0 + 12, x0 + 24, x0 + 130, right];
  const top = bottom + (rows.length + 1) * BOM_ROW;
  s.lines.push({ pts: [[x0, bottom], [x0, top], [right, top]], kind: "frame" });
  for (let k = 1; k <= rows.length; k++) s.lines.push({ pts: [[x0, bottom + k * BOM_ROW], [right, bottom + k * BOM_ROW]], kind: "thin" });
  for (const x of cols.slice(1, -1)) s.lines.push({ pts: [[x, bottom], [x, top]], kind: "thin" });
  const row = (k: number, cells: string[], size: number) => cells.forEach((t, i) => s.texts.push({ at: [cols[i]! + 1.5, bottom + k * BOM_ROW + 1.6], text: t, size, anchor: "start" }));
  row(0, [w.pos, w.qty, w.name, w.material], 2.2);
  // The first part sits right above the header, the last at the top.
  rows.forEach((r, k) => row(k + 1, [String(r.pos), String(r.qty), r.name, r.material ?? ""], 2.8));
}

// ---------------------------------------------------------------- writers

const STYLE: Record<LineKind, { width: number; dash?: number[] }> = {
  visible: { width: 0.5 },
  hidden: { width: 0.35, dash: [3, 1.5] },
  thin: { width: 0.25 },
  frame: { width: 0.7 },
  chain: { width: 0.25, dash: [8, 1.5, 1, 1.5] },
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
    ops.push(`${n(st.width)} w ${st.dash ? `[${st.dash.map(n).join(" ")}] 0 d` : "[] 0 d"}`);
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
  out.push(0, "ENDTAB", 0, "TABLE", 2, "LAYER", 70, 6);
  for (const [name, lt] of [["VISIBLE", "CONTINUOUS"], ["HIDDEN", "DASHED"], ["THIN", "CONTINUOUS"], ["FRAME", "CONTINUOUS"], ["CHAIN", "DASHED"], ["TEXT", "CONTINUOUS"]]) out.push(0, "LAYER", 2, name!, 70, 0, 62, 7, 6, lt!);
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
