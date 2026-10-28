import type { MeercadDocument } from "@meercad/schema";
import type { BodyMesh, BodySummary } from "./mesh.js";
import type { RebuildReport, ReferenceView } from "./session.js";
import type { Measurement, PickRef } from "./tools.js";

export type WorkerRequest =
  /** `props: false` skips volume and surface area (previews while dragging). */
  | { type: "rebuild"; seq: number; doc: MeercadDocument; mesh?: boolean; props?: boolean }
  /** Rebuild in a throw-away session (AI sandbox, previews); never touches the main session's cache. */
  | { type: "sandbox"; seq: number; doc: MeercadDocument }
  | { type: "export_step"; seq: number; bodies?: string[] }
  /** Fine triangles for STL/3MF (the display meshes are too coarse to print or mill from). */
  | { type: "export_mesh"; seq: number; bodies?: string[] }
  /** Session settings: `meshCoarse` loosens tessellation (touch devices, where meshing is slow). */
  | { type: "configure"; seq: number; meshCoarse: number }
  /** Volume and surface area of the last rebuild's bodies, after a rebuild that skipped them. */
  | { type: "props"; seq: number }
  | { type: "measure"; seq: number; a: PickRef; b?: PickRef };

export type WorkerResponse =
  | { type: "ready"; initMs: number; threads: boolean }
  | { type: "fatal"; message: string }
  | { type: "rebuilt"; seq: number; report: RebuildReport; meshes: BodyMesh[]; references: ReferenceView[] }
  | { type: "exported"; seq: number; data: Uint8Array }
  | { type: "exported_mesh"; seq: number; meshes: BodyMesh[] }
  | { type: "measured"; seq: number; result: Measurement }
  | { type: "configured"; seq: number }
  | { type: "props"; seq: number; bodies: BodySummary[] }
  | { type: "failed"; seq: number; message: string };
