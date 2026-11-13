// The fresh kernel taking over in the real Mac app (a private copy): with the limit set low, a few
// changes to a big design must make it take over, and the design must go on working after it.
// Usage (from tests/): ../node_modules/.bin/jiti bench/app-renew.ts file.meercad featureId [featureId …]
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { startApp } from "../e2e/app.js";
import { sleep } from "../e2e/cdp.js";

const [file, ...edits] = process.argv.slice(2);
const app = await startApp();

try {
  copyFileSync(file!, join(app.dir, "projects", "Bench.meercad"));

  const { page } = app;
  // Renew as soon as the kernel holds more than 100 MB: after the first build.
  await page.eval(`localStorage.setItem("meercad.kernel.renew", "100")`);
  await page.eval("location.reload()");
  await sleep(4000);

  for (let i = 0; i < 100 && !(await page.eval<boolean>("!!window.meercadTest").catch(() => false)); i++) {
    await sleep(250);
  }

  await page.eval("meercadTest.store.refreshProjects()");

  const id = await page.eval<string>(
    "meercadTest.app.getState().projects.find((p) => p.name === 'Bench').id",
  );

  const call = async (label: string, method: string, params: object = {}) => {
    const r = await page.eval<{ ms: number; note: string }>(`(async () => {
      const t0 = performance.now();
      try {
        const r = await meercadTest.mcp(${JSON.stringify(method)}, ${JSON.stringify(params)});
        return { ms: performance.now() - t0, note: (r.featuresOk ?? "?") + " ok, " + (r.features ?? []).filter((f) => f.status === "error").length + " errors" };
      } catch (e) {
        return { ms: performance.now() - t0, note: String(e) };
      }
    })()`);
    const state = await page.eval<string>(
      `(() => { const k = meercadTest.store.kernel; const o = meercadTest.app.getState().output; return "renewed " + k.renewed + "×, " + o.meshes.length + " meshes shown, " + o.meshes.reduce((n, m) => n + m.indices.length / 3, 0) + " triangles"; })()`,
    );
    console.log(`${label.padEnd(34)} ${(r.ms / 1000).toFixed(1).padStart(7)} s  ${r.note}; ${state}`);
  };

  await call("open_project", "open_project", { id });

  for (let round = 0; round < 2; round++) {
    for (const f of edits) {
      const patch = await page.eval<Record<string, unknown>>(`(() => {
        const f = meercadTest.store.currentDoc().features.find((x) => x.id === ${JSON.stringify(f)});
        for (const k of ["size", "diameter", "height", "radius", "distance", "depth", "length"]) {
          const v = f[k];
          if (typeof v === "number") return { [k]: v + 0.1 };
          if (Array.isArray(v) && typeof v[0] === "number") return { [k]: [v[0] + 0.1, ...v.slice(1)] };
        }
        throw new Error("no number to change on " + f.id);
      })()`);
      await call(`apply_ops edit ${f}`, "apply_ops", { ops: [{ type: "edit_feature", id: f, patch }] });
    }

    // Time for the fresh kernel to build the design and take over.
    console.log("waiting 45 s");
    await sleep(45000);
  }

  await call("render_view", "render_view", { width: 400, height: 300 });

  const errors = page.takeErrors();
  console.log(errors.length ? `page errors: ${errors.slice(0, 8).join(" | ")}` : "no page errors");
} finally {
  await app.stop();
}

process.exit(0);
