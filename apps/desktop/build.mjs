import { build } from "esbuild";

const common = { bundle: true, platform: "node", target: "node20", external: ["electron"], logLevel: "warning" };
await build({ ...common, entryPoints: ["src/main.ts"], format: "cjs", outfile: "dist/main.cjs" });
await build({ ...common, entryPoints: ["src/preload.ts"], format: "cjs", outfile: "dist/preload.cjs" });
