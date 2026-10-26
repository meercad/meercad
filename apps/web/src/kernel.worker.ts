import { startKernelWorker } from "@opencad/kernel/worker";
import gcsUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import occtUrl from "replicad-opencascadejs/wasm?url";

startKernelWorker(self as unknown as Parameters<typeof startKernelWorker>[0], { occt: occtUrl, planegcs: gcsUrl });
