import type { OpenCascadeInstance } from "replicad-opencascadejs";

export type OC = OpenCascadeInstance;

/**
 * Loads the OCCT WASM module. In the browser pass `wasmUrl` (e.g. from Vite's `?url` import);
 * in Node the module finds its .wasm next to the JS file.
 *
 * `threads` loads the pthreads build instead (same API). It needs SharedArrayBuffer, so in the
 * browser only a cross-origin isolated page can use it; it starts one thread per logical core and
 * meshing (BRepMesh) then runs in parallel. Booleans are switched to parallel mode as well.
 */
export async function loadOcct(wasmUrl?: string, threads = false): Promise<OC> {
  if (threads) exposeSharedArrayBuffer();
  const { default: init } = threads ? await import("replicad-opencascadejs/multi") : await import("replicad-opencascadejs");
  const oc = await init(wasmUrl ? { locateFile: () => wasmUrl } : {});
  if (threads) oc.BOPAlgo_Options.SetParallelMode(true);
  return oc;
}

/**
 * In the iPad app (a cross-origin isolated `capacitor://` page) WebKit leaves out the global
 * `SharedArrayBuffer` constructor, although shared wasm memory and Atomics work. The pthreads build
 * refuses to start a thread without that global, and OCCT then waits forever for its thread pool.
 * The constructor is reachable through a shared memory's buffer, so put it back.
 */
function exposeSharedArrayBuffer(): void {
  const scope = globalThis as { SharedArrayBuffer?: unknown };
  if (scope.SharedArrayBuffer) return;
  scope.SharedArrayBuffer = new WebAssembly.Memory({ initial: 0, maximum: 0, shared: true }).buffer.constructor;
}

/** Converts whatever OCCT threw (C++ exceptions arrive as WebAssembly.Exception) into a message. */
export function occtErrorMessage(oc: OC, e: unknown): string {
  const WasmException = (globalThis as { WebAssembly?: { Exception?: new (...a: never[]) => object } }).WebAssembly?.Exception;
  if (WasmException && e instanceof WasmException) {
    try {
      const [type, message] = oc.getExceptionMessage(e as Parameters<OC["getExceptionMessage"]>[0]);
      return message ? `${type}: ${message}` : type;
    } catch {
      return "OCCT exception";
    }
  }
  return e instanceof Error ? e.message : String(e);
}
