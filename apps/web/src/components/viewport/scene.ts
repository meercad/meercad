/**
 * What the 3D view shows, worked out from the rebuild and the document: bodies, sketches, planes and
 * the joint symbols, and which feature a pick belongs to. Pure functions, so they are tested on their
 * own.
 */
import type { RebuildOutput } from "@meercad/kernel/client";
import { motion } from "@meercad/model";
import type { Feature, Joint } from "@meercad/schema";
import type { JointGlyph, Pick, PlaneView, SceneData, SketchView } from "@meercad/viewport";
import { sketchesUsed } from "../../lib/features";
import { meshBodyIds } from "../../lib/meshParts";
import { PLANE_LABELS } from "../../lib/topology";
import { CUSTOM_PLANE_COLOR, PLANE_COLORS } from "../PlaneChooser";

export const ORIGIN_FRAMES: Record<string, PlaneView["frame"]> = {
  "origin.XY": { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
  "origin.XZ": { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] },
  "origin.YZ": { origin: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] },
};

/** The view while no model is there yet (a project is opening). */
export const EMPTY_SCENE: SceneData = {
  bodies: [],
  sketches: [],
  planes: [],
  references: [],
  hiddenBodies: new Set(),
  editingSketch: null,
};

/** Half the model's extent in mm, at least this, so the planes have a size on an empty design. */
const MIN_SCENE_SIZE = 60;
/** Planes are drawn this share of the scene size. */
const PLANE_SHARE = 0.6;
/** Tools that take a sketch's profile, so sketches already used stay pickable while they are open. */
const SKETCH_TOOLS = ["extrude", "revolve", "loft", "sweep", "rib"];

type Report = RebuildOutput["report"];

/** How solid a see-through part is drawn for the amount that shows through it (0.75: the usual 0.25). */
export const ghostOpacity = (amount: number) => Math.min(0.95, Math.max(0.05, 1 - amount));

/** What the view shows of a rebuild. */
export function sceneFor(
  output: RebuildOutput,
  doc: { features: readonly Feature[]; seeThrough?: string[]; seeThroughAmount?: Record<string, number> },
  hidden: ReadonlySet<string>,
  sketchId: string | null,
  dialogOp: string,
): SceneData {
  const size = sceneSize(output.report.bodies);

  return {
    bodies: sceneBodies(output, doc.features),
    sketches: visibleSketches(output.report.sketches, doc.features, hidden, sketchId, dialogOp),
    planes: scenePlanes(output.report.planes, doc.features, size),
    references: output.references,
    hiddenBodies: hidden,
    ghostBodies: new Set(doc.seeThrough ?? []),
    ...(doc.seeThroughAmount
      ? {
          ghostOpacity: new Map(
            Object.entries(doc.seeThroughAmount).map(([part, amount]) => [part, ghostOpacity(amount)]),
          ),
        }
      : {}),
    editingSketch: sketchId,
  };
}

/** The largest coordinate any part reaches, at least MIN_SCENE_SIZE. */
function sceneSize(bodies: Report["bodies"]): number {
  let size = MIN_SCENE_SIZE;
  for (const b of bodies) size = Math.max(size, ...b.bbox.max.map(Math.abs), ...b.bbox.min.map(Math.abs));

  return size;
}

/**
 * Sketches not hidden; one a feature has used up only while it is edited or a tool that takes a profile
 * is open.
 */
function visibleSketches(
  sketches: Report["sketches"],
  features: readonly Feature[],
  hidden: ReadonlySet<string>,
  sketchId: string | null,
  dialogOp: string,
): SketchView[] {
  const consumed = sketchesUsed(features);
  const picksSketches = SKETCH_TOOLS.includes(dialogOp);

  return sketches
    .filter(
      (sketchView) =>
        !hidden.has(sketchView.id) &&
        (sketchView.id === sketchId || !consumed.has(sketchView.id) || picksSketches),
    )
    .map((sketchView) => ({
      id: sketchView.id,
      frame: sketchView.frame,
      curves: sketchView.curves,
      regions: sketchView.regions.map((g) => ({ key: g.key, polygons: g.polygons })),
    }));
}

/** The three origin planes and the design's own, sized to the model. */
function scenePlanes(planes: Report["planes"], features: readonly Feature[], size: number): PlaneView[] {
  return [
    ...Object.entries(ORIGIN_FRAMES).map(([id, frame]) => ({
      id,
      label: PLANE_LABELS[id]!,
      frame,
      size: size * PLANE_SHARE,
      color: PLANE_COLORS[id]!,
    })),
    ...planes.map((p) => ({
      id: p.id,
      label: features.find((feature) => feature.id === p.id)?.name ?? p.id,
      frame: p.frame,
      size: size * PLANE_SHARE,
      color: CUSTOM_PLANE_COLOR,
    })),
  ];
}

/** The meshes; mesh parts show no edges, they would outline every triangle. */
function sceneBodies(output: RebuildOutput, features: readonly Feature[]): RebuildOutput["meshes"] {
  const meshParts = meshBodyIds(features, output.meshes);

  return output.meshes.map((mesh) =>
    meshParts.has(mesh.bodyId) && mesh.edgeRanges.length
      ? { ...mesh, edgeLines: new Float32Array(), edgeRanges: new Int32Array() }
      : mesh,
  );
}

/**
 * The joint symbols while the joints panel is open; the one being edited stands out. Switched off they
 * stay away so the motion shows alone, except for the joint being edited.
 */
export function jointGlyphsFor(
  joints: readonly Joint[],
  frames: Report["joints"],
  editedJoint: string | undefined,
  showJoints: boolean,
): JointGlyph[] {
  return joints.flatMap((j) => {
    const f = frames.find((x) => x.id === j.id);
    if (!f || f.error || j.suppressed) return [];

    const active = editedJoint === j.id;
    if (!showJoints && !active) return [];

    const on = j.b !== "ground" ? { parent: j.b } : {};

    // A cylindrical joint shows a ring to turn it (riding on its slide) and an arrow to slide it.
    if (j.type === "cylindrical") {
      return [
        {
          id: `${j.id}${motion.TURN}`,
          type: "revolute" as const,
          origin: f.origin,
          axis: f.axis,
          parent: motion.cylindricalCarrier(j.id),
          active,
        },
        {
          id: `${j.id}${motion.SLIDE}`,
          type: "slider" as const,
          origin: f.origin,
          axis: f.axis,
          ...on,
          active,
        },
      ];
    }

    return [{ id: j.id, type: j.type, origin: f.origin, axis: f.axis, ...on, active }];
  });
}

/** The feature a pick opens: its sketch, its plane, or the latest feature that shaped the face. */
export function featureOfPick(pick: Pick, features: readonly Feature[]): string | null {
  if (pick.kind === "region" || pick.kind === "sketch_curve") return pick.sketchId;
  if (pick.kind === "plane") return pick.planeId.startsWith("origin.") ? null : pick.planeId;

  if (pick.kind === "face") {
    // The latest feature that tagged this face is the most specific owner.
    const ids = pick.tags.map((t) => t.split(/[.@[]/)[0]!);

    for (let i = features.length - 1; i >= 0; i--) {
      if (ids.includes(features[i]!.id)) return features[i]!.id;
    }
  }

  // An edge, or a face no feature tagged: the part's own feature.
  return features.find((feature) => feature.id === pick.bodyId)?.id ?? null;
}
