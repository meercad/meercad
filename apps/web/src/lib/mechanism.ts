/**
 * Moving parts in the app: the mechanism of the open design (joints from the document, axes from
 * the last rebuild), the joint values being shown (view state, not saved, no undo), dragging parts,
 * and the joint being drawn up in the joints panel.
 */
import { evaluate, motion } from "@meercad/model";
import type { Coupling, Joint, JointAnchor } from "@meercad/schema";
import type { Pick, Ray } from "@meercad/viewport";
import { create } from "zustand";
import { apply, currentDoc, toast, useApp } from "../store";
import { edgeSelectorForPick, faceSelectorForPick } from "./topology";

export type JointField = "a" | "b" | "anchor";

export const useMotion = create<{
  open: boolean;
  /** Values of the joints nothing drives (degrees or mm). */
  free: Record<string, number>;
  draft: { joint: Joint; isNew: boolean; field: JointField | null } | null;
}>(() => ({ open: false, free: {}, draft: null }));

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
  return mech.poses(mech.values(m.free));
}

/** Sets a joint's value (a driven joint moves its driver instead). */
export function setJointValue(id: string, value: number): void {
  const { mech } = currentMechanism();
  const r = mech.rootValueFor(id, value);
  if (!r) return;
  const [lo, hi] = mech.range(r.root);
  useMotion.setState((s) => ({ free: { ...s.free, [r.root]: Math.min(hi, Math.max(lo, r.value)) } }));
}

// ---------------------------------------------------------------- dragging

let drag: { joint: motion.MotionJoint; o: motion.V3; n: motion.V3; start: number; grab: motion.V3; last: motion.V3; turned: number; t0: number } | null = null;

/** Viewport hook: a press on a part that can move grabs it. */
export const partDrag = {
  start(pick: Extract<Pick, { kind: "face" }>, ray: Ray): boolean {
    if (useMotion.getState().draft) return false;
    const { mech } = currentMechanism();
    // A part held fixed to a moving part moves that part.
    let joint = mech.jointOf(pick.bodyId);
    for (let i = 0; joint?.type === "fixed" && i < 100; i++) joint = mech.jointOf(joint.b);
    if (!joint || joint.type === "fixed") return false;
    const values = mech.values(useMotion.getState().free);
    const parent = mech.poses(values).get(joint.b) ?? motion.IDENTITY;
    const o = motion.transformPoint(parent, joint.origin);
    const n = motion.transformDir(parent, joint.axis);
    const t0 = motion.rayLineParam(ray.origin, ray.dir, o, n) ?? 0;
    drag = { joint, o, n, start: values[joint.id] ?? 0, grab: pick.point, last: pick.point, turned: 0, t0 };
    return true;
  },
  move(ray: Ray): void {
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
  },
};

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
    if (useApp.getState().dialog) return toast("Finish the open tool first");
    useApp.setState({ measure: { active: false, picks: [], result: null } });
  }
  useMotion.setState({ open, draft: null, ...(open ? {} : { free: {} }) });
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
    if (d.field === "b" && pick.bodyId === d.joint.a) return toast("Pick another part, or Ground"), true;
    updateJointDraft(d.field === "a" ? { a: pick.bodyId, ...(d.joint.b === pick.bodyId ? { b: "ground" } : {}) } : { b: pick.bodyId }, d.field === "a" ? "b" : "anchor");
    return true;
  }
  let anchor: JointAnchor | null = null;
  if (pick.kind === "face") {
    if (pick.normal) return toast("Pick a round face (hole or shaft) or an edge for the axis"), true;
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
  if (!d.joint.a) return toast("Pick the part that moves", "error"), false;
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
