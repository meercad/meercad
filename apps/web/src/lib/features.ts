/** Labels, icons and default drafts for every feature type. */
import {
  ArrowUpFromLine,
  ArrowUpToLine,
  Bolt,
  Box,
  Cone,
  Magnet,
  Nut,
  Scaling,
  Pyramid,
  Scissors,
  Slash,
  Type,
  Spline,
  Cog,
  CircleDot,
  Combine,
  Copy,
  FileUp,
  Grid3x3,
  Layers,
  Pencil,
  Rotate3d,
  Shell,
  SquareRoundCorner,
  SquareSplitHorizontal,
  Triangle,
  Orbit,
  Shapes,
  Move3d,
  LayoutGrid,
  Grid2x2,
  Tag,
  Cuboid,
  Rainbow,
  PackageOpen,
  FishingHook,
  Dna,
  Screw,
  createLucideIcon,
  Image as ImageIcon,
  type LucideIcon, Trash2 } from "lucide-react";
import { type EdgeSelector, type Feature, type FeatureOp, type MeercadDocument } from "@meercad/schema";
import { nextFeatureId, standardShape } from "@meercad/model";
import { t } from "./i18n";

/** A coil spring (lucide has none). */
const Spring = createLucideIcon("spring", [["path", { d: "M8 3h8M16 3 7 7l10 3.5L7 14l10 3.5L8 21h8", key: "coil" }]]);

export interface FeatureMeta {
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  hint: string;
}

