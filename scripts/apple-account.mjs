#!/usr/bin/env node
/**
 * Moves the iPhone, iPad and Mac app to another Apple developer team: new team id, bundle id and,
 * with it, iCloud container ("iCloud.<bundle id>"). Every place that names them is rewritten at
 * once, so the apps keep sharing one App Store record and one iCloud Drive folder.
 *
 *   node scripts/apple-account.mjs --team ABCDE12345 --bundle-id com.example.meercad
 *
 * Afterwards, outside the repo: certificates of the new team in the keychain, provisioning profiles
 * in ~/.appstoreconnect/certs/, and the new team's API key and app id in ~/.appstoreconnect/meercad.json.
 * iCloud containers cannot move between teams: files in the old container stay with the old app.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name) => {
  const i = process.argv.indexOf(name);

  return i > 0 ? process.argv[i + 1] : undefined;
};

const team = arg("--team");
const bundle = arg("--bundle-id");

if (!team || !/^[A-Z0-9]{10}$/.test(team) || !bundle || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(bundle)) {
  console.error(
    "usage: node scripts/apple-account.mjs --team <10-character team id> --bundle-id <reverse.dns.id>",
  );
  process.exit(1);
}

const xcodePath = "apps/ios/ios/App/App.xcodeproj/project.pbxproj";
const xcode = readFileSync(join(root, xcodePath), "utf8");
const oldTeam = /DEVELOPMENT_TEAM = (\w+);/.exec(xcode)?.[1];
const oldBundle = /PRODUCT_BUNDLE_IDENTIFIER = ([\w.-]+);/.exec(xcode)?.[1];
if (!oldTeam || !oldBundle) throw new Error(`no team or bundle id in ${xcodePath}`);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Replaces whole identifiers only, so "dev.meercad.app" does not touch "dev.meercad.app.wip" or ".rc". */
const swap = (text, from, to) =>
  text.replace(new RegExp(`(?<![\\w.~-])${escape(from)}(?![\\w-]|\\.\\w)`, "g"), to);
const cloudPath = (id) => `iCloud~${id.replaceAll(".", "~")}`;

const files = [
  xcodePath,
  "apps/ios/capacitor.config.json",
  "apps/ios/ios/App/App/capacitor.config.json",
  "apps/ios/ios/App/App/App.entitlements",
  "apps/ios/ios/App/App/Info.plist",
  "apps/desktop/package.json",
  "apps/desktop/build/entitlements.mas.plist",
  "apps/desktop/src/main.ts",
  "scripts/install-mac.mjs",
  "scripts/mas.mjs",
  "packages/mcp/src/launchApp.ts",
  "packages/mcp/src/launchApp.test.ts",
];

for (const file of files) {
  // Generated files (capacitor.config.json in the Xcode project) exist only after a sync.
  if (!existsSync(join(root, file))) continue;

  const before = readFileSync(join(root, file), "utf8");
  let text = swap(before, `${oldTeam}.${oldBundle}`, `${team}.${bundle}`);
  text = swap(text, `iCloud.${oldBundle}`, `iCloud.${bundle}`);
  text = swap(text, `${oldBundle}.wip`, `${bundle}.wip`);
  text = swap(text, `${oldBundle}.rc`, `${bundle}.rc`);
  text = swap(text, oldBundle, bundle);
  text = text.replaceAll(cloudPath(oldBundle), cloudPath(bundle));
  text = swap(text, oldTeam, team);

  if (text !== before) {
    writeFileSync(join(root, file), text);
    console.log(`✓ ${file}`);
  }
}

console.log(`team ${oldTeam} → ${team}, bundle id ${oldBundle} → ${bundle}`);
