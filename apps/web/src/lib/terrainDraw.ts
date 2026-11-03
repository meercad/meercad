/**
 * Marking up a terrain (a reference model): lines and areas through clicked points that follow the
 * ground between them, with their length and area, notes pinned to a spot and points to stake out
 * with their coordinates. No grid and no snapping: every point is where the click meets the
 * ground. Kept in the reference model's `marks`, so they are saved, undone and versioned like any
 * change. Measuring on the ground and correcting a terrain's scale from a known distance live here too.
 */
import type { ReferenceModel, TerrainMark, Vec3 } from "@meercad/schema";
import { THREE, type Viewport } from "@meercad/viewport";
import { create } from "zustand";
import { askText } from "../components/Ask";
import { apply, currentDoc, getViewport, toast } from "../store";
import { t } from "./i18n";
import { touchOnly } from "./keyboard";

export type MarkKind = TerrainMark["kind"];
export const MARK_COLORS = ["#e8590c", "#f2c94c", "#2f9e44", "#1c7ed6", "#c2255c", "#ffffff"];

/** Highlighter widths, in steps of the terrain's detail (so they suit a field as well as a garden). */
export const STROKE_WIDTHS = { s: 2, m: 6, l: 16 } as const;

/**
 * The marking being drawn: its kind, the terrain, the points so far and where the pointer is; for
 * the highlighter also its width and the stroke being painted.
 */
export const useTerrainDraw = create<{ kind: MarkKind | null; ref: string | null; points: Vec3[]; hover: Vec3 | null; color: string; width: keyof typeof STROKE_WIDTHS; painting: boolean }>(() => ({
  kind: null,
  ref: null,
  points: [],
  hover: null,
  color: MARK_COLORS[0]!,
  width: "m",
  painting: false,
}));

const shown = (): ReferenceModel[] => (currentDoc().references ?? []).filter((r) => !r.hidden);

/** Starts drawing a line, an area, a note or a point on a terrain (the one clicked, or the first shown). */
export function startMarking(kind: MarkKind, ref?: string): void {
  const target = ref ?? shown()[0]?.id;
  if (!target) return toast(t("Show a terrain to draw on first."), "error");
  useTerrainDraw.setState({ kind, ref: target, points: [], hover: null });
  const touch = touchOnly();
  toast(
    kind === "note"
      ? touch ? t("Tap the terrain where the note goes.") : t("Click on the terrain where the note goes.")
      : kind === "point"
        ? touch ? t("Tap the terrain where the point goes.") : t("Click on the terrain where the point goes.")
        : kind === "stroke"
          ? touch ? t("Paint on the terrain with a finger. Done ends painting.") : t("Paint on the terrain with the mouse button held down. Esc ends painting.")
          : touch ? t("Tap points on the terrain, then Done.") : t("Click points on the terrain; Enter or a double click finishes, Esc cancels."),
  );
}

export function cancelMarking(): void {
  useTerrainDraw.setState({ kind: null, points: [], hover: null });
}

/** Adds a clicked point; a note or a point is placed at once. */
export function addMarkPoint(p: Vec3, ref?: string): void {
  const s = useTerrainDraw.getState();
  if (!s.kind) return;
  if (ref && !s.points.length) useTerrainDraw.setState({ ref });
  if (s.kind === "note" || s.kind === "point") return void placeNote(p);
  useTerrainDraw.setState({ points: [...s.points, p] });
}

/** The highlighter: a stroke starts where the pointer goes down on the ground… */
export function beginStroke(p: Vec3, ref: string): void {
  useTerrainDraw.setState({ ref, points: [p], painting: true });
}

/** …follows it (points a little apart, the ground fills in between)… */
export function extendStroke(p: Vec3): void {
  const s = useTerrainDraw.getState();
  const last = s.points[s.points.length - 1];
  const step = Math.max(getViewport()?.sceneryStep ?? 1, 1);
  if (!s.painting || (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < step * 0.8)) return;
  useTerrainDraw.setState({ points: [...s.points, p] });
}

/** …and is kept when it comes up. Painting goes on until Done. */
export function endStroke(): void {
  const s = useTerrainDraw.getState();
  useTerrainDraw.setState({ points: [], painting: false });
  if (!s.ref || s.points.length < 2) return;
  const width = Math.round(Math.max(getViewport()?.sceneryStep ?? 100, 1) * STROKE_WIDTHS[s.width]);
  saveMark(s.ref, { id: newMarkId(s.ref), kind: "stroke", points: s.points, color: s.color, width });
}