export const FEATURES: Record<FeatureOp, FeatureMeta> = {
  sketch: { label: t("Sketch"), icon: Pencil, shortcut: "S", hint: t("Draw a constrained 2D sketch on a plane or face") },
  extrude: { label: t("Extrude"), icon: ArrowUpFromLine, shortcut: "E", hint: t("Extrude sketch regions to add, cut or intersect") },
  revolve: { label: t("Revolve"), icon: Rotate3d, shortcut: "V", hint: t("Revolve sketch regions around an axis") },
  fillet: { label: t("Fillet"), icon: SquareRoundCorner, shortcut: "F", hint: t("Round edges") },
  chamfer: { label: t("Chamfer"), icon: Triangle, shortcut: "C", hint: t("Bevel edges") },
  shell: { shortcut: "H", label: t("Shell"), icon: Shell, hint: t("Hollow a body, removing selected faces") },
  thread: { shortcut: "T", label: t("Thread"), icon: Bolt, hint: t("ISO metric thread in a hole or on a shaft") },
  loft: { shortcut: "Shift+L", label: t("Loft"), icon: Cone, hint: t("Solid through two or more profiles: funnels, round-to-square adapters") },
  sweep: { shortcut: "W", label: t("Sweep"), icon: Spline, hint: t("Move a profile along a path of lines and arcs: pipes, ducts, handles") },
  scale: { label: t("Scale"), icon: Scaling, hint: t("Make parts larger or smaller, e.g. correct a scan to a measured size") },
  bend: { label: t("Bend"), icon: Rainbow, hint: t("Bend parts round an axis, wrap them into a ring or roll a long strip into a flat spiral") },
  align: { shortcut: "Shift+A", label: t("Align"), icon: Magnet, hint: t("Set a part's face onto another's, or a shaft's axis onto a hole's") },
  standard_part: { shortcut: "Shift+P", label: t("Standard part"), icon: Nut, hint: t("Screws, nuts, bearings, magnets, aluminium profiles, linear guides and lead screws to standard sizes, placed on a face") },
  lithophane: { label: t("Lithophane"), icon: ImageIcon, hint: t("A photo as a printable plate: a lithophane that shows the picture against the light, or a relief; flat, curved or as a lamp shade") },
  gridfinity: { label: t("Storage bin"), icon: LayoutGrid, hint: t("Bins and baseplates for the Gridfinity storage grid: compartments, scoops, label tabs, magnets; editable like any part") },
  box: { label: t("Box with lid"), icon: PackageOpen, hint: t("Printable box with a snap lid, or a round jar with a screw lid; box and lid as two parts with the right play") },
  snap_hook: { label: t("Snap hook"), icon: FishingHook, hint: t("Snap hooks on a face that click into a window in the other part, with the bending strain checked") },
  wall: { label: t("Wall storage"), icon: Grid2x2, hint: t("Boards for the wall (openGrid, pegboards) and holders that clip into them: hooks, rings, shelves, shelves for Gridfinity bins") },
  primitive: { label: t("Basic solid"), icon: Cuboid, hint: t("A box, cylinder or sphere without a sketch: stand-ins, quick assemblies, blocks to cut with") },
  label: { label: t("Label"), icon: Tag, hint: t("Printable label with a screw, nut or insert symbol and text, raised or engraved, in one or two colours") },
  text: { shortcut: "Shift+T", label: t("Text"), icon: Type, hint: t("Raised or engraved lettering on a face") },
  offset_face: { shortcut: "Shift+E", label: t("feature::Move face"), icon: ArrowUpToLine, hint: t("Move faces along their normals or up to a plane: thicker walls, tighter holes, a face flush with another") },
  draft: { shortcut: "Shift+D", label: t("feature::Draft"), icon: Pyramid, hint: t("Tilt side faces by an angle so a cast or moulded part leaves its mould") },
  rib: { shortcut: "Shift+B", label: t("Rib"), icon: Slash, hint: t("Stiffening web from an open sketch line to the walls it meets") },
  split: { shortcut: "Shift+K", label: t("Split"), icon: Scissors, hint: t("Cut parts in two at a plane or flat face, e.g. for the printer's build volume") },
  hole: { shortcut: "Shift+H", label: t("Hole"), icon: CircleDot, hint: t("Holes for screws (clearance, counterbore, countersink), threads and heat-set inserts") },
  coil: { label: t("Coil"), icon: Dna, hint: t("Sweep a profile along a helix round an axis: custom threads, coils, worms, spiral ramps") },
  spring: { label: t("Spring"), icon: Spring, hint: t("Compression, extension or torsion spring from wire, diameter and coils, with its spring rate") },
  screw: { label: t("Screw and nut"), icon: Screw, hint: t("Screw, threaded rod or nut of any size and thread form: metric, trapezoidal, square, buttress, round, multi-start") },
  gear: { shortcut: "G", label: t("Gear"), icon: Cog, hint: t("Involute gear, ring gear or rack; adds the mating gear at the right distance") },
  linear_pattern: { shortcut: "L", label: t("Linear pattern"), icon: Grid3x3, hint: t("Repeat features or bodies along a direction") },
  circular_pattern: { shortcut: "O", label: t("Circular pattern"), icon: Orbit, hint: t("Repeat features or bodies around an axis") },
  mirror: { shortcut: "I", label: t("Mirror"), icon: SquareSplitHorizontal, hint: t("Mirror features or bodies about a plane") },
  transform: { shortcut: "M", label: t("Move"), icon: Move3d, hint: t("Move, rotate or copy parts") },
  boolean: { shortcut: "B", label: t("Boolean"), icon: Combine, hint: t("Union, subtract or intersect bodies") },
  plane: { shortcut: "N", label: t("Plane"), icon: Layers, hint: t("Construction plane offset from a plane or face") },
  delete: { label: t("Delete part"), icon: Trash2, hint: t("Remove parts from the model") },
  import: { label: t("Import"), icon: FileUp, hint: t("Import STEP or STL") },
  mesh_convert: { label: t("Convert mesh"), icon: Shapes, hint: t("Turn an imported mesh into a body with editable faces") },
};

export const BODY_ICON = Box;
export const COPY_ICON = Copy;

export const TOOLBAR: FeatureOp[] = ["sketch", "extrude", "revolve", "loft", "sweep", "coil", "rib", "primitive", "text", "standard_part", "screw", "spring", "gridfinity", "wall", "label", "box", "snap_hook", "lithophane", "fillet", "chamfer", "shell", "draft", "offset_face", "thread", "hole", "split", "gear", "transform", "align", "scale", "bend", "linear_pattern", "circular_pattern", "mirror", "boolean", "plane"];

