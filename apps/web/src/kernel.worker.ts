import { startKernelWorker } from "@meercad/kernel/worker";
import gcsUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import occtThreadsUrl from "replicad-opencascadejs/multi/wasm?url";
import occtUrl from "replicad-opencascadejs/wasm?url";

// The page names the worker "kernel-threads" to ask for the multi-threaded OCCT build (see store.ts).
const threads = self.name === "kernel-threads" && self.crossOriginIsolated;
// "kernel-reserve" (iPhone and iPad): without threads, and with its memory taken at once, as growing
// it later copies it there (see reserveHeap). 1.5 GB is about what the page may hold at all.
const reserve = self.name === "kernel-reserve" ? 1536 * 2 ** 20 : undefined;
startKernelWorker(self as unknown as Parameters<typeof startKernelWorker>[0], { occt: occtUrl, occtThreads: threads ? occtThreadsUrl : undefined, planegcs: gcsUrl, ...(reserve ? { reserve } : {}) });