export function undoMarkPoint(): void {
  useTerrainDraw.setState((s) => ({ points: s.points.slice(0, -1) }));
}

/** Keeps the line or area drawn so far (at least two or three points). */
export function finishMarking(): void {
  const s = useTerrainDraw.getState();
  if ((s.kind !== "line" && s.kind !== "area") || !s.ref) return;
  const need = s.kind === "area" ? 3 : 2;
  if (s.points.length < need) return toast(s.kind === "area" ? t("An area needs at least three points.") : t("A line needs at least two points."), "error");
  saveMark(s.ref, { id: newMarkId(s.ref), kind: s.kind, points: s.points, color: s.color });
  cancelMarking();
}

/** A note (its text is asked for) or a point to stake out (a name is optional). */
async function placeNote(p: Vec3): Promise<void> {
  const s = useTerrainDraw.getState();
  cancelMarking();
  if (!s.ref) return;
  if (s.kind === "point") {
    const count = (currentDoc().references?.find((r) => r.id === s.ref)?.marks ?? []).filter((m) => m.kind === "point").length;
    const name = await askText({ title: t("Point"), label: t("Name (optional)"), value: `P${count + 1}`, confirmLabel: t("Set") });
    if (name === null) return;
    return saveMark(s.ref, { id: newMarkId(s.ref), kind: "point", points: [p], color: s.color, ...(name.trim() ? { text: name.trim() } : {}) });
  }
  const text = (await askText({ title: t("Note"), label: t("Text"), confirmLabel: t("Pin it") }))?.trim();
  if (text) saveMark(s.ref, { id: newMarkId(s.ref), kind: "note", points: [p], color: s.color, text });
}

function newMarkId(ref: string): string {
  const used = new Set(currentDoc().references?.find((r) => r.id === ref)?.marks?.map((m) => m.id));
  let n = 1;
  while (used.has(`m${n}`)) n++;
  return `m${n}`;
}

function saveMark(ref: string, mark: TerrainMark): void {
  const r = currentDoc().references?.find((x) => x.id === ref);
  if (r) apply({ type: "set_reference", reference: { ...r, marks: [...(r.marks ?? []).filter((m) => m.id !== mark.id), mark] } });
}

export function deleteMark(ref: string, id: string): void {
  const r = currentDoc().references?.find((x) => x.id === ref);
  if (!r) return;
  const marks = (r.marks ?? []).filter((m) => m.id !== id);
  const { marks: _old, ...rest } = r;
  apply({ type: "set_reference", reference: marks.length ? { ...rest, marks } : rest });
}

export async function editMark(ref: string, mark: TerrainMark): Promise<void> {
  const text = (await askText({ title: mark.kind === "note" ? t("Note") : t("Name"), label: t("Text"), value: mark.text ?? "" }))?.trim();
  if (text === undefined) return;
  const { text: _old, ...rest } = mark;
  saveMark(ref, text ? { ...rest, text } : rest);
}

// ---------------------------------------------------------------- following the ground

/** Height above the ground lines are drawn at, so the ground does not hide them. */
const lift = (vp: Viewport) => Math.max(30, vp.sceneryStep * 0.4);

/** The points with the ground in between: each stretch split finer than the terrain's detail. */
export function drape(points: readonly Vec3[], closed: boolean, vp: Viewport): Vec3[] {
  const step = Math.max(vp.sceneryStep, 1);
  const up = lift(vp);
  const out: Vec3[] = [];
  const n = closed ? points.length : points.length - 1;
  for (let k = 0; k < n; k++) {
    const a = points[k]!, b = points[(k + 1) % points.length]!;
    const pieces = Math.min(2000, Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)));
    for (let i = 0; i < pieces; i++) {
      const u = i / pieces;
      const x = a[0] + (b[0] - a[0]) * u, y = a[1] + (b[1] - a[1]) * u;
      // The surface the clicked points lie on (the floor, not the ceiling above it).
      const near = a[2] + (b[2] - a[2]) * u;
      out.push([x, y, (vp.sceneryHeight(x, y, near) ?? near) + up]);
    }
  }
  const last = points[closed ? 0 : points.length - 1];
  if (last) out.push([last[0], last[1], (vp.sceneryHeight(last[0], last[1], last[2]) ?? last[2]) + up]);
  return out;
}