/** A new feature with sensible defaults; selections start empty and are filled from the viewport. */
export function draftFeature(op: FeatureOp, doc: MeercadDocument): Feature {
  const id = nextFeatureId(doc, op);
  const lastSketch = [...doc.features].reverse().find((f) => f.op === "sketch");
  const lastSketchUsed = lastSketch && sketchesUsed(doc.features).has(lastSketch.id);
  const profile = lastSketch && !lastSketchUsed ? { sketch: lastSketch.id } : { sketch: "" };
  const noEdges: EdgeSelector[] = [];
  switch (op) {
    case "sketch":
      return { id, op, plane: { ref: "origin.XY" }, entities: [], constraints: [] };
    case "extrude":
      return { id, op, profile, extent: "blind", distance: 10, mode: doc.features.some((f) => f.op === "extrude" || f.op === "revolve" || f.op === "import") ? "join" : "new_body" };
    case "revolve":
      return { id, op, profile, axis: { ref: "origin.Z" }, angle: 360, mode: "new_body" };
    case "fillet":
      return { id, op, edges: noEdges, radius: 2 };
    case "chamfer":
      return { id, op, edges: noEdges, distance: 1 };
    case "shell":
      return { id, op, faces: [], thickness: 2 };
    case "thread":
      // Printed threads fit with half the design's fit on their flanks (it can be set to 0 for cut threads).
      return { id, op, face: { face: "" }, clearance: "fit / 2" };
    case "coil":
      return { id, op, profile, axis: { ref: "origin.Z" }, pitch: 5, turns: 5, mode: doc.features.some((f) => f.op === "extrude" || f.op === "revolve" || f.op === "import") ? "join" : "new_body" };
    case "spring":
      return { id, op, kind: "compression", wire: 1.5, diameter: 15, coils: 6, length: 40, plane: { ref: "origin.XY" }, mode: "new_body" };
    case "screw":
      return { id, op, kind: "screw", head: "hex", diameter: 8, length: 25, plane: { ref: "origin.XY" }, mode: "new_body" };
    case "gear":
      return { id, op, kind: "spur", module: 1.5, teeth: 20, width: 8, plane: { ref: "origin.XY" }, mode: "new_body" };
    case "linear_pattern":
      return { id, op, source: { features: [] }, direction: { ref: "origin.X" }, count: 3, spacing: 20 };
    case "circular_pattern":
      return { id, op, source: { features: [] }, axis: { ref: "origin.Z" }, count: 6 };
    case "mirror":
      return { id, op, source: { features: [] }, plane: { ref: "origin.YZ" } };
    case "boolean":
      return { id, op, operation: "union", target: "", tools: [] };
    case "transform":
      return { id, op, bodies: [], translate: [0, 0, 0] };
    case "delete":
      return { id, op, bodies: [] };
    case "plane":
      return { id, op, base: { ref: "origin.XY" }, offset: 20 };
    case "import":
      return { id, op, format: "step", fileName: "", data: "" };
    case "mesh_convert":
      return { id, op, body: "" };
    case "loft":
      return { id, op, profiles: [], mode: doc.features.some((f) => f.op === "extrude" || f.op === "revolve" || f.op === "loft" || f.op === "sweep" || f.op === "import") ? "join" : "new_body" };
    case "sweep":
      return { id, op, profile, path: { sketch: "" }, mode: doc.features.some((f) => f.op === "extrude" || f.op === "revolve" || f.op === "loft" || f.op === "sweep" || f.op === "import") ? "join" : "new_body" };
    case "scale":
      return { id, op, bodies: [], factor: 1 };
    case "bend":
      return { id, op, bodies: [], mode: "spiral", axis: { ref: "origin.Z" }, radius: 20, gap: 1 };
    case "align":
      return { id, op, from: { face: { face: "" } }, to: { face: { face: "" } } };
    case "standard_part":
      return { id, op, kind: "socket_screw", size: "M3", length: 10, plane: { ref: "origin.XY" }, points: [] } as unknown as Feature;
    case "gridfinity": {
      // A new bin goes into the last baseplate, beside the bins already in it.
      const plate = [...doc.features].reverse().find((f): f is Extract<Feature, { op: "gridfinity" }> => f.op === "gridfinity" && f.kind === "baseplate");
      if (plate) return { id, op, kind: "bin", units: [1, 1], height: 3, baseplate: plate.id, cell: freeCell(doc, plate) };
      return { id, op, kind: "bin", units: [2, 1], height: 3, dividers: [3, 0], scoop: 10, tab: {} };
    }
    case "wall": {
      // A new holder goes onto the last board, beside the holders already on it.
      const board = [...doc.features].reverse().find((f): f is Extract<Feature, { op: "wall" }> => f.op === "wall" && f.kind === "board");
      if (board) return { id, op, system: board.system, kind: "holder", units: [1, 1], accessory: "hook", board: board.id, cell: freeWallCell(doc, board) };
      return { id, op, system: "opengrid", kind: "board", units: [4, 4] };
    }
    case "label":
      return { id, op, text: "M3×10", symbol: "screw_socket" };
    case "primitive":
      return { id, op, shape: "box", size: [20, 20, 20], center: [0, 0, 10], mode: doc.features.some((f) => f.op === "extrude" || f.op === "revolve" || f.op === "import" || f.op === "primitive") ? "join" : "new_body" };
    case "box":
      return { id, op, lid: "snap", width: 80, depth: 60, height: 40 };
    case "snap_hook":
      return { id, op, plane: { ref: "origin.XY" }, points: [] };
    case "lithophane":
      // The photo comes from the dialog; until then the step has nothing to build.
      return { id, op, image: { width: 1, height: 1, pixels: "" }, width: 100 };
    case "text":
      return { id, op, plane: { ref: "origin.XY" }, text: "meerCAD", size: 8, depth: 1, mode: doc.features.some((f) => f.op === "extrude" || f.op === "revolve" || f.op === "import") ? "join" : "new_body" };
    case "draft":
      return { id, op, faces: [], angle: 3, neutral: { ref: "origin.XY" } };
    case "offset_face":
      return { id, op, faces: [], distance: 1 };
    case "rib":
      return { id, op, sketch: lastSketch && !lastSketchUsed ? lastSketch.id : "", thickness: 3 };
    case "split":
      return { id, op, plane: { ref: "origin.YZ" }, bodies: [] };
    case "hole":
      return { id, op, plane: { ref: "origin.XY" }, points: [], kind: "clearance", size: "M3" } as unknown as Feature;
  }
}

