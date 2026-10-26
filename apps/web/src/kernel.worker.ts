import { startKernelWorker } from "@opencad/kernel/worker";
import wasmUrl from "replicad-opencascadejs/wasm?url";

startKernelWorker(self as unknown as Parameters<typeof startKernelWorker>[0], wasmUrl);