/** An area's surface following the ground, as triangles (corners, no index). */
export function drapeFill(points: readonly Vec3[], vp: Viewport): Float32Array {
  const contour = points.map((p) => new THREE.Vector2(p[0], p[1]));
  if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const step = Math.max(vp.sceneryStep * 2, 1);
  const up = lift(vp) * 0.5;
  const out: number[] = [];
  const level = points.reduce((s, p) => s + p[2], 0) / points.length;
  const at = (x: number, y: number) => out.push(x, y, (vp.sceneryHeight(x, y, level) ?? level) + up);
  const split = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2, depth: number) => {
    const ab = a.distanceTo(b), bc = b.distanceTo(c), ca = c.distanceTo(a);
    if (Math.max(ab, bc, ca) <= step || depth > 12 || out.length > 3_000_000) {
      at(a.x, a.y), at(b.x, b.y), at(c.x, c.y);
      return;
    }
    // Halve the longest edge.
    if (ab >= bc && ab >= ca) {
      const m = a.clone().lerp(b, 0.5);
      split(a, m, c, depth + 1), split(m, b, c, depth + 1);
    } else if (bc >= ca) {
      const m = b.clone().lerp(c, 0.5);
      split(a, b, m, depth + 1), split(a, m, c, depth + 1);
    } else {
      const m = c.clone().lerp(a, 0.5);
      split(a, b, m, depth + 1), split(m, b, c, depth + 1);
    }
  };
  for (const [i, j, k] of tris) split(contour[i!]!, contour[j!]!, contour[k!]!, 0);
  return Float32Array.from(out);
}

/** A band of the given width lying on the ground along a line (triangles, corners, no index): a highlighter stroke. */
export function ribbon(line: readonly Vec3[], width: number, vp: Viewport): Float32Array {
  const up = lift(vp) * 0.7;
  const half = width / 2;
  const sides: [Vec3, Vec3][] = line.map((p, i) => {
    const a = line[Math.max(0, i - 1)]!, b = line[Math.min(line.length - 1, i + 1)]!;
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const nx = (-dy / l) * half, ny = (dx / l) * half;
    const at = (x: number, y: number): Vec3 => [x, y, (vp.sceneryHeight(x, y, p[2] - lift(vp)) ?? p[2]) + up];
    return [at(p[0] + nx, p[1] + ny), at(p[0] - nx, p[1] - ny)];
  });
  const out: number[] = [];
  for (let i = 1; i < sides.length; i++) {
    const [l0, r0] = sides[i - 1]!, [l1, r1] = sides[i]!;
    out.push(...l0, ...r0, ...l1, ...l1, ...r0, ...r1);
  }
  return Float32Array.from(out);
}

/** Length along the ground (mm). */
export function lengthOf(draped: readonly Vec3[]): number {
  let l = 0;
  for (let i = 1; i < draped.length; i++) l += Math.hypot(draped[i]![0] - draped[i - 1]![0], draped[i]![1] - draped[i - 1]![1], draped[i]![2] - draped[i - 1]![2]);
  return l;
}

/** An area seen from above and along the ground (mm²). */
export function areaOf(points: readonly Vec3[], fill: Float32Array): { flat: number; ground: number } {
  let flat = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    flat += a[0] * b[1] - b[0] * a[1];
  }
  let ground = 0;
  const v = (k: number) => new THREE.Vector3(fill[k], fill[k + 1], fill[k + 2]);
  for (let k = 0; k + 8 < fill.length; k += 9) {
    const a = v(k), b = v(k + 3), c = v(k + 6);
    ground += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return { flat: Math.abs(flat) / 2, ground };
}

/** "12.4 m" or "1.23 km". */
export const metres = (mm: number): string => (mm >= 1e6 ? `${(mm / 1e6).toFixed(2)} km` : `${(mm / 1000).toFixed(mm >= 1e5 ? 0 : 1)} m`);
/** "250 m²" or "1.20 ha". */
export const squareMetres = (mm2: number): string => (mm2 >= 1e10 ? `${(mm2 / 1e10).toFixed(2)} ha` : `${(mm2 / 1e6).toFixed(mm2 >= 1e8 ? 0 : 1)} m²`);

type DrawnMark = Parameters<Viewport["setSceneryMarks"]>[0][number];

/**
 * A label in the view: a note card, a stake-out point (its name; where it is shows on hover), or a
 * value on a line, an area or a measurement. Earlier ones in the list win where labels overlap.
 */
