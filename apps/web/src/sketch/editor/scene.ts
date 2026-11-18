/** The sketch in the 3D view: curves, points, regions, previews, snap markers and dimension lines. */
import type { SketchFeature } from "@meercad/schema";
import {
  distance2,
  splinePoints,
  type findRegions,
  type SolvedCurve,
  type SolvedSketch,
  type Vec2,
} from "@meercad/sketch";
import type { SectionChain } from "@meercad/kernel/fit";
import { fatLine, frameMatrix, SKETCH_LINE_WIDTH, THREE, type Viewport } from "@meercad/viewport";
import { sameSel, type SketchSel, type SketchTool } from "../state";
import { arcPoints, arcRays, type AngleArc, type Segment } from "../../lib/angleDim";
import { angleOf, arcThrough, curveSamples, dimensionGeometry, pointEntries, refsOf } from "./geometry";
import type { Snap } from "./types";

export const COLORS = {
  under: 0x1f6fe5,
  full: 0x16a34a,
  construction: 0x8aa4c8,
  external: 0xa35cff,
  sel: 0xff7a1a,
  hover: 0x2e7dff,
  preview: 0x1a5fd6,
  conflict: 0xd93f3f,
  snap: 0xf08c00,
  guide: 0x8a94a6,
  section: 0xe8590c,
};

let dotTex: THREE.Texture | null = null;

function dotTexture(): THREE.Texture {
  if (dotTex) return dotTex;

  const element = document.createElement("canvas");
  element.width = element.height = 32;

  const g = element.getContext("2d")!;
  g.fillStyle = "#fff";
  g.beginPath();
  g.arc(16, 16, 14, 0, Math.PI * 2);
  g.fill();
  dotTex = new THREE.CanvasTexture(element);

  return dotTex;
}

function curveObject(curve: SolvedCurve, color: number, dashed: boolean): THREE.Object3D {
  const pts = curveSamples(curve.kind === "line" ? curve : { ...curve }).map(
    ([x, y]) => new THREE.Vector3(x, y, 0),
  );

  if (curve.kind === "circle" || curve.kind === "arc") {
    const n = 96;
    const [a0, sw] =
      curve.kind === "circle"
        ? [0, 2 * Math.PI]
        : [curve.a0, (curve.a1 - curve.a0 + 4 * Math.PI) % (2 * Math.PI) || 2 * Math.PI];
    pts.length = 0;

    for (let i = 0; i <= n; i++) {
      pts.push(
        new THREE.Vector3(
          curve.center[0] + curve.radius * Math.cos(a0 + (sw * i) / n),
          curve.center[1] + curve.radius * Math.sin(a0 + (sw * i) / n),
          0,
        ),
      );
    }
  }

  const line = fatLine(pts, {
    color,
    width: dashed ? 1.75 : SKETCH_LINE_WIDTH,
    ...(dashed ? { dashed: { dash: 2, gap: 1.2 } } : {}),
  });
  line.renderOrder = 28;

  return line;
}

