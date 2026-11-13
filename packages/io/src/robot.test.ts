import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fitCollisionShape, writeRobot, type RobotJoint, type RobotPart } from "./index.js";
import type { TriangleMesh } from "./stl.js";

/** An axis-aligned box part from `min` to `max` (mm), 1 g/cm³: mass, centre and inertia as meerCAD reports them. */
function box(id: string, min: [number, number, number], max: [number, number, number], color?: string): RobotPart {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  const [a, b, c] = [x1 - x0, y1 - y0, z1 - z0];
  const mass = (a * b * c) / 1000; // g at 1 g/cm³
  return {
    id,
    name: `Box ${id}`,
    mesh: { positions, indices },
    ...(color ? { color } : {}),
    mass,
    centroid: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
    inertia: [(mass * (b * b + c * c)) / 12, (mass * (a * a + c * c)) / 12, (mass * (a * a + b * b)) / 12, 0, 0, 0],
  };
}

/** A closed cylinder of radius r from z0 to z1 about the Z axis through (cx, cy), `n` sides. */
function cylinderMesh(r: number, z0: number, z1: number, n = 48, cx = 0, cy = 0): TriangleMesh {
  const pos: number[] = [cx, cy, z0, cx, cy, z1];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pos.push(cx + r * Math.cos(a), cy + r * Math.sin(a), z0, cx + r * Math.cos(a), cy + r * Math.sin(a), z1);
  }
  for (let i = 0; i < n; i++) {
    const [b0, t0, b1, t1] = [2 + 2 * i, 3 + 2 * i, 2 + 2 * ((i + 1) % n), 3 + 2 * ((i + 1) % n)];
    idx.push(0, b1, b0, 1, t0, t1, b0, b1, t1, b0, t1, t0);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Points of a mesh turned by `deg` about Z. */
function turnedZ(m: TriangleMesh, deg: number): TriangleMesh {
  const [c, s] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
  const p = new Float32Array(m.positions);
  for (let i = 0; i < p.length; i += 3) [p[i], p[i + 1]] = [c * m.positions[i]! - s * m.positions[i + 1]!, s * m.positions[i]! + c * m.positions[i + 1]!];
  return { positions: p, indices: m.indices };
}

const text = (files: Record<string, Uint8Array>, name: string) => new TextDecoder().decode(files[name]!);
const attr = (xml: string, tag: string, name: string, key: string) => {
  const el = new RegExp(`<${tag}[^>]*name="${name}"[^>]*>`).exec(xml)?.[0];
  return el ? new RegExp(`${key}="([^"]*)"`).exec(el)?.[1] : undefined;
};

/** A pendulum: a base, an arm turning about X at (0, 0, 100) mm, a weight fixed to the arm's end. */
function pendulum() {
  const parts = [box("base", [-50, -50, 0], [50, 50, 100], "#ff0000"), box("arm", [-10, -10, 0], [10, 10, 100]), box("weight", [-20, -20, -10], [20, 20, 10])];
  // Move arm and weight above the base: the arm turns at its bottom end.
  const shift = (p: RobotPart, dz: number) => {
    for (let i = 2; i < p.mesh.positions.length; i += 3) p.mesh.positions[i]! += dz;
    p.centroid[2] += dz;
  };
  shift(parts[1]!, 100);
  shift(parts[2]!, 200);
  const joints: RobotJoint[] = [
    { id: "hinge", type: "revolute", a: "arm", b: "base", origin: [0, 0, 100], axis: [1, 0, 0], limits: [-90, 45] },
    { id: "glue", type: "fixed", a: "weight", b: "arm", origin: [0, 0, 0], axis: [0, 0, 1] },
  ];
  return { parts, joints };
}

describe("writeRobot", () => {
  it("makes one link per group of fixed parts and one joint per moving joint", () => {
    const { parts, joints } = pendulum();
    const r = writeRobot(parts, joints, [], { name: "pendel" });
    expect(r.links.map((l) => l.name).sort()).toEqual(["arm", "base"]);
    const arm = r.links.find((l) => l.name === "arm")!;
    expect(arm.parts.sort()).toEqual(["arm", "weight"]);
    expect(arm.parent).toBe("base");
    expect(arm.joint).toBe("hinge");
    // arm 20·20·100 mm³ = 40 g, weight 40·40·20 = 32 g → 0.072 kg
    expect(arm.mass).toBeCloseTo(0.072, 6);
    expect(Object.keys(r.files).sort()).toEqual(["meshes/arm.stl", "meshes/base.stl", "meshes/weight.stl", "pendel.urdf", "pendel.xml"]);
  });

  it("writes MJCF in metres and radians with the child frame at its joint", () => {
    const { parts, joints } = pendulum();
    const mj = text(writeRobot(parts, joints, [], { name: "pendel" }).files, "pendel.xml");
    expect(mj).toContain(`<compiler angle="radian" meshdir="meshes" autolimits="true"/>`);
    expect(attr(mj, "body", "arm", "pos")).toBe("0 0 0.1");
    expect(attr(mj, "joint", "hinge", "type")).toBe("hinge");
    expect(attr(mj, "joint", "hinge", "axis")).toBe("1 0 0");
    const [lo, hi] = attr(mj, "joint", "hinge", "range")!.split(" ").map(Number);
    expect(lo).toBeCloseTo(-Math.PI / 2, 5);
    expect(hi).toBeCloseTo(Math.PI / 4, 5);
    // The base hangs on nothing: a walking robot's floating base.
    expect(mj).toContain(`<freejoint name="base_free"/>`);
    expect(mj).toContain(`rgba="1 0 0 1"`);
  });

  it("puts each link's centre of gravity and inertia in its own frame, in kg·m²", () => {
    const { parts, joints } = pendulum();
    const mj = text(writeRobot(parts, joints, [], { name: "pendel" }).files, "pendel.xml");
    const inertial = /<body name="arm"[\s\S]*?<inertial pos="([^"]*)" mass="([^"]*)" fullinertia="([^"]*)"/.exec(mj)!;
    const pos = inertial[1]!.split(" ").map(Number);
    // arm centre 50 mm above the joint (40 g), weight centre 100 mm above (32 g) → 72.2 mm
    expect(pos[2]).toBeCloseTo(((40 * 50 + 32 * 100) / 72) / 1000, 6);
    const [ixx, iyy, izz] = inertial[3]!.split(" ").map(Number);
    expect(ixx).toBeGreaterThan(0);
    expect(ixx).toBeCloseTo(iyy!, 12);
    // About Z only the boxes' own spread counts: 40·(20²+20²)/12 + 32·(40²+40²)/12 g·mm²
    expect(izz).toBeCloseTo(((40 * 800) / 12 + (32 * 3200) / 12) * 1e-9, 12);
  });

  it("writes the products of inertia with the tensor's sign", () => {
    const p = box("p", [0, 0, 0], [10, 10, 10]);
    p.inertia = [1e6, 1e6, 1e6, 2e5, 0, 0];
    const mj = text(writeRobot([p], [], [], { name: "x" }).files, "x.xml");
    const full = /fullinertia="([^"]*)"/.exec(mj)![1]!.split(" ").map(Number);
    expect(full[3]).toBeCloseTo(-2e5 * 1e-9, 15);
  });

  it("writes URDF with the same tree, limits in radians and inertia per link", () => {
    const { parts, joints } = pendulum();
    const ur = text(writeRobot(parts, joints, [], { name: "pendel", actuators: { hinge: { effort: 17, velocity: 40, damping: 0.1 } } }).files, "pendel.urdf");
    expect(ur).toMatch(/<joint name="hinge" type="revolute">\s*<origin xyz="0 0 0.1" rpy="0 0 0"\/>\s*<parent link="base"\/>\s*<child link="arm"\/>/);
    expect(ur).toMatch(/<limit lower="-1.570796" upper="0.7853982" effort="17" velocity="40"\/>/);
    expect(ur).toContain(`<dynamics damping="0.1" friction="0"/>`);
    expect(ur.match(/<link name=/g)!.length).toBe(2);
    expect(ur).toContain(`<mesh filename="meshes/weight.stl"/>`);
  });

  it("adds actuators only for joints with actuator data", () => {
    const { parts, joints } = pendulum();
    const passive = writeRobot(parts, joints, [], { name: "p" });
    expect(text(passive.files, "p.xml")).not.toContain("<actuator>");
    expect(passive.warnings.join(" ")).toContain("no actuator data");
    const servo = text(writeRobot(parts, joints, [], { name: "p", actuators: { hinge: { effort: 6, kp: 40, kv: 1, armature: 0.01 } } }).files, "p.xml");
    expect(servo).toMatch(/<position name="hinge" joint="hinge" kp="40" kv="1" ctrlrange="-1.570796 0.7853982" forcerange="-6 6"\/>/);
    expect(attr(servo, "joint", "hinge", "armature")).toBe("0.01");
    const motor = text(writeRobot(parts, joints, [], { name: "p", actuators: { hinge: { effort: 6 } } }).files, "p.xml");
    expect(motor).toContain(`<motor name="hinge" joint="hinge" ctrlrange="-6 6"/>`);
  });

  it("anchors parts fixed to the ground and leaves out closed loops", () => {
    const { parts, joints } = pendulum();
    const grounded = writeRobot(parts, [...joints, { id: "stand", type: "fixed", a: "base", b: "ground", origin: [0, 0, 0], axis: [0, 0, 1] }], [], { name: "g" });
    expect(text(grounded.files, "g.xml")).not.toContain("freejoint");
    expect(text(grounded.files, "g.urdf")).toContain(`<joint name="base_fixed" type="fixed"><parent link="world"/>`);
    const loop = writeRobot(parts, [...joints, { id: "back", type: "revolute", a: "base", b: "weight", origin: [0, 0, 0], axis: [1, 0, 0] }], [], { name: "l" });
    expect(loop.warnings.join(" ")).toContain("closes a loop");
    expect(loop.links.find((l) => l.name === "base")!.joint).toBeNull();
  });

  it("couples joints: MJCF equality, URDF mimic", () => {
    const parts = [box("frame", [0, 0, 0], [100, 10, 10]), box("g1", [0, 0, 10], [10, 10, 20]), box("g2", [50, 0, 10], [60, 10, 20])];
    const joints: RobotJoint[] = [
      { id: "j1", type: "revolute", a: "g1", b: "frame", origin: [5, 5, 15], axis: [0, 0, 1] },
      { id: "j2", type: "revolute", a: "g2", b: "frame", origin: [55, 5, 15], axis: [0, 0, 1] },
    ];
    const r = writeRobot(parts, joints, [{ driver: "j1", driven: "j2", ratio: -0.5 }], { name: "gears" });
    expect(text(r.files, "gears.xml")).toContain(`<joint joint1="j2" joint2="j1" polycoef="0 -0.5 0 0 0"/>`);
    expect(text(r.files, "gears.urdf")).toContain(`<mimic joint="j1" multiplier="-0.5" offset="0"/>`);
    // Without limits a revolute joint turns all the way round.
    expect(text(r.files, "gears.urdf")).toContain(`type="continuous"`);
  });

  it("keeps links whose boxes overlap at rest from colliding, beyond parent and child", () => {
    // A shin, an ankle carrier on it, and a foot on the carrier whose box reaches up around the shin.
    const parts = [box("shin", [-10, -10, 50], [10, 10, 200]), box("carrier", [-5, -5, 40], [5, 5, 50]), box("foot", [-30, -60, 0], [30, 60, 80])];
    const joints: RobotJoint[] = [
      { id: "pitch", type: "revolute", a: "carrier", b: "shin", origin: [0, 0, 45], axis: [1, 0, 0] },
      { id: "roll", type: "revolute", a: "foot", b: "carrier", origin: [0, 0, 45], axis: [0, 1, 0] },
    ];
    const mj = text(writeRobot(parts, joints, [], { name: "leg" }).files, "leg.xml");
    expect(mj).toContain(`<exclude body1="shin" body2="foot"/>`);
    expect(mj.match(/<exclude /g)!.length).toBe(1);
  });

  it("names links and joints so simulators accept them", () => {
    const { parts, joints } = pendulum();
    const r = writeRobot(parts, joints.map((j) => (j.id === "hinge" ? { ...j, id: "hinge.turn" } : j)), [], { name: "n" });
    expect(r.links.find((l) => l.parts.includes("arm"))!.joint).toBe("hinge_turn");
  });

  it("fits a box to a box, along the model axes", () => {
    const s = fitCollisionShape(box("b", [0, 0, 0], [40, 20, 10]).mesh)!;
    expect(s.type).toBe("box");
    expect(s.center).toEqual([20, 10, 5]);
    expect(s.size).toEqual([20, 10, 5]);
    expect(s.rotation).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(s.fill).toBeCloseTo(1, 6);
  });

  it("fits a turned box with a turned box", () => {
    const s = fitCollisionShape(turnedZ(box("b", [-40, -10, 0], [40, 10, 10]).mesh, 30))!;
    expect(s.type).toBe("box");
    expect([...s.size].sort((a, b) => a - b).map((v) => +v.toFixed(3))).toEqual([5, 10, 40]);
    // The long side runs at 30° in the XY plane.
    const cols = [0, 1, 2].map((k) => [s.rotation[k]!, s.rotation[3 + k]!, s.rotation[6 + k]!]);
    const long = cols[s.size.indexOf(Math.max(...s.size))]!;
    expect(Math.abs(long[0]! * Math.cos(Math.PI / 6) + long[1]! * Math.sin(Math.PI / 6))).toBeCloseTo(1, 4);
  });

  it("fits a cylinder to a round part, along its axis", () => {
    const s = fitCollisionShape(cylinderMesh(15, 0, 60, 48, 5, -5))!;
    expect(s.type).toBe("cylinder");
    expect(s.size[0]).toBeCloseTo(15, 3);
    expect(s.size[1]).toBeCloseTo(30, 3);
    expect(s.center.map((v) => +v.toFixed(3))).toEqual([5, -5, 30]);
    expect(Math.abs(s.rotation[8]!)).toBeCloseTo(1, 6); // its Z is the model's Z
    expect(s.fill).toBeLessThan(1.01);
    // A flat disc too (a wheel): the axis is the short side.
    const wheel = fitCollisionShape(turnedZ(cylinderMesh(40, -4, 4), 0))!;
    expect(wheel.type).toBe("cylinder");
    expect(wheel.size[1]).toBeCloseTo(4, 3);
  });

  it("collides links with simple shapes in MJCF and URDF, meshes stay the visuals", () => {
    const parts = [box("base", [-50, -50, 0], [50, 50, 20]), { ...box("wheel", [0, 0, 0], [1, 1, 1]), mesh: cylinderMesh(30, 20, 30) }];
    const joints: RobotJoint[] = [{ id: "spin", type: "revolute", a: "wheel", b: "base", origin: [0, 0, 20], axis: [0, 0, 1] }];
    const r = writeRobot(parts, joints, [], { name: "w" });
    const mj = text(r.files, "w.xml");
    expect(mj).toContain(`<geom name="base" class="visual" type="mesh"`);
    expect(mj).toContain(`<geom name="base_collision" class="collision" type="box" size="0.05 0.05 0.01" pos="0 0 0.01" quat="1 0 0 0"/>`);
    // The wheel's frame is its joint at z 20 mm: its cylinder stands 5 mm above it.
    expect(attr(mj, "geom", "wheel_collision", "type")).toBe("cylinder");
    expect(attr(mj, "geom", "wheel_collision", "pos")).toBe("0 0 0.005");
    const [radius, half] = attr(mj, "geom", "wheel_collision", "size")!.split(" ").map(Number);
    expect(radius).toBeCloseTo(0.03, 5);
    expect(half).toBeCloseTo(0.005, 5);
    const ur = text(r.files, "w.urdf");
    expect(ur).toMatch(/<collision name="base_collision">\s*<origin xyz="0 0 0.01" rpy="0 0 0"\/>\s*<geometry><box size="0.1 0.1 0.02"\/><\/geometry>/);
    expect(ur).toMatch(/<collision name="wheel_collision">\s*<origin xyz="0 0 0.005" rpy="[^"]*"\/>\s*<geometry><cylinder radius="0.03" length="0.01"\/><\/geometry>/);
    expect(ur).toContain(`<mesh filename="meshes/wheel.stl"/>`); // the visual
    expect(ur.match(/<collision /g)!.length).toBe(2);
  });

  it("says which parts their shape fits badly, and collides with meshes on request", () => {
    // An L: two bars, its box three times its volume and more.
    const a = box("a", [0, 0, 0], [100, 10, 10]);
    const b = box("b", [0, 10, 0], [10, 100, 10]);
    const l: RobotPart = { ...a, id: "L", name: "Bracket", mesh: { positions: new Float32Array([...a.mesh.positions, ...b.mesh.positions]), indices: new Uint32Array([...a.mesh.indices, ...[...b.mesh.indices].map((i) => i + 8)]) } };
    expect(writeRobot([l], [], [], { name: "l" }).warnings.join(" ")).toMatch(/Bracket \(box, [\d.]+×\)/);
    const mesh = writeRobot([l], [], [], { name: "l", collision: "mesh" });
    expect(text(mesh.files, "l.urdf")).toMatch(/<collision name="L_collision">\s*<origin xyz="0 0 0" rpy="0 0 0"\/>\s*<geometry><mesh filename="meshes\/L.stl"\/>/);
    expect(text(mesh.files, "l.xml")).not.toContain("_collision");
    expect(mesh.warnings.join(" ")).not.toContain("poorly");
  });

  it("writes a turned shape's rotation the same way in MJCF and URDF", () => {
    const p = { ...box("bar", [0, 0, 0], [1, 1, 1]), mesh: turnedZ(box("x", [-40, -5, -5], [40, 5, 5]).mesh, 30) };
    const r = writeRobot([p], [], [], { name: "t" });
    const [w, , , z] = attr(text(r.files, "t.xml"), "geom", "bar_collision", "quat")!.split(" ").map(Number);
    const rpy = /<collision name="bar_collision">\s*<origin xyz="[^"]*" rpy="([^"]*)"/.exec(text(r.files, "t.urdf"))![1]!.split(" ").map(Number);
    // Both describe a turn about Z (by 30°, or 30° plus a half turn that maps the box onto itself).
    const turnMj = (2 * Math.atan2(z!, w!) * 180) / Math.PI;
    expect(Math.abs(rpy[0]!) % Math.PI).toBeCloseTo(0, 4);
    expect(Math.abs(rpy[1]!) % Math.PI).toBeCloseTo(0, 4);
    const mod = (v: number) => ((v % 180) + 180) % 180;
    expect(mod(turnMj)).toBeCloseTo(30, 2);
    expect(mod((rpy[2]! * 180) / Math.PI + (Math.abs(rpy[0]!) > 1 ? 180 : 0))).toBeCloseTo(30, 2);
  });

  it("loads in MuJoCo when it is installed", () => {
    const python = process.env["MUJOCO_PYTHON"] ?? "python3";
    try {
      execFileSync(python, ["-c", "import mujoco"], { stdio: "ignore" });
    } catch {
      return; // MuJoCo is optional on the build machine
    }
    const { parts, joints } = pendulum();
    const r = writeRobot(parts, joints, [], { name: "pendel", actuators: { hinge: { effort: 5, kp: 20 } } });
    const dir = mkdtempSync(join(tmpdir(), "meercad-robot-"));
    for (const [name, data] of Object.entries(r.files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), data);
    }
    const out = execFileSync(python, ["-c", `import mujoco;m=mujoco.MjModel.from_xml_path(${JSON.stringify(join(dir, "pendel.xml"))});d=mujoco.MjData(m);mujoco.mj_step(m,d);print(m.nbody,m.njnt,m.nu,round(float(m.body_subtreemass[1]),4))`]).toString().trim();
    // world, base, arm; free joint + hinge; one actuator; base 1000 g + arm 72 g
    expect(out).toBe("3 2 1 1.072");
  });

  it("says what it leaves out or makes up: joints on their own link, second movers, loose links, parts without mass", () => {
    const { parts, joints } = pendulum();
    const r = writeRobot(
      [...parts, box("loose", [300, 0, 0], [310, 10, 10]), { ...box("air", [400, 0, 0], [410, 10, 10]), mass: 0 }],
      [
        ...joints,
        // Turning the weight against the arm it is glued to: one link, nothing to turn.
        { id: "self", type: "revolute", a: "weight", b: "arm", origin: [0, 0, 200], axis: [1, 0, 0] },
        // A second joint moving the arm (already on the hinge).
        { id: "again", type: "slider", a: "arm", b: "base", origin: [0, 0, 0], axis: [0, 0, 1] },
        // A slider with no travel, on a carrier that is no part.
        { id: "rail", type: "slider", a: "carrier", b: "base", origin: [0, 0, 0], axis: [1, 0, 0] },
      ],
      [],
      { name: "w", actuators: { hinge: { effort: 1, friction: 0.2, damping: 0.1, armature: 0.001, kp: 10, kv: 1 } } },
    );
    const w = r.warnings.join("\n");
    expect(w).toMatch(/joint self moves a part on its own link/);
    expect(w).toMatch(/joint again: link .* already moves on joint hinge/);
    expect(w).toMatch(/links hang on nothing/);
    expect(w).toMatch(/link carrier has no parts \(a joint carrier\)/);
    expect(w).toMatch(/link air has no mass/);
    expect(w).toMatch(/slider rail has no travel; the URDF gets ±1 m/);
    expect(text(r.files, "w.xml")).toContain('frictionloss="0.2"');
    // Several roots: the URDF hangs the others on the first.
    expect(text(r.files, "w.urdf")).toMatch(/_floating" type="floating"/);
  });

  it("names parts that start with a digit or share a name", () => {
    const a = box("1st", [0, 0, 0], [10, 10, 10]);
    const b = { ...box("x", [20, 0, 0], [30, 10, 10]), name: "Box 1st" };
    const r = writeRobot([a, b], [], [], { name: "names", floating: false });
    const names = r.links.map((l) => l.name);
    expect(names.every((n) => /^[A-Za-z_]/.test(n))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("fits a sphere to a ball", () => {
    const n = 24;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= n; i++)
      for (let j = 0; j < 2 * n; j++) {
        const t = (Math.PI * i) / n, f = (Math.PI * j) / n;
        pos.push(10 * Math.sin(t) * Math.cos(f), 10 * Math.sin(t) * Math.sin(f), 10 * Math.cos(t));
      }
    for (let i = 0; i < n; i++)
      for (let j = 0; j < 2 * n; j++) {
        const a = i * 2 * n + j, b = i * 2 * n + ((j + 1) % (2 * n)), c = a + 2 * n, d = b + 2 * n;
        idx.push(a, c, b, b, c, d);
      }
    const s = fitCollisionShape({ positions: new Float32Array(pos), indices: new Uint32Array(idx) });
    expect(s?.type).toBe("sphere");
    expect(s!.size[0]).toBeCloseTo(10, 0);
  });
});

describe("collision shapes turned any way", () => {
  /** Row-major rotation matrix from a unit quaternion (w, x, y, z). */
  const fromQuat = ([w, x, y, z]: number[]) => [
    1 - 2 * (y! * y! + z! * z!), 2 * (x! * y! - z! * w!), 2 * (x! * z! + y! * w!),
    2 * (x! * y! + z! * w!), 1 - 2 * (x! * x! + z! * z!), 2 * (y! * z! - x! * w!),
    2 * (x! * z! - y! * w!), 2 * (y! * z! + x! * w!), 1 - 2 * (x! * x! + y! * y!),
  ];
  /** Row-major R = Rz(yaw)·Ry(pitch)·Rx(roll). */
  const fromRpy = ([r, p, y]: number[]) => {
    const [cr, sr, cp, sp, cy, sy] = [Math.cos(r!), Math.sin(r!), Math.cos(p!), Math.sin(p!), Math.cos(y!), Math.sin(y!)];
    return [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, -sp, cp * sr, cp * cr];
  };
  /** A 10 × 20 × 40 mm box about the origin, turned by the row-major matrix `m`. */
  const turnedBox = (m: number[]): RobotPart => {
    const p = box("p", [-5, -10, -20], [5, 10, 20]);
    const q = p.mesh.positions;
    for (let i = 0; i < q.length; i += 3) {
      const [x, y, z] = [q[i]!, q[i + 1]!, q[i + 2]!];
      for (let r = 0; r < 3; r++) q[i + r] = m[r * 3]! * x + m[r * 3 + 1]! * y + m[r * 3 + 2]! * z;
    }
    return p;
  };
  const turns: number[][] = [
    // Half turns about each axis (the quaternion's x, y or z part is the largest), a quarter turn
    // about Y (pitch ±90°: roll and yaw fold into one), and a few turns at odd angles.
    fromQuat([0, 1, 0, 0]), fromQuat([0, 0, 1, 0]), fromQuat([0, 0, 0, 1]),
    fromRpy([0, Math.PI / 2, 0]), fromRpy([0, -Math.PI / 2, 0.3]),
    fromRpy([0.4, 0.2, 2.9]), fromRpy([2.8, -0.3, 0.1]), fromRpy([-2.5, 0.6, -2.7]),
  ];

  /** A rod (radius 5, 60 long, along Z) turned by `m`. */
  const turnedRod = (m: number[]): RobotPart => {
    const p = box("p", [-5, -5, -30], [5, 5, 30]);
    const rod = cylinderMesh(5, -30, 30);
    const q = new Float32Array(rod.positions);
    for (let i = 0; i < q.length; i += 3) {
      const [x, y, z] = [rod.positions[i]!, rod.positions[i + 1]!, rod.positions[i + 2]!];
      for (let r = 0; r < 3; r++) q[i + r] = m[r * 3]! * x + m[r * 3 + 1]! * y + m[r * 3 + 2]! * z;
    }
    return { ...p, mesh: { positions: q, indices: rod.indices } };
  };
  // Rods tilted so the fitted cylinder's frame turns more than half way (each branch of the
  // quaternion's largest part), and one standing on its side (pitch 90°).
  const rods: number[][] = [fromRpy([0, -1.2, 0]), fromRpy([0, -1.2, -2.8]), fromRpy([0, 1.2, -1.5]), fromRpy([0, Math.PI / 2, 1.5]), fromRpy([0.4, Math.PI / 2, -1.5])];

  it.each([...turns.map((m, i) => ["box", i, m] as const), ...rods.map((m, i) => ["cylinder", i, m] as const)])("%s %i: MJCF's quaternion and URDF's roll-pitch-yaw both give the fitted shape's turn", (type, _, m) => {
    const part = type === "box" ? turnedBox(m) : turnedRod(m);
    const fit = fitCollisionShape(part.mesh)!;
    expect(fit.type).toBe(type);
    const files = writeRobot([part], [], [], { name: "t" }).files;
    const geom = /<geom name="[^"]*_collision"[^>]*quat="([^"]*)"/.exec(text(files, "t.xml"))!;
    const q = geom[1]!.split(" ").map(Number);
    const origin = /<collision[\s\S]*?<origin xyz="[^"]*" rpy="([^"]*)"/.exec(text(files, "t.urdf"))!;
    const rpy = origin[1]!.split(" ").map(Number);
    const a = fromQuat(q);
    const b = fromRpy(rpy);
    for (let k = 0; k < 9; k++) {
      expect(a[k]).toBeCloseTo(fit.rotation[k]!, 4);
      expect(b[k]).toBeCloseTo(fit.rotation[k]!, 4);
    }
    // The box's long side, the cylinder's axis, lies along the turned Z axis of the part.
    const longest = type === "cylinder" ? 2 : fit.size.indexOf(Math.max(...fit.size));
    const axis = [fit.rotation[longest]!, fit.rotation[3 + longest]!, fit.rotation[6 + longest]!];
    const want = [m[2]!, m[5]!, m[8]!];
    expect(Math.abs(axis[0]! * want[0]! + axis[1]! * want[1]! + axis[2]! * want[2]!)).toBeCloseTo(1, 4);
  });
});