export interface TerrainLabel {
  key: string;
  ref: string;
  mark?: TerrainMark;
  at: Vec3;
  kind: "note" | "point" | "value";
  title: string;
  detail?: string;
  color: string;
}

/** Every mark of the shown terrains with the drawing and measuring in progress, as the viewport draws them, and their labels. */
export function marksForView(refs: readonly ReferenceModel[] | undefined, drawing: ReturnType<typeof useTerrainDraw.getState>): {
  lines: DrawnMark[];
  labels: TerrainLabel[];
} {
  const vp = getViewport();
  const lines: DrawnMark[] = [];
  const labels: ReturnType<typeof marksForView>["labels"] = [];
  if (!vp || !vp.sceneryStep) return { lines, labels };
  const up = lift(vp);
  for (const r of refs ?? []) {
    if (r.hidden) continue;
    for (const m of r.marks ?? []) {
      if (m.kind === "note" || m.kind === "point") {
        const p = m.points[0]!;
        const ground: Vec3 = [p[0], p[1], vp.sceneryHeight(p[0], p[1], p[2]) ?? p[2]];
        labels.push({ key: `${r.id}/${m.id}`, ref: r.id, mark: m, at: ground, kind: m.kind, title: m.kind === "note" ? (m.text ?? "") : (m.text ?? t("Point")), ...(m.kind === "point" ? { detail: placeText(r, ground) } : {}), color: m.color });
        continue;
      }
      if (m.kind === "stroke") {
        lines.push({ id: `${r.id}/${m.id}`, points: [], color: m.color, fill: ribbon(drape(m.points, false, vp), m.width ?? vp.sceneryStep * STROKE_WIDTHS.m, vp), fillOpacity: 0.55 });
        continue;
      }
      const area = m.kind === "area";
      const points = drape(m.points, area, vp);
      const fill = area ? drapeFill(m.points, vp) : undefined;
      lines.push({ id: `${r.id}/${m.id}`, points, closed: false, color: m.color, ...(fill ? { fill } : {}) });
      const value = area ? squareMetres(areaOf(m.points, fill!).ground) : metres(lengthOf(points));
      labels.push({ key: `${r.id}/${m.id}`, ref: r.id, mark: m, at: area ? centreOf(m.points, vp) : points[Math.floor(points.length / 2)]!, kind: "value", title: value, ...(m.text ? { detail: m.text } : {}), color: m.color });
    }
  }
  // A measurement between two points of the ground.
  const ms = useTerrainMeasure.getState();
  if (ms.points.length) {
    const pts = ms.points.length < 2 && ms.hover ? [...ms.points, ms.hover] : ms.points;
    const lifted = pts.map((p): Vec3 => [p[0], p[1], p[2] + up]);
    lines.push({ id: "measure", points: lifted, color: "#ffffff", width: 2.5, dashed: ms.points.length < 2 });
    const ref = (refs ?? []).find((r) => r.id === ms.ref);
    if (pts.length === 2) {
      const [head, ...rest] = distanceText(pts[0]!, pts[1]!).split(" · ");
      labels.unshift({ key: "measure", ref: ms.ref ?? "", at: lifted[1]!, kind: "value", title: head!, detail: rest.join(" · "), color: "#ffffff" });
    } else if (ref) labels.unshift({ key: "measure", ref: ms.ref ?? "", at: pts[0]!, kind: "point", title: t("Here"), detail: placeText(ref, pts[0]!), color: "#ffffff" });
  }
  // The stroke being painted.
  if (drawing.kind === "stroke" && drawing.points.length >= 2) lines.push({ id: "drawing", points: [], color: drawing.color, fill: ribbon(drape(drawing.points, false, vp), vp.sceneryStep * STROKE_WIDTHS[drawing.width], vp), fillOpacity: 0.55 });
  // The line or area being drawn, up to the pointer.
  if ((drawing.kind === "line" || drawing.kind === "area") && drawing.points.length) {
    const pts = drawing.hover ? [...drawing.points, drawing.hover] : drawing.points;
    const area = drawing.kind === "area" && pts.length >= 3;
    const points = drape(pts, area, vp);
    const fill = area ? drapeFill(pts, vp) : undefined;
    lines.push({ id: "drawing", points, color: drawing.color, dashed: true, ...(fill ? { fill } : {}) });
    labels.unshift({ key: "drawing", ref: drawing.ref ?? "", at: points[points.length - 1]!, kind: "value", title: area ? squareMetres(areaOf(pts, fill!).ground) : metres(lengthOf(points)), color: drawing.color });
  }
  return { lines, labels };
}

