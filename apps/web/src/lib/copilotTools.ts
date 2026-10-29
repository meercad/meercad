/**
 * The copilot's tools: a few typed actions a small language model can use reliably (numbers in mm,
 * fixed choices), each turned into the same document ops an assistant would send over MCP. Pure:
 * document and rebuild report in, ops or text out, so the tools are tested against the real kernel.
 */
import { nextFeatureId } from "@meercad/model";
import type { DocOp, EdgeSelector, Feature, FaceSelector, MeercadDocument, SketchEntity } from "@meercad/schema";

export interface ToolParam {
  name: string;
  type: "number" | "integer" | "string" | "choice";
  description: string;
  options?: string[];
  optional?: boolean;
}
export interface ToolSpec {
  name: string;
  description: string;
  params: ToolParam[];
}

/** What the tools know about the built model. */
export interface ModelInfo {
  bodies: { id: string; name: string; bbox: { min: number[]; max: number[] } }[];
  params: Record<string, number>;
}

/** Tells the model what it is and how the world is laid out. Short: the on-device model has little room. */
export const INSTRUCTIONS = `You are the copilot in meerCAD, a CAD app for designing parts to 3D print. Change the model only with the tools. Lengths are millimetres. Z points up, the build plate is z = 0, x goes right, y goes back. Boxes and cylinders are centred on their x and y. Parts are named by ids like ex1; call describe_model for their sizes and positions before changing an existing part, and use those numbers (a box from x -20 to 20 has its middle at x 0; 5 mm taller than 15 is 20). Carry out every step the user asks for, one tool call after another, reading each result; do not stop to ask before the last one. Then reply briefly, saying what you did, always in the language of the user's latest message (German when they write German).`;

const where: ToolParam[] = [
  { name: "x", type: "number", description: "Centre x in mm (default 0)", optional: true },
  { name: "y", type: "number", description: "Centre y in mm (default 0)", optional: true },
  { name: "z", type: "number", description: "Height of the bottom in mm (default 0)", optional: true },
  { name: "mode", type: "choice", description: "new part (default), add to the part it touches, or cut it away", options: ["new", "add", "cut"], optional: true },
];
const part: ToolParam = { name: "part", type: "string", description: "Part id from describe_model, e.g. ex1" };
const edges: ToolParam = { name: "edges", type: "choice", description: "Which edges", options: ["all", "top", "bottom", "vertical"] };

export const TOOLS: ToolSpec[] = [
  { name: "describe_model", description: "Lists the parts (id, name, size, position) and variables.", params: [] },
  {
    name: "add_box",
    description: "Adds a box (cuboid) standing upright.",
    params: [
      { name: "width", type: "number", description: "Size along x in mm" },
      { name: "depth", type: "number", description: "Size along y in mm" },
      { name: "height", type: "number", description: "Size along z in mm" },
      ...where,
    ],
  },
  {
    name: "add_cylinder",
    description: "Adds an upright cylinder (round post, disc or rod).",
    params: [{ name: "diameter", type: "number", description: "Diameter in mm" }, { name: "height", type: "number", description: "Height in mm" }, ...where],
  },
  { name: "round_edges", description: "Rounds edges of a part (fillet).", params: [part, { name: "radius", type: "number", description: "Radius in mm" }, edges] },
  { name: "chamfer_edges", description: "Bevels edges of a part (chamfer).", params: [part, { name: "size", type: "number", description: "Chamfer size in mm" }, edges] },
  {
    name: "hollow",
    description: "Hollows a part out to walls of the given thickness, e.g. to make a box or cup.",
    params: [part, { name: "wall", type: "number", description: "Wall thickness in mm" }, { name: "open", type: "choice", description: "Which side stays open", options: ["top", "bottom", "closed"] }],
  },
  {
    name: "add_hole",
    description: "Drills a round hole straight down through everything at a spot.",
    params: [
      { name: "diameter", type: "number", description: "Hole diameter in mm" },
      { name: "x", type: "number", description: "Hole centre x in mm" },
      { name: "y", type: "number", description: "Hole centre y in mm" },
    ],
  },
  {
    name: "resize",
    description: "Changes the size of a box or cylinder made with add_box or add_cylinder. Give only what changes.",
    params: [
      part,
      { name: "width", type: "number", description: "New size along x in mm (boxes)", optional: true },
      { name: "depth", type: "number", description: "New size along y in mm (boxes)", optional: true },
      { name: "height", type: "number", description: "New height in mm", optional: true },
      { name: "diameter", type: "number", description: "New diameter in mm (cylinders)", optional: true },
    ],
  },
  {
    name: "move_part",
    description: "Moves a part by an offset.",
    params: [
      part,
      { name: "dx", type: "number", description: "Along x in mm", optional: true },
      { name: "dy", type: "number", description: "Along y in mm", optional: true },
      { name: "dz", type: "number", description: "Along z in mm", optional: true },
    ],
  },
  {
    name: "set_variable",
    description: "Sets a named variable (a value other features can use), e.g. wall = 2 mm.",
    params: [{ name: "name", type: "string", description: "Variable name" }, { name: "value", type: "string", description: "Value with unit or formula, e.g. 2 mm" }],
  },
  { name: "undo", description: "Undoes the last change.", params: [] },
  { name: "set_view", description: "Turns the camera to a standard view.", params: [{ name: "view", type: "choice", description: "View", options: ["iso", "top", "front", "right", "fit"] }] },
];

