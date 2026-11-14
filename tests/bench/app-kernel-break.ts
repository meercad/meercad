// What a break of the geometry kernel costs afterwards, in the real Mac app (a private copy,
// tests/e2e/app.ts): a change and an export before, the kernel made to break as OCCT does, then the
// same again while the replacement works and after a multi-threaded kernel has taken over.
// The file is copied, never changed.
// Usage (from tests/): ../node_modules/.bin/jiti bench/app-kernel-break.ts file.meercad featureId
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { startApp } from "../e2e/app.js";
import { sleep } from "../e2e/cdp.js";

const [file, edit] = process.argv.slice(2);
const app = await startApp();

try {
  copyFileSync(file!, join(app.dir, "projects", "Bench.meercad"));

  const { page } = app;
  await page.eval("meercadTest.store.refreshProjects()");

  const id = await page.eval<string>(
    "meercadTest.app.getState().projects.find((p) => p.name === 'Bench').id",
  );

  const call = async (label: string, method: string, params: object = {}) => {
    const r = await page.eval<{ ms: number; error?: string }>(`(async () => {
      const t0 = performance.now();
      try {
        await meercadTest.mcp(${JSON.stringify(method)}, ${JSON.stringify(params)});
        return { ms: performance.now() - t0 };
      } catch (e) {
        return { ms: performance.now() - t0, error: String(e) };
      }
    })()`);
    console.log(`${label.padEnd(40)} ${(r.ms / 1000).toFixed(1).padStart(7)} s  ${r.error ?? ""}`);
  };

  let n = 0;
  // A small change of the step's distance, back and forth.
  let base = 0;
  const changeBy = (label: string) =>
    call(`${label}: change ${edit}`, "apply_ops", {
      ops: [{ type: "edit_feature", id: edit, patch: { distance: base + (++n % 2 ? 0.1 : 0) } }],
    });
  await call("open_project", "open_project", { id });
  base = await page.eval<number>(
    `meercadTest.store.currentDoc().features.find((x) => x.id === ${JSON.stringify(edit)}).distance`,
  );

  const one = await page.eval<string>("meercadTest.app.getState().output.report.bodies.at(-1).id");
  await changeBy("before");
  await call("before: export stl (one part)", "export", { format: "stl", parts: [one], stage: true });
  // As OCCT breaking in the multi-threaded worker reports it (KernelClient.crashed).
  await page.eval(
    `meercadTest.store.kernel.crashed({ type: "crashed", seq: -1, message: "memory access out of bounds (bench)", threads: true })`,
  );
  console.log(
    "kernel broken (as OCCT does), renewed:",
    await page.eval<number>("meercadTest.store.kernel.renewed"),
  );
  await changeBy("right after");
  await call("right after: export stl (one part)", "export", { format: "stl", parts: [one], stage: true });

  // Wait for the multi-threaded kernel to take over (it builds the design in the background).
  const t0 = Date.now();

  while ((await page.eval<number>("meercadTest.store.kernel.renewed")) < 1 && Date.now() - t0 < 600_000) {
    await sleep(1000);
  }

  console.log(
    `multi-threaded kernel took over after ${((Date.now() - t0) / 1000).toFixed(0)} s, renewed:`,
    await page.eval<number>("meercadTest.store.kernel.renewed"),
  );
  await changeBy("after take-over");
  await call("after take-over: export stl (one part)", "export", {
    format: "stl",
    parts: [one],
    stage: true,
  });

  const errors = page.takeErrors();
  if (errors.length) console.log("page errors:", errors.slice(0, 8));
} finally {
  await app.stop();
}

process.exit(0);
