// Measures what MCP answers cost: starts a private dev copy of the Mac app (own ports, app data and
// projects in a temp folder, never the user's), drives it through packages/mcp/dist/server.js and
// logs size (chars, picture bytes) and time of every call while building corpus models step by step
// and in one call.  Usage: node packages/mcp/scripts/bench.mjs [label]  (LOOK=1 adds apply_ops look,
// IMG=1 saves the pictures; results go to $TMPDIR/meercad-bench/<label>.json)
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = process.env.ROOT ?? resolve(import.meta.dirname, "../../..");
const OUT = join(tmpdir(), "meercad-bench");
mkdirSync(OUT, { recursive: true });

const label = process.argv[2] ?? "run";
const { Client } = await import(
  join(ROOT, "packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")
);
const { StdioClientTransport } = await import(
  join(ROOT, "packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js")
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

async function waitFor(what, fn, ms = 90000) {
  const end = Date.now() + ms;

  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}

    if (Date.now() > end) throw new Error("timeout " + what);

    await sleep(300);
  }
}

const dir = mkdtempSync(join(tmpdir(), "meercad-bench-app-"));
mkdirSync(join(dir, "shared"), { recursive: true });

// Terms of use accepted (apps/web/src/lib/terms.ts: raise the version here with TERMS_VERSION;
// tests/terms.test.ts checks it).
const termsAccepted = {
  version: "2026-11-12",
  acceptedAt: new Date().toISOString(),
  appVersion: "bench",
  lang: "en",
  points: ["hobby", "accuracy", "check", "safety", "ai", "risk"],
};
writeFileSync(join(dir, "shared", "shared.json"), JSON.stringify({ tourDone: true, termsAccepted }));

const [webPort, cdpPort, mcpPort] = [await freePort(), await freePort(), await freePort()];

if (spawnSync("node", ["build.mjs"], { cwd: join(ROOT, "apps/desktop"), stdio: "inherit" }).status) {
  throw new Error("desktop build");
}

if (spawnSync("node", ["build.mjs"], { cwd: join(ROOT, "packages/mcp"), stdio: "inherit" }).status) {
  throw new Error("mcp build");
}

const vite = spawn(
  join(ROOT, "apps/web/node_modules/.bin/vite"),
  ["--port", String(webPort), "--strictPort", "--host", "127.0.0.1"],
  { cwd: join(ROOT, "apps/web"), stdio: "ignore" },
);
const devUrl = `http://127.0.0.1:${webPort}`;
await waitFor("vite", async () => (await fetch(devUrl)).ok);

const electron = spawn(
  join(ROOT, "apps/desktop/node_modules/.bin/electron"),
  [
    ".",
    "--dev",
    `--user-data-dir=${join(dir, "userdata")}`,
    `--remote-debugging-port=${cdpPort}`,
    "--lang=en-US",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
  ],
  {
    cwd: join(ROOT, "apps/desktop"),
    env: {
      ...process.env,
      MEERCAD_DEV_URL: devUrl,
      MEERCAD_PROJECTS_DIR: join(dir, "projects"),
      MEERCAD_MCP_BRIDGE: "off",
      MEERCAD_SHARED_DIR: join(dir, "shared"),
    },
    stdio: "ignore",
  },
);

let cleanup = () => {
  try {
    electron.kill();
    vite.kill();
  } catch {}
};