export type ToolPlan = { ops: DocOp[]; note: string } | { text: string } | { action: "undo" } | { action: "view"; view: string };

type Args = Record<string, unknown>;
const num = (a: Args, k: string, fallback?: number): number => {
  const v = a[k];
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  if (Number.isFinite(n)) return n;
  if (fallback !== undefined) return fallback;
  throw new Error(`${k} is missing`);
};
const str = (a: Args, k: string): string => {
  const v = a[k];
  if (typeof v !== "string" || !v.trim()) throw new Error(`${k} is missing`);
  return v.trim();
};
const mm = (n: number) => `${+n.toFixed(3)} mm`;
const fmt = (n: number) => `${+n.toFixed(1)}`;

/** Ids for several new features at once (each sees the ones before it). */
function ids(doc: MeercadDocument, ops: Feature["op"][]): string[] {
  const out: string[] = [];
  let d = doc;
  for (const op of ops) {
    const id = nextFeatureId(d, op);
    out.push(id);
    d = { ...d, features: [...d.features, { id, op } as Feature] };
  }
  return out;
}

function rectangle(prefix: string, cx: number, cy: number, w: number, d: number): SketchEntity[] {
  const p = (i: number) => `${prefix}p${i}`;
  const pts: [number, number][] = [[cx - w / 2, cy - d / 2], [cx + w / 2, cy - d / 2], [cx + w / 2, cy + d / 2], [cx - w / 2, cy + d / 2]];
  return [
    ...pts.map(([x, y], i): SketchEntity => ({ id: p(i + 1), type: "point", x, y })),
    ...[1, 2, 3, 4].map((i): SketchEntity => ({ id: `${prefix}${i}`, type: "line", p1: p(i), p2: p((i % 4) + 1) })),
  ];
}

/** A sketch (on the build plate or a plane at height z) extruded straight up. */
function solid(doc: MeercadDocument, a: Args, kind: "Box" | "Cylinder", entities: SketchEntity[], height: number): { ops: DocOp[]; id: string } {
  const z = num(a, "z", 0);
  const mode = ({ add: "join", cut: "cut" } as const)[String(a["mode"]) as "add" | "cut"] ?? "new_body";
  const [pl, sk, ex] = z ? ids(doc, ["plane", "sketch", "extrude"]) : ["", ...ids(doc, ["sketch", "extrude"])];
  const n = doc.features.filter((f) => f.name?.startsWith(kind)).length + 1;
  const features: Feature[] = [
    ...(z ? [{ id: pl!, op: "plane", base: { ref: "origin.XY" }, offset: mm(z) } as Feature] : []),
    { id: sk!, op: "sketch", plane: { ref: z ? pl! : "origin.XY" }, entities, constraints: [] },
    { id: ex!, name: `${kind} ${n}`, op: "extrude", profile: { sketch: sk! }, extent: "blind", distance: mm(height), mode },
  ];
  return { ops: [{ type: "add_features", features }], id: ex! };
}

