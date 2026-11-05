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
  let h1 = 0x811c9dc5, h2 = 0x01000193;
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
export function snapshot(doc: MeercadDocument, name: string, at: number, blobs: Record<string, string>): Version {
  const { format: _f, ...state } = structuredClone(designOf(doc));
  const keep = (data: string) => {
    if (data.length < INLINE) return data;
    const key = blobKey(data);
    blobs[key] = data;
    return key;
  };
  state.features = state.features.map((f): Feature => {
    if (f.op !== "import") return f;
    return { ...f, data: keep(f.data), ...(f.texture ? { texture: { ...f.texture, image: keep(f.texture.image), uvs: keep(f.texture.uvs) } } : {}) };
  });
  state.references = state.references?.map((r) => {
    if (r.data.length < INLINE) return r;
    const key = blobKey(r.data);
    blobs[key] = r.data;
    return { ...r, data: key };
  });
  if (!state.references) delete state.references;
  return { name, at, state };
}

/** A version as a whole document, imports filled in again; the file's versions and blobs are kept. */
export function restored(doc: MeercadDocument, version: Version): MeercadDocument {
  const state: VersionState = structuredClone(version.state);
  state.features = state.features.map((f): Feature => {
    if (f.op !== "import") return f;
    const fill = (data: string) => {
      if (!data.startsWith("blob:")) return data;
      const full = doc.blobs?.[data];
      if (full === undefined) throw new Error(`version "${version.name}": the contents of ${f.fileName} are missing`);
      return full;
    };
    return { ...f, data: fill(f.data), ...(f.texture ? { texture: { ...f.texture, image: fill(f.texture.image), uvs: fill(f.texture.uvs) } } : {}) };
  });
  state.references = state.references?.map((r) => {
    if (!r.data.startsWith("blob:")) return r;
    const data = doc.blobs?.[r.data];
    if (data === undefined) throw new Error(`version "${version.name}": the contents of ${r.name} are missing`);
    return { ...r, data };
  });
  if (!state.references) delete state.references;
  return { ...state, format: doc.format, ...(doc.versions ? { versions: doc.versions } : {}), ...(doc.blobs ? { blobs: doc.blobs } : {}) };
}

/** Drops blobs no version refers to any more. */
export function pruneBlobs(doc: MeercadDocument): void {
  if (!doc.blobs) return;
  const used = new Set(
    doc.versions?.flatMap((v) => [
      ...v.state.features.flatMap((f) => (f.op === "import" ? [f.data, f.texture?.image ?? "", f.texture?.uvs ?? ""].filter((d) => d.startsWith("blob:")) : [])),
      ...(v.state.references ?? []).flatMap((r) => (r.data.startsWith("blob:") ? [r.data] : [])),
    ]) ?? [],
  );
  for (const k of Object.keys(doc.blobs)) if (!used.has(k)) delete doc.blobs[k];
  if (!Object.keys(doc.blobs).length) delete doc.blobs;
}

/** What differs between a version and the design: steps added, removed or changed, and other changes. */
export function versionChanges(version: VersionState, design: MeercadDocument): { added: string[]; removed: string[]; changed: string[]; other: boolean } {
  const then = new Map(version.features.map((f) => [f.id, f]));
  const now = new Map(design.features.map((f) => [f.id, f]));
  const same = (a: Feature, b: Feature) => {
    // Imports compare by their file, not by the key a version keeps.
    const strip = (f: Feature) => (f.op === "import" ? { ...f, data: f.data.startsWith("blob:") ? f.data : blobKey(f.data) } : f);
    return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  };
  const added = design.features.filter((f) => !then.has(f.id)).map((f) => f.id);
  const removed = version.features.filter((f) => !now.has(f.id)).map((f) => f.id);
  const changed = design.features.filter((f) => then.has(f.id) && !same(then.get(f.id)!, f)).map((f) => f.id);
  const { features: _a, ...restThen } = version;
  const { features: _b, format: _c, versions: _d, blobs: _e, ...restNow } = design;
  // Reference models, like imports, compare by their file.
  const keyed = (rest: Partial<VersionState>) => (rest.references ? { ...rest, references: rest.references.map((r) => ({ ...r, data: r.data.startsWith("blob:") ? r.data : blobKey(r.data) })) } : rest);
  const other = JSON.stringify(sorted(keyed(restThen))) !== JSON.stringify(sorted(keyed(restNow)));
  return { added, removed, changed, other };
}

const sorted = (o: object) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
