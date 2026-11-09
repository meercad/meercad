/**
 * Height pictures in the kernel (a lithophane's picture face): the step that lays one remembers its
 * faces; meshing then refines and displaces those faces' triangles (see model/texture). The solid
 * itself never changes, so volume, mass, STEP and later steps see the smooth part.
 */
import { resolveFaces } from "@meercad/naming";
import { applyTextures, decodeHeightImage, DISPLAY_TEXTURE, DRAFT_TEXTURE, EXPORT_TEXTURE, type FaceSurface, type TextureLayer } from "@meercad/model";
import { Arena } from "./arena.js";
import type { Body } from "./body.js";
import type { BodyMesh } from "./mesh.js";
import type { OC } from "./occt.js";
import type { ModelState } from "./state.js";

/** The pictures on a body at the end of a rebuild: faces found again if the part changed since. */
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
      depth: f.depth,
      pitch: f.pitch,
      angle: f.angle,
      ...(f.fade !== undefined ? { fade: f.fade } : {}),
      image: decodeHeightImage(f.image),
      ...(rec.up ? { up: rec.up } : {}),
      ...(f.invert ? { invert: true } : {}),
    });
    sig.push(faces, f.depth, f.pitch, f.angle, f.fade, f.invert, rec.up, [f.image.width, f.image.height, f.image.pixels]);
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
