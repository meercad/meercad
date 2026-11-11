/**
 * Moving parts in the app: the mechanism of the open design (joints from the document, axes from
 * the last rebuild), the joint values being shown (view state, not saved, no undo), dragging parts,
 * and the joint being drawn up in the joints panel.
 */
import { cable, evaluate, fitExpr, linkage, MeshCollider, meshesCollide, motion, resolveFeature } from "@meercad/model";
import type { Coupling, Joint, JointAnchor, Motion } from "@meercad/schema";
import type { Pick, Ray } from "@meercad/viewport";
import { create } from "zustand";
import type { BodyMesh, Clearance } from "@meercad/kernel";
import { apply, currentDoc, kernel, toast, useApp } from "../store";
import { edgeSelectorForPick, faceSelectorForPick } from "./topology";
import { isFastener } from "./features";
import { t } from "./i18n";

export type JointField = "a" | "b" | "anchor";

export interface ClearanceCheck {
  running: boolean;
  /** Joint values the check ran for (results go stale when the parts move). */
  free: Record<string, number>;
  results: Clearance[];
  error?: string;
}

export const useMotion = create<{
  open: boolean;
  /** Values of the joints nothing drives (degrees or mm). */
  free: Record<string, number>;
  draft: { joint: Joint; isNew: boolean; field: JointField | null } | null;
  /** Joint being played (driven back and forth or round), or null. */
  playing: string | null;
  /** Motion being played (its id), or null. */
  playingMotion: string | null;
  check: ClearanceCheck | null;
  /** Bumped when a closed-loop linkage moves (its pose lives outside the store). */
  tick: number;
  /** Parts held at their joint's limit: shown red. */
  blocked: string[];
  /** Pairs of parts that run into each other in the shown pose (and did not touch as drawn). */
  hits: [string, string][];
  /** Cables in the shown pose: stretched, bent too tight or running into parts. */
  cables: cable.CableState[];
}>(() => ({ open: false, free: {}, draft: null, playing: null, playingMotion: null, check: null, tick: 0, blocked: [], hits: [], cables: [] }));

// ---------------------------------------------------------------- closed loops

/** Pose of a linkage with closed loops, solved step by step from the last one. */
let loop: { key: string; L: linkage.Linkage; poses: Map<string, motion.Mat4>; values: Record<string, number> } | null = null;

/** The loop solver when some part hangs in more than one joint, else null. */
function loopOf(mech: motion.Mechanism): NonNullable<typeof loop> | null {
  if (!linkage.hasLoops(mech.joints)) return (loop = null);
  const key = JSON.stringify([mech.joints, mech.couplings]);
  if (loop?.key !== key) loop = { key, L: new linkage.Linkage(mech.joints, mech.couplings), poses: new Map(), values: {} };
  return loop;
}

function moveLoop(l: NonNullable<typeof loop>, r: linkage.LinkageResult): boolean {
  if (r.poses.size) {
    l.poses = r.poses;
    l.values = r.values;
  }
  useMotion.setState((s) => ({ tick: s.tick + 1, blocked: [] }));
  return r.ok;
}


/** Back to where the parts were drawn. */
export function restPose(): void {
  loop = null;
  useMotion.setState((s) => ({ free: {}, tick: s.tick + 1, blocked: [] }));
}

/**
 * How far each joint of a linkage can move from the drawn position, by driving it each way until it
 * stops (a rocker at the end of its swing); null for one that goes all the way round. Worked out
 * once per linkage, for the panel's sliders.
 */
let swings: { key: string; ranges: Record<string, [number, number] | null> } | null = null;
export function swingRanges(): Record<string, [number, number] | null> {
  const { mech } = currentMechanism();
  const l = loopOf(mech);
  if (!l) return {};
  if (swings?.key === l.key) return swings.ranges;
  const ranges: Record<string, [number, number] | null> = {};
  for (const j of mech.joints) {
    if (j.type === "fixed") continue;
    const far = j.type === "revolute" ? 200 : 1000;
    const up = l.L.solve(new Map(), { [j.id]: far });
    const down = l.L.solve(new Map(), { [j.id]: -far });
    ranges[j.id] = up.ok && down.ok ? null : [down.values[j.id] ?? -far, up.values[j.id] ?? far];
  }
  swings = { key: l.key, ranges };
  return ranges;
}

/** Every joint's value now (degrees or mm). */
export function jointValues(): Record<string, number> {
  const { mech } = currentMechanism();
  const l = loopOf(mech);
  return l ? { ...Object.fromEntries(mech.joints.map((j) => [j.id, 0])), ...l.values } : mech.values(useMotion.getState().free);
}

/** The mechanism as it can move now, with a message per joint that cannot. */
export function currentMechanism(): { mech: motion.Mechanism; problems: Record<string, string> } {
  const s = useApp.getState();
  const doc = s.doc;
  const report = s.output?.report;
  const problems: Record<string, string> = {};
  const scope = new Map(Object.entries(report?.params ?? {}));
  const num = (e: string | number) => evaluate(e, scope);
  const bodies = new Set(report?.bodies.map((b) => b.id) ?? []);
  const joints: motion.MotionJoint[] = [];
  for (const j of doc.mechanism?.joints ?? []) {
    if (j.suppressed) continue;
    const frame = report?.joints.find((f) => f.id === j.id);
    if (!frame) continue;
    if (frame.error) problems[j.id] = frame.error;
    else if (!bodies.has(j.a)) problems[j.id] = `part "${j.a}" is gone`;
    else if (j.b !== "ground" && !bodies.has(j.b)) problems[j.id] = `part "${j.b}" is gone`;
    else {
      const range = (r: [string | number, string | number] | undefined): [number, number] | undefined => {
        if (!r) return undefined;
        const v = [num(r[0]), num(r[1])];
        return [Math.min(...v), Math.max(...v)];
      };
      let limits: [number, number] | undefined;
      let travel: [number, number] | undefined;
      try {
        limits = range(j.limits);
        travel = range(j.travel);
      } catch (e) {
        problems[j.id] = `limits: ${(e as Error).message}`;
        continue;
      }
      const base = { id: j.id, a: j.a, b: j.b, origin: frame.origin, axis: frame.axis };
      // A cylindrical joint moves as a turn and a slide of its own (motion.cylindricalJoints).
      if (j.type === "cylindrical") joints.push(...motion.cylindricalJoints({ ...base, ...(limits ? { limits } : {}), ...(travel ? { travel } : {}) }));
      else joints.push({ ...base, type: j.type, ...(limits ? { limits } : {}) });
    }
  }
  const couplings: motion.MotionCoupling[] = [];
  for (const c of doc.mechanism?.couplings ?? []) {
    try {
      couplings.push({ driver: c.driver, driven: c.driven, ratio: num(c.ratio) });
    } catch (e) {
      problems[c.id] = `ratio: ${(e as Error).message}`;
    }
  }
  return { mech: new motion.Mechanism(joints, couplings), problems };
}

