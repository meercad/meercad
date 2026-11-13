/**
 * Lithophanes and reliefs from a picture: a plate (flat, or bent round the plane's normal) with the
 * picture laid on its picture face as a height picture (see texture.ts and model/texture).
 * The solid is the plain plate; the picture moves the picture face's triangles by the picture's
 * brightness. With a frame, the plate is built at the full thickness and the picture area recessed
 * to the thinnest thickness, so the picture rises from the recess up to the frame's top.
 */
import { decodeHeightImage, FeatureError, type ResolvedLithophane } from "@meercad/model";
import type { PlaneFrame, Vec3 } from "@meercad/sketch";
import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import { Body } from "./body.js";
import { Builder } from "./builder.js";
import type { OC } from "./occt.js";
import type { PictureSpec, TextureRecord } from "./state.js";

export function lithophaneBody(
  oc: OC,
  arena: Arena,
  f: ResolvedLithophane,
  frame: PlaneFrame,
): { body: Body; texture: TextureRecord } {
  const b = new Builder(oc, arena);
  const { width: W, thickness: t, depth: d, frame: fw } = f;
  const img = f.image.pixels.startsWith("blob:") ? null : decodeHeightImage(f.image);
  if (!img) throw new FeatureError("the picture is missing");
  if (!(W >= 5)) throw new FeatureError("the picture must be at least 5 mm wide");
  if (!(t >= 0.2)) throw new FeatureError("the plate must be at least 0.2 mm thick");
  if (!(d > 0)) throw new FeatureError("the depth must be greater than zero");
  if (!(fw >= 0)) throw new FeatureError("the frame cannot be narrower than zero");

  if (!(f.curve >= 0 && f.curve <= 360)) {
    throw new FeatureError("the curve must be between 0 and 360 degrees");
  }

  const H = (W * img.height) / img.width;
  const T = t + d;
  const curved = f.curve >= 1;
  let shape: TopoDS_Shape;
  let classify: (p: Vec3, planar: boolean, n: Vec3 | null) => string;
  let upLocal: Vec3;

  if (!curved) {
    // Lying on the plane, the picture's top towards +y, its face up at the thinnest thickness.
    shape =
      fw > 0
        ? b.bool("cut", b.block(0, 0, W + 2 * fw, H + 2 * fw, 0, 0, T), [b.block(0, 0, W, H, 0, t, T + 1)])
        : b.block(0, 0, W, H, 0, 0, t);
    upLocal = [0, 1, 0];

    classify = (p, _planar, n) => {
      if (n && n[2] > 0.99 && Math.abs(p[2] - t) < 1e-4) return "picture";
      if (n && n[2] > 0.99) return "frame";
      if (n && n[2] < -0.99) return "back";

      return "side";
    };
  } else {
    // Standing on the plane, bent round its normal through the origin; the picture faces outwards
    // with its middle towards −y and its top up.
    const theta = (Math.min(f.curve, 360) * Math.PI) / 180;
    const R = W / theta; // radius of the picture face
    const Rin = R - t;

    if (Rin < 1) {
      throw new FeatureError(
        `the curve is too tight for a ${W} mm wide picture: at most ${Math.floor(((W / (t + 1)) * 180) / Math.PI)}°`,
      );
    }

    const closed = f.curve >= 359.999;
    const endFrame = closed ? 0 : fw / R;
    const total = Math.min(2 * Math.PI, theta + 2 * endFrame);

    const sector = (r0: number, r1: number, span: number, z0: number, z1: number): TopoDS_Shape => {
      const full = span >= 2 * Math.PI - 1e-9;
      const start = -Math.PI / 2 - span / 2;
      const ax = arena.track(
        new oc.gp_Ax2(
          b.pnt(0, 0, z0),
          arena.track(new oc.gp_Dir(0, 0, 1)),
          arena.track(new oc.gp_Dir(Math.cos(start), Math.sin(start), 0)),
        ),
      );
      const outer = full
        ? arena.track(arena.track(new oc.BRepPrimAPI_MakeCylinder(ax, r1, z1 - z0)).Shape())
        : arena.track(arena.track(new oc.BRepPrimAPI_MakeCylinder(ax, r1, z1 - z0, span)).Shape());
      if (r0 <= 0) return outer;

      return b.bool("cut", outer, [b.cylinderZ(0, 0, r0, z0 - 1, z1 + 1)]);
    };

    if (fw > 0) {
      const plate = sector(Rin, R + d, total, 0, H + 2 * fw);
      shape = b.bool("cut", plate, [sector(R, R + d + 1, closed ? 2 * Math.PI : theta, fw, fw + H)]);
    } else {
      shape = sector(Rin, R, closed ? 2 * Math.PI : theta, 0, H);
    }

    upLocal = [0, 0, 1];

    classify = (p, planar) => {
      if (planar) return "side";

      const r = Math.hypot(p[0], p[1]);
      // Face points are triangle centroids, a little inside a round face.
      const near = (x: number) => Math.abs(r - x) < Math.min(t, d) / 2;
      if (near(R)) return "picture";
      if (near(Rin)) return "back";
      if (near(R + d)) return "frame";

      return "side";
    };
  }

  const local = new Body(oc, arena, f.id, b.unify(shape));
  local.faceTags = local.faces.map((_, i) => [
    `${f.id}.${classify(local.facePoints[i]!, local.faceInfo[i]!.planar, local.faceInfo[i]!.normal)}`,
  ]);

  const trsf = b.placement(frame, f.position);
  const body = b.place(local, trsf, f.id);
  const faces = body.faceTags.flatMap((tags, i) => (tags.includes(`${f.id}.picture`) ? [i] : []));
  if (!faces.length) throw new FeatureError("the picture face could not be found");

  // The picture's top in world directions: the plane's v when flat, its normal when curved.
  const n = frame.normal,
    u = frame.u;
  const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const up: Vec3 = upLocal[2] === 1 ? [...n] : v;
  const texture: PictureSpec = {
    id: f.id,
    faces: [{ face: `${f.id}.picture` }],
    // Within a frame the picture stays a hair under its top, so the recess walls keep some height.
    depth: fw > 0 ? d - 0.01 : d,
    pitch: W,
    angle: 0,
    fade: 0,
    image: f.image,
    // The picture keeps bright = high; a lithophane wants dark = thick.
    ...((f.kind === "lithophane") !== !!f.invert ? { invert: true } : {}),
  };

  return { body, texture: { feature: texture, body, faces, up } };
}
