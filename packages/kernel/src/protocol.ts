import type { MeercadDocument } from "@meercad/schema";
import type { BodyMesh, BodySummary } from "./mesh.js";
import type { RebuildReport, ReferenceView } from "./session.js";
import type { Clearance, Measurement, PickRef, StepPart } from "./tools.js";
import type { DrawingView, ViewName } from "./drawing.js";

export type WorkerRequest =
  /** `props: false` skips volume and surface area (previews while dragging). */
  /** `draft`: lithophane pictures coarse and quick (while a value is being dragged); `textures: false` shows parts smooth. */
  | { type: "rebuild"; seq: number; doc: MeercadDocument; mesh?: boolean; props?: boolean; draft?: boolean; textures?: boolean }
  /** Rebuild of a changed copy (AI previews, thumbnails) next to the open design: shares its cached steps, never changes them. */
  | { type: "sandbox"; seq: number; doc: MeercadDocument }
  /** `parts`: names and colours to write with each part (XCAF), by body id. */
  | { type: "export_step"; seq: number; bodies?: string[]; parts?: StepPart[] }
  /** Fine triangles for STL/3MF (the display meshes are too coarse to print or mill from). */
  | { type: "export_mesh"; seq: number; bodies?: string[] }
  /** Session settings: `meshCoarse` loosens tessellation (touch devices, where meshing is slow). */
  | { type: "configure"; seq: number; meshCoarse: number }
  /** Volume and surface area of the last rebuild's bodies, after a rebuild that skipped them. */
  | { type: "props"; seq: number }
  | { type: "measure"; seq: number; a: PickRef; b?: PickRef }
  /** Gaps between parts in a pose of the mechanism (see tools.clearances). */
  | { type: "clearance"; seq: number; moving: string[]; poses: Record<string, number[]>; within?: number; skip?: string[]; rigid?: Record<string, number> }
  /** Views for a technical drawing, with hidden lines (see drawing.ts). */
  /** `doc` builds the drawing from that document instead of the open one (threads simplified, see model/drawing). */
  | { type: "drawing"; seq: number; views: ViewName[]; bodies?: string[]; doc?: MeercadDocument };

export type WorkerResponse =
  | { type: "ready"; initMs: number; threads: boolean }
  | { type: "fatal"; message: string }
  /** OCCT broke (a WebAssembly runtime error) while handling `seq`: the worker must be replaced. */
  | { type: "crashed"; seq: number; message: string; threads: boolean }
  | { type: "rebuilt"; seq: number; report: RebuildReport; meshes: BodyMesh[]; references: ReferenceView[] }
  /** A rebuild is about to compute feature `index` of `total` (features from cache are skipped). */
  | { type: "progress"; seq: number; index: number; total: number; feature: string }
  | { type: "exported"; seq: number; data: Uint8Array }
  | { type: "exported_mesh"; seq: number; meshes: BodyMesh[] }
  | { type: "measured"; seq: number; result: Measurement }
  | { type: "clearances"; seq: number; result: Clearance[] }
  | { type: "drawn"; seq: number; views: DrawingView[] }
  | { type: "configured"; seq: number }
  | { type: "props"; seq: number; bodies: BodySummary[] }
  | { type: "failed"; seq: number; message: string };
