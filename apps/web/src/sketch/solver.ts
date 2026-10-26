import gcsUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import { SketchSolver } from "@leocad/sketch";

let solver: Promise<SketchSolver> | null = null;
/** Main-thread PlaneGCS instance for interactive sketch editing (the kernel worker has its own). */
export const getSolver = () => (solver ??= SketchSolver.create(gcsUrl));
