/**
 * Pictures on imported meshes (a scan's colours): kept on the import feature, laid on the part
 * wherever it shows the file's own triangles (also moved, copied or patterned), and exported with
 * OBJ. Only the look: building ignores them, and a cut or combined part is shown plain.
 */
import type { BodyMesh } from "@meercad/kernel";
import type { Feature, ImportFeature, MeshTexture } from "@meercad/schema";
import type { BodyTexture } from "@meercad/viewport";
import { apply, useApp } from "../store";
import { t } from "./i18n";
import { meshUvs as fileMeshUvs } from "./meshUvs";

/** Base64 decoded once per string (a scan's picture is megabytes; rebuilds come often). */
const floats = new Map<string, Float32Array>();
const pictures = new Map<string, Blob>();
const bytesOf = new Map<string, Uint8Array>();
const exported = new Map<string, Uint8Array>();

function decode(b64: string): Uint8Array {
  let bytes = bytesOf.get(b64);

  if (!bytes) {
    const raw = atob(b64);
    bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    bytesOf.clear();
    bytesOf.set(b64, bytes);
  }

  return bytes;
}

/** The file's texture coordinates, two per triangle corner in file order. */
function fileUvs(t: MeshTexture): Float32Array {
  let uv = floats.get(t.uvs);

  if (!uv) {
    const bytes = decode(t.uvs);
    uv = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~3)));
    if (floats.size > 8) floats.clear();

    floats.set(t.uvs, uv);
  }

  return uv;
}

function picture(t: MeshTexture): Blob {
  let blob = pictures.get(t.image);

  if (!blob) {
    blob = new Blob([decode(t.image) as BlobPart], { type: t.mime });
    if (pictures.size > 8) pictures.clear();

    pictures.set(t.image, blob);
  }

  return blob;
}

/** The import feature behind a mesh part, when it has a picture. */
export function textureFeature(
  features: readonly Feature[],
  mesh: Pick<BodyMesh, "source">,
): (ImportFeature & { texture: MeshTexture }) | null {
  const id = mesh.source?.feature;
  const feature = id ? features.find((x) => x.id === id) : undefined;

  return feature?.op === "import" && feature.texture
    ? (feature as ImportFeature & { texture: MeshTexture })
    : null;
}

/** Coordinates for every vertex of a part's mesh, or null when it does not show the file's triangles. */
export const meshUvs = (mesh: Pick<BodyMesh, "source" | "positions">, t: MeshTexture): Float32Array | null =>
  fileMeshUvs(mesh, fileUvs(t));

/** The pictures the viewport lays on parts: every shown scan whose texture is switched on. */
export function bodyTextures(features: readonly Feature[], meshes: readonly BodyMesh[]): BodyTexture[] {
  return meshes.flatMap((mesh) => {
    const f = textureFeature(features, mesh);
    if (!f || f.texture.hidden) return [];

    const uvs = meshUvs(mesh, f.texture);

    return uvs
      ? [{ bodyId: mesh.bodyId, uvs, image: picture(f.texture), key: `${f.id}:${f.texture.image.length}` }]
      : [];
  });
}

/** A part's picture for export: its coordinates and the picture's bytes, or nothing. */
export function exportTexture(
  features: readonly Feature[],
  mesh: BodyMesh,
): { uvs: Float32Array; image: { data: Uint8Array; mime: string } } | null {
  const f = textureFeature(features, mesh);
  if (!f || f.texture.hidden) return null;

  const uvs = meshUvs(mesh, f.texture);
  if (!uvs) return null;

  // One array per picture, so copies of a scan share one picture file in the export.
  let data = exported.get(f.texture.image);

  if (!data) {
    if (exported.size > 8) exported.clear();

    exported.set(f.texture.image, (data = decode(f.texture.image).slice()));
  }

  return { uvs, image: { data, mime: f.texture.mime } };
}

/** Whether a part shows (or could show) its picture: for the part menu's switch. */
export function partTexture(
  features: readonly Feature[],
  meshes: readonly BodyMesh[],
  bodyId: string,
): { feature: string; shown: boolean } | null {
  const mesh = meshes.find((x) => x.bodyId === bodyId);
  const f = mesh ? textureFeature(features, mesh) : null;

  return f && mesh && meshUvs(mesh, f.texture) ? { feature: f.id, shown: !f.texture.hidden } : null;
}

/** The part menu's switch for a scan's picture, or null for parts without one. */
export function textureToggle(bodyId: string): { label: string; shown: boolean; onClick: () => void } | null {
  const { doc, output } = useApp.getState();
  const found = partTexture(doc.features, output?.meshes ?? [], bodyId);
  if (!found) return null;

  return {
    label: found.shown ? t("Show without texture") : t("Show texture"),
    shown: found.shown,
    onClick: () => {
      const feature = useApp.getState().doc.features.find((x) => x.id === found.feature);
      if (feature?.op !== "import" || !feature.texture) return;

      const { hidden: _h, ...rest } = feature.texture;
      apply({
        type: "edit_feature",
        id: feature.id,
        patch: { texture: found.shown ? { ...rest, hidden: true } : rest },
      });
    },
  };
}