/** The first cell of a wall board that no holder covers yet (top row first, left to right), or [0, 0]. */
function freeWallCell(doc: MeercadDocument, board: Extract<Feature, { op: "wall" }>): [number, number] {
  const n = (e: unknown, d: number) => (typeof e === "number" ? e : d);
  const [bx, by] = [n(board.units[0], 1), n(board.units[1], 1)];
  const taken = new Set<string>();
  for (const f of doc.features)
    if (f.op === "wall" && f.board === board.id) {
      const [ci, cj] = [n(f.cell?.[0], 0), n(f.cell?.[1], 0)];
      for (let i = 0; i < n(f.units?.[0], 1); i++) for (let j = 0; j < n(f.units?.[1], 1); j++) taken.add(`${ci + i},${cj + j}`);
    }
  for (let j = by - 1; j >= 0; j--) for (let i = 0; i < bx; i++) if (!taken.has(`${i},${j}`)) return [i, j];
  return [0, 0];
}

/** The first cell of a baseplate that no bin stands on yet (row by row), or [0, 0] when it is full. */
function freeCell(doc: MeercadDocument, plate: Extract<Feature, { op: "gridfinity" }>): [number, number] {
  const n = (e: unknown, d: number) => (typeof e === "number" ? e : d);
  const [px, py] = plate.drawer || !plate.units ? [0, 0] : [n(plate.units[0], 1), n(plate.units[1], 1)];
  const taken = new Set<string>();
  for (const f of doc.features)
    if (f.op === "gridfinity" && f.baseplate === plate.id) {
      const [ci, cj] = [n(f.cell?.[0], 0), n(f.cell?.[1], 0)];
      for (let i = 0; i < n(f.units?.[0], 1); i++) for (let j = 0; j < n(f.units?.[1], 1); j++) taken.add(`${ci + i},${cj + j}`);
    }
  for (let j = 0; j < py; j++) for (let i = 0; i < px; i++) if (!taken.has(`${i},${j}`)) return [i, j];
  return [0, 0];
}

