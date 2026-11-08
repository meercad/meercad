/**
 * A robot for physics simulation and robot learning: the parts and joints of a design as MJCF
 * (MuJoCo, mjlab, Isaac Lab's MJCF importer) and URDF (ROS, Isaac Sim, PyBullet), with one STL per
 * part. Parts held together by fixed joints become one link; every turning or sliding joint becomes
 * a joint between two links. Each link carries the mass, centre of gravity and inertia of its parts.
 *
 * Units out: metres, kilograms, radians (MJCF is written with angle="radian"). Units in: the
 * design's millimetres, grams and degrees.
 */
import { writeStl, type TriangleMesh } from "./stl.js";

type V3 = [number, number, number];

/** One part as it stands in the design (at rest). */
export interface RobotPart {
  id: string;
  /** The name people see, written as a comment next to the link. */
  name?: string;
  /** Triangles in model coordinates, mm. */
  mesh: TriangleMesh;
  /** "#rrggbb". */
  color?: string;
  /** Grams. */
  mass: number;
  /** Centre of gravity, model coordinates, mm. */
  centroid: V3;
  /**
   * Inertia about the centre of gravity, axes parallel to X, Y, Z, in g·mm²: Ixx, Iyy, Izz and the
   * products ∫xy, ∫xz, ∫yz dm (as meerCAD reports them).
   */
  inertia: readonly [number, number, number, number, number, number];
}

/** A joint as the app moves it: `a` moves on `b` (a part or "ground"). */
export interface RobotJoint {
  id: string;
  type: "revolute" | "slider" | "fixed";
  a: string;
  b: string;
  /** A point on the axis, model coordinates, mm. */
  origin: V3;
  /** Unit direction of the axis. */
  axis: V3;
  /** Degrees (revolute) or mm (slider). */
  limits?: [number, number];
}

/** driven = ratio × driver (gear pairs, racks). */
export interface RobotCoupling {
  driver: string;
  driven: string;
  ratio: number;
}

/** What drives a joint; leave a joint out to write it as passive. */
export interface RobotActuator {
  /** Peak torque (Nm) or force (N). */
  effort?: number;
  /** Top speed, rad/s or m/s. */
  velocity?: number;
  /** Position gain: with it the MJCF gets a position actuator, without it a torque motor. */
  kp?: number;
  /** Velocity gain of the position actuator. */
  kv?: number;
  /** Reflected rotor inertia, kg·m² (MJCF armature). */
  armature?: number;
  /** Viscous damping, Nm·s/rad. */
  damping?: number;
  /** Dry friction, Nm. */
  friction?: number;
}

export interface RobotOptions {
  /** Model name; files are named after it. */
  name: string;
  /** Give links that hang on nothing a free joint (a walking robot). Default true. */
  floating?: boolean;
  /** Actuators by joint id. */
  actuators?: Readonly<Record<string, RobotActuator>>;
}

export interface RobotLink {
  name: string;
  parts: string[];
  /** kg */
  mass: number;
  parent: string | null;
  /** The joint that moves it, null for a root. */
  joint: string | null;
}

export interface RobotExport {
  /** `<name>.xml` (MJCF), `<name>.urdf` and `meshes/<part>.stl`. */
  files: Record<string, Uint8Array>;
  links: RobotLink[];
  warnings: string[];
}

const GROUND = "ground";
const WORLD = "world";
/** A link with no parts (the turning carrier of a cylindrical joint) still needs mass in a simulator. */
const TINY_MASS = 1e-3;
const TINY_INERTIA = 1e-7;

const num = (v: number) => {
  const r = Math.abs(v) < 1e-12 ? 0 : +v.toPrecision(7);
  return Object.is(r, -0) ? "0" : String(r);
};
const vec = (v: readonly number[]) => v.map(num).join(" ");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Comments may not contain "--". */
const comment = (s: string) => `<!-- ${s.replace(/-{2,}/g, "-")} -->`;

