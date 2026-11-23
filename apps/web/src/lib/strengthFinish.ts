/**
 * The last step of a topology: its skin may be made of more triangles than a mesh part may have
 * here (see importBudget.ts). It is then made lighter, which leaves a smooth skin as smooth as it
 * was: the triangles go where the skin is nearly flat.
 */
import type { TriangleSkin } from "@meercad/model";
import { IMPORT_TRIANGLES, withinBudget } from "./importBudget";

/** A topology has at most this many triangles: smoothness comes first, working on it as a body second. */
export const TOPOLOGY_TRIANGLES = IMPORT_TRIANGLES;

export const lightTopology = (mesh: TriangleSkin, budget = TOPOLOGY_TRIANGLES): TriangleSkin =>
  withinBudget([mesh], budget).meshes[0]!;
