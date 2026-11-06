/**
 * Surface textures in the kernel: the texture step checks its faces and remembers them; meshing
 * then refines and displaces those faces' triangles (see model/texture). The solid itself never
 * changes, so volume, mass, STEP and later steps see the smooth part.
 */
import { resolveFaces } from "@meercad/naming";
import { applyTextures, decodeHeightImage, DISPLAY_TEXTURE, DRAFT_TEXTURE, EXPORT_TEXTURE, FeatureError, type FaceSurface, type ResolvedTexture, type TextureLayer } from "@meercad/model";
import { Arena } from "./arena.js";
import type { Body } from "./body.js";
import type { BodyMesh } from "./mesh.js";
import type { OC } from "./occt.js";
import type { ModelState, TextureRecord } from "./state.js";

/** The texture step: its faces must exist and belong to one part. */
export function textureRecord(f: ResolvedTexture, bodies: ReadonlyMap<string, Body>): TextureRecord {
  if (!f.faces.length) throw new FeatureError("select the faces to texture");
  const refs = f.faces.flatMap((s) => resolveFaces(s, [...bodies.values()]));
  const ids = new Set(refs.map((r) => r.body));
  if (ids.size !== 1) throw new FeatureError(ids.size ? "the faces must belong to one part" : "face selector matches no face");
  const body = bodies.get([...ids][0]!)!;
  if (f.pitch <= 0) throw new FeatureError("the pitch must be larger than zero");
  if (f.depth === 0) throw new FeatureError("the depth must not be zero");
  if (f.pattern === "image" && !f.image) throw new FeatureError('pattern "image" needs a picture');
  return { feature: f, body, faces: [...new Set(refs.flatMap((r) => r.faces))] };
}

/** The textures on a body at the end of a rebuild: faces found again if the part changed since. */
export function texturesOf(state: ModelState, body: Body): { layers: TextureLayer[]; sig: string } | null {
  const layers: TextureLayer[] = [];
  const sig: unknown[] = [];
  for (const rec of state.textures?.values() ?? []) {
    if (rec.body.bodyId !== body.bodyId) continue;
    let faces = rec.faces;
    if (rec.body !== body) {
      try {
        faces = [...new Set(rec.feature.faces.flatMap((s) => resolveFaces(s, [body]).flatMap((r) => r.faces)))];
      } catch {
        continue;
      }
    }
    if (!faces.length) continue;
    const f = rec.feature;
    layers.push({
      faces,
      pattern: f.pattern,
      depth: f.depth,
      pitch: f.pitch,
      angle: f.angle,
      ...(f.ratio !== undefined ? { ratio: f.ratio } : {}),
      ...(f.fade !== undefined ? { fade: f.fade } : {}),
      ...(f.seed !== undefined ? { seed: f.seed } : {}),
      ...(f.image ? { image: decodeHeightImage(f.image) } : {}),
      ...(f.invert ? { invert: true } : {}),
    });
    sig.push(faces, f.pattern, f.depth, f.pitch, f.angle, f.ratio, f.fade, f.seed, f.invert, f.image ? [f.image.width, f.image.height, f.image.pixels] : null);
  }
  return layers.length ? { layers, sig: JSON.stringify(sig) } : null;
}

/** Plane, cylinder (with its axis) or anything else, for each textured face. */
function surfacesOf(oc: OC, body: Body, faces: Iterable<number>): FaceSurface[] {
  const arena = new Arena();
  try {
    const out: FaceSurface[] = [];
    for (const fi of faces) {
      const surf = arena.track(new oc.BRepAdaptor_Surface(body.faces[fi]!, true));
      const type = surf.GetType();
      if (type === "GeomAbs_Plane") out[fi] = { kind: "plane" };
      else if (type === "GeomAbs_Cylinder") {
        const cyl = arena.track(surf.Cylinder());
        const ax = arena.track(cyl.Axis());
        const p = arena.track(ax.Location());
        const d = arena.track(ax.Direction());
        out[fi] = { kind: "cylinder", origin: [p.X(), p.Y(), p.Z()], axis: [d.X(), d.Y(), d.Z()], radius: cyl.Radius() };
      } else out[fi] = { kind: "other" };
    }
    return out;
  } finally {
    arena.dispose();
  }
}

/** Whether a textured face is curved in a way only a finer tessellation follows (not flat, not a cylinder). */
export function needsFineBase(oc: OC, body: Body, layers: TextureLayer[]): boolean {
  if (body.sourceMesh) return false;
  const s = surfacesOf(oc, body, new Set(layers.flatMap((l) => l.faces)));
  return s.some((x) => x?.kind === "other");
}

/**
 * The mesh with its textures applied: "export" fine for printing, "display" for looking at
 * (coarser on slow devices, `coarse` > 1), "draft" while a value is being dragged.
 */
export function texturedMesh(oc: OC, body: Body, base: BodyMesh, layers: TextureLayer[], quality: "export" | "display" | "draft", coarse = 1): BodyMesh {
  const surfaces = body.sourceMesh ? [] : surfacesOf(oc, body, new Set(layers.flatMap((l) => l.faces)));
  const preset = quality === "export" ? EXPORT_TEXTURE : quality === "draft" ? DRAFT_TEXTURE : DISPLAY_TEXTURE;
  const opts = quality === "export" ? preset : { ...preset, maxTriangles: Math.round(preset.maxTriangles / Math.max(1, coarse)) };
  const t = applyTextures(base, layers, surfaces, opts);
  if (!t) return base;
  // A scan's picture no longer fits the refined triangles: the part is shown plain.
  const { source: _source, ...rest } = base;
  return { ...rest, positions: t.positions, normals: t.normals, indices: t.indices, faceRanges: t.faceRanges, edgeRanges: t.edgeRanges, textured: true };
}
