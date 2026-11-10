// Opening and editing a big design in the real Mac app (a private copy, tests/e2e/app.ts): time to
// the first picture and to the finished build, on first opening, on opening again (kept result) and
// after changes early, in the middle and late in the timeline. The file is copied, never changed.
// Usage (from tests/): node <jiti-cli> bench/app-open.ts file.meercad [featureId …]
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { startApp } from "../e2e/app.js";
import { sleep } from "../e2e/cdp.js";

const [file, ...edits] = process.argv.slice(2);
const app = await startApp();
try {
  copyFileSync(file!, join(app.dir, "projects", "Bench.meercad"));
  const { page } = app;
  await page.eval("meercadTest.store.refreshProjects()");
  const id = await page.eval<string>("meercadTest.app.getState().projects.find((p) => p.name === 'Bench').id");

  // Resolves once a rebuild started by `start` has finished: first output shown, and finished.
  const measure = (start: string) =>
    page.eval<{ first: number; done: number; kernel?: number; mesh?: number; tris: number; transfer?: number }>(`new Promise((res) => {
      const { app, store } = meercadTest;
      const t0 = performance.now();
      const before = app.getState().output;
      let first = 0, started = false;
      ${start};
      const iv = setInterval(() => {
        const s = app.getState();
        if (!first && s.output && s.output !== before) first = performance.now() - t0;
        started ||= s.building || store.rebuilding();
        if (started && !s.building && !store.rebuilding() && s.output && s.output !== before) {
          clearInterval(iv);
          const r = s.output.report;
          res({ first, done: performance.now() - t0, kernel: r.rebuildMs, mesh: r.meshMs, tris: s.output.meshes.reduce((n, m) => n + m.indices.length / 3, 0), transfer: r.timing && r.timing.received - r.timing.post });
        }
      }, 50);
    })`);
  const show = (name: string, r: Awaited<ReturnType<typeof measure>>) =>
    console.log(`${name.padEnd(28)} first ${(r.first / 1000).toFixed(1).padStart(6)} s  done ${(r.done / 1000).toFixed(1).padStart(6)} s  kernel ${((r.kernel ?? 0) / 1000).toFixed(1)} s  mesh ${((r.mesh ?? 0) / 1000).toFixed(1)} s  transfer ${((r.transfer ?? 0) / 1000).toFixed(1)} s  tris ${r.tris}`);

  show("open (first time)", await measure(`void store.openProject(${JSON.stringify(id)})`));
  // The kept result is written once things are quiet.
  await sleep(20000);
  await page.eval("meercadTest.store.goHome()");
  await page.eval(`meercadTest.store.closeTab(${JSON.stringify(id)}, false)`);
  await sleep(2000);
  show("open again (kept result)", await measure(`void store.openProject(${JSON.stringify(id)})`));
  for (const f of edits) {
    // A small change of the feature's first number (size, diameter, height, …).
    const patch = await page.eval<Record<string, unknown>>(`(() => {
      const f = meercadTest.store.currentDoc().features.find((x) => x.id === ${JSON.stringify(f)});
      for (const k of ["size", "diameter", "height", "radius", "distance", "depth", "length"]) {
        const v = f[k];
        if (typeof v === "number") return { [k]: v + 0.1 };
        if (Array.isArray(v) && typeof v[0] === "number") return { [k]: [v[0] + 0.1, ...v.slice(1)] };
      }
      throw new Error("no number to change on " + f.id);
    })()`);
    const index = await page.eval<number>(`meercadTest.store.currentDoc().features.findIndex((x) => x.id === ${JSON.stringify(f)})`);
    show(`edit #${index} ${f}`, await measure(`store.apply({ type: "edit_feature", id: ${JSON.stringify(f)}, patch: ${JSON.stringify(patch)} })`));
  }
  const errors = page.takeErrors();
  if (errors.length) console.log("page errors:", errors.slice(0, 5));
} finally {
  await app.stop();
}
process.exit(0);