/** Poses of the moving parts while the joints panel is open; at rest otherwise. */
export function currentPoses(): Map<string, number[]> {
  const m = useMotion.getState();
  if (!m.open) return new Map();
  const { mech } = currentMechanism();
  const l = loopOf(mech);
  if (l) return l.poses;
  return mech.poses(mech.values(m.free));
}

/** Sets a joint's value (a driven joint moves its driver instead). False when it cannot get there. */
export function setJointValue(id: string, value: number): boolean {
  const { mech } = currentMechanism();
  const l = loopOf(mech);
  if (l) {
    let r = l.L.solve(l.poses, { [id]: value }, undefined, l.values);
    // Leaving an end position the linkage can take the wrong branch and stick halfway; from the
    // drawn position it often gets there: take whichever comes closer.
    if (!r.ok) {
      const fresh = l.L.solve(new Map(), { [id]: value });
      if (fresh.poses.size && Math.abs((fresh.values[id] ?? 0) - value) < Math.abs((r.values[id] ?? 0) - value) - 0.5) r = fresh;
    }
    return moveLoop(l, r);
  }
  const r = mech.rootValueFor(id, value);
  if (!r) return false;
  const [lo, hi] = mech.range(r.root);
  // Asked for more than the limits allow: the part stops there and shows red.
  const held = r.value < lo - 1e-9 || r.value > hi + 1e-9;
  const part = mech.joint(id)?.a;
  useMotion.setState((s) => ({ free: { ...s.free, [r.root]: Math.min(hi, Math.max(lo, r.value)) }, blocked: held && part ? [part] : [] }));
  return true;
}

// ---------------------------------------------------------------- dragging

let loopDrag: { part: string; local: motion.V3 } | null = null;
let drag: { joint: motion.MotionJoint; o: motion.V3; n: motion.V3; start: number; grab: motion.V3; last: motion.V3; turned: number; t0: number } | null = null;

/** Viewport hook: a press on a part that can move grabs it. */
export const partDrag = {
  start(pick: Extract<Pick, { kind: "face" }>, ray: Ray): boolean {
    if (useMotion.getState().draft) return false;
    stopPlaying();
    const { mech } = currentMechanism();
    const l = loopOf(mech);
    if (l) {
      if (!l.L.parts.includes(pick.bodyId)) return false;
      const pose = l.poses.get(pick.bodyId) ?? motion.IDENTITY;
      loopDrag = { part: pick.bodyId, local: motion.transformPoint(linkage.inverse(pose), pick.point) };
      return true;
    }
    // A part held fixed to a moving part moves that part.
    let joint = mech.jointOf(pick.bodyId);
    for (let i = 0; joint?.type === "fixed" && i < 100; i++) joint = mech.jointOf(joint.b);
    if (!joint || joint.type === "fixed") return false;
    return grabJoint(mech, joint, ray, pick.point);
  },
  /** A press on a joint's symbol: turns or slides that joint (in a linkage too). */
  startJoint(id: string, ray: Ray): boolean {
    if (useMotion.getState().draft) return false;
    stopPlaying();
    const { mech } = currentMechanism();
    const joint = mech.joint(id);
    if (!joint || joint.type === "fixed") return false;
    return grabJoint(mech, joint, ray, null);
  },
  move(ray: Ray): void {
    if (loopDrag) {
      const l = loopOf(currentMechanism().mech);
      if (l) moveLoop(l, l.L.solve(l.poses, {}, { ...loopDrag, ray }, l.values));
      return;
    }
    if (!drag) return;
    let value: number;
    if (drag.joint.type === "revolute") {
      const hit = motion.rayPlane(ray.origin, ray.dir, drag.grab, drag.n);
      if (!hit) return;
      // Added up step by step, so a part can turn more than half a turn.
      drag.turned += motion.angleAbout(drag.o, drag.n, drag.last, hit);
      drag.last = hit;
      value = Math.round((drag.start + drag.turned) * 10) / 10;
    } else {
      const t = motion.rayLineParam(ray.origin, ray.dir, drag.o, drag.n);
      if (t === null) return;
      value = Math.round((drag.start + t - drag.t0) * 100) / 100;
    }
    setJointValue(drag.joint.id, value);
  },
  end(): void {
    drag = null;
    loopDrag = null;
  },
};

/**
 * Starts dragging `joint` from the point `grab` on the part; from its symbol (`grab` null), where the
 * ray meets the plane across the axis.
 */
function grabJoint(mech: motion.Mechanism, joint: motion.MotionJoint, ray: Ray, grab: motion.V3 | null): boolean {
  const l = loopOf(mech);
  const values = l ? jointValues() : mech.values(useMotion.getState().free);
  const parent = (l ? l.poses : mech.poses(values)).get(joint.b) ?? motion.IDENTITY;
  const o = motion.transformPoint(parent, joint.origin);
  const n = motion.transformDir(parent, joint.axis);
  const t0 = motion.rayLineParam(ray.origin, ray.dir, o, n) ?? 0;
  const from = grab ?? (joint.type === "revolute" ? motion.rayPlane(ray.origin, ray.dir, o, n) : null) ?? o;
  drag = { joint, o, n, start: values[joint.id] ?? 0, grab: from, last: from, turned: 0, t0 };
  return true;
}

/**
 * The part and every part joined to it, directly or through others (not through the ground). Moving
 * one of them alone would pull its joints apart, so they move together.
 */
export function joinedParts(part: string, joints: readonly Joint[] = currentDoc().mechanism?.joints ?? []): string[] {
  const group = new Set([part]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const j of joints) {
      if (j.suppressed || j.b === "ground") continue;
      for (const [x, y] of [[j.a, j.b], [j.b, j.a]] as const)
        if (group.has(x) && !group.has(y)) {
          group.add(y);
          grew = true;
        }
    }
  }
  return [...group];
}

// ---------------------------------------------------------------- collisions while moving

const colliders = new WeakMap<BodyMesh, MeshCollider>();
const colliderOf = (m: BodyMesh) => colliders.get(m) ?? colliders.set(m, new MeshCollider(m.positions, m.indices)).get(m)!;
/**
 * A mesh's box at rest, straight from its vertices: cheap, so the trees (slow to build for a few
 * hundred parts with millions of triangles) are made only for parts whose boxes meet.
 */
const restBoxes = new WeakMap<BodyMesh, { min: motion.V3; max: motion.V3 }>();
function restBox(m: BodyMesh): { min: motion.V3; max: motion.V3 } {
  const hit = restBoxes.get(m);
  if (hit) return hit;
  const min: motion.V3 = [Infinity, Infinity, Infinity];
  const max: motion.V3 = [-Infinity, -Infinity, -Infinity];
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = p[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  const box = { min, max };
  restBoxes.set(m, box);
  return box;
}
/** Whether a pair touches as drawn, by the meshes of one result: those contacts are designed (a pin in its hole). */
let rest: { meshes: BodyMesh[]; touching: Map<string, boolean> } | null = null;

/** Box of a mesh in a pose. */
function placedBox(m: BodyMesh, pose: motion.Mat4 | undefined): { min: motion.V3; max: motion.V3 } {
  const r = restBox(m);
  const min: motion.V3 = [Infinity, Infinity, Infinity];
  const max: motion.V3 = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const p: motion.V3 = [c & 1 ? r.max[0] : r.min[0], c & 2 ? r.max[1] : r.min[1], c & 4 ? r.max[2] : r.min[2]];
    const q = pose ? motion.transformPoint(pose, p) : p;
    for (let k = 0; k < 3; k++) {
      if (q[k]! < min[k]!) min[k] = q[k]!;
      if (q[k]! > max[k]!) max[k] = q[k]!;
    }
  }
  return { min, max };
}

