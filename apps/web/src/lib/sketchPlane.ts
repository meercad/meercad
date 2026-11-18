/**
 * Where a new sketch goes, from the click that starts it: on the flat face or plane clicked, on the
 * ground (the XY plane at height 0) when the click hits nothing or Option/Alt is held (parts never
 * stand in the way of the ground), or level on the terrain where there is terrain under the click.
 */
import type { PlaneSpec } from "@meercad/schema";
import type { Pick } from "@meercad/viewport";

export type PlaneChoice = { kind: "plane"; spec: PlaneSpec } | { kind: "terrain" } | { kind: "not-flat" };

/** The ground every design stands on. */
export const GROUND: PlaneSpec = { ref: "origin.XY" };

export function choosePlane(
  pick: Pick | null,
  onTerrain: boolean,
  ground: boolean,
  specOf: (pick: Pick) => PlaneSpec | null,
): PlaneChoice {
  if (ground) return { kind: "plane", spec: GROUND };
  if (!pick) return onTerrain ? { kind: "terrain" } : { kind: "plane", spec: GROUND };

  const spec = specOf(pick);

  return spec ? { kind: "plane", spec } : { kind: "not-flat" };
}
