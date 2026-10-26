import type { OpenCascadeInstance } from "replicad-opencascadejs";

export type OC = OpenCascadeInstance;

/**
 * Loads the OCCT WASM module. In the browser pass `wasmUrl` (e.g. from Vite's `?url` import);
 * in Node the module finds its .wasm next to the JS file.
 */
export async function loadOcct(wasmUrl?: string): Promise<OC> {
  const { default: init } = await import("replicad-opencascadejs");
  return init(wasmUrl ? { locateFile: () => wasmUrl } : {});
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
