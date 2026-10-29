/**
 * Pictures and videos of the model for assistants (MCP) and for sharing: framed from any
 * direction, zoomed onto parts, cut open, with parts or faces highlighted, and frames of a moving
 * joint as one contact sheet (collisions marked) or as an animated GIF.
 */
import { encodeGif } from "@meercad/io";
import { resolveFaces } from "@meercad/naming";
import type { FaceSelector } from "@meercad/schema";
import type { Pick, StandardView } from "@meercad/viewport";
import { getViewport, useApp } from "../store";
import { partName } from "./features";
import { clearanceNow, currentMechanism, currentPoses, jointValues, openForCheck, restPose, setJointValue, stopPlaying, useMotion } from "./mechanism";
import { meshTopology } from "./topology";

type V3 = [number, number, number];

export interface Shot {
  width?: number;
  height?: number;
  view?: StandardView;
  /** Looking along this direction (from the camera towards the model), instead of a standard view. */
  direction?: V3;
  /** Parts to frame (zoom onto); `isolate` hides all others. */
  focus?: string[];
  isolate?: boolean;
  /** Cut the model open: a plane through the origin offset along its normal; the cut shows red. */
  section?: { normal: V3; offset?: number };
  highlight?: { parts?: string[]; faces?: FaceSelector[] };
}

const HIGHLIGHT = "#ff8a3d";

function viewport() {
  const vp = getViewport();
  if (!vp) throw new Error("viewport not ready");
  return vp;
}

/** Face picks for selectors, to paint them as selected. */
function facePicks(selectors: readonly FaceSelector[]): Pick[] {
  const meshes = useApp.getState().output?.meshes ?? [];
  const topos = meshes.map(meshTopology);
  const picks: Pick[] = [];
  for (const sel of selectors)
    for (const r of resolveFaces(sel, topos)) {
      const m = meshes.find((x) => x.bodyId === r.body)!;
      for (const face of r.faces) picks.push({ kind: "face", bodyId: r.body, face, tags: m.faceTags[face] ?? [], point: [0, 0, 0], normal: null });
    }
  if (selectors.length && !picks.length) throw new Error("no face matches the highlight selectors");
  return picks;
}

function renderOptions(s: Shot, box?: { min: V3; max: V3 }) {
  const bodies = new Set(useApp.getState().output?.report.bodies.map((b) => b.id) ?? []);
  for (const id of [...(s.focus ?? []), ...(s.highlight?.parts ?? [])]) if (!bodies.has(id)) throw new Error(`no part "${id}"`);
  return {
    width: Math.round(s.width ?? 800),
    height: Math.round(s.height ?? 600),
    ...(s.view ? { view: s.view } : {}),
    ...(s.direction ? { direction: s.direction } : {}),
    ...(s.focus?.length ? { focus: s.focus, isolate: !!s.isolate } : {}),
    ...(s.section ? { section: { normal: s.section.normal, offset: s.section.offset ?? 0 } } : {}),
    ...(s.highlight?.parts?.length ? { bodyColors: new Map(s.highlight.parts.map((p) => [p, HIGHLIGHT])) } : {}),
    ...(s.highlight?.faces?.length ? { faces: facePicks(s.highlight.faces) } : {}),
    ...(box ? { box } : {}),
  };
}

/** A PNG (data URL) of the model as shown now (moving parts in their pose). */
export function renderShot(s: Shot): string {
  return viewport().render(renderOptions(s));
}

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not draw a frame"));
    img.src = url;
  });

/**
 * Moves `joint` through `values`, picturing each pose with one camera for all (framing every
 * pose), and puts the joints back afterwards. `each` gets each frame.
 */
async function framesOf(joint: string, values: number[], shot: Shot, each: (url: string, value: number, i: number) => Promise<void>): Promise<void> {
  openForCheck();
  stopPlaying();
  const vp = viewport();
  const { mech } = currentMechanism();
  if (!mech.joint(joint)) throw new Error(`no joint "${joint}"`);
  const before = jointValues();
  const free = { ...useMotion.getState().free };
  const go = (v: number) => {
    setJointValue(joint, v);
    vp.setPoses(currentPoses());
  };
  try {
    // One framing for all frames, so the parts move and the camera stays.
    let box: { min: V3; max: V3 } | null = null;
    for (const v of values) {
      go(v);
      const b = vp.modelBox(shot.focus);
      if (b) box = box ? { min: box.min.map((x, k) => Math.min(x, b.min[k]!)) as V3, max: box.max.map((x, k) => Math.max(x, b.max[k]!)) as V3 } : b;
    }
    for (let i = 0; i < values.length; i++) {
      go(values[i]!);
      await each(vp.render(renderOptions(shot, box ?? undefined)), values[i]!, i);
    }
  } finally {
    restPose();
    useMotion.setState({ free });
    for (const [id, v] of Object.entries(before)) if (v) setJointValue(id, v);
    vp.setPoses(currentPoses());
  }
}

