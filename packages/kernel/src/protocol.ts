import type { OpencadDocument } from "@opencad/schema";
import type { BodyMesh } from "./mesh.js";
import type { RebuildReport } from "./session.js";

export type WorkerRequest =
  | { type: "rebuild"; seq: number; doc: OpencadDocument; mesh?: boolean }
  /** Rebuild in a throw-away session (AI sandbox); never touches the main session's cache. */
  | { type: "sandbox"; seq: number; doc: OpencadDocument };

export type WorkerResponse =
  | { type: "ready"; initMs: number }
  | { type: "fatal"; message: string }
  | { type: "rebuilt"; seq: number; report: RebuildReport; meshes: BodyMesh[] }
  | { type: "failed"; seq: number; message: string };
