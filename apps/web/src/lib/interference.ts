/**
 * Interference check for the whole model: every part against every other, in the position they
 * are modelled in. Parts that overlap are reported with the volume they share; parts that only
 * touch are counted (stacked parts touch on purpose).
 */
import { t, tn } from "./i18n";
import { kernel, toast, useApp } from "../store";
import { partName } from "./features";

export async function checkInterference(): Promise<void> {
  const out = useApp.getState().output;
  const ids = out?.report.bodies.map((b) => b.id) ?? [];
  if (ids.length < 2) return toast(t("There is only one part: nothing can overlap"), "info");
  const { pairs, fine } = await kernel.overlaps(ids);
  const features = useApp.getState().doc.features;
  const name = (id: string) => partName(id, features);
  const overlaps = pairs.filter((p) => p.overlap > 1e-3).sort((a, b) => b.overlap - a.overlap);
  const touching = pairs.filter((p) => p.overlap <= 1e-3 && p.distance < 1e-4).length;
  // Fine imported meshes are beyond the kernel (see FINE_MESH_FACES): said, not silently left out.
  if (fine.length) toast(tn(fine.length, "Not checked: the imported mesh {list} has too many triangles", "Not checked: the imported meshes {list} have too many triangles", { list: fine.map(name).join(", ") }), "info");
  if (!overlaps.length) return toast(touching ? tn(touching, "No parts overlap ({n} pair touches)", "No parts overlap ({n} pairs touch)") : t("No parts overlap"));
  const list = overlaps
    .slice(0, 4)
    .map((p) => `${name(p.a)} · ${name(p.b)}: ${p.overlap.toFixed(p.overlap < 10 ? 2 : 0)} mm³`)
    .join("; ");
  toast(tn(overlaps.length, "{n} overlap: {list}", "{n} overlaps: {list}", { list: `${list}${overlaps.length > 4 ? " …" : ""}` }), "error");
}