/** The shape the tool would draw now, from the points placed so far to the cursor. */
export function previewObjects(
  tool: SketchTool,
  ts: { points: Snap[]; cursor: Vec2 | null; sweep: number },
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const cur = ts.cursor;
  if (!cur) return out;

  const line = (pts: Vec2[], loop = false) => {
    const o = fatLine(pts, { color: COLORS.preview, width: 2, loop });
    o.renderOrder = 40;
    out.push(o);
  };

  const p0 = ts.points[0]?.pos;
  if (!p0) return out;
  if (tool === "line") line([p0, cur]);
  if (tool === "spline") line(splinePoints([...ts.points.map((snap) => snap.pos), cur]));
  if (tool === "rect") line([p0, [cur[0], p0[1]], cur, [p0[0], cur[1]]], true);

  if (tool === "rect_center") {
    line(
      [
        [2 * p0[0] - cur[0], 2 * p0[1] - cur[1]],
        [cur[0], 2 * p0[1] - cur[1]],
        cur,
        [2 * p0[0] - cur[0], cur[1]],
      ],
      true,
    );
  }

  if (tool === "select") line([p0, [cur[0], p0[1]], cur, [p0[0], cur[1]]], true);

  if (tool === "polygon") {
    const r = distance2(p0, cur);
    const a0 = Math.atan2(cur[1] - p0[1], cur[0] - p0[0]);
    line(
      Array.from(
        { length: 6 },
        (_, i) =>
          [
            p0[0] + r * Math.cos(a0 + (i * Math.PI) / 3),
            p0[1] + r * Math.sin(a0 + (i * Math.PI) / 3),
          ] as Vec2,
      ),
      true,
    );
  }

  if (tool === "arc" && ts.points.length === 1) line([p0, cur]);

  if (tool === "arc" && ts.points.length === 2) {
    const g = arcThrough(p0, ts.points[1]!.pos, cur);

    if (!g) {
      line([p0, ts.points[1]!.pos]);
    } else {
      const a0 = Math.atan2(g.start[1] - g.center[1], g.start[0] - g.center[0]);
      line(
        Array.from(
          { length: 65 },
          (_, i) =>
            [
              g.center[0] + g.radius * Math.cos(a0 + (g.sweep * i) / 64),
              g.center[1] + g.radius * Math.sin(a0 + (g.sweep * i) / 64),
            ] as Vec2,
        ),
      );
    }
  }

  if (tool === "circle" || (tool === "arc_center" && ts.points.length === 1)) {
    const r = distance2(p0, cur);
    line(
      Array.from(
        { length: 65 },
        (_, i) =>
          [
            p0[0] + r * Math.cos((i / 64) * 2 * Math.PI),
            p0[1] + r * Math.sin((i / 64) * 2 * Math.PI),
          ] as Vec2,
      ),
    );
  }

  if (tool === "arc_center" && ts.points.length === 2) {
    const s = ts.points[1]!.pos;
    const r = distance2(p0, s);
    const a0 = Math.atan2(s[1] - p0[1], s[0] - p0[0]);
    line(
      Array.from(
        { length: 65 },
        (_, i) =>
          [
            p0[0] + r * Math.cos(a0 + (ts.sweep * i) / 64),
            p0[1] + r * Math.sin(a0 + (ts.sweep * i) / 64),
          ] as Vec2,
      ),
    );
  }

  return out;
}

/**
 * Marker for what the cursor snapped to (square = endpoint, triangle = midpoint, X = crossing), plus
 * alignment guides.
 */
export function snapObjects(snap: Snap, unit: number): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const [x, y] = snap.pos;
  const r = unit * 5;

  const add = (pts: Vec2[], kind: "loop" | "segments" | "line", color: number, dashed = false) => {
    const g = new THREE.BufferGeometry().setFromPoints(pts.map(([a, b]) => new THREE.Vector3(a, b, 0)));
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: unit * 5, gapSize: unit * 4, depthTest: false })
      : new THREE.LineBasicMaterial({ color, depthTest: false });
    const o =
      kind === "loop"
        ? new THREE.LineLoop(g, mat)
        : kind === "segments"
          ? new THREE.LineSegments(g, mat)
          : new THREE.Line(g, mat);
    if (dashed) o.computeLineDistances();

    o.renderOrder = 45;
    out.push(o);
  };

  for (const [a, b] of snap.guides ?? []) add([a, b], "line", COLORS.guide, true);

  // The landing point itself: a dot with a light halo so it reads on the grid, the model and lines.
  const onGeometry = snap.kind && snap.kind !== "grid";

  for (const [size, color] of [
    [13, 0xffffff],
    [8, onGeometry ? COLORS.snap : COLORS.preview],
  ] as const) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([x, y, 0], 3));

    const dot = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        size,
        color,
        sizeAttenuation: false,
        depthTest: false,
        map: dotTexture(),
        transparent: true,
        alphaTest: 0.5,
      }),
    );
    dot.renderOrder = size === 13 ? 46 : 47;
    out.push(dot);
  }

  switch (snap.kind) {
    case "point":
      add(
        [
          [x - r, y - r],
          [x + r, y - r],
          [x + r, y + r],
          [x - r, y + r],
        ],
        "loop",
        COLORS.snap,
      );
      break;
    case "mid":
      add(
        [
          [x, y + r * 1.2],
          [x - r * 1.1, y - r * 0.7],
          [x + r * 1.1, y - r * 0.7],
        ],
        "loop",
        COLORS.snap,
      );
      break;
    case "cross":
      add(
        [
          [x - r, y - r],
          [x + r, y + r],
          [x - r, y + r],
          [x + r, y - r],
        ],
        "segments",
        COLORS.snap,
      );
      break;
    case "curve":
    case "edge":
    case "align":
      add(
        [
          [x, y - r],
          [x + r, y],
          [x, y + r],
          [x - r, y],
        ],
        "loop",
        COLORS.snap,
      );
      break;
    case "center": {
      const ring: Vec2[] = Array.from({ length: 20 }, (_, i) => [
        x + r * Math.cos((i / 20) * 2 * Math.PI),
        y + r * Math.sin((i / 20) * 2 * Math.PI),
      ]);
      add(ring, "loop", COLORS.snap);
      add(
        [
          [x - r * 1.6, y],
          [x + r * 1.6, y],
          [x, y - r * 1.6],
          [x, y + r * 1.6],
        ],
        "segments",
        COLORS.snap,
      );
      break;
    }
  }

  return out;
}

