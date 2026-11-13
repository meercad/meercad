// What an assistant's calls cost on a big design, in the real Mac app (a private copy, tests/e2e/app.ts):
// opening, a small change, saving a version, exports, pictures. The file is copied, never changed.
// Usage (from tests/): ../node_modules/.bin/jiti bench/app-mcp.ts file.meercad featureId [featureId …]
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { startApp } from "../e2e/app.js";

const [file, ...edits] = process.argv.slice(2);
const app = await startApp();

try {
  copyFileSync(file!, join(app.dir, "projects", "Bench.meercad"));

  const { page } = app;
  await page.eval("meercadTest.store.refreshProjects()");

  const id = await page.eval<string>(
    "meercadTest.app.getState().projects.find((p) => p.name === 'Bench').id",
  );

  /** One call as the bridge serves it: seconds, size of the answer, and a few words of it. */
  const call = async (label: string, method: string, params: object = {}, show = "") => {
    const r = await page.eval<{ ms: number; chars: number; note: string; error?: string }>(`(async () => {
      const t0 = performance.now();
      try {
        const r = await meercadTest.mcp(${JSON.stringify(method)}, ${JSON.stringify(params)});
        const text = JSON.stringify(r) ?? "";
        const note = ${show ? `String((${show})(r))` : '""'};
        return { ms: performance.now() - t0, chars: text.length, note };
      } catch (e) {
        return { ms: performance.now() - t0, chars: 0, note: "", error: String(e) };
      }
    })()`);
    console.log(
      `${label.padEnd(34)} ${(r.ms / 1000).toFixed(1).padStart(7)} s  ${String(r.chars).padStart(9)} chars  ${r.error ?? r.note}`,
    );

    return r;
  };

  const memory = async () =>
    console.log(
      "  memory:",
      await page.eval<string>(
        `(() => { const m = performance.memory; return m ? Math.round(m.usedJSHeapSize / 2 ** 20) + " MB JS heap" : "?"; })()`,
      ),
    );
  const counts =
    "(r) => (r.featuresOk ?? '?') + ' ok, ' + (r.parts ?? r.bodies?.length ?? '?') + ' parts named, ' + (r.unchangedBodies ?? '?') + ' unchanged'";

  await call("open_project", "open_project", { id }, counts);
  await memory();
  await call("get_model", "get_model");

  for (const f of edits) {
    // A small change of the step's first number (size, diameter, height, …).
    const patch = await page.eval<Record<string, unknown>>(`(() => {
      const f = meercadTest.store.currentDoc().features.find((x) => x.id === ${JSON.stringify(f)});
      for (const k of ["size", "diameter", "height", "radius", "distance", "depth", "length", "slack"]) {
        const v = f[k];
        if (typeof v === "number") return { [k]: v + 0.1 };
        if (Array.isArray(v) && typeof v[0] === "number") return { [k]: [v[0] + 0.1, ...v.slice(1)] };
      }
      throw new Error("no number to change on " + f.id);
    })()`);
    const index = await page.eval<number>(
      `meercadTest.store.currentDoc().features.findIndex((x) => x.id === ${JSON.stringify(f)})`,
    );
    await call(
      `apply_ops edit #${index} ${f}`,
      "apply_ops",
      { ops: [{ type: "edit_feature", id: f, patch }] },
      counts,
    );
  }

  await memory();
  await call(
    "apply_ops save_version",
    "apply_ops",
    { ops: [{ type: "save_version", name: "bench" }] },
    counts,
  );
  await call("render_view", "render_view", { width: 800, height: 600 });
  await call("export 3mf (whole model)", "export", { format: "3mf", stage: true });
  await call("export 3mf again", "export", { format: "3mf", stage: true });
  await call("check_clearance", "check_clearance");

  const joint = await page.eval<string | null>(
    `(meercadTest.store.currentDoc().mechanism?.joints ?? []).find((j) => j.type === "revolute" && !j.suppressed)?.id ?? null`,
  );

  if (joint) {
    await call(
      `check_motion ${joint} 0→20, 6 steps`,
      "check_motion",
      { joint, from: 0, to: 20, steps: 6 },
      "(r) => (r.firstContact ? 'contact at ' + r.firstContact.value : 'no contact') + ', ' + r.smallest.length + ' pairs'",
    );
  }

  const part = await page.eval<string>(`meercadTest.app.getState().output.report.bodies[0].id`);
  await call(
    `check_interference parts [${part}]`,
    "check_interference",
    { parts: [part] },
    "(r) => r.overlaps.length + ' overlaps, ' + r.touching.length + ' touching' + (r.unchecked ? ', ' + r.unchecked + ' unchecked' : '')",
  );
  await call(
    "check_interference (all, 60 s)",
    "check_interference",
    { seconds: 60 },
    "(r) => r.overlaps.length + ' overlaps, ' + r.touching.length + ' touching' + (r.unchecked ? ', ' + r.unchecked + ' unchecked' : '')",
  );
  await memory();

  const errors = page.takeErrors();
  if (errors.length) console.log("page errors:", errors.slice(0, 8));
} finally {
  await app.stop();
}

process.exit(0);
