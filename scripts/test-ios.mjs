#!/usr/bin/env node
// The iPhone and iPad UI tests (apps/ios/uitests): builds the web app and the iOS app for the
// Simulator, installs it on test simulators of its own (never the ones a person or another run
// uses), and runs the touch tests there with XCUITest: real taps, double taps, drags and pinches.
//
//   pnpm test:ios                        iPad and iPhone
//   pnpm test:ios --device ipad          one of them
//   pnpm test:ios --only TouchTests/testDoubleTapsAndPinchesNeverZoomTheInterface
//   pnpm test:ios --skip-build           reuse the last build (only the tests changed)
//
// Results: test-results/ios/<device>.xcresult (open in Xcode for screenshots of failures).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);
const out = join(root, "test-results/ios");
const derived = join(out, "DerivedData");
mkdirSync(out, { recursive: true });

const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
const DEVICES = {
  ipad: { name: "meerCAD UITest iPad", type: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB" },
  iphone: { name: "meerCAD UITest iPhone", type: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro-Max" },
};
const which = (arg("device") ?? "ipad,iphone").split(",");

const run = (cmd, args, opts = {}) => {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  return r.status === 0;
};
const must = (cmd, args, opts) => {
  if (!run(cmd, args, opts)) {
    console.error(`failed: ${cmd} ${args.join(" ")}`);
    process.exit(1);
  }
};

/** The test simulator's id, created the first time. */
function simulator({ name, type }) {
  const list = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "-j"], { encoding: "utf8" }));
  for (const devs of Object.values(list.devices)) for (const d of devs) if (d.name === name && d.isAvailable) return d.udid;
  return execFileSync("xcrun", ["simctl", "create", name, type, RUNTIME], { encoding: "utf8" }).trim();
}

const appPath = join(derived, "Build/Products/Debug-iphonesimulator/App.app");
if (!flag("skip-build") || !existsSync(appPath)) {
  must("pnpm", ["--filter", "@meercad/web", "build"]);
  must("npx", ["cap", "sync", "ios"], { cwd: join(root, "apps/ios") });
  must("xcodebuild", ["-project", "apps/ios/ios/App/App.xcodeproj", "-scheme", "App", "-configuration", "Debug", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", derived, "CODE_SIGNING_ALLOWED=NO", "-quiet", "build"]);
}

const results = [];
for (const key of which) {
  const dev = DEVICES[key];
  if (!dev) throw new Error(`unknown device ${key} (ipad, iphone)`);
  const udid = simulator(dev);
  spawnSync("xcrun", ["simctl", "boot", udid]);
  must("xcrun", ["simctl", "bootstatus", udid, "-b"]);
  // A fresh install each run: no projects or settings left from the last one.
  spawnSync("xcrun", ["simctl", "uninstall", udid, "app.meercad"]);
  must("xcrun", ["simctl", "install", udid, appPath]);
  const bundle = join(out, `${key}.xcresult`);
  rmSync(bundle, { recursive: true, force: true });
  const only = arg("only");
  const ok = run("xcodebuild", [
    "-project", "apps/ios/uitests/MeercadUITests.xcodeproj",
    "-scheme", "MeercadUITests",
    "-destination", `id=${udid}`,
    "-derivedDataPath", join(out, "DerivedData-tests"),
    "-resultBundlePath", bundle,
    "CODE_SIGN_IDENTITY=-", "CODE_SIGN_STYLE=Manual", "DEVELOPMENT_TEAM=",
    ...(only ? [`-only-testing:MeercadUITests/${only}`] : []),
    "test",
  ]);
  results.push([key, ok]);
  if (!flag("keep-running")) spawnSync("xcrun", ["simctl", "shutdown", udid]);
}

console.log("\n=== iOS UI tests\n");
for (const [k, ok] of results) console.log(`${k.padEnd(8)} ${ok ? "ok" : "FAILED"}  (test-results/ios/${k}.xcresult)`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