export function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();

    const mat = m.material as THREE.Material | undefined;
    if (mat && !Array.isArray(mat)) mat.dispose();
  });
  g.clear();
}

/** What the sketch shows apart from the tool's preview. */
export interface SketchScene {
  sketch: SketchFeature | undefined;
  shown: SolvedSketch;
  regions: ReturnType<typeof findRegions>;
  sections: SectionChain[];
  /** The section the section tool would trace (drawn bold), or -1. */
  hotSection: number;
  selection: SketchSel[];
  hover: SketchSel | null;
}

/** Adds the sketch to `group`: regions, mesh sections, curves, then points. */
export function drawSketch(group: THREE.Group, scene: SketchScene) {
  const full = scene.shown.diagnostics.dof === 0 && scene.shown.diagnostics.ok;
  drawRegions(group, scene.regions);
  drawSections(group, scene.sections, scene.hotSection);
  drawCurves(group, scene, full);
  drawPoints(group, scene, full);
}

/** Regions (closed profiles) as a light fill. */
function drawRegions(group: THREE.Group, regions: ReturnType<typeof findRegions>) {
  for (const region of regions) {
    if (region.depth % 2 === 0) continue;

    const shape = new THREE.Shape(region.polygons[0]!.map(([x, y]) => new THREE.Vector2(x, y)));

    for (const h of region.polygons.slice(1)) {
      shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
    }

    const m = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({
        color: 0x5c9dff,
        transparent: true,
        opacity: 0.2,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      }),
    );
    m.renderOrder = 20;
    group.add(m);
  }
}

/** Where the plane cuts meshes, dashed; the one the section tool points at bold. */
function drawSections(group: THREE.Group, sections: SectionChain[], hotSection: number) {
  sections.forEach((c, i) => {
    const hot = i === hotSection;
    const o = fatLine(c.points, {
      color: COLORS.section,
      width: hot ? 3 : 1.5,
      loop: c.closed,
      ...(hot ? {} : { dashed: { dash: 1.5, gap: 1 } }),
    });
    o.renderOrder = 22;
    group.add(o);
  });
}

/** Curves in the colour of their state: selected, hovered, conflicting, reference, construction, defined. */
function drawCurves(group: THREE.Group, scene: SketchScene, full: boolean) {
  const conflictCurves = conflictingRefs(scene.sketch, scene.shown);

  for (const curve of scene.shown.curves) {
    const sel = isSelected(scene, { kind: "curve", id: curve.id });
    const hov = scene.hover?.kind === "curve" && scene.hover.id === curve.id;
    const color = sel
      ? COLORS.sel
      : hov
        ? COLORS.hover
        : conflictCurves.has(curve.id)
          ? COLORS.conflict
          : curve.external
            ? COLORS.external
            : curve.construction
              ? COLORS.construction
              : full
                ? COLORS.full
                : COLORS.under;
    group.add(curveObject(curve, color, curve.construction));
  }
}

const isSelected = (scene: SketchScene, selection: SketchSel) =>
  scene.selection.some((x) => sameSel(x, selection));

/** What the conflicting constraints refer to. */
function conflictingRefs(sketch: SketchFeature | undefined, shown: SolvedSketch): Set<string> {
  const refs = new Set<string>();

  for (const cid of shown.diagnostics.conflicting) {
    const constraint = sketch?.constraints.find((x) => x.id === cid);
    if (constraint) for (const v of refsOf(constraint)) refs.add(v);
  }

  return refs;
}

