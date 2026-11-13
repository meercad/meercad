/**
 * Versions: named states of the design kept in the file itself, so they go wherever the file goes.
 * Imported files are by far the largest part of a design; a version keeps their contents as a key
 * into the document's `blobs`, so ten versions of a scanned part hold the scan once.
 */
import type { Feature, MeercadDocument, Version, VersionState } from "@meercad/schema";

/** Contents shorter than this stay in the version itself. */
const INLINE = 4096;

/** Key of a file's contents: its length and a 53-bit FNV-1a hash of all of it. */
export function blobKey(data: string): string {
  let h1 = 0x811c9dc5,
    h2 = 0x01000193;

  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }

  return `blob:${data.length.toString(36)}:${(h2 & 0x1fffff).toString(36)}${h1.toString(36)}`;
}

/** The design without the file's bookkeeping: what a version saves and what gets built. */
export function designOf(doc: MeercadDocument): MeercadDocument {
  if (!doc.versions && !doc.blobs) return doc;

  const { versions: _v, blobs: _b, ...design } = doc;

  return design;
}

/** The current design as a version, its large imports moved into `blobs` (which it adds to). */
export function snapshot(
  doc: MeercadDocument,
  name: string,
  at: number,
  blobs: Record<string, string>,
): Version {
  const { format: _f, ...state } = structuredClone(designOf(doc));

  const keep = (data: string) => {
    if (data.length < INLINE) return data;

    const key = blobKey(data);
    blobs[key] = data;

    return key;
  };

  state.features = state.features.map((feature): Feature => {
    if (feature.op === "lithophane") {
      return { ...feature, image: { ...feature.image, pixels: keep(feature.image.pixels) } };
    }

    if (feature.op !== "import") return feature;

    return {
      ...feature,
      data: keep(feature.data),
      ...(feature.texture
        ? {
            texture: {
              ...feature.texture,
              image: keep(feature.texture.image),
              uvs: keep(feature.texture.uvs),
            },
          }
        : {}),
    };
  });
  state.references = state.references?.map((reference) => {
    if (reference.data.length < INLINE) return reference;

    const key = blobKey(reference.data);
    blobs[key] = reference.data;

    return { ...reference, data: key };
  });
  if (!state.references) delete state.references;

  return { name, at, state };
}

/** A version as a whole document, imports filled in again; the file's versions and blobs are kept. */
export function restored(doc: MeercadDocument, version: Version): MeercadDocument {
  const state: VersionState = structuredClone(version.state);
  state.features = state.features.map((feature): Feature => {
    if (feature.op === "lithophane" && feature.image.pixels.startsWith("blob:")) {
      const pixels = doc.blobs?.[feature.image.pixels];

      if (pixels === undefined) {
        throw new Error(`version "${version.name}": the picture of ${feature.name ?? feature.id} is missing`);
      }

      return { ...feature, image: { ...feature.image, pixels } };
    }

    if (feature.op !== "import") return feature;

    const fill = (data: string) => {
      if (!data.startsWith("blob:")) return data;

      const full = doc.blobs?.[data];

      if (full === undefined) {
        throw new Error(`version "${version.name}": the contents of ${feature.fileName} are missing`);
      }

      return full;
    };

    return {
      ...feature,
      data: fill(feature.data),
      ...(feature.texture
        ? {
            texture: {
              ...feature.texture,
              image: fill(feature.texture.image),
              uvs: fill(feature.texture.uvs),
            },
          }
        : {}),
    };
  });
  state.references = state.references?.map((reference) => {
    if (!reference.data.startsWith("blob:")) return reference;

    const data = doc.blobs?.[reference.data];

    if (data === undefined) {
      throw new Error(`version "${version.name}": the contents of ${reference.name} are missing`);
    }

    return { ...reference, data };
  });
  if (!state.references) delete state.references;

  return {
    ...state,
    format: doc.format,
    ...(doc.versions ? { versions: doc.versions } : {}),
    ...(doc.blobs ? { blobs: doc.blobs } : {}),
  };
}