/**
 * How far a part's display mesh may stray from its true surface (mm), as the kernel meshes it:
 * round faces become polygons, so a pin turning in its hole pokes through the hole's facets by
 * up to this much although the real surfaces only slide on each other. Touch screens get looser
 * meshes (see store).
 */
function meshSlack(m: BodyMesh): number {
  const r = restBox(m);
  const diag = Math.hypot(r.max[0] - r.min[0], r.max[1] - r.min[1], r.max[2] - r.min[2]);
  return Math.max(0.01, diag * 5e-4) * (matchMedia("(pointer: coarse)").matches ? 2 : 1);
}

/** Parts that run into each other in the current pose, leaving out contacts that exist as drawn. */
function findHits(): [string, string][] {
  // Cables bend with the parts: they are checked on their own (see cableStates).
  const cableIds = new Set(cableRigs().map((r) => r.id));
  const meshes = (useApp.getState().output?.meshes ?? []).filter((m) => !cableIds.has(m.bodyId));
  const poses = currentPoses();
  if (!poses.size || !meshes.length) return [];
  if (rest?.meshes !== meshes) rest = { meshes, touching: new Map() };
  const moved = (id: string) => {
    const p = poses.get(id);
    return !!p && p.some((v, i) => Math.abs(v - motion.IDENTITY[i]!) > 1e-9);
  };
  const boxes = new Map(meshes.map((m) => [m.bodyId, placedBox(m, poses.get(m.bodyId))]));
  const hits: [string, string][] = [];
  for (let i = 0; i < meshes.length; i++)
    for (let j = i + 1; j < meshes.length; j++) {
      const a = meshes[i]!;
      const b = meshes[j]!;
      if (!moved(a.bodyId) && !moved(b.bodyId)) continue;
      const p = boxes.get(a.bodyId)!;
      const q = boxes.get(b.bodyId)!;
      if (p.min[0] > q.max[0] || q.min[0] > p.max[0] || p.min[1] > q.max[1] || q.min[1] > p.max[1] || p.min[2] > q.max[2] || q.min[2] > p.max[2]) continue;
      const key = `${a.bodyId}|${b.bodyId}`;
      // Only a part pushed further in than the meshes' own inaccuracy counts.
      const inset = 1.5 * Math.max(meshSlack(a), meshSlack(b));
      let touching = rest.touching.get(key);
      if (touching === undefined) rest.touching.set(key, (touching = meshesCollide(colliderOf(a), colliderOf(b), undefined, undefined, inset)));
      if (touching) continue;
      if (meshesCollide(colliderOf(a), colliderOf(b), poses.get(a.bodyId), poses.get(b.bodyId), inset)) hits.push([a.bodyId, b.bodyId]);
    }
  return hits;
}

// Checked after the parts move, at most every 60 ms (and once more after the last move).
let hitTimer: ReturnType<typeof setTimeout> | null = null;
let lastHitCheck = 0;
function scheduleHits(): void {
  if (hitTimer) return;
  hitTimer = setTimeout(() => {
    hitTimer = null;
    lastHitCheck = performance.now();
    const s = useMotion.getState();
    const hits = s.open ? findHits() : [];
    const same = hits.length === s.hits.length && hits.every(([a, b], i) => s.hits[i]![0] === a && s.hits[i]![1] === b);
    if (!same) useMotion.setState({ hits });
    const cables = s.open ? cableStates() : [];
    if (JSON.stringify(cables) !== JSON.stringify(s.cables)) useMotion.setState({ cables });
  }, Math.max(0, 60 - (performance.now() - lastHitCheck)));
}
useMotion.subscribe((s, prev) => {
  if (s.open !== prev.open || s.free !== prev.free || s.tick !== prev.tick) scheduleHits();
});
useApp.subscribe((s, prev) => {
  if (s.output !== prev.output && useMotion.getState().open) scheduleHits();
});

// ---------------------------------------------------------------- cables

/** Cables of the design as built (rigs to lay them again in a pose), worked out once per result. */
let rigs: { output: unknown; list: cable.CableRig[]; errors: Record<string, string> } | null = null;
export function cableRigs(): cable.CableRig[] {
  return rigsNow().list;
}
/** Ids of the cable parts in the design (built or not): left out of the kernel's gap checks. */
const cableIds = () => useApp.getState().doc.features.filter((f) => f.op === "cable").map((f) => f.id);
/**
 * Parts held together by fixed joints (see motion.rigidGroups): the kernel's gap checks leave
 * their pairs out. In Mini v4 they were half of all pairs near each other, every one a boolean.
 */
const rigidParts = () => motion.rigidGroups(useApp.getState().doc.mechanism?.joints ?? []);
function rigsNow(): NonNullable<typeof rigs> {
  const s = useApp.getState();
  if (rigs?.output === s.output) return rigs;
  const built = new Set(s.output?.report.bodies.map((b) => b.id) ?? []);
  const scope = new Map(Object.entries(s.output?.report.params ?? {}));
  const list: cable.CableRig[] = [];
  const errors: Record<string, string> = {};
  for (const f of s.doc.features) {
    if (f.op !== "cable" || f.suppressed || !built.has(f.id)) continue;
    try {
      const r = resolveFeature(f, scope);
      if (r.op === "cable") list.push(cable.cableRig(r));
    } catch (e) {
      errors[f.id] = (e as Error).message;
    }
  }
  return (rigs = { output: s.output, list, errors });
}

/** Whether a cable has a point on a part that moves (only those need laying again). */
export const cableMoves = (r: cable.CableRig, poses: ReadonlyMap<string, motion.Mat4>) => r.points.some((p) => !!p.on && !!poses.get(p.on) && motion.isMoved(poses.get(p.on)!));

/** Each cable in the pose shown now: length needed against its length, tightest bend, parts it runs into. */
export function cableStates(poses: ReadonlyMap<string, motion.Mat4> = currentPoses()): cable.CableState[] {
  const list = cableRigs();
  if (!list.length) return [];
  const ids = new Set(list.map((r) => r.id));
  const bodies: cable.CollisionBody[] = (useApp.getState().output?.meshes ?? [])
    .filter((m) => !ids.has(m.bodyId))
    .map((m) => {
      const pose = poses.get(m.bodyId);
      return { id: m.bodyId, collider: () => colliderOf(m), box: restBox(m), ...(pose ? { pose } : {}), still: !pose || !motion.isMoved(pose), inset: 1.5 * meshSlack(m) };
    });
  return list.map((r) => cable.checkCable(r, poses, bodies).state);
}

