/**
 * Moving parts in the app: the mechanism of the open design (joints from the document, axes from
 * the last rebuild), the joint values being shown (view state, not saved, no undo), dragging parts,
 * and the joint being drawn up in the joints panel.
 */
import { evaluate, linkage, motion } from "@meercad/model";
import type { Coupling, Joint, JointAnchor } from "@meercad/schema";
import type { Pick, Ray } from "@meercad/viewport";
import { create } from "zustand";
import type { Clearance } from "@meercad/kernel";
import { apply, currentDoc, kernel, toast, useApp } from "../store";
import { edgeSelectorForPick, faceSelectorForPick } from "./topology";
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
  check: ClearanceCheck | null;
  /** Bumped when a closed-loop linkage moves (its pose lives outside the store). */
  tick: number;
  /** Set when a linkage cannot move further (a dead point or a limit). */
  stuck: boolean;
}>(() => ({ open: false, free: {}, draft: null, playing: null, check: null, tick: 0, stuck: false }));

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
  useMotion.setState((s) => ({ tick: s.tick + 1, stuck: !r.ok }));
  return r.ok;
}

/** Back to where the parts were drawn. */
export function restPose(): void {
  loop = null;
  useMotion.setState((s) => ({ free: {}, tick: s.tick + 1, stuck: false }));
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
      let limits: [number, number] | undefined;
      try {
        limits = j.limits ? [num(j.limits[0]), num(j.limits[1])] : undefined;
      } catch (e) {
        problems[j.id] = `limits: ${(e as Error).message}`;
        continue;
      }
      joints.push({ id: j.id, type: j.type, a: j.a, b: j.b, origin: frame.origin, axis: frame.axis, ...(limits ? { limits: [Math.min(...limits), Math.max(...limits)] as [number, number] } : {}) });
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
  if (l) return moveLoop(l, l.L.solve(l.poses, { [id]: value }, undefined, l.values));
  const r = mech.rootValueFor(id, value);
  if (!r) return false;
  const [lo, hi] = mech.range(r.root);
  useMotion.setState((s) => ({ free: { ...s.free, [r.root]: Math.min(hi, Math.max(lo, r.value)) } }));
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
  if (useMotion.getState().playing) useMotion.setState({ playing: null });
}

// ---------------------------------------------------------------- clearance

/** Smallest wanted gap between moving parts (print-in-place), mm. */
export function wantedClearance(): number {
  const c = currentDoc().mechanism?.clearance;
  try {
    return c === undefined ? 0.3 : evaluate(c, new Map(Object.entries(useApp.getState().output?.report.params ?? {})));
  } catch {
    return 0.3;
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
    const results = await kernel.clearances(moving, Object.fromEntries(poses), Math.max(2, wantedClearance() * 2));
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
export function setPose(values: Readonly<Record<string, number>>): { values: Record<string, number>; reached: boolean; problems: Record<string, string> } {
  openForCheck();
  stopPlaying();
  const { mech, problems } = currentMechanism();
  let reached = true;
  for (const [id, v] of Object.entries(values)) {
    if (!mech.joint(id)) throw new Error(`no joint "${id}"${problems[id] ? `: ${problems[id]}` : ""}`);
    reached = setJointValue(id, v) && reached;
  }
  const now = jointValues();
  // A limit or a dead point can stop a joint short of its value.
  for (const [id, v] of Object.entries(values)) if (Math.abs((now[id] ?? 0) - v) > 1e-3) reached = false;
  return { values: now, reached, problems };
}

/** Gaps between moving parts and what they come near, in the pose shown now. */
export async function clearanceNow(): Promise<{ wanted: number; pairs: Clearance[] }> {
  openForCheck();
  const { mech } = currentMechanism();
  const moving = [...new Set(mech.joints.filter((j) => j.type !== "fixed").map((j) => j.a))];
  if (!moving.length) throw new Error("no part moves: add joints first");
  const want = wantedClearance();
  const pairs = await kernel.clearances(moving, Object.fromEntries(currentPoses()), Math.max(2, want * 2));
  return { wanted: want, pairs: pairs.map(({ points: _p, ...rest }) => rest).sort((x, y) => x.distance - y.distance) };
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
}> {
  openForCheck();
  const before = jointValues();
  const free = { ...useMotion.getState().free };
  const n = Math.max(1, Math.min(90, Math.round(steps)));
  let firstContact: { value: number; a: string; b: string; kind: "touch" | "overlap"; overlap: number } | null = null;
  let stoppedAt: number | null = null;
  const smallest = new Map<string, { a: string; b: string; distance: number; at: number }>();
  try {
    for (let k = 0; k <= n; k++) {
      const v = from + ((to - from) * k) / n;
      if (!setJointValue(joint, v) || Math.abs((jointValues()[joint] ?? 0) - v) > 1e-3) {
        stoppedAt = jointValues()[joint] ?? v;
        break;
      }
      for (const c of (await clearanceNow()).pairs) {
        const key = `${c.a}|${c.b}`;
        const cur = smallest.get(key);
        if (!cur || c.distance < cur.distance) smallest.set(key, { a: c.a, b: c.b, distance: c.distance, at: v });
        if (!firstContact && (c.overlap > 1e-3 || c.distance < 1e-4)) firstContact = { value: v, a: c.a, b: c.b, kind: c.overlap > 1e-3 ? "overlap" : "touch", overlap: c.overlap };
      }
    }
  } finally {
    // Back to the pose before the check.
    restPose();
    useMotion.setState({ free });
    for (const [id, v] of Object.entries(before)) if (v) setJointValue(id, v);
  }
  return { steps: n, firstContact, smallest: [...smallest.values()].sort((x, y) => x.distance - y.distance), stoppedAt };
}