/** The sketch's points as round dots, coloured like the curves. */
function drawPoints(group: THREE.Group, scene: SketchScene, full: boolean) {
  const pts: number[] = [];
  const ptCols: number[] = [];
  const col = new THREE.Color();

  for (const [id, [x, y]] of pointEntries(scene.sketch, scene.shown)) {
    pts.push(x, y, 0);

    const sel = isSelected(scene, { kind: "point", id });
    const hov = scene.hover?.kind === "point" && scene.hover.id === id;
    col.setHex(
      sel ? COLORS.sel : hov ? COLORS.hover : id === "origin" ? 0x8a93a3 : full ? COLORS.full : COLORS.under,
    );
    ptCols.push(col.r, col.g, col.b);
  }

  const pg = new THREE.BufferGeometry();
  pg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  pg.setAttribute("color", new THREE.Float32BufferAttribute(ptCols, 3));

  const points = new THREE.Points(
    pg,
    new THREE.PointsMaterial({
      size: 7,
      sizeAttenuation: false,
      vertexColors: true,
      depthTest: false,
      map: dotTexture(),
      transparent: true,
      alphaTest: 0.5,
    }),
  );
  points.renderOrder = 30;
  group.add(points);
}

/** Colour of dimension lines, and of the arc of an angle that is only measured so far. */
const DIMENSION_COLOR = 0x6b7280;
const MEASURED_COLOR = 0x4f46e5;

/** An angle's arc and rays, dashed (dashes sized to the arc, so it looks the same at any size). */
export function dashedAngle(arc: AngleArc, p: Segment, q: Segment, color = DIMENSION_COLOR): THREE.Group {
  const group = new THREE.Group();
  const dash = (arc.radius * 2 * Math.PI) / 60;
  const material = new THREE.LineDashedMaterial({
    color,
    dashSize: dash,
    gapSize: dash * 0.7,
    depthTest: false,
  });

  const add = (points: Vec2[]) => {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points.map(([x, y]) => new THREE.Vector3(x, y, 0))),
      material,
    );
    line.computeLineDistances();
    line.renderOrder = 25;
    group.add(line);
  };

  add(arcPoints(arc));
  for (const ray of arcRays(arc, p, q)) add([ray.a, ray.b]);

  return group;
}

/**
 * The extension and dimension lines of the dimensions that have a label placed, every angle's dashed
 * arc, and the arc of the angle between two lines picked together (`pair`).
 */
export function drawDimensionLines(
  group: THREE.Group,
  sketch: SketchFeature | undefined,
  shown: SolvedSketch,
  pair?: { arc: AngleArc; p: Segment; q: Segment } | null,
) {
  if (pair) group.add(dashedAngle(pair.arc, pair.p, pair.q, MEASURED_COLOR));

  for (const constraint of sketch?.constraints ?? []) {
    if (constraint.type === "angle") {
      const angle = angleOf(constraint, shown);
      if (angle) group.add(dashedAngle(angle.arc, angle.p, angle.q));

      continue;
    }

    const geo = dimensionGeometry(constraint, shown);

    if (geo) {
      const l = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(geo.map(([x, y]) => new THREE.Vector3(x, y, 0))),
        new THREE.LineBasicMaterial({ color: 0x6b7280, depthTest: false }),
      );
      l.renderOrder = 25;
      group.add(l);
    }
  }
}

/** The sketch plane's two axes, endless lines through the origin in a colour that suits the theme. */
export function planeAxes(): THREE.LineSegments {
  const dark =
    document.documentElement.dataset["theme"] === "dark" ||
    (!document.documentElement.dataset["theme"] && matchMedia("(prefers-color-scheme: dark)").matches);
  const far = 1e5;
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-far, 0, 0, far, 0, 0, 0, -far, 0, 0, far, 0], 3),
  );

  const axes = new THREE.LineSegments(
    g,
    new THREE.LineBasicMaterial({
      color: dark ? 0xa8b3c8 : 0x5d6878,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
      depthWrite: false,
    }),
  );
  axes.renderOrder = 3;

  return axes;
}

/** Moves the HTML labels in `layer` (sketch position in data-x / data-y) to where the camera shows them. */
export function placeOnScreen(
  layer: HTMLElement,
  frame: Parameters<typeof frameMatrix>[0],
  viewport: Viewport,
) {
  const m = frameMatrix(frame);

  for (const element of layer.querySelectorAll<HTMLElement>("[data-x]")) {
    const v = new THREE.Vector3(Number(element.dataset["x"]), Number(element.dataset["y"]), 0).applyMatrix4(
      m,
    );
    const s = viewport.worldToScreen([v.x, v.y, v.z]);

    if (!s) {
      element.style.display = "none";
      continue;
    }

    element.style.display = "";
    element.style.left = `${s[0]}px`;
    element.style.top = `${s[1]}px`;
  }
}
