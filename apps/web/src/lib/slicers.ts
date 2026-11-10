/**
 * The slicers installed on this Mac that a model can be sent to (Bambu Studio first, then
 * PrusaSlicer), asked of the desktop app once at start; none in the browser and on iPhone and iPad.
 */
import { create } from "zustand";
import { desktop } from "./persistence";

export type SlicerId = "bambu" | "prusa";
export interface Slicer {
  id: SlicerId;
  name: string;
}

export const useSlicers = create<{ slicers: Slicer[] }>(() => ({ slicers: [] }));

/** Asks the desktop app again (after the user installed one, or at start). */
export async function refreshSlicers(): Promise<Slicer[]> {
  const slicers = (await desktop?.slicers?.list().catch(() => [] as Slicer[])) ?? [];
  useSlicers.setState({ slicers });
  return slicers;
}
void refreshSlicers();

/** The slicer `id`, or the first one installed (Bambu Studio before PrusaSlicer); null if none. */
export function slicerFor(id?: SlicerId): Slicer | null {
  const { slicers } = useSlicers.getState();
  return (id ? slicers.find((s) => s.id === id) : slicers[0]) ?? null;
}
