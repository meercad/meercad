import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeRobot, type RobotJoint, type RobotPart } from "./index.js";

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
});