function edgeSelector(p: string, which: string): EdgeSelector | EdgeSelector[] {
  switch (which) {
    case "top":
      return { select: "edges", of: p, where: { face: "end_cap" } };
    case "bottom":
      return { select: "edges", of: p, where: { face: "start_cap" } };
    case "vertical":
      return { edge: [`${p}.side[*]`, `${p}.side[*]`] };
    default:
      return { select: "edges", of: p };
  }
}

function needPart(info: ModelInfo, id: string): ModelInfo["bodies"][number] {
  const b = info.bodies.find((x) => x.id === id);
  if (!b) throw new Error(`there is no part "${id}"; parts: ${info.bodies.map((x) => x.id).join(", ") || "none"}`);
  return b;
}

export function describe(info: ModelInfo): string {
  const parts = info.bodies.map((b) => {
    const s = b.bbox.max.map((v, i) => v - b.bbox.min[i]!);
    return `${b.id} "${b.name}": ${s.map(fmt).join(" x ")} mm, from (${b.bbox.min.map(fmt).join(", ")}) to (${b.bbox.max.map(fmt).join(", ")})`;
  });
  const vars = Object.entries(info.params).map(([k, v]) => `${k} = ${fmt(v)}`);
  return `${parts.length ? `Parts:\n${parts.join("\n")}` : "No parts yet."}${vars.length ? `\nVariables: ${vars.join(", ")}` : ""}`;
}

