#!/usr/bin/env node
/**
 * Builds the sandboxed Mac App Store version of meerCAD and uploads it to App Store Connect, where it
 * goes to the TestFlight testers on the Mac and later into the App Store. Same app record and bundle
 * id as the iPhone and iPad app, so one purchase covers every device.
 *
 * Signing material never lives in the repo. On this Mac:
 *
 *   Keychain: "Apple Distribution" and "3rd Party Mac Developer Installer" (upload),
 *             "Apple Development" (--dev), each of the team in the Xcode project
 *   ~/.appstoreconnect/certs/meerCAD_Mac_App_Store.provisionprofile
 *   ~/.appstoreconnect/certs/meerCAD_Mac_Development.provisionprofile   (--dev)
 *   ~/.appstoreconnect/meercad.json + private_keys/AuthKey_<KEYID>.p8   (upload, as for pnpm testflight;
 *             "appId" is the app's Apple ID from App Store Connect)
 *
 * Team and bundle id come from the iOS Xcode project, so both apps always ship as the same app
 * (scripts/apple-account.mjs switches them all at once).
 *
 *   pnpm mas              build the .pkg and upload it
 *   pnpm mas --no-upload  build the .pkg only
 *   pnpm mas --dev        build a development-signed copy and open it, to try the sandbox on this Mac
 *
 * Each build gets a fresh build number (UTC date and time); the version shown in the store stays VERSION.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.0";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const certs = join(homedir(), ".appstoreconnect", "certs");
const dev = process.argv.includes("--dev");
const upload = !dev && !process.argv.includes("--no-upload");

const run = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();

const xcode = readFileSync(join(root, "apps/ios/ios/App/App.xcodeproj/project.pbxproj"), "utf8");
const TEAM = /DEVELOPMENT_TEAM = (\w+);/.exec(xcode)?.[1];
const APP_ID = /PRODUCT_BUNDLE_IDENTIFIER = ([\w.-]+);/.exec(xcode)?.[1];
if (!TEAM || !APP_ID) fail("no DEVELOPMENT_TEAM or PRODUCT_BUNDLE_IDENTIFIER in the Xcode project");

/** The keychain certificate of this kind that belongs to the team (its OU), by common name. */
function identity(kind) {
  let pem = "";

  try {
    pem = execFileSync("security", ["find-certificate", "-a", "-c", kind, "-p"], { encoding: "utf8" });
  } catch {
    // none of this kind
  }

  for (const p of pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) {
    const c = new X509Certificate(p);
    const field = (k) => new RegExp(`^${k}=(.+)$`, "m").exec(c.subject)?.[1];
    if (field("OU") === TEAM && new Date(c.validTo) > new Date()) return field("CN").replace(`${kind}: `, "");
  }

  fail(`no valid "${kind}" certificate of team ${TEAM} in the keychain`);
}

const profile = join(
  certs,
  dev ? "meerCAD_Mac_Development.provisionprofile" : "meerCAD_Mac_App_Store.provisionprofile",
);
if (!existsSync(profile)) fail(`provisioning profile not found: ${profile}`);

let auth = [];
let ascApp = "";

if (upload) {
  const c = JSON.parse(readFileSync(join(homedir(), ".appstoreconnect", "meercad.json"), "utf8"));

  if (!c.keyId || !c.issuerId || !c.appId) {
    fail("~/.appstoreconnect/meercad.json needs keyId, issuerId and appId");
  }

  // altool finds the key file in ~/.appstoreconnect/private_keys by its id.
  auth = ["--apiKey", c.keyId, "--apiIssuer", c.issuerId];
  ascApp = String(c.appId);
}

const d = new Date();
const build = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()]
  .map((n, i) => String(n).padStart(i ? 2 : 4, "0"))
  .join("");
const sha = git("rev-parse", "--short", "HEAD") + (git("status", "--porcelain") ? "-dirty" : "");

console.log("› building web app, MCP server and desktop shell");
run("pnpm", ["--filter", "@meercad/web", "build"]);
run("pnpm", ["--filter", "@meercad/mcp", "build"]);
run("node", ["build.mjs"], desktop);

// The MCP server as a Claude Desktop extension: the sandboxed app cannot write Claude's config, so
// "Add to Claude Desktop" opens this file and Claude installs it (it brings its own Node). One per
// store channel, each with its own name and port, so a TestFlight build is added next to the App
// Store one instead of replacing it (see CHANNEL_PORTS and CHANNEL_MCP_NAMES in packages/mcp).
const work = mkdtempSync(join(tmpdir(), "meercad-mas-"));
const protocol = readFileSync(join(root, "packages/mcp/src/protocol.ts"), "utf8");
const extensions = [
  { name: "meercad", display: "meerCAD", port: 47821, channel: "prod" },
  { name: "meercad-testflight", display: "meerCAD TestFlight", port: 47824, channel: "testflight" },
];
const mcpbs = [];

