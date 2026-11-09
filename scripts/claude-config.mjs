#!/usr/bin/env node
/**
 * Points Claude Desktop (and with it the Claude Code sessions that use its servers) at the two
 * side-by-side Mac builds: "meercad" → meerCAD RC, "meercad-wip" → meerCAD WIP. Each build's MCP
 * server talks to that build only (own port, see CHANNEL_PORTS), so an assistant working with
 * "meercad-wip" never touches the RC. Only builds installed in /Applications get an entry; every
 * other server stays as it is, and the previous file is kept as claude_desktop_config.json.bak.
 * Claude Desktop reads the file at start: restart it afterwards.
 *
 *   pnpm claude-config            write both entries
 *   pnpm claude-config --dry-run  show what would change
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const file = join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
const dry = process.argv.includes("--dry-run");

const entry = (name) => {
  const app = `/Applications/${name}.app`;
  if (!existsSync(app)) return null;
  return { command: `${app}/Contents/MacOS/${name}`, args: [`${app}/Contents/Resources/mcp/server.js`], env: { ELECTRON_RUN_AS_NODE: "1" } };
};
const wanted = { meercad: entry("meerCAD RC"), "meercad-wip": entry("meerCAD WIP") };
if (!wanted.meercad && !wanted["meercad-wip"]) {
  console.error("✗ neither meerCAD RC nor meerCAD WIP is installed (pnpm rc, pnpm wip)");
  process.exit(1);
}

const raw = existsSync(file) ? readFileSync(file, "utf8") : "{}";
const config = JSON.parse(raw);
const servers = { ...config.mcpServers };
for (const [key, value] of Object.entries(wanted)) {
  const before = JSON.stringify(servers[key] ?? null);
  if (!value) {
    console.log(`  ${key}: ${before === "null" ? "–" : "kept"} (app not installed)`);
    continue;
  }
  servers[key] = value;
  console.log(`  ${key}: ${before === JSON.stringify(value) ? "unchanged" : "→"} ${value.command}`);
}
if (dry) process.exit(0);
const next = `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`;
if (next === raw) {
  console.log("✓ Claude Desktop is already set up");
  process.exit(0);
}
mkdirSync(dirname(file), { recursive: true });
if (existsSync(file)) writeFileSync(`${file}.bak`, raw);
writeFileSync(file, next);
console.log(`✓ ${file} updated; restart Claude Desktop to connect`);