/**
 * A version as a project file of its own (for a backup outside the app): the design as it was, with
 * its imports filled in, without the other versions. Any meerCAD opens it as a project.
 */
export function versionFile(doc: MeercadDocument, name: string): MeercadDocument {
  const version = doc.versions?.find((x) => x.name === name);

  if (!version) {
    throw new Error(
      `unknown version "${name}"; saved: ${(doc.versions ?? []).map((x) => `"${x.name}"`).join(", ") || "none"}`,
    );
  }

  return designOf(restored(doc, version));
}

/** A name for a version not taken yet: `name`, else "name (2)", "name (3)", … */
export function freeVersionName(doc: MeercadDocument, name: string): string {
  const taken = new Set((doc.versions ?? []).map((version) => version.name));
  const base = name.slice(0, 72);
  if (!taken.has(base)) return base;

  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`)) return `${base} (${n})`;
}

/** Drops blobs no version refers to any more. */
export function pruneBlobs(doc: MeercadDocument): void {
  if (!doc.blobs) return;

  const used = new Set(
    doc.versions?.flatMap((version) => [
      ...version.state.features.flatMap((feature) =>
        (feature.op === "import"
          ? [feature.data, feature.texture?.image ?? "", feature.texture?.uvs ?? ""]
          : feature.op === "lithophane"
            ? [feature.image.pixels]
            : []
        ).filter((d) => d.startsWith("blob:")),
      ),
      ...(version.state.references ?? []).flatMap((reference) =>
        reference.data.startsWith("blob:") ? [reference.data] : [],
      ),
    ]) ?? [],
  );
  for (const k of Object.keys(doc.blobs)) if (!used.has(k)) delete doc.blobs[k];
  if (!Object.keys(doc.blobs).length) delete doc.blobs;
}

/** What differs between a version and the design: steps added, removed or changed, and other changes. */
export function versionChanges(
  version: VersionState,
  design: MeercadDocument,
): { added: string[]; removed: string[]; changed: string[]; other: boolean } {
  const then = new Map(version.features.map((feature) => [feature.id, feature]));
  const now = new Map(design.features.map((feature) => [feature.id, feature]));

  const same = (a: Feature, b: Feature) => {
    // Imports compare by their file, not by the key a version keeps.
    const strip = (feature: Feature) =>
      feature.op === "import"
        ? { ...feature, data: feature.data.startsWith("blob:") ? feature.data : blobKey(feature.data) }
        : feature.op === "lithophane"
          ? {
              ...feature,
              image: {
                ...feature.image,
                pixels:
                  feature.image.pixels.startsWith("blob:") || feature.image.pixels.length < INLINE
                    ? feature.image.pixels
                    : blobKey(feature.image.pixels),
              },
            }
          : feature;

    return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  };

  const added = design.features.filter((feature) => !then.has(feature.id)).map((feature) => feature.id);
  const removed = version.features.filter((feature) => !now.has(feature.id)).map((feature) => feature.id);
  const changed = design.features
    .filter((feature) => then.has(feature.id) && !same(then.get(feature.id)!, feature))
    .map((feature) => feature.id);
  const { features: _a, ...restThen } = version;
  const { features: _b, format: _c, versions: _d, blobs: _e, ...restNow } = design;
  // Reference models, like imports, compare by their file.
  const keyed = (rest: Partial<VersionState>) =>
    rest.references
      ? {
          ...rest,
          references: rest.references.map((reference) => ({
            ...reference,
            data: reference.data.startsWith("blob:") ? reference.data : blobKey(reference.data),
          })),
        }
      : rest;
  const other = JSON.stringify(sorted(keyed(restThen))) !== JSON.stringify(sorted(keyed(restNow)));

  return { added, removed, changed, other };
}

const sorted = (o: object) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