/** The middle of an area, on the ground: where its label goes. */
function centreOf(points: readonly Vec3[], vp: Viewport): Vec3 {
  const x = points.reduce((s, p) => s + p[0], 0) / points.length, y = points.reduce((s, p) => s + p[1], 0) / points.length;
  const level = points.reduce((s, p) => s + p[2], 0) / points.length;
  return [x, y, (vp.sceneryHeight(x, y, level) ?? level) + lift(vp)];
}

// ---------------------------------------------------------------- measuring, staking out, scale

/**
 * Measuring on the terrain (the Measure tool over ground): one point shows where it is, two the
 * distance between them. With `scale`, the second point asks for the distance's real length and
 * the terrain is scaled to it.
 */
export const useTerrainMeasure = create<{ points: Vec3[]; hover: Vec3 | null; ref: string | null; scale: boolean }>(() => ({ points: [], hover: null, ref: null, scale: false }));

export function measurePoint(p: Vec3, ref: string): void {
  const s = useTerrainMeasure.getState();
  const points = s.points.length >= 2 ? [p] : [...s.points, p];
  useTerrainMeasure.setState({ points, ref: s.points.length >= 2 || !s.ref ? ref : s.ref });
  if (points.length === 2 && s.scale) void scaleTo(points[0]!, points[1]!);
}

export function clearTerrainMeasure(): void {
  useTerrainMeasure.setState({ points: [], hover: null, scale: false });
}

/** Starts correcting a terrain's size: the user clicks the two ends of a distance they know. */
export function startScaling(ref: string): void {
  useTerrainMeasure.setState({ points: [], hover: null, ref, scale: true });
  toast(touchOnly() ? t("Tap both ends of a distance whose real length you know (a parking space, a wall, a measured line).") : t("Click both ends of a distance whose real length you know (a parking space, a wall, a measured line)."));
}

async function scaleTo(a: Vec3, b: Vec3): Promise<void> {
  const ref = useTerrainMeasure.getState().ref;
  const r = currentDoc().references?.find((x) => x.id === ref);
  const now = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (!r || now < 1) return clearTerrainMeasure();
  const answer = await askText({ title: t("Correct the scale"), message: t("The model shows {length} between the two points.", { length: metres(now) }), label: t("Real length (m)"), value: (now / 1000).toFixed(2), confirmLabel: t("Scale") });
  clearTerrainMeasure();
  const real = Number((answer ?? "").replace(",", ".")) * 1000;
  if (!answer || !(real > 0)) return;
  const k = real / now;
  const scaled = (p: Vec3): Vec3 => [p[0] * k, p[1] * k, p[2] * k];
  apply({
    type: "set_reference",
    reference: { ...r, scale: (r.scale ?? 1) * k, ...(r.marks ? { marks: r.marks.map((m) => ({ ...m, points: m.points.map(scaled) })) } : {}) },
  });
  toast(t("Scaled by {factor}: the distance is now {length}.", { factor: k.toFixed(4), length: metres(real) }));
}

/** "12.4 m · level 12.1 m · ↑ 2.3 m (19 %) · 47° from north". */
export function distanceText(a: Vec3, b: Vec3): string {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const level = Math.hypot(dx, dy);
  const bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  const slope = level > 0 ? Math.round((Math.abs(dz) / level) * 100) : 0;
  return `${metres(Math.hypot(level, dz))} · ${t("level {d}", { d: metres(level) })} · ${dz >= 0 ? "↑" : "↓"} ${metres(Math.abs(dz))} (${slope} %) · ${t("{deg}° from north", { deg: bearing.toFixed(0) })}`;
}

/** Where a point is: metres east and north of the terrain's origin and its height; with GPS also its latitude and longitude. */
export function placeText(r: ReferenceModel, p: Vec3): string {
  const local = t("E {e} · N {n} · height {h}", { e: (p[0] / 1000).toFixed(2), n: (p[1] / 1000).toFixed(2), h: (p[2] / 1000).toFixed(2) });
  if (!r.geo) return local;
  const lat = r.geo.lat + p[1] / 1000 / 111_320;
  const lon = r.geo.lon + p[0] / 1000 / (111_320 * Math.cos((r.geo.lat * Math.PI) / 180));
  return `${local}\n${lat.toFixed(7)}, ${lon.toFixed(7)} · ${(r.geo.alt + p[2] / 1000).toFixed(1)} m`;
}