for (const x of extensions) {
  if (
    !new RegExp(`\\b${x.channel}: ${x.port}\\b`).test(protocol) &&
    !(x.channel === "prod" && /prod: DEFAULT_PORT/.test(protocol) && /DEFAULT_PORT = 47821/.test(protocol))
  ) {
    fail(`port ${x.port} of ${x.channel} is not the one in packages/mcp/src/protocol.ts`);
  }

  const ext = join(work, x.name);
  mkdirSync(join(ext, "server"), { recursive: true });
  copyFileSync(join(root, "packages/mcp/dist/server.js"), join(ext, "server", "server.js"));
  copyFileSync(join(desktop, "build", "icon.png"), join(ext, "icon.png"));
  writeFileSync(
    join(ext, "manifest.json"),
    `${JSON.stringify(
      {
        manifest_version: "0.3",
        name: x.name,
        display_name: x.display,
        version: `${VERSION}.0`,
        description: `Lets Claude design parts in the ${x.display} app on this Mac: sketches, features, parameters, renders and exports.`,
        author: { name: "Torben Berger UG (haftungsbeschränkt)" },
        icon: "icon.png",
        server: {
          type: "node",
          entry_point: "server/server.js",
          mcp_config: {
            command: "node",
            args: ["${__dirname}/server/server.js"],
            env: { MEERCAD_MCP_PORT: String(x.port), MEERCAD_APP: "app.meercad" },
          },
        },
        compatibility: { platforms: ["darwin"] },
      },
      null,
      2,
    )}\n`,
  );

  const mcpb = join(work, `${x.name}.mcpb`);
  run("zip", ["-qrX", mcpb, "manifest.json", "icon.png", "server"], ext);
  mcpbs.push({ from: mcpb, to: `${x.name}.mcpb` });
}

// Development builds talk to the iCloud development environment.
let entitlements = "build/entitlements.mas.plist";

if (dev) {
  entitlements = join(work, "entitlements.mas-dev.plist");
  writeFileSync(
    entitlements,
    readFileSync(join(desktop, "build/entitlements.mas.plist"), "utf8").replace(
      "<string>Production</string>",
      "<string>Development</string>",
    ),
  );
}

const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
const iosInfo = readFileSync(join(root, "apps/ios/ios/App/App/Info.plist"), "utf8");

if (!iosInfo.includes("<string>meerCAD</string>")) {
  fail("the iOS Info.plist no longer names the iCloud folder meerCAD; keep both apps in step");
}

const { identity: _adHoc, ...mac } = pkg.build.mac;
const signing = {
  hardenedRuntime: false,
  entitlements,
  entitlementsInherit: "build/entitlements.mas.inherit.plist",
  provisioningProfile: profile,
};
const config = {
  ...pkg.build,
  appId: APP_ID,
  directories: { ...pkg.build.directories, output: "release-mas" },
  // The FSL text belongs to the source, not to the App Store app.
  extraResources: [...pkg.build.extraResources.filter((r) => r.from !== "../../LICENSE"), ...mcpbs],
  asarUnpack: ["dist/native/**"],
  mac: {
    ...mac,
    target: [{ target: dev ? "mas-dev" : "mas", arch: ["universal"] }],
    bundleShortVersion: VERSION,
    bundleVersion: build,
    // Copied as is when the two architectures are merged: the .node helpers are already universal,
    // the photo helper is Apple silicon only (Apple's photogrammetry needs it).
    x64ArchFiles: "**/native/{*.node,meercad-photos}",
    extendInfo: {
      ElectronTeamID: TEAM,
      ITSAppUsesNonExemptEncryption: false,
      // Same iCloud Drive folder as the iPhone and iPad app.
      NSUbiquitousContainers: {
        [`iCloud.${APP_ID}`]: {
          NSUbiquitousContainerIsDocumentScopePublic: true,
          NSUbiquitousContainerName: "meerCAD",
          NSUbiquitousContainerSupportedFolderLevels: "Any",
        },
      },
    },
  },
  ...(dev
    ? { masDev: { ...signing, type: "development", identity: identity("Apple Development") } }
    : { mas: { ...signing, type: "distribution", identity: identity("Apple Distribution") } }),
  extraMetadata: { version: `${VERSION}.0`, buildSha: sha },
};
delete config.dmg;

const configFile = join(work, "electron-builder.json");
writeFileSync(configFile, JSON.stringify(config, null, 2));

const outDir = join(desktop, "release-mas");
rmSync(outDir, { recursive: true, force: true });
console.log(
  `› packaging meerCAD ${VERSION} (${build}, ${sha}) for the Mac App Store${dev ? ", development signed" : ""}`,
);
run(
  "pnpm",
  ["exec", "electron-builder", "--mac", "--universal", "--config", configFile, "--publish", "never"],
  desktop,
);

const find = (dir, test) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (test(e.name)) return p;

    if (e.isDirectory() && !e.name.endsWith(".app")) {
      const hit = find(p, test);
      if (hit) return hit;
    }
  }

  return null;
};

if (dev) {
  const app = find(outDir, (n) => n === "meerCAD.app");
  if (!app) fail(`no meerCAD.app in ${outDir}`);

  run("codesign", ["--verify", "--deep", "--strict", app]);
  if (!process.argv.includes("--no-open")) run("open", [app]);

  console.log(`✓ ${app}`);
  process.exit(0);
}

const pkgFile = find(outDir, (n) => n.endsWith(".pkg"));
if (!pkgFile) fail(`no .pkg in ${outDir}`);

console.log(`✓ built ${pkgFile}`);
if (!upload) process.exit(0);

console.log("› uploading to App Store Connect");
run("xcrun", [
  "altool",
  "--upload-package",
  pkgFile,
  "--type",
  "macos",
  "--apple-id",
  ascApp,
  "--bundle-id",
  APP_ID,
  "--bundle-version",
  build,
  "--bundle-short-version-string",
  VERSION,
  ...auth,
]);
console.log(`✓ uploaded build ${build}; it appears in TestFlight (macOS) once Apple has processed it`);