/** The cables that bend in the pose shown now, as meshes to draw instead of their parts as built. */
export function posedCables(poses: ReadonlyMap<string, motion.Mat4>): { bodyId: string; mesh: cable.CableMesh; trouble: boolean }[] {
  const states = useMotion.getState().cables;
  return cableRigs()
    .filter((r) => cableMoves(r, poses))
    .flatMap((r) => {
      try {
        const st = states.find((c) => c.id === r.id);
        return [{ bodyId: r.id, mesh: cable.cableMesh(cable.layInPose(r, poses), r.spec), trouble: !!st && cable.cableTrouble(st) }];
      } catch {
        return [];
      }
    });
}

/** Cable states for assistants: numbers rounded, a line on each. */
export function cableReport(states: cable.CableState[] = cableStates()) {
  return states.map((c) => ({
    cable: c.id,
    ok: !cable.cableTrouble(c),
    needed: +c.needed.toFixed(2),
    length: +c.available.toFixed(2),
    stretch: +Math.max(0, c.stretch).toFixed(2),
    minRadius: Number.isFinite(c.minRadius) ? +c.minRadius.toFixed(2) : null,
    bendRadius: c.bendRadius,
    hits: c.hits,
    note: cable.describeCable(c),
  }));
}

// ---------------------------------------------------------------- editing joints