/** What a tool call does to the document. Throws with a message the model can act on. */
export function planTool(name: string, a: Args, doc: MeercadDocument, info: ModelInfo): ToolPlan {
  switch (name) {
    case "describe_model":
      return { text: describe(info) };
    case "add_box": {
      const w = num(a, "width"), d = num(a, "depth"), h = num(a, "height");
      const x = num(a, "x", 0), y = num(a, "y", 0), z = num(a, "z", 0);
      const r = solid(doc, a, "Box", rectangle("b", x, y, w, d), h);
      return { ops: r.ops, note: `added box ${r.id}: ${fmt(w)} x ${fmt(d)} x ${fmt(h)} mm, x ${fmt(x - w / 2)} to ${fmt(x + w / 2)}, y ${fmt(y - d / 2)} to ${fmt(y + d / 2)}, z ${fmt(z)} to ${fmt(z + h)}` };
    }
    case "add_cylinder": {
      const dia = num(a, "diameter"), h = num(a, "height");
      const entities: SketchEntity[] = [
        { id: "cc", type: "point", x: num(a, "x", 0), y: num(a, "y", 0) },
        { id: "c1", type: "circle", center: "cc", radius: dia / 2 },
      ];
      const r = solid(doc, a, "Cylinder", entities, h);
      const z = num(a, "z", 0);
      return { ops: r.ops, note: `added cylinder ${r.id}: diameter ${fmt(dia)} mm, centre x ${fmt(num(a, "x", 0))}, y ${fmt(num(a, "y", 0))}, z ${fmt(z)} to ${fmt(z + h)}` };
    }
    case "round_edges":
    case "chamfer_edges": {
      const p = str(a, "part");
      needPart(info, p);
      const which = String(a["edges"] ?? "all");
      const size = num(a, name === "round_edges" ? "radius" : "size");
      const op = name === "round_edges" ? "fillet" : "chamfer";
      const [id] = ids(doc, [op]);
      const f = (op === "fillet" ? { id, op, edges: edgeSelector(p, which), radius: mm(size) } : { id, op, edges: edgeSelector(p, which), distance: mm(size) }) as Feature;
      return { ops: [{ type: "add_features", features: [f] }], note: `${op === "fillet" ? "rounded" : "chamfered"} ${which} edges of ${p} (${fmt(size)} mm)` };
    }
    case "hollow": {
      const p = str(a, "part");
      needPart(info, p);
      const open = String(a["open"] ?? "top");
      const faces: FaceSelector[] = open === "closed" ? [] : [{ face: `${p}.${open === "bottom" ? "start_cap" : "end_cap"}` }];
      const [id] = ids(doc, ["shell"]);
      return { ops: [{ type: "add_features", features: [{ id: id!, op: "shell", faces, thickness: mm(num(a, "wall")) }] }], note: `hollowed ${p} (walls ${fmt(num(a, "wall"))} mm, ${open})` };
    }
    case "add_hole": {
      const dia = num(a, "diameter"), x = num(a, "x"), y = num(a, "y");
      const [sk, ex] = ids(doc, ["sketch", "extrude"]);
      // Straight through everything, both ways from the build plate.
      const reach = Math.max(10, ...info.bodies.flatMap((b) => [...b.bbox.max, ...b.bbox.min].map(Math.abs))) * 2 + 10;
      const features: Feature[] = [
        { id: sk!, op: "sketch", plane: { ref: "origin.XY" }, entities: [{ id: "hc", type: "point", x, y }, { id: "h1", type: "circle", center: "hc", radius: dia / 2 }], constraints: [] },
        { id: ex!, name: `Hole ${dia}`, op: "extrude", profile: { sketch: sk! }, extent: "symmetric", distance: mm(reach), mode: "cut" },
      ];
      return { ops: [{ type: "add_features", features }], note: `drilled a ${fmt(dia)} mm hole at (${fmt(x)}, ${fmt(y)})` };
    }
    case "resize": {
      const p = str(a, "part");
      const ex = doc.features.find((f): f is Extract<Feature, { op: "extrude" }> => f.id === p && f.op === "extrude");
      const sk = ex && "sketch" in ex.profile ? doc.features.find((f): f is Extract<Feature, { op: "sketch" }> => f.id === (ex.profile as { sketch: string }).sketch && f.op === "sketch") : undefined;
      if (!ex || !sk) throw new Error(`${p} was not made with add_box or add_cylinder`);
      const ops: DocOp[] = [];
      const box = sk.entities.filter((e): e is Extract<SketchEntity, { type: "point" }> => e.type === "point" && /^bp[1-4]$/.test(e.id));
      const circle = sk.entities.find((e): e is Extract<SketchEntity, { type: "circle" }> => e.type === "circle");
      if (box.length === 4 && (a["width"] !== undefined || a["depth"] !== undefined)) {
        const xs = box.map((e) => e.x), ys = box.map((e) => e.y);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const w = num(a, "width", Math.max(...xs) - Math.min(...xs)), d = num(a, "depth", Math.max(...ys) - Math.min(...ys));
        ops.push({ type: "edit_feature", id: sk.id, patch: { entities: rectangle("b", cx, cy, w, d) } });
      }
      if (circle && a["diameter"] !== undefined) {
        ops.push({ type: "edit_feature", id: sk.id, patch: { entities: sk.entities.map((e) => (e.id === circle.id ? { ...circle, radius: num(a, "diameter") / 2 } : e)) } });
      }
      if (a["height"] !== undefined) ops.push({ type: "edit_feature", id: ex.id, patch: { distance: mm(num(a, "height")) } });
      if (!ops.length) throw new Error("give the new width, depth, height or diameter");
      const changed = ["width", "depth", "height", "diameter"].filter((k) => a[k] !== undefined).map((k) => `${k} ${fmt(num(a, k))} mm`);
      return { ops, note: `resized ${p}: ${changed.join(", ")}` };
    }
    case "move_part": {
      const p = str(a, "part");
      needPart(info, p);
      const t = [num(a, "dx", 0), num(a, "dy", 0), num(a, "dz", 0)];
      const [id] = ids(doc, ["transform"]);
      return { ops: [{ type: "add_features", features: [{ id: id!, op: "transform", bodies: [p], translate: t.map(mm) as [string, string, string] }] }], note: `moved ${p} by (${t.map(fmt).join(", ")}) mm` };
    }
    case "set_variable": {
      const n = str(a, "name").replace(/\s+/g, "_");
      return { ops: [{ type: "set_param", name: n, expr: str(a, "value") }], note: `set ${n} = ${str(a, "value")}` };
    }
    case "undo":
      return { action: "undo" };
    case "set_view":
      return { action: "view", view: String(a["view"] ?? "iso") };
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