process.on("exit", () => {
  cleanup();
  spawnSync("sleep", ["2"]);

  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

try {
  const target = await waitFor("window", async () =>
    (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find(
      (t) => t.type === "page" && t.url.startsWith(devUrl),
    ),
  );
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok) => ws.addEventListener("open", ok));

  let n = 0;
  const pend = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));

    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    }
  });

  const cdp = (method, params = {}) =>
    new Promise((ok) => {
      const id = ++n;
      pend.set(id, ok);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expr) =>
    (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result
      ?.result?.value;
  await waitFor("load", () => ev("document.readyState === 'complete' && !!window.meercadTest"));
  await ev(
    `sessionStorage.setItem("meercad.mcp.port", "${mcpPort}"); location.href = ${JSON.stringify(devUrl)}; true`,
  );
  await sleep(1500);
  await waitFor("reload", () =>
    ev("document.readyState === 'complete' && !location.search.includes('bridge=off')"),
  );

  const client = new Client({ name: "bench", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [join(ROOT, "packages/mcp/dist/server.js")],
      env: { ...process.env, MEERCAD_MCP_PORT: String(mcpPort), MEERCAD_NO_LAUNCH: "1" },
      stderr: "ignore",
    }),
  );

  const toolsChars = JSON.stringify((await client.listTools()).tools).length;
  const log = [];

  const call = async (name, args = {}, tag = name) => {
    const t = Date.now();
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
    const ms = Date.now() - t;
    let chars = 0,
      img = 0;
    for (const c of r.content) c.type === "text" ? (chars += c.text.length) : (img += c.data.length);

    const sample = r.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("")
      .slice(0, 700);

    for (const [i, c] of r.content.entries()) {
      if (c.type === "image" && process.env.IMG) {
        writeFileSync(
          join(OUT, `${tag.replace(/[^a-z0-9]+/gi, "_")}_${i}.png`),
          Buffer.from(c.data, "base64"),
        );
      }
    }

    log.push({ tag, ms, chars, img, err: !!r.isError, sample });
    if (r.isError) console.error("ERR", tag, r.content[0].text.slice(0, 300));

    return r;
  };

  await waitFor(
    "connected",
    async () =>
      JSON.parse((await client.callTool({ name: "status", arguments: {} })).content[0].text).connected ===
      true,
  );
  await call("get_guide");
  await call(
    "get_guide",
    { schema: ["sketch", "extrude", "plane", "transform", "set_joint"] },
    "get_guide schema",
  );

  for (const file of ["feature-16-enclosure-with-lid", "feature-23-four-bar-linkage"]) {
    const doc = JSON.parse(readFileSync(join(ROOT, "tests/corpus", `${file}.meercad.json`), "utf8"));
    await call("new_project", { name: `bench ${file}` }, `${file}: new_project`);

    // Step by step, as assistants usually build: params, then one feature per call, then joints.
    for (const f of doc.features) {
      await call("apply_ops", { ops: [{ type: "add_features", features: [f] }] }, `${file}: add ${f.id}`);
    }

    for (const j of doc.mechanism?.joints ?? []) {
      await call("apply_ops", { ops: [{ type: "set_joint", joint: j }] }, `${file}: joint ${j.id}`);
    }

    await call("get_model", {}, `${file}: get_model`);
    await call("render_view", { view: "iso", width: 800, height: 600 }, `${file}: render_view`);
    await call("undo", {}, `${file}: undo`);
    await call("redo", {}, `${file}: redo`);
  }

  // One model in a single batched call.
  const doc = JSON.parse(
    readFileSync(join(ROOT, "tests/corpus/feature-16-enclosure-with-lid.meercad.json"), "utf8"),
  );
  await call("new_project", { name: "bench batch" }, "batch: new_project");
  await call(
    "apply_ops",
    { ops: [{ type: "add_features", features: doc.features }] },
    "batch: all in one apply_ops",
  );
  await call("render_view", { view: "iso", width: 800, height: 600 }, "batch: render_view");

  if (process.env.LOOK) {
    await call("new_project", { name: "bench look" }, "look: new_project");
    await call(
      "apply_ops",
      { ops: [{ type: "add_features", features: doc.features }], look: { view: "iso" } },
      "look: apply_ops + picture",
    );
    await call(
      "preview_ops",
      {
        ops: [{ type: "edit_feature", id: doc.features[0].id, patch: { name: "x" } }],
        look: { view: "front" },
      },
      "look: preview_ops + picture",
    );

    const bad = await call(
      "apply_ops",
      { ops: [{ type: "set_param", name: "zz", expr: "3" }], look: { view: "nope" } },
      "look: bad option",
    );
    const after = await call("get_model", {}, "look: get_model after bad");
    console.log(
      "bad look:",
      bad.content[0].text.slice(0, 200),
      "| param applied anyway:",
      after.content[0].text.includes('"zz"'),
    );
  }

  await call("status", {}, "status");

  const total = log.reduce((a, r) => ({ ms: a.ms + r.ms, chars: a.chars + r.chars }), { ms: 0, chars: 0 });
  writeFileSync(join(OUT, `${label}.json`), JSON.stringify({ toolsChars, total, log }, null, 1));
  console.log(JSON.stringify({ toolsChars, total }));

  for (const r of log) {
    console.log(
      String(r.ms).padStart(6),
      String(r.chars).padStart(7),
      r.img ? `img${r.img}` : "",
      r.err ? "ERR" : "",
      r.tag,
    );
  }

  await client.close();
} finally {
  cleanup();
}

process.exit(0);