/** The values a joint runs through: between its limits, a full turn without, or ±20 mm for a free slider. */
export function jointRange(joint: string): [number, number] {
  const j = currentMechanism().mech.joint(joint);
  if (!j) throw new Error(`no joint "${joint}"`);
  if (j.limits) return j.limits;
  return j.type === "revolute" ? [0, 360] : [-20, 20];
}

/**
 * Frames of a joint's motion side by side on one sheet, each labelled with its value; a frame
 * where parts overlap gets a red border and names them.
 */
export async function renderMotionSheet(joint: string, from: number, to: number, frames = 9, s: Shot = {}, collisions = true): Promise<{ png: string; frames: { value: number; collisions: string[] }[] }> {
  const n = Math.max(2, Math.min(16, Math.round(frames)));
  const values = Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
  const cols = n <= 3 ? n : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  const rows = Math.ceil(n / cols);
  const width = Math.round(s.width ?? 1200);
  const cw = Math.floor(width / cols);
  const ch = Math.floor(cw * 0.75);
  const label = 22;
  const canvas = document.createElement("canvas");
  canvas.width = cw * cols;
  canvas.height = (ch + label) * rows;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  const unit = currentMechanism().mech.joint(joint)?.type === "slider" ? " mm" : "°";
  const features = useApp.getState().doc.features;
  const out: { value: number; collisions: string[] }[] = [];
  await framesOf(joint, values, { ...s, width: cw, height: ch }, async (url, value, i) => {
    const hits = collisions ? (await clearanceNow()).pairs.filter((c) => c.overlap > 1e-3).map((c) => `${partName(c.a, features)} · ${partName(c.b, features)}`) : [];
    out.push({ value: +value.toFixed(3), collisions: hits });
    const x = (i % cols) * cw;
    const y = Math.floor(i / cols) * (ch + label);
    g.drawImage(await loadImage(url), x, y, cw, ch);
    g.fillStyle = hits.length ? "#d93f3f" : "#19202b";
    g.font = "600 14px -apple-system, Helvetica, sans-serif";
    g.fillText(`${joint} = ${value.toFixed(unit === "°" ? 0 : 1)}${unit}${hits.length ? `  collision: ${hits.join(", ")}` : ""}`, x + 8, y + ch + 16, cw - 16);
    if (hits.length) {
      g.strokeStyle = "#d93f3f";
      g.lineWidth = 4;
      g.strokeRect(x + 2, y + 2, cw - 4, ch + label - 4);
    }
  });
  return { png: canvas.toDataURL("image/png"), frames: out };
}

/** An animated GIF of a joint's motion: once round for a free turn, there and back otherwise. */
export async function renderMotionGif(joint: string, from: number, to: number, frames = 36, s: Shot = {}): Promise<Uint8Array> {
  const n = Math.max(4, Math.min(120, Math.round(frames)));
  const fullTurn = currentMechanism().mech.joint(joint)?.type === "revolute" && Math.abs(Math.abs(to - from) - 360) < 1e-6;
  // A full turn ends where it starts: leave out the last frame so the loop does not stutter.
  const count = fullTurn ? n : Math.ceil(n / 2) + 1;
  const there = Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (fullTurn ? count : count - 1));
  const values = fullTurn ? there : [...there, ...there.slice(1, -1).reverse()];
  const width = Math.round(s.width ?? 480);
  const height = Math.round(s.height ?? 360);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  const rgba: Uint8ClampedArray[] = [];
  await framesOf(joint, values, { ...s, width, height }, async (url) => {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, width, height);
    g.drawImage(await loadImage(url), 0, 0, width, height);
    rgba.push(g.getImageData(0, 0, width, height).data);
  });
  return encodeGif(rgba.map((d) => ({ width, height, rgba: d })), 1000 / 15);
}