/** Names simulators accept everywhere: letters, digits and underscores, unique. */
function namer(): (raw: string) => string {
  const used = new Set<string>([WORLD]);
  return (raw) => {
    let base = raw.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "part";
    if (!/^[A-Za-z_]/.test(base)) base = `_${base}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    return name;
  };
}

function rgba(color: string | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color ?? "");
  if (!m) return "0.8 0.8 0.8 1";
  const n = parseInt(m[1]!, 16);
  return vec([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1]);
}

/** Mass, centre and inertia (about the centre, g·mm², products ∫xy dm) of several parts together. */
function combine(parts: readonly RobotPart[]): { mass: number; center: V3; inertia: number[] } {
  const mass = parts.reduce((s, p) => s + p.mass, 0);
  const center: V3 = [0, 0, 0];
  if (mass > 0) for (const p of parts) for (let k = 0; k < 3; k++) center[k]! += (p.centroid[k]! * p.mass) / mass;
  const inertia = [0, 0, 0, 0, 0, 0];
  for (const p of parts) {
    const [dx, dy, dz] = [p.centroid[0] - center[0], p.centroid[1] - center[1], p.centroid[2] - center[2]];
    const shift = [dy * dy + dz * dz, dx * dx + dz * dz, dx * dx + dy * dy, dx * dy, dx * dz, dy * dz];
    for (let k = 0; k < 6; k++) inertia[k]! += p.inertia[k]! + p.mass * shift[k]!;
  }
  return { mass, center, inertia };
}

/** The part's triangles moved into its link's frame and scaled to metres. */
function inFrame(mesh: TriangleMesh, frame: V3): TriangleMesh {
  const p = new Float32Array(mesh.positions.length);
  for (let i = 0; i < p.length; i += 3) {
    p[i] = (mesh.positions[i]! - frame[0]) / 1000;
    p[i + 1] = (mesh.positions[i + 1]! - frame[1]) / 1000;
    p[i + 2] = (mesh.positions[i + 2]! - frame[2]) / 1000;
  }
  return { positions: p, indices: mesh.indices };
}

/** mm two boxes must overlap by before their links stop colliding with each other. */
const OVERLAP = 0.5;

/** The box around parts' triangles, mm (null without triangles). */
function boxOf(parts: readonly RobotPart[]): { min: V3; max: V3 } | null {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts)
    for (let i = 0; i < p.mesh.positions.length; i += 3)
      for (let d = 0; d < 3; d++) {
        const v = p.mesh.positions[i + d]!;
        if (v < min[d]!) min[d] = v;
        if (v > max[d]!) max[d] = v;
      }
  return min[0] <= max[0] ? { min, max } : null;
}

interface Link {
  name: string;
  parts: RobotPart[];
  /** Moved by this joint (null: a root). */
  joint: RobotJoint | null;
  /** WORLD for a link moving on the ground. */
  parent: Link | typeof WORLD | null;
  children: Link[];
  /** Frame origin, model mm: the parent joint's origin (roots: the model origin). */
  frame: V3;
  /** Fixed to the ground (directly, no joint). */
  grounded: boolean;
}

export function writeRobot(parts: readonly RobotPart[], joints: readonly RobotJoint[], couplings: readonly RobotCoupling[], options: RobotOptions): RobotExport {
  const warnings: string[] = [];
  const floating = options.floating !== false;
  const byId = new Map(parts.map((p) => [p.id, p]));

  // Parts a joint names that are no part (the carrier of a cylindrical joint) become empty links.
  const virtual = new Set<string>();
  for (const j of joints) for (const end of [j.a, j.b]) if (end !== GROUND && !byId.has(end)) virtual.add(end);

  // Parts held together by fixed joints are one link.
  const up = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (up.get(r) !== undefined && up.get(r) !== r) r = up.get(r)!;
    return r;
  };
  for (const id of [...byId.keys(), ...virtual]) up.set(id, id);
  const grounded = new Set<string>();
  for (const j of joints) {
    if (j.type !== "fixed") continue;
    if (j.b === GROUND) grounded.add(j.a);
    else up.set(find(j.a), find(j.b));
  }

  const groups = new Map<string, string[]>();
  for (const id of up.keys()) {
    const r = find(id);
    groups.set(r, [...(groups.get(r) ?? []), id]);
  }
  const moving = joints.filter((j) => j.type !== "fixed");
  // A link is named after the part its joint moves, else after its heaviest part.
  const name = namer();
  const linkOf = new Map<string, Link>();
  const links: Link[] = [];
  for (const members of groups.values()) {
    const real = members.filter((m) => byId.has(m)).map((m) => byId.get(m)!);
    const driven = members.find((m) => moving.some((j) => j.a === m));
    const heaviest = [...real].sort((x, y) => y.mass - x.mass)[0];
    const link: Link = { name: name(driven ?? heaviest?.id ?? members[0]!), parts: real, joint: null, parent: null, children: [], frame: [0, 0, 0], grounded: members.some((m) => grounded.has(m)) };
    links.push(link);
    for (const m of members) linkOf.set(m, link);
  }

  for (const j of moving) {
    const child = linkOf.get(j.a)!;
    const parent = j.b === GROUND ? WORLD : linkOf.get(j.b)!;
    if (parent === child) {
      warnings.push(`joint ${j.id} moves a part on its own link (both ends are held together by fixed joints); left out`);
      continue;
    }
    if (child.joint) {
      warnings.push(`joint ${j.id}: link ${child.name} already moves on joint ${child.joint.id} (a closed loop); left out`);
      continue;
    }
    // A joint into one of the child's own descendants would close a loop.
    let p: Link | typeof WORLD | null = parent;
    let loop = false;
    while (p && p !== WORLD) {
      if (p === child) {
        loop = true;
        break;
      }
      p = p.parent;
    }
    if (loop) {
      warnings.push(`joint ${j.id} closes a loop (four-bar linkages and the like cannot be a tree); left out`);
      continue;
    }
    child.joint = j;
    child.parent = parent;
    child.frame = [...j.origin];
    if (parent !== WORLD) parent.children.push(child);
  }

  const roots = links.filter((l) => !l.parent);
  const onGround = links.filter((l) => l.parent === WORLD);
  const free = roots.filter((l) => !l.grounded);
  if (free.length > 1) warnings.push(`${free.length} links hang on nothing (${free.map((l) => l.name).join(", ")}); each becomes its own body. Join them with joints for one robot`);
  for (const l of links) if (!l.parts.length) warnings.push(`link ${l.name} has no parts (a joint carrier); it gets a tiny mass of ${TINY_MASS * 1000} g`);
  for (const l of links) if (l.parts.length && l.parts.every((p) => !(p.mass > 0))) warnings.push(`link ${l.name} has no mass: give its parts a material`);
  const passive = moving.filter((j) => !options.actuators?.[j.id]);
  if (passive.length) warnings.push(`no actuator data for ${passive.length} of ${moving.length} joints (${passive.slice(0, 6).map((j) => j.id).join(", ")}${passive.length > 6 ? ", …" : ""}): passive in the MJCF, default effort/velocity in the URDF`);

  // Mass properties per link, in the link frame, SI units.
  const inertial = (l: Link) => {
    const c = combine(l.parts);
    if (!(c.mass > 0)) return { mass: TINY_MASS, pos: [0, 0, 0] as V3, full: [TINY_INERTIA, TINY_INERTIA, TINY_INERTIA, 0, 0, 0] };
    const pos: V3 = [(c.center[0] - l.frame[0]) / 1000, (c.center[1] - l.frame[1]) / 1000, (c.center[2] - l.frame[2]) / 1000];
    // g·mm² → kg·m² is 1e-9; the inertia tensor's off-diagonal entries are −∫xy dm.
    const s = 1e-9;
    const full = [c.inertia[0]! * s, c.inertia[1]! * s, c.inertia[2]! * s, -c.inertia[3]! * s, -c.inertia[4]! * s, -c.inertia[5]! * s].map((v, i) => (i < 3 ? Math.max(v, TINY_INERTIA) : v));
    return { mass: c.mass / 1000, pos, full };
  };

  const files: Record<string, Uint8Array> = {};
  const meshName = new Map<string, string>();
  const meshNamer = namer();
  for (const l of links)
    for (const p of l.parts) {
      const n = meshNamer(p.id);
      meshName.set(p.id, n);
      files[`meshes/${n}.stl`] = writeStl([inFrame(p.mesh, l.frame)], `meerCAD ${n} (metres)`);
    }

  const rad = (j: RobotJoint, v: number) => (j.type === "revolute" ? (v * Math.PI) / 180 : v / 1000);
  const rel = (l: Link): V3 => {
    const pf = l.parent && l.parent !== WORLD ? l.parent.frame : ([0, 0, 0] as V3);
    return [(l.frame[0] - pf[0]) / 1000, (l.frame[1] - pf[1]) / 1000, (l.frame[2] - pf[2]) / 1000];
  };
  const jointName = new Map<string, string>();
  const jn = namer();
  for (const l of links) if (l.joint) jointName.set(l.joint.id, jn(l.joint.id));

  // ---------- MJCF ----------
  const mj: string[] = [];
  const indent = (d: number) => "  ".repeat(d);
  const writeBody = (l: Link, depth: number, withFreeJoint: boolean) => {
    const pos = l.parent ? rel(l) : ([0, 0, 0] as V3);
    mj.push(`${indent(depth)}<body name="${l.name}" pos="${vec(pos)}">`);
    if (l.parts.length) mj.push(`${indent(depth + 1)}${comment(l.parts.map((p) => p.name ?? p.id).join(", "))}`);
    if (withFreeJoint) mj.push(`${indent(depth + 1)}<freejoint name="${l.name}_free"/>`);
    if (l.joint) {
      const j = l.joint;
      const a = options.actuators?.[j.id];
      const attrs = [`name="${jointName.get(j.id)}"`, `type="${j.type === "slider" ? "slide" : "hinge"}"`, `pos="0 0 0"`, `axis="${vec(j.axis)}"`];
      if (j.limits) attrs.push(`range="${num(rad(j, j.limits[0]))} ${num(rad(j, j.limits[1]))}"`);
      if (a?.armature !== undefined) attrs.push(`armature="${num(a.armature)}"`);
      if (a?.damping !== undefined) attrs.push(`damping="${num(a.damping)}"`);
      if (a?.friction !== undefined) attrs.push(`frictionloss="${num(a.friction)}"`);
      if (a?.effort !== undefined) attrs.push(`actuatorfrcrange="${num(-a.effort)} ${num(a.effort)}"`);
      mj.push(`${indent(depth + 1)}<joint ${attrs.join(" ")}/>`);
    }
    const m = inertial(l);
    mj.push(`${indent(depth + 1)}<inertial pos="${vec(m.pos)}" mass="${num(m.mass)}" fullinertia="${vec(m.full)}"/>`);
    for (const p of l.parts) mj.push(`${indent(depth + 1)}<geom name="${meshName.get(p.id)}" type="mesh" mesh="${meshName.get(p.id)}" rgba="${rgba(p.color)}"/>`);
    for (const c of l.children) writeBody(c, depth + 1, false);
    mj.push(`${indent(depth)}</body>`);
  };
  mj.push(`<mujoco model="${esc(options.name)}">`);
  mj.push(`  ${comment("Written by meerCAD. Units: metres, kilograms, radians. Meshes in meshes/, one per part.")}`);
  mj.push(`  <compiler angle="radian" meshdir="meshes" autolimits="true"/>`);
  mj.push(`  <option timestep="0.002" integrator="implicitfast"/>`);
  mj.push(`  <default>`);
  mj.push(`    <geom contype="1" conaffinity="1" condim="3" friction="0.8 0.02 0.01"/>`);
  mj.push(`  </default>`);
  mj.push(`  <asset>`);
  for (const [, n] of meshName) mj.push(`    <mesh name="${n}" file="${n}.stl"/>`);
  mj.push(`  </asset>`);
  mj.push(`  <worldbody>`);
  mj.push(`    <light name="sun" pos="0 0 3" dir="0 0 -1" directional="true"/>`);
  mj.push(`    <geom name="floor" type="plane" size="0 0 0.05" rgba="0.85 0.86 0.88 1"/>`);
  for (const r of roots) writeBody(r, 2, floating && !r.grounded);
  for (const l of onGround) writeBody(l, 2, false);
  mj.push(`  </worldbody>`);
  // Simulators collide meshes by their convex hulls: a foot's hull swallows the ankle above it. Links
  // whose boxes already overlap at rest would push each other apart at the first step, so they do not
  // collide with each other (parent and child never do in MuJoCo).
  const boxes = new Map(links.map((l) => [l, boxOf(l.parts)]));
  const excluded: [Link, Link][] = [];
  for (let i = 0; i < links.length; i++)
    for (let k = i + 1; k < links.length; k++) {
      const [x, y] = [links[i]!, links[k]!];
      if (x.parent === y || y.parent === x) continue;
      const [bx, by] = [boxes.get(x), boxes.get(y)];
      if (bx && by && [0, 1, 2].every((d) => bx.min[d]! < by.max[d]! - OVERLAP && by.min[d]! < bx.max[d]! - OVERLAP)) excluded.push([x, y]);
    }
  if (excluded.length) {
    mj.push(`  <contact>`);
    for (const [x, y] of excluded) mj.push(`    <exclude body1="${x.name}" body2="${y.name}"/>`);
    mj.push(`  </contact>`);
  }
  const coupled =couplings.filter((c) => jointName.has(c.driver) && jointName.has(c.driven));
  if (coupled.length) {
    mj.push(`  <equality>`);
    for (const c of coupled) mj.push(`    <joint joint1="${jointName.get(c.driven)}" joint2="${jointName.get(c.driver)}" polycoef="0 ${num(c.ratio)} 0 0 0"/>`);
    mj.push(`  </equality>`);
  }
  const driven = links.filter((l) => l.joint && options.actuators?.[l.joint.id]);
  if (driven.length) {
    mj.push(`  <actuator>`);
    for (const l of driven) {
      const j = l.joint!;
      const a = options.actuators![j.id]!;
      const n = jointName.get(j.id)!;
      const force = a.effort !== undefined ? ` forcerange="${num(-a.effort)} ${num(a.effort)}"` : "";
      if (a.kp !== undefined) {
        const range = j.limits ? ` ctrlrange="${num(rad(j, j.limits[0]))} ${num(rad(j, j.limits[1]))}"` : "";
        mj.push(`    <position name="${n}" joint="${n}" kp="${num(a.kp)}"${a.kv !== undefined ? ` kv="${num(a.kv)}"` : ""}${range}${force}/>`);
      } else {
        const e = a.effort ?? 1;
        mj.push(`    <motor name="${n}" joint="${n}" ctrlrange="${num(-e)} ${num(e)}"/>`);
      }
    }
    mj.push(`  </actuator>`);
  }
  mj.push(`</mujoco>`);
  files[`${options.name}.xml`] = new TextEncoder().encode(mj.join("\n") + "\n");

  // ---------- URDF ----------
  const ur: string[] = [];
  ur.push(`<?xml version="1.0"?>`);
  ur.push(`<robot name="${esc(options.name)}">`);
  ur.push(`  ${comment("Written by meerCAD. Units: metres, kilograms, radians. Meshes in meshes/, one per part.")}`);
  const urdfRoots = roots.filter((r) => !r.grounded);
  const needsWorld = onGround.length > 0 || roots.some((r) => r.grounded);
  if (needsWorld) ur.push(`  <link name="${WORLD}"/>`);
  if (!needsWorld && urdfRoots.length > 1) warnings.push(`URDF has one root: ${urdfRoots.slice(1).map((l) => l.name).join(", ")} hang on ${urdfRoots[0]!.name} with floating joints, which many URDF tools do not support`);
  for (const l of links) {
    const m = inertial(l);
    ur.push(`  <link name="${l.name}">`);
    if (l.parts.length) ur.push(`    ${comment(l.parts.map((p) => p.name ?? p.id).join(", "))}`);
    ur.push(`    <inertial>`);
    ur.push(`      <origin xyz="${vec(m.pos)}" rpy="0 0 0"/>`);
    ur.push(`      <mass value="${num(m.mass)}"/>`);
    const [ixx, iyy, izz, ixy, ixz, iyz] = m.full;
    ur.push(`      <inertia ixx="${num(ixx!)}" ixy="${num(ixy!)}" ixz="${num(ixz!)}" iyy="${num(iyy!)}" iyz="${num(iyz!)}" izz="${num(izz!)}"/>`);
    ur.push(`    </inertial>`);
    for (const p of l.parts) {
      const file = `meshes/${meshName.get(p.id)}.stl`;
      ur.push(`    <visual>`);
      ur.push(`      <origin xyz="0 0 0" rpy="0 0 0"/>`);
      ur.push(`      <geometry><mesh filename="${file}"/></geometry>`);
      ur.push(`      <material name="${meshName.get(p.id)}"><color rgba="${rgba(p.color)}"/></material>`);
      ur.push(`    </visual>`);
      ur.push(`    <collision>`);
      ur.push(`      <origin xyz="0 0 0" rpy="0 0 0"/>`);
      ur.push(`      <geometry><mesh filename="${file}"/></geometry>`);
      ur.push(`    </collision>`);
    }
    ur.push(`  </link>`);
  }
  const urdfJoint = (l: Link) => {
    if (!l.parent) return;
    const j = l.joint!;
    const a = options.actuators?.[j.id];
    const parent = l.parent === WORLD ? WORLD : l.parent.name;
    const type = j.type === "slider" ? "prismatic" : j.limits ? "revolute" : "continuous";
    ur.push(`  <joint name="${jointName.get(j.id)}" type="${type}">`);
    ur.push(`    <origin xyz="${vec(rel(l))}" rpy="0 0 0"/>`);
    ur.push(`    <parent link="${parent}"/>`);
    ur.push(`    <child link="${l.name}"/>`);
    ur.push(`    <axis xyz="${vec(j.axis)}"/>`);
    const effort = a?.effort ?? 100;
    const velocity = a?.velocity ?? (j.type === "slider" ? 1 : 10);
    if (type !== "continuous") {
      const [lo, hi] = j.limits ? [rad(j, j.limits[0]), rad(j, j.limits[1])] : [-1, 1];
      if (!j.limits) warnings.push(`slider ${j.id} has no travel; the URDF gets ±1 m`);
      ur.push(`    <limit lower="${num(lo)}" upper="${num(hi)}" effort="${num(effort)}" velocity="${num(velocity)}"/>`);
    } else ur.push(`    <limit effort="${num(effort)}" velocity="${num(velocity)}"/>`);
    if (a?.damping !== undefined || a?.friction !== undefined) ur.push(`    <dynamics damping="${num(a?.damping ?? 0)}" friction="${num(a?.friction ?? 0)}"/>`);
    const mimic = couplings.find((c) => c.driven === j.id && jointName.has(c.driver));
    if (mimic) ur.push(`    <mimic joint="${jointName.get(mimic.driver)}" multiplier="${num(mimic.ratio)}" offset="0"/>`);
    ur.push(`  </joint>`);
  };
  for (const l of links) urdfJoint(l);
  // Links fixed to the ground hang on the world; extra free roots hang on the first with floating joints.
  for (const r of roots) {
    if (r.grounded) ur.push(`  <joint name="${r.name}_fixed" type="fixed"><parent link="${WORLD}"/><child link="${r.name}"/><origin xyz="0 0 0" rpy="0 0 0"/></joint>`);
  }
  if (!needsWorld) for (const r of urdfRoots.slice(1)) ur.push(`  <joint name="${r.name}_floating" type="floating"><parent link="${urdfRoots[0]!.name}"/><child link="${r.name}"/><origin xyz="${vec([-urdfRoots[0]!.frame[0] / 1000, -urdfRoots[0]!.frame[1] / 1000, -urdfRoots[0]!.frame[2] / 1000])}" rpy="0 0 0"/></joint>`);
  else for (const r of urdfRoots) ur.push(`  <joint name="${r.name}_floating" type="floating"><parent link="${WORLD}"/><child link="${r.name}"/><origin xyz="0 0 0" rpy="0 0 0"/></joint>`);
  ur.push(`</robot>`);
  files[`${options.name}.urdf`] = new TextEncoder().encode(ur.join("\n") + "\n");

  return {
    files,
    links: links.map((l) => ({ name: l.name, parts: l.parts.map((p) => p.id), mass: +inertial(l).mass.toFixed(4), parent: l.parent === WORLD ? WORLD : (l.parent?.name ?? null), joint: l.joint ? jointName.get(l.joint.id)! : null })),
    warnings,
  };
}
