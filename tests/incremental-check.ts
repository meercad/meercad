/**
 * Helpers to check that a rebuild which took steps over from an earlier rebuild (only the parts a
 * change touches are built again) gives the same model as building from scratch.
 */
import { summarizeBody, type ModelState, type OC } from "@meercad/kernel";
import type { Feature, MeercadDocument } from "@meercad/schema";

/** The document with a small change to the step's first number (size, diameter, height, …). */
export function nudged(doc: MeercadDocument, id: string, by = 0.1): MeercadDocument {
  return {
    ...doc,
    features: doc.features.map((f) => {
      if (f.id !== id) return f;
      const g = f as unknown as Record<string, unknown>;
      for (const k of ["size", "diameter", "height", "radius", "distance", "depth", "length", "offset", "angle", "count", "slack"]) {
        const v = g[k];
        if (typeof v === "number") return { ...f, [k]: v + (k === "count" ? 1 : by) } as Feature;
        if (Array.isArray(v) && typeof v[0] === "number") return { ...f, [k]: [v[0] + by, ...v.slice(1)] } as Feature;
      }
      // Nothing to change: suppress it instead.
      return { ...f, suppressed: !f.suppressed } as Feature;
    }),
  };
}

const close = (a: number, b: number, rel = 1e-6) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

/** null when both states hold the same parts, sketches and planes; else what differs. */
/** `ocB`: the kernel `b` was built in, when it is another one than `a`'s. */
export function sameModel(oc: OC, a: ModelState, b: ModelState, ocB: OC = oc): string | null {
  const ids = (m: ReadonlyMap<string, unknown>) => [...m.keys()].sort().join(",");
  if (ids(a.bodies) !== ids(b.bodies)) return `parts differ: ${ids(a.bodies)} vs ${ids(b.bodies)}`;
  if (ids(a.sketches) !== ids(b.sketches)) return "sketches differ";
  if (ids(a.planes) !== ids(b.planes)) return "planes differ";
  for (const [id, pa] of a.planes) if (JSON.stringify(pa) !== JSON.stringify(b.planes.get(id))) return `plane ${id} differs`;
  for (const [id, ba] of a.bodies) {
    const bb = b.bodies.get(id)!;
    if (JSON.stringify(ba.faceTags) !== JSON.stringify(bb.faceTags)) return `face tags of ${id} differ`;
    const sa = summarizeBody(oc, ba, true);
    const sb = summarizeBody(ocB, bb, true);
    if (sa.faces !== sb.faces || sa.edges !== sb.edges) return `${id}: ${sa.faces}/${sa.edges} faces/edges vs ${sb.faces}/${sb.edges}`;
    if (!close(sa.volume, sb.volume) || !close(sa.area, sb.area)) return `${id}: volume ${sa.volume} vs ${sb.volume}`;
    for (let i = 0; i < 3; i++) if (!close(sa.bbox.min[i]!, sb.bbox.min[i]!) || !close(sa.bbox.max[i]!, sb.bbox.max[i]!)) return `${id}: box differs`;
  }
  return null;
}
