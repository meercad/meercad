/**
 * Mesh analysis without OCCT: surface recognition and parametric reconstruction (usable on the main thread).
 */
export {
  fitMesh,
  surfaceDistance,
  type FitOptions,
  type MeshFit,
  type Primitive,
  type Region,
  type Segment,
} from "./meshfit.js";
export { repairMesh, type RepairOptions, type RepairReport } from "./meshrepair.js";
export {
  compareShapes,
  nearestTriangle,
  scanMesh,
  shapeAt,
  shapeValues,
  type ScanMesh,
  type ScanShape,
  type ShapeValue,
} from "./scanfit.js";
export {
  fitSection,
  sectionMesh,
  type SectionChain,
  type SectionFrame,
  type SectionPiece,
} from "./meshsection.js";
export {
  reconstruct,
  type Measurement as ReconstructMeasurement,
  type Reconstruction,
} from "./reconstruct.js";
