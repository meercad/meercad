import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const common = { bundle: true, platform: "node", target: "node20", external: ["electron"], logLevel: "warning" };
await build({ ...common, entryPoints: ["src/main.ts"], format: "cjs", outfile: "dist/main.cjs" });
await build({ ...common, entryPoints: ["src/preload.ts"], format: "cjs", outfile: "dist/preload.cjs" });

// The iCloud helper (Node-API, so one universal binary works with any Electron version).
if (process.platform === "darwin") {
  const headers = dirname(createRequire(import.meta.url).resolve("node-api-headers/include/node_api.h"));
  mkdirSync("dist/native", { recursive: true });
  const r = spawnSync(
    "xcrun",
    ["clang++", "-std=c++17", "-ObjC++", "-fobjc-arc", "-O2", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=12.0", "-bundle", "-undefined", "dynamic_lookup", "-DNODE_GYP_MODULE_NAME=icloud", `-I${headers}`, "-framework", "Foundation", "native/icloud.mm", "-o", "dist/native/icloud.node"],
    { stdio: "inherit" },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
  // The photo helper (Apple's photogrammetry: Apple silicon, macOS 14), sharing its code with the iPad app.
  const photos = spawnSync("xcrun", ["swiftc", "-O", "-target", "arm64-apple-macos14", "../ios/ios/App/App/TerrainBuild.swift", "native/photos/main.swift", "-o", "dist/native/meercad-photos"], { stdio: "inherit" });
  if (photos.status !== 0) process.exit(photos.status ?? 1);
}