const nextId = (prefix: string, taken: string[]) => {
  let n = 1;
  while (taken.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
};

/** Opens or closes the joints panel (closing puts the parts back where they were drawn). */
export function toggleJoints(): void {
  const open = !useMotion.getState().open;
  if (open) {
    if (useApp.getState().dialog) return toast(t("Finish the open tool first"));
    useApp.setState({ measure: { active: false, picks: [], result: null } });
  }
  if (!open) {
    stopPlaying();
    restPose();
  }
  useMotion.setState({ open, draft: null, ...(open ? {} : { free: {}, check: null }) });
}

// One mode at a time: a tool, a sketch or measuring closes the joints panel (and puts the parts back).
useApp.subscribe((s, prev) => {
  const started = (s.dialog && !prev.dialog) || (s.sketchId && !prev.sketchId) || (s.measure.active && !prev.measure.active);
  if (started && useMotion.getState().open) toggleJoints();
});

export function startJoint(): void {
  const doc = currentDoc();
  const id = nextId("j", doc.mechanism?.joints.map((j) => j.id) ?? []);
  useMotion.setState({ open: true, draft: { joint: { id, type: "revolute", a: "", b: "ground", anchor: { axis: { ref: "origin.Z" } } }, isNew: true, field: "a" } });
}

export function editJoint(id: string): void {
  const j = currentDoc().mechanism?.joints.find((x) => x.id === id);
  if (j) useMotion.setState({ draft: { joint: structuredClone(j), isNew: false, field: null } });
}

export function updateJointDraft(patch: Partial<Joint>, field?: JointField | null): void {
  useMotion.setState((s) => (s.draft ? { draft: { ...s.draft, joint: { ...s.draft.joint, ...patch }, field: field === undefined ? s.draft.field : field } } : {}));
}

export function setJointField(field: JointField | null): void {
  useMotion.setState((s) => (s.draft ? { draft: { ...s.draft, field } } : {}));
}

/** A viewport tap while a joint field waits for a pick. Returns whether it was used. */
export function jointPick(pick: Pick | null): boolean {
  const d = useMotion.getState().draft;
  if (!d?.field) return false;
  if (!pick) return true;
  const meshes = useApp.getState().output?.meshes ?? [];
  if (d.field === "a" || d.field === "b") {
    if (pick.kind !== "face" && pick.kind !== "edge") return true;
    if (d.field === "b" && pick.bodyId === d.joint.a) return toast(t("Pick another part, or Ground")), true;
    updateJointDraft(d.field === "a" ? { a: pick.bodyId, ...(d.joint.b === pick.bodyId ? { b: "ground" } : {}) } : { b: pick.bodyId }, d.field === "a" ? "b" : "anchor");
    return true;
  }
  let anchor: JointAnchor | null = null;
  if (pick.kind === "face") {
    if (pick.normal) return toast(t("Pick a round face (hole or shaft) or an edge for the axis")), true;
    const sel = faceSelectorForPick(pick, meshes);
    if (sel) anchor = { axisOf: sel };
  } else if (pick.kind === "edge") {
    const sel = edgeSelectorForPick(pick, meshes);
    if (sel) anchor = { edge: sel };
  }
  if (anchor) updateJointDraft({ anchor }, null);
  return true;
}

export function saveJoint(): boolean {
  const d = useMotion.getState().draft;
  if (!d) return false;
  if (!d.joint.a) return toast(t("Pick the part that moves"), "error"), false;
  if (!apply({ type: "set_joint", joint: d.joint })) return false;
  useMotion.setState({ draft: null });
  return true;
}

export function deleteJoint(id: string): void {
  apply({ type: "delete_joint", id });
  useMotion.setState((s) => {
    const free = { ...s.free };
    delete free[id];
    return { free };
  });
}

/**
 * Joints for gears that have none: each turns on its own axis (a rack slides along itself), and
 * gears in mesh are coupled by their teeth.
 */
export function jointsFromGears(): number {
  const s = useApp.getState();
  const gears = s.output?.report.gears ?? [];
  const doc = currentDoc();
  const joints = doc.mechanism?.joints ?? [];
  const couplings = doc.mechanism?.couplings ?? [];
  const bodies = new Set(s.output?.report.bodies.map((b) => b.id) ?? []);
  const jointOf = new Map(joints.map((j) => [j.a, j.id]));
  const ids = joints.map((j) => j.id);
  const cids = couplings.map((c) => c.id);
  const newJoints: Joint[] = [];
  const newCouplings: Coupling[] = [];
  for (const g of gears) {
    if (!bodies.has(g.id) || jointOf.has(g.id)) continue;
    const id = nextId("j", ids);
    ids.push(id);
    jointOf.set(g.id, id);
    newJoints.push({ id, name: `${g.kind === "rack" ? "Slide" : "Turn"} ${g.id}`, type: g.kind === "rack" ? "slider" : "revolute", a: g.id, b: "ground", anchor: { gear: g.id } });
  }
  for (const g of gears) {
    const p = g.meshWith ? gears.find((x) => x.id === g.meshWith) : undefined;
    const driver = p && jointOf.get(p.id);
    const driven = jointOf.get(g.id);
    if (!p || !driver || !driven || couplings.some((c) => c.driven === driven)) continue;
    // driven value = ratio × driver value; outside gears turn the other way, a ring the same way.
    let ratio: number;
    if (p.kind === "rack") ratio = 180 / (Math.PI * g.radius);
    else if (g.kind === "rack") ratio = (Math.PI * p.radius) / 180;
    else ratio = (p.kind === "spur" && g.kind === "spur" ? -1 : 1) * (p.teeth / g.teeth);
    const id = nextId("c", cids);
    cids.push(id);
    newCouplings.push({ id, driver, driven, ratio: Math.round(ratio * 1e6) / 1e6 });
  }
  if (!newJoints.length && !newCouplings.length) return 0;
  apply(...newJoints.map((joint) => ({ type: "set_joint" as const, joint })), ...newCouplings.map((coupling) => ({ type: "set_coupling" as const, coupling })));
  return newJoints.length;
}

// ---------------------------------------------------------------- playing

let frame = 0;

/** Drives a joint on its own: back and forth between its limits, or round and round when a turn has none. */
export function playJoint(id: string): void {
  stopPlaying();
  const { mech } = currentMechanism();
  const j = mech.joint(id);
  const l = loopOf(mech);
  if (l && j && j.type !== "fixed") {
    // A linkage: push the joint on and turn back where it cannot go further.
    const speed = j.type === "revolute" ? 60 : 15;
    let dir = 1;
    let last = performance.now();
    useMotion.setState({ playing: id });
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const cur = loopOf(currentMechanism().mech);
      if (!cur) return stopPlaying();
      const v = (cur.values[id] ?? 0) + dir * speed * dt;
      const lim = j.limits;
      if (!setJointValue(id, lim ? Math.min(lim[1], Math.max(lim[0], v)) : v) || (lim && (v >= lim[1] || v <= lim[0]))) dir = -dir;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return;
  }
  const root = mech.rootOf(id);
  if (!j || j.type === "fixed" || !root) return;
  const [lo, hi] = mech.range(root);
  const rootJoint = mech.joint(root)!;
  const turning = rootJoint.type === "revolute";
  const bounded = Number.isFinite(lo) && Number.isFinite(hi);
  // Degrees or mm per second of the driving joint; sliders without limits swing ±20 mm.
  const speed = turning ? 60 : 15;
  const [a, b] = bounded ? [lo, hi] : turning ? [-Infinity, Infinity] : [-20, 20];
  let dir = 1;
  let last = performance.now();
  useMotion.setState({ playing: id });
  const step = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const cur = useMotion.getState().free[root] ?? 0;
    let next = cur + dir * speed * dt;
    if (next >= b) (next = b), (dir = -1);
    if (next <= a) (next = a), (dir = 1);
    useMotion.setState((s) => ({ free: { ...s.free, [root]: next } }));
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}

export function stopPlaying(): void {
  cancelAnimationFrame(frame);
  if (useMotion.getState().playing || useMotion.getState().playingMotion) useMotion.setState({ playing: null, playingMotion: null });
}

// ---------------------------------------------------------------- motions (several joints over time)

/** The design's motion with this id. */
export function motionById(id: string): Motion {
  const m = currentDoc().mechanism?.motions?.find((x) => x.id === id);
  if (!m) throw new Error(`no motion "${id}"${currentDoc().mechanism?.motions?.length ? `: there are ${currentDoc().mechanism!.motions!.map((x) => x.id).join(", ")}` : ""}`);
  return m;
}

/**
 * Puts the parts where a motion has them at `t` seconds. Joints the motion does not name keep their
 * values. Returns the joints a limit (or dead point) held short of the motion's value.
 */
export function showMotionAt(m: Motion, t: number): { joint: string; wanted: number; got: number }[] {
  const values = motion.sampleMotion(m, t);
  for (const [id, v] of Object.entries(values)) setJointValue(id, v);
  const now = jointValues();
  return Object.entries(values)
    .filter(([id, v]) => Math.abs((now[id] ?? 0) - v) > 1e-3)
    .map(([id, v]) => ({ joint: id, wanted: +v.toFixed(3), got: +(now[id] ?? 0).toFixed(3) }));
}

/** Plays a motion in the app, looping ones over and over, others once. */
export function playMotion(id: string): void {
  stopPlaying();
  const m = motionById(id);
  openForCheck();
  const t0 = performance.now();
  useMotion.setState({ playingMotion: id });
  const step = (now: number) => {
    const t = (now - t0) / 1000;
    const cur = currentDoc().mechanism?.motions?.find((x) => x.id === id);
    if (!cur) return stopPlaying();
    showMotionAt(cur, t);
    if (!cur.loop && t >= cur.duration) return stopPlaying();
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}

/** Adds the pose shown now to a motion as a moment (a new motion when `id` is not one yet). */
export function addPoseToMotion(id: string, at?: number): void {
  const { mech } = currentMechanism();
  const values = Object.fromEntries(
    Object.entries(jointValues())
      .filter(([j]) => mech.joint(j)?.type !== "fixed" && mech.rootOf(j) === j)
      .map(([j, v]) => [j, +v.toFixed(3)]),
  );
  const existing = currentDoc().mechanism?.motions?.find((x) => x.id === id);
  const m: Motion = existing ? structuredClone(existing) : { id, name: t("Motion"), duration: 2, loop: true, keys: [] };
  const when = at ?? (m.keys.length ? Math.min(m.duration, (m.keys[m.keys.length - 1]!.at ?? 0) + 0.5) : 0);
  m.keys = [...m.keys.filter((k) => Math.abs(k.at - when) > 1e-9), { at: when, values }].sort((a, b) => a.at - b.at);
  if (when > m.duration) m.duration = when;
  apply({ type: "set_motion", motion: m });
}

/** Pairs that touch on purpose: held together by a fixed joint, or meeting at a joint they turn on. */
export function designedContacts(): Set<string> {
  const pairs = new Set<string>();
  for (const j of currentDoc().mechanism?.joints ?? []) if (j.b !== "ground") pairs.add([j.a, j.b].sort().join("|"));
  return pairs;
}

/**
 * Runs a motion in `frames` steps and checks the gaps at each: every pose where parts run into each
 * other (overlap), and the joints a limit held short. The joints go back where they were.
 */
export async function checkMotionRun(id: string, frames = 24): Promise<{
  frames: number;
  collisions: { at: number; a: string; b: string; overlap: number }[];
  held: { at: number; joint: string; wanted: number; got: number }[];
  smallest: { a: string; b: string; distance: number; at: number }[];
  cables?: CableRun[];
}> {
  openForCheck();
  stopPlaying();
  const m = motionById(id);
  const cables = new CableWatch();
  const before = jointValues();
  const free = { ...useMotion.getState().free };
  const touching = designedContacts();
  const collisions: { at: number; a: string; b: string; overlap: number }[] = [];
  const held: { at: number; joint: string; wanted: number; got: number }[] = [];
  const smallest = new Map<string, { a: string; b: string; distance: number; at: number }>();
  const times = motion.motionTimes(m, Math.max(2, Math.min(240, Math.round(frames))));
  let base: Map<string, number[]> | null = null;
  let overlapping: Clearance[] = [];
  try {
    for (const at of times) {
      const t3 = +at.toFixed(3);
      for (const h of showMotionAt(m, at)) held.push({ at: t3, ...h });
      cables.add(t3);
      // All pairs at the first frame, then only those that moved against each other since; parts
      // that overlapped then and still sit the same way overlap in this frame too.
      const now = await clearanceNow(base ?? undefined);
      if (!base) {
        base = new Map(currentPoses());
        overlapping = now.pairs.filter((c) => c.overlap > 1e-3);
      } else for (const c of overlapping) if (now.together?.[c.a] === now.together?.[c.b]) collisions.push({ at: t3, a: c.a, b: c.b, overlap: +c.overlap.toFixed(3) });
      for (const c of now.pairs) {
        if (c.overlap > 1e-3) collisions.push({ at: t3, a: c.a, b: c.b, overlap: +c.overlap.toFixed(3) });
        const key = `${c.a}|${c.b}`;
        // Parts that touch by design (a servo on its link) are no news; their overlaps still count.
        if (touching.has([c.a, c.b].sort().join("|"))) continue;
        const cur = smallest.get(key);
        if (!cur || c.distance < cur.distance) smallest.set(key, { a: c.a, b: c.b, distance: +c.distance.toFixed(3), at: t3 });
      }
    }
  } finally {
    restPose();
    useMotion.setState({ free });
    for (const [jid, v] of Object.entries(before)) if (v) setJointValue(jid, v);
  }
  return { frames: times.length, collisions, held, smallest: [...smallest.values()].sort((x, y) => x.distance - y.distance).slice(0, 12), ...cables.result() };
}

// ---------------------------------------------------------------- clearance

const PRINT_IN_PLACE_MIN = 0.3;

/** Smallest wanted gap between moving parts (print-in-place), mm. */
export function wantedClearance(): number {
  const doc = currentDoc();
  const scope = new Map(Object.entries(useApp.getState().output?.report.params ?? {}));
  // Without an own value: the design's fit, but at least 0.3 mm (parts printed in place fuse more easily).
  const fallback = () => {
    try {
      return Math.max(PRINT_IN_PLACE_MIN, evaluate(fitExpr(doc), scope));
    } catch {
      return PRINT_IN_PLACE_MIN;
    }
  };
  const c = doc.mechanism?.clearance;
  try {
    return c === undefined ? fallback() : evaluate(c, scope);
  } catch {
    return fallback();
  }
}

/** Gaps between moving parts and what they come near, in the pose shown now. */
export async function checkClearance(): Promise<void> {
  stopPlaying();
  const { mech } = currentMechanism();
  const free = { ...useMotion.getState().free, tick: useMotion.getState().tick };
  const poses = loopOf(mech)?.poses ?? mech.poses(mech.values(useMotion.getState().free));
  const moving = [...new Set(mech.joints.filter((j) => j.type !== "fixed").map((j) => j.a))];
  if (!moving.length) return toast(t("No part moves yet: add a joint first"));
  useMotion.setState({ check: { running: true, free, results: [] } });
  try {
    const results = await kernel.clearances(moving, Object.fromEntries(poses), Math.max(2, wantedClearance() * 2), cableIds(), rigidParts());
    useMotion.setState({ check: { running: false, free, results: results.sort((x, y) => x.distance - y.distance || y.overlap - x.overlap) } });
  } catch (e) {
    useMotion.setState({ check: { running: false, free, results: [], error: (e as Error).message } });
  }
}

// ---------------------------------------------------------------- for assistants (MCP)

/** Joints panel open and nothing in the way, so poses show and can be checked. */
export function openForCheck(): void {
  if (useApp.getState().dialog) throw new Error("a tool dialog is open in the app; finish or cancel it first");
  if (!useMotion.getState().open) useMotion.setState({ open: true, draft: null });
}

/** Sets joint values one after another (driven joints move their drivers); the parts move in the app. */
export function setPose(values: Readonly<Record<string, number>>): { values: Record<string, number>; fixedLeftOut?: number; reached: boolean; problems: Record<string, string>; cables?: ReturnType<typeof cableReport> } {
  openForCheck();
  stopPlaying();
  const { mech, problems } = currentMechanism();
  let reached = true;
  for (const [id, v] of Object.entries(values)) {
    if (!mech.joint(id)) throw new Error(`no joint "${id}"${problems[id] ? `: ${problems[id]}` : ""}`);
    reached = setJointValue(id, v) && reached;
  }
  const now = jointValues();
  // A limit or a dead point can stop a joint short of its value: say which and where.
  for (const [id, v] of Object.entries(values))
    if (Math.abs((now[id] ?? 0) - v) > 1e-3) {
      reached = false;
      const lim = mech.joint(id)?.limits;
      problems[id] = lim && ((now[id] ?? 0) <= lim[0] + 1e-6 || (now[id] ?? 0) >= lim[1] - 1e-6) ? `held at its limit ${+(now[id] ?? 0).toFixed(3)} (limits ${lim[0]} to ${lim[1]}), asked ${v}` : `stopped at ${+(now[id] ?? 0).toFixed(3)}, asked ${v}`;
    }
  const cables = cableReport();
  // Fixed joints never move: in a design of hundreds of parts they would bury the joints that do.
  const fixed = new Set(mech.joints.filter((j) => j.type === "fixed").map((j) => j.id));
  const shown = Object.fromEntries(Object.entries(now).filter(([id]) => !fixed.has(id) || id in values));
  const fixedLeftOut = Object.keys(now).length - Object.keys(shown).length;
  return { values: shown, ...(fixedLeftOut ? { fixedLeftOut } : {}), reached, problems, ...(cables.length ? { cables } : {}) };
}

/** How each cable fared over a run of poses: where it first got into trouble, its most stretch and tightest bend. */
export interface CableRun {
  cable: string;
  ok: boolean;
  /** Joint value or time of the first pose with trouble, and what it was. */
  first: { at: number; note: string } | null;
  maxStretch: number;
  maxStretchAt: number;
  minRadius: number | null;
  bendRadius: number;
  hits: string[];
}

class CableWatch {
  private runs = new Map<string, CableRun>();
  add(at: number): void {
    for (const c of cableStates()) {
      const r = this.runs.get(c.id) ?? { cable: c.id, ok: true, first: null, maxStretch: -Infinity, maxStretchAt: at, minRadius: null, bendRadius: c.bendRadius, hits: [] };
      if (cable.cableTrouble(c)) {
        r.ok = false;
        r.first ??= { at, note: cable.describeCable(c) };
      }
      if (c.stretch > r.maxStretch) {
        r.maxStretch = c.stretch;
        r.maxStretchAt = at;
      }
      if (Number.isFinite(c.minRadius) && (r.minRadius === null || c.minRadius < r.minRadius)) r.minRadius = +c.minRadius.toFixed(2);
      for (const h of c.hits) if (!r.hits.includes(h)) r.hits.push(h);
      this.runs.set(c.id, r);
    }
  }
  result(): { cables?: CableRun[] } {
    const list = [...this.runs.values()].map((r) => ({ ...r, maxStretch: +Math.max(0, r.maxStretch).toFixed(2) }));
    return list.length ? { cables: list } : {};
  }
}

/**
 * Which parts have moved together since the poses `base`: parts with the same number have kept
 * their place relative to each other, so the gap between them is what it was then. A check of a
 * motion looks at every pair once and after that only at pairs that moved against each other (one
 * joint of a robot moves a few parts against the rest; checking all its parts at every step took
 * minutes).
 */
function movedTogether(base: ReadonlyMap<string, number[]>, now: ReadonlyMap<string, number[]>): Record<string, number> {
  const groups = new Map<string, number>();
  const out: Record<string, number> = {};
  for (const b of useApp.getState().output?.report.bodies ?? []) {
    const p0 = (base.get(b.id) ?? motion.IDENTITY) as motion.Mat4;
    const p1 = (now.get(b.id) ?? motion.IDENTITY) as motion.Mat4;
    // The move since then, in the world: p1 · p0⁻¹ (poses are rigid: the inverse is the transpose and the shift turned back).
    const inv: motion.Mat4 = [p0[0]!, p0[4]!, p0[8]!, 0, p0[1]!, p0[5]!, p0[9]!, 0, p0[2]!, p0[6]!, p0[10]!, 0, -(p0[0]! * p0[12]! + p0[1]! * p0[13]! + p0[2]! * p0[14]!), -(p0[4]! * p0[12]! + p0[5]! * p0[13]! + p0[6]! * p0[14]!), -(p0[8]! * p0[12]! + p0[9]! * p0[13]! + p0[10]! * p0[14]!), 1];
    const key = motion.multiply(p1, inv).map((v) => (Math.abs(v) < 5e-7 ? 0 : v).toFixed(6)).join();
    if (!groups.has(key)) groups.set(key, groups.size);
    out[b.id] = groups.get(key)!;
  }
  return out;
}

/**
 * Gaps between moving parts and what they come near, in the pose shown now. With `since` (the
 * poses of an earlier check in the same run) only pairs that moved against each other since then.
 */
export async function clearanceNow(since?: ReadonlyMap<string, number[]>): Promise<{ wanted: number; pairs: Clearance[]; together?: Record<string, number> }> {
  openForCheck();
  const { mech } = currentMechanism();
  let moving = [...new Set(mech.joints.filter((j) => j.type !== "fixed").map((j) => j.a))];
  if (!moving.length) throw new Error("no part moves: add joints first");
  const want = wantedClearance();
  let rigid = rigidParts();
  let together: Record<string, number> | undefined;
  if (since) {
    together = movedTogether(since, currentPoses());
    const sizes = new Map<number, number>();
    for (const g of Object.values(together)) sizes.set(g, (sizes.get(g) ?? 0) + 1);
    if (sizes.size < 2) return { wanted: want, pairs: [], together };
    // Every pair across two groups has one part outside the biggest group.
    const biggest = [...sizes].sort((a, b) => b[1] - a[1])[0]![0];
    moving = Object.keys(together).filter((id) => together![id] !== biggest);
    rigid = together;
  }
  // As without `since`: a pair counts only when one of the two is a part that a joint moves.
  const jointed = new Set(mech.joints.filter((j) => j.type !== "fixed").map((j) => j.a));
  const pairs = (await kernel.clearances(moving, Object.fromEntries(currentPoses()), Math.max(2, want * 2), cableIds(), rigid)).filter((c) => jointed.has(c.a) || jointed.has(c.b));
  return {
    wanted: want,
    pairs: pairs
      .map(({ points: _p, ...rest }) => rest)
      .sort((x, y) => x.distance - y.distance),
    ...(together ? { together } : {}),
  };
}

/**
 * Moves one joint from `from` to `to` in steps and checks the gaps at each: the first pose where
 * parts touch or overlap, and the smallest gap of every pair. The joints go back where they were.
 */
export async function checkMotion(joint: string, from: number, to: number, steps = 12): Promise<{
  steps: number;
  firstContact: { value: number; a: string; b: string; kind: "touch" | "overlap"; overlap: number } | null;
  smallest: { a: string; b: string; distance: number; at: number }[];
  stoppedAt: number | null;
  cables?: CableRun[];
}> {
  openForCheck();
  const before = jointValues();
  const free = { ...useMotion.getState().free };
  const n = Math.max(1, Math.min(90, Math.round(steps)));
  let firstContact: { value: number; a: string; b: string; kind: "touch" | "overlap"; overlap: number } | null = null;
  let stoppedAt: number | null = null;
  const smallest = new Map<string, { a: string; b: string; distance: number; at: number }>();
  const touching = designedContacts();
  const cables = new CableWatch();
  let base: Map<string, number[]> | null = null;
  try {
    for (let k = 0; k <= n; k++) {
      const v = from + ((to - from) * k) / n;
      if (!setJointValue(joint, v) || Math.abs((jointValues()[joint] ?? 0) - v) > 1e-3) {
        stoppedAt = jointValues()[joint] ?? v;
        break;
      }
      cables.add(+v.toFixed(3));
      // All pairs at the first pose, then only those that moved against each other since.
      const pairs = (await clearanceNow(base ?? undefined)).pairs;
      base ??= new Map(currentPoses());
      for (const c of pairs) {
        const key = `${c.a}|${c.b}`;
        const cur = smallest.get(key);
        if (!cur || c.distance < cur.distance) smallest.set(key, { a: c.a, b: c.b, distance: c.distance, at: v });
        // Parts that touch by design (fixed together, or meeting at their joint) only count when they overlap.
        const designed = touching.has([c.a, c.b].sort().join("|"));
        if (!firstContact && (c.overlap > 1e-3 || (c.distance < 1e-4 && !designed))) firstContact = { value: v, a: c.a, b: c.b, kind: c.overlap > 1e-3 ? "overlap" : "touch", overlap: c.overlap };
      }
    }
  } finally {
    // Back to the pose before the check.
    restPose();
    useMotion.setState({ free });
    for (const [id, v] of Object.entries(before)) if (v) setJointValue(id, v);
  }
  return { steps: n, firstContact, smallest: [...smallest.values()].sort((x, y) => x.distance - y.distance), stoppedAt, ...cables.result() };
}

/** A joint swept by sweepCheck: between from and to (default its limits) in steps. */
export interface SweepJoint {
  joint: string;
  from?: number;
  to?: number;
  steps?: number;
}

/** What sweepCheck found for one pair of parts over all poses. */
export interface SweepPair {
  a: string;
  b: string;
  /** The first pose where they overlap by more than touchBelow (null: never). */
  firstCollision: number | Record<string, number> | null;
  /** Their largest overlap, mm³, the pose and about where (between their closest points). */
  maxOverlapMm3: number;
  maxOverlapAt?: number | Record<string, number>;
  where?: [number, number, number];
  /** Their smallest gap over all poses and where it was. */
  minDistance: number;
  minDistanceAt: number | Record<string, number>;
}

const MAX_SWEEP_POSES = 600;

/**
 * Sweeps one to three joints over their ranges (every combination of their steps) and checks the
 * parts that move against the parts around them. For a big design: `parts` (default the parts the
 * joints move) only against `against` (default all others), fasteners (screws, nuts, inserts) left
 * out unless `fasteners`, overlaps under `touchBelow` mm³ counted as touching (turned round shapes
 * give slivers of 0.04 to 0.1 mm³ at hubs). Only the parts named take part in the gap checks; after
 * the first pose only pairs that moved against each other are measured again. The answer is one
 * line per pair: the first pose where it collides, the largest overlap with where, the smallest gap.
 * The joints go back where they were.
 */
export async function sweepCheck(o: { joints: SweepJoint[]; parts?: string[]; against?: string[]; fasteners?: boolean; touchBelow?: number; most?: number }): Promise<{
  poses: number;
  parts: number;
  against: number;
  leftOut: { fasteners: number; cables: number };
  collisions: SweepPair[];
  closest: SweepPair[];
  held: { joint: string; at: number | Record<string, number>; got: number }[];
  cables?: CableRun[];
}> {
  openForCheck();
  stopPlaying();
  const { mech, problems } = currentMechanism();
  if (!o.joints.length || o.joints.length > 3) throw new Error("joints: one to three joints");
  const ranges = o.joints.map((s) => {
    const j = mech.joint(s.joint);
    if (!j) throw new Error(`no joint "${s.joint}"${problems[s.joint] ? `: ${problems[s.joint]}` : ""}`);
    const [lo, hi] = j.limits ?? (j.type === "revolute" ? [0, 360] : [-20, 20]);
    const from = s.from ?? lo;
    const to = s.to ?? hi;
    const n = Math.max(1, Math.min(120, Math.round(s.steps ?? (o.joints.length === 1 ? 12 : 6))));
    return { id: s.joint, values: Array.from({ length: n + 1 }, (_, k) => +(from + ((to - from) * k) / n).toFixed(4)) };
  });
  const total = ranges.reduce((p, r) => p * r.values.length, 1);
  if (total > MAX_SWEEP_POSES) throw new Error(`${total} poses are too many (at most ${MAX_SWEEP_POSES}): fewer steps`);
  const combos: number[][] = [[]];
  for (const r of ranges) combos.splice(0, combos.length, ...combos.flatMap((c) => r.values.map((v) => [...c, v])));
  const label = (c: number[]) => (c.length === 1 ? c[0]! : Object.fromEntries(ranges.map((r, i) => [r.id, c[i]!])));

  const doc = currentDoc();
  const all = (useApp.getState().output?.report.bodies ?? []).map((b) => b.id);
  const known = new Set(all);
  for (const id of [...(o.parts ?? []), ...(o.against ?? [])]) if (!known.has(id)) throw new Error(`no part "${id}"`);
  const cables = new Set(cableIds());
  const fasteners = o.fasteners ? new Set<string>() : new Set(all.filter((id) => isFastener(id, doc.features)));
  const usable = (id: string) => !cables.has(id) && !fasteners.has(id);

  const before = jointValues();
  const free = { ...useMotion.getState().free };
  const touchBelow = o.touchBelow ?? 0.1;
  const touching = designedContacts();
  const watch = new CableWatch();
  const pairs = new Map<string, SweepPair>();
  /** Pairs measured after the first pose: they moved against each other. */
  const movedApart = new Set<string>();
  const held: { joint: string; at: number | Record<string, number>; got: number }[] = [];
  const within = Math.max(2, wantedClearance() * 2);
  let movers: string[] = [];
  let others: string[] = [];
  try {
    // The parts the joints move: those whose place changes between the ends of their ranges.
    const poseAt = (c: number[]) => {
      ranges.forEach((r, i) => setJointValue(r.id, c[i]!));
      return new Map(currentPoses());
    };
    const first = poseAt(ranges.map((r) => r.values[0]!));
    const last = poseAt(ranges.map((r) => r.values[r.values.length - 1]!));
    const mid = poseAt(ranges.map((r) => r.values[Math.floor(r.values.length / 2)]!));
    const same = (x?: number[], y?: number[]) => (x ?? motion.IDENTITY).every((v, i) => Math.abs(v - ((y ?? motion.IDENTITY)[i] ?? 0)) < 1e-6);
    const moved = all.filter((id) => !same(first.get(id), last.get(id)) || !same(first.get(id), mid.get(id)));
    movers = (o.parts ?? moved).filter(usable);
    if (!movers.length) throw new Error(o.parts ? "no part left to check (cables and fasteners are left out)" : "the joints move no part over these ranges");
    const mover = new Set(movers);
    others = (o.against ?? all.filter((id) => !mover.has(id))).filter((id) => usable(id) && !mover.has(id));
    const taking = new Set([...movers, ...others]);
    const skip = all.filter((id) => !taking.has(id));
    let base: Map<string, number[]> | null = null;
    let firstDone = false;
    for (const c of combos) {
      ranges.forEach((r, i) => {
        if (!setJointValue(r.id, c[i]!) || Math.abs((jointValues()[r.id] ?? 0) - c[i]!) > 1e-3) held.push({ joint: r.id, at: label(c), got: +(jointValues()[r.id] ?? 0).toFixed(3) });
      });
      watch.add(c[0]!);
      const poses = currentPoses();
      // At the first pose every pair; after that only pairs that moved against each other since.
      const rigid = base ? movedTogether(base, poses) : rigidParts();
      const found = await kernel.clearances(movers, Object.fromEntries(poses), within, skip, rigid);
      base ??= new Map(poses);
      for (const f of found) {
        if (!mover.has(f.a) && !mover.has(f.b)) continue;
        const key = [f.a, f.b].sort().join("|");
        if (firstDone) movedApart.add(key);
        const designed = touching.has(key);
        const p = pairs.get(key) ?? { a: f.a, b: f.b, firstCollision: null, maxOverlapMm3: 0, minDistance: Infinity, minDistanceAt: label(c) };
        if (f.distance < p.minDistance) {
          p.minDistance = +f.distance.toFixed(3);
          p.minDistanceAt = label(c);
        }
        if (f.overlap > p.maxOverlapMm3) {
          p.maxOverlapMm3 = +f.overlap.toFixed(3);
          p.maxOverlapAt = label(c);
          if (f.points) p.where = [0, 1, 2].map((k) => +((f.points![0][k]! + f.points![1][k]!) / 2).toFixed(2)) as [number, number, number];
        }
        if (p.firstCollision === null && f.overlap >= touchBelow) p.firstCollision = label(c);
        if (!designed || f.overlap > 0) pairs.set(key, p);
      }
      firstDone = true;
    }
  } finally {
    restPose();
    useMotion.setState({ free });
    for (const [id, v] of Object.entries(before)) if (v) setJointValue(id, v);
  }
  const most = o.most ?? 12;
  // Two moving parts that kept their places to each other (a servo and its bracket on one link) are no news.
  const mover = new Set(movers);
  const list = [...pairs.entries()].filter(([key, p]) => !(mover.has(p.a) && mover.has(p.b)) || movedApart.has(key)).map(([, p]) => p);
  return {
    poses: combos.length,
    parts: movers.length,
    against: others.length,
    leftOut: { fasteners: fasteners.size, cables: cables.size },
    collisions: list.filter((p) => p.maxOverlapMm3 >= touchBelow).sort((x, y) => y.maxOverlapMm3 - x.maxOverlapMm3).slice(0, most),
    closest: list.filter((p) => p.maxOverlapMm3 < touchBelow && !touching.has([p.a, p.b].sort().join("|"))).sort((x, y) => x.minDistance - y.minDistance).slice(0, most),
    held: held.slice(0, most),
    ...watch.result(),
  };
}
