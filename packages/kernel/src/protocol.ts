import type { MeercadDocument } from "@meercad/schema";
import type { BodyMesh } from "./mesh.js";
import type { RebuildReport, ReferenceView } from "./session.js";
import type { Measurement, PickRef } from "./tools.js";

export type WorkerRequest =
  /** `props: false` skips volume and surface area (previews while dragging). */
  | { type: "rebuild"; seq: number; doc: MeercadDocument; mesh?: boolean; props?: boolean }
  /** Rebuild in a throw-away session (AI sandbox, previews); never touches the main session's cache. */
  | { type: "sandbox"; seq: number; doc: MeercadDocument }
  | { type: "export_step"; seq: number; bodies?: string[] }
  | { type: "measure"; seq: number; a: PickRef; b?: PickRef };

export type WorkerResponse =
  | { type: "ready"; initMs: number }
  | { type: "fatal"; message: string }
  | { type: "rebuilt"; seq: number; report: RebuildReport; meshes: BodyMesh[]; references: ReferenceView[] }
  | { type: "exported"; seq: number; data: Uint8Array }
  | { type: "measured"; seq: number; result: Measurement }
  | { type: "failed"; seq: number; message: string };