/** Why a draft cannot be built yet (missing selections), or null. */
export function draftProblem(f: Feature): string | null {
  switch (f.op) {
    case "extrude":
    case "revolve":
      return "face" in f.profile || f.profile.sketch ? null : t("Select sketch regions or a face as profile");
    case "fillet":
    case "chamfer":
      return (Array.isArray(f.edges) ? f.edges.length : 1) ? null : t("Select edges");
    case "shell":
      return f.faces.length ? null : t("Select faces to remove");
    case "thread":
      return "face" in f.face && !f.face.face ? t("Select a hole wall or a round shaft") : null;
    case "linear_pattern":
    case "circular_pattern":
    case "mirror":
      return ("features" in f.source ? f.source.features : f.source.bodies).length ? null : t("Select features or bodies to copy");
    case "boolean":
      return !f.target ? t("Select the target body") : f.tools.length ? null : t("Select tool bodies");
    case "transform":
      return f.bodies.length ? null : t("Select parts to move");
    case "delete":
      return f.bodies.length ? null : t("Select parts to delete");
    case "import":
      return f.data ? null : t("Choose a file");
    case "mesh_convert":
      return f.body ? null : t("Select a mesh part");
    case "gridfinity":
      return f.pocket && !f.pocket.body ? t("Pick the part the bin should hold") : null;
    case "scale":
      return f.bodies.length ? null : t("Pick the parts to scale");
    case "bend":
      return f.bodies.length ? null : t("Pick the parts to bend");
    case "align": {
      const empty = (s: Feature & { op: "align" }, k: "from" | "to") => {
        const v = s[k];
        const sel = "face" in v ? v.face : v.axisOf;
        return "face" in sel && !sel.face;
      };
      return empty(f, "from") ? t("Pick the face of the part to move") : empty(f, "to") ? t("Pick the face to set it onto") : null;
    }
    case "standard_part":
      return f.points.length ? null : t("Tap a flat face where the part goes");
    case "draft":
      return f.faces.length ? null : t("Pick the side faces to draft");
    case "offset_face":
      return f.faces.length ? null : t("Pick the faces to move");
    case "rib":
      return f.sketch ? null : t("Pick the rib's line in a sketch");
    case "loft":
      return f.profiles.length >= 2 ? null : t("Pick at least two profiles in order: sketch regions or flat faces");
    case "coil":
      return "face" in f.profile || f.profile.sketch ? null : t("Pick the profile: sketch regions beside the axis");
    case "sweep":
      return !("face" in f.profile) && !f.profile.sketch ? t("Pick the profile: sketch regions") : f.path.sketch ? null : t("Pick the path: lines and arcs of a sketch");
    case "hole":
      return f.points.length ? null : t("Tap a flat face where the hole goes");
    case "snap_hook":
      return f.points.length ? null : t("Tap a flat face where the hook stands");
    case "lithophane":
      return f.image.pixels ? null : t("Choose a photo");
    default:
      return null;
  }
}

/** Names of the wall holders' accessories. */
export const WALL_ACCESSORIES: Record<NonNullable<Extract<Feature, { op: "wall" }>["accessory"]>, string> = {
  plain: t("Plate"),
  hook: t("Hook"),
  ring: t("Ring holder"),
  shelf: t("Shelf"),
  bin: t("Bin shelf"),
  screw: t("Screw snap"),
};

export function featureName(f: Feature): string {
  if (!f.name && f.op === "standard_part") {
    // A standard part is named by what it is, e.g. "M3×12 ISO 4762".
    try {
      const length = typeof f.length === "number" ? f.length : undefined;
      const diameter = typeof f.diameter === "number" ? f.diameter : undefined;
      const height = typeof f.height === "number" ? f.height : undefined;
      const shape = standardShape(f.kind, { size: f.size, length, diameter, height });
      return shape.labelText ? t(shape.labelText.text, shape.labelText.values) : shape.label;
    } catch {
      // Falls through to the generic name.
    }
  }
  // Bins and baseplates by their size ("Bin 2×1×3", "Baseplate 4×3"), labels by their text.
  if (!f.name && f.op === "gridfinity" && f.pocket && !f.units) return t("Bin for a part");
  if (!f.name && f.op === "gridfinity" && typeof f.units?.[0] === "number" && typeof f.units[1] === "number")
    return f.kind === "bin" ? `${t("Bin")} ${f.units[0]}×${f.units[1]}×${typeof f.height === "number" ? f.height : 3}` : f.drawer || f.outline ? `${t("Baseplate")} ${f.id.replace(/^\D+/, "")}` : `${t("Baseplate")} ${f.units[0]}×${f.units[1]}`;
  // Boxes by their size ("Box 80×60×40", "Jar ⌀60×50").
  if (!f.name && f.op === "box" && typeof f.width === "number" && typeof f.height === "number")
    return f.lid === "screw" || f.shape === "round"
      ? `${t(f.lid === "screw" ? "Jar" : "Round box")} ⌀${f.width}×${f.height}`
      : `${t("Box")} ${f.width}×${typeof f.depth === "number" ? f.depth : f.width}×${f.height}`;
  // Wall boards by system and size ("openGrid 4×4", "Pegboard 6×4"), holders by what they hold ("Hook 1×1").
  if (!f.name && f.op === "wall" && typeof f.units[0] === "number" && typeof f.units[1] === "number") {
    const size = `${f.units[0]}×${f.units[1]}`;
    if (f.kind === "board") return `${f.system === "opengrid" ? "openGrid" : t("Pegboard")} ${size}`;
    return `${WALL_ACCESSORIES[f.accessory ?? "hook"]} ${size}`;
  }
  if (!f.name && f.op === "label" && f.text?.trim()) return `${t("Label")} ${f.text.trim().split("\n")[0]}`;
  if (f.name) return f.name;
  // "Extrude 3" from ex3; an id without a number (an assistant's "base", "lid") is shown as it is,
  // so two such parts are not both just "Extrude".
  const n = f.id.replace(/^\D+/, "");
  return `${FEATURES[f.op].label} ${n || f.id}`;
}

