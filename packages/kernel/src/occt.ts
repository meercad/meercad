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

  const { default: init } = threads
    ? await import("replicad-opencascadejs/multi")
    : await import("replicad-opencascadejs");
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

  scope.SharedArrayBuffer = new WebAssembly.Memory({
    initial: 0,
    maximum: 0,
    shared: true,
  }).buffer.constructor;
}

/**
 * Makes the module's memory `bytes` big at once (less if that much is refused), and says how big.
 *
 * On the iPhone and iPad growing a WebAssembly memory copies it: at 1 GB it is there twice for a
 * moment, the page passes what the system allows it (about 1.6 GB above its idle size, measured on
 * an iPhone 18 Pro Max) and is ended. A big design therefore died near the end of its first build,
 * whatever else was saved. Memory that is reserved but not yet written to costs nothing, so the
 * kernel takes its room while it is still small and never grows again below that size. (The
 * threaded build shares its memory, which is never moved, and needs none of this.)
 */
export function reserveHeap(oc: OC, bytes: number): number {
  const m = oc as unknown as {
    _emscripten_builtin_malloc?: (n: number) => number;
    _emscripten_builtin_free?: (p: number) => void;
    wasmMemory: { buffer: ArrayBuffer };
  };
  if (!m._emscripten_builtin_malloc || !m._emscripten_builtin_free) return 0;

  for (let n = bytes; n >= 256 * 2 ** 20; n -= 256 * 2 ** 20) {
    const p = m._emscripten_builtin_malloc(n);
    if (!p) continue;

    m._emscripten_builtin_free(p);

    return m.wasmMemory.buffer.byteLength;
  }

  return 0;
}

const crashes = new WeakMap<OC, string>();

/**
 * The WebAssembly runtime error (memory access out of bounds, null function) a module has thrown, if
 * any. After one its memory can no longer be trusted, so it must be replaced, not used on.
 */
export function crashOf(oc: OC): string | undefined {
  return crashes.get(oc);
}

/** Converts whatever OCCT threw (C++ exceptions arrive as WebAssembly.Exception) into a message. */
export function occtErrorMessage(oc: OC, e: unknown): string {
  const RuntimeError = (globalThis as { WebAssembly?: { RuntimeError?: new (...a: never[]) => Error } })
    .WebAssembly?.RuntimeError;
  if (RuntimeError && e instanceof RuntimeError && !crashes.has(oc)) crashes.set(oc, e.message);

  const WasmException = (globalThis as { WebAssembly?: { Exception?: new (...a: never[]) => object } })
    .WebAssembly?.Exception;

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
