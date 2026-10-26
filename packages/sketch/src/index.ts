export * from "./geometry.js";
export { SketchSolver, SketchSolveError, type ResolvedConstraint, type SolveInput, type SolveOptions } from "./solve.js";
export { intersectionPoints, findRegions, selectRegions, regionAt, loopArea, polygonOf, pointInPolygon, type Region, type LoopEdge, type LoopSegment } from "./regions.js";
