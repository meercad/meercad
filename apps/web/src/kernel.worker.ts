import { startKernelWorker } from "@meercad/kernel/worker";
import gcsUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import occtThreadsUrl from "replicad-opencascadejs/multi/wasm?url";
import occtUrl from "replicad-opencascadejs/wasm?url";

// The page names the worker "kernel-threads" to ask for the multi-threaded OCCT build (see store.ts).
const threads = self.name === "kernel-threads" && self.crossOriginIsolated;
startKernelWorker(self as unknown as Parameters<typeof startKernelWorker>[0], { occt: occtUrl, occtThreads: threads ? occtThreadsUrl : undefined, planegcs: gcsUrl });
