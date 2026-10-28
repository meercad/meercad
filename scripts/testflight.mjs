#!/usr/bin/env node
/**
 * Builds the iOS app from the working tree and uploads it to App Store Connect for TestFlight, so a
 * new version reaches the iPhone and iPad wherever they are (no cable, no shared network).
 *
 * Signs with the team in the Xcode project (automatic signing) and authenticates with an App Store
 * Connect API key. The key never lives in the repo; set it up once on this Mac:
 *
 *   ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8   the key file downloaded from App Store Connect
 *   ~/.appstoreconnect/meercad.json                      { "keyId": "<KEYID>", "issuerId": "<ISSUER>" }
 *
 * (or ASC_KEY_ID, ASC_ISSUER_ID and optionally ASC_KEY_PATH in the environment).
 *
 *   pnpm testflight             build and upload
 *   pnpm testflight --no-upload build and export the .ipa only (checks signing)
 *
 * Each upload gets a fresh build number (UTC date and time), so builds never collide.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = join(root, "apps/ios/ios/App/App.xcodeproj");
const upload = !process.argv.includes("--no-upload");

const run = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

// API key: environment first, then ~/.appstoreconnect/meercad.json.
const ascDir = join(homedir(), ".appstoreconnect");
let keyId = process.env.ASC_KEY_ID;
let issuerId = process.env.ASC_ISSUER_ID;
let keyPath = process.env.ASC_KEY_PATH;
const configFile = join(ascDir, "meercad.json");
if ((!keyId || !issuerId) && existsSync(configFile)) {
  const c = JSON.parse(readFileSync(configFile, "utf8"));
  keyId ??= c.keyId;
  issuerId ??= c.issuerId;
  keyPath ??= c.keyPath;
}
if (!keyId || !issuerId) fail(`no App Store Connect API key: put { "keyId", "issuerId" } in ${configFile} (see the top of this script)`);
keyPath ??= join(ascDir, "private_keys", `AuthKey_${keyId}.p8`);
if (!existsSync(keyPath)) fail(`API key file not found: ${keyPath}`);
const auth = ["-allowProvisioningUpdates", "-authenticationKeyPath", keyPath, "-authenticationKeyID", keyId, "-authenticationKeyIssuerID", issuerId];

const team = /DEVELOPMENT_TEAM = (\w+);/.exec(readFileSync(join(project, "project.pbxproj"), "utf8"))?.[1];
if (!team) fail("no DEVELOPMENT_TEAM in the Xcode project");
const d = new Date();
const build = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()].map((n, i) => String(n).padStart(i ? 2 : 4, "0")).join("");

const work = mkdtempSync(join(tmpdir(), "meercad-testflight-"));
const archive = join(work, "meerCAD.xcarchive");
const options = join(work, "ExportOptions.plist");
writeFileSync(
  options,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>${upload ? "upload" : "export"}</string>
  <key>teamID</key><string>${team}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
`,
);

console.log(`› building the web app into the iOS project (build ${build})`);
run("pnpm", ["--filter", "meercad-ios", "sync"]);

console.log("› archiving");
run("xcodebuild", ["-project", project, "-scheme", "App", "-configuration", "Release", "-destination", "generic/platform=iOS", "-archivePath", archive, `CURRENT_PROJECT_VERSION=${build}`, ...auth, "-quiet", "archive"]);

console.log(upload ? "› uploading to App Store Connect" : "› exporting the .ipa");
run("xcodebuild", ["-exportArchive", "-archivePath", archive, "-exportOptionsPlist", options, "-exportPath", join(work, "export"), ...auth]);

console.log(upload ? `✓ build ${build} uploaded; it shows up in TestFlight once App Store Connect has processed it (usually 5–15 min)` : `✓ build ${build} exported to ${join(work, "export")}`);