/**
 * A part's name: the feature that made it ("Extrude 1"), with the copy number for pattern and
 * copy results ("Linear pattern 3 (2)"). Part ids are the making feature's id plus "_…" for copies.
 */
export function partName(id: string, features: readonly Feature[]): string {
  let best: Feature | undefined;
  for (const f of features)
    if ((id === f.id || id.startsWith(`${f.id}_`)) && f.id.length > (best?.id.length ?? 0)) best = f;
  if (!best) return id;
  const rest = id.slice(best.id.length + 1);
  if (!rest) return featureName(best);
  // A rail's carriage, a lead screw's nut: named by what they are ("MGN12C carriage").
  const moving = /^(?:(\d+)_)?(carriage|nut)$/.exec(rest);
  if (moving && best.op === "standard_part") {
    try {
      const m = standardShape(best.kind, { size: best.size, moving: true }).moving;
      if (m) return `${m.shape.labelText ? t(m.shape.labelText.text, m.shape.labelText.values) : m.label}${moving[1] ? ` (${moving[1]})` : ""}`;
    } catch {
      // the generic name below
    }
  }
  // Inserts a hole places in itself: named by what they are ("M3×5.7 heat-set insert (2)").
  const insert = /^insert(?:_(\d+))?$/.exec(rest);
  if (insert && best.op === "hole" && best.kind === "insert") {
    try {
      const s = standardShape("insert", { size: best.size, length: typeof best.length === "number" ? best.length : undefined });
      return `${s.labelText ? t(s.labelText.text, s.labelText.values) : s.label}${insert[1] ? ` (${insert[1]})` : ""}`;
    } catch {
      // the generic name below
    }
  }
  if (best.op === "box" && rest === "lid") return t("Lid of {name}", { name: featureName(best) });
  if (/^\d+$/.test(rest)) return `${featureName(best)} (${rest})`;
  // Copies of several parts carry the copied part's id: "lp1_ex2_3".
  const [, of, n] = /^(.*?)(?:_(\d+))?$/.exec(rest)!;
  return `${featureName(best)} (${partName(of!, features)}${n ? ` ${n}` : ""})`;
}

const FASTENERS = new Set(["socket_screw", "countersunk_screw", "hex_screw", "set_screw", "hex_nut", "washer", "insert", "t_nut"]);

/**
 * Whether a part is a fastener: a screw, nut, washer or insert (a standard part, a screw, an insert
 * a hole places), or a copy of one by a pattern or mirror. Checks of moving designs leave them out
 * on request: every screw in its thread showed up as a collision (Emil, 560 parts, 2026-11-11).
 */
export function isFastener(id: string, features: readonly Feature[]): boolean {
  let best: Feature | undefined;
  for (const f of features) if ((id === f.id || id.startsWith(`${f.id}_`)) && f.id.length > (best?.id.length ?? 0)) best = f;
  if (!best) return false;
  if (best.op === "screw") return true;
  if (best.op === "standard_part") return FASTENERS.has(best.kind);
  const rest = id.slice(best.id.length + 1);
  if (best.op === "hole") return /^insert(?:_\d+)?$/.test(rest);
  // A copy carries the copied part's id: "lp1_ex2_3" is a copy of ex2.
  const of = /^(.*?)(?:_\d+)?$/.exec(rest)?.[1];
  return !!of && of !== id && isFastener(of, features);
}

/** Sketches that a feature builds on (they are hidden once used, like a consumed profile). */
export function sketchesUsed(features: readonly Feature[]): Set<string> {
  return new Set(
    features.flatMap((f) => {
      if (f.op === "extrude" || f.op === "revolve" || f.op === "coil") return "sketch" in f.profile ? [f.profile.sketch] : [];
      if (f.op === "rib") return [f.sketch];
      if (f.op === "loft") return f.profiles.flatMap((p) => ("sketch" in p ? [p.sketch] : []));
      if (f.op === "sweep") return ["sketch" in f.profile ? f.profile.sketch : "", f.path.sketch].filter(Boolean);
      return [];
    }),
  );
}
