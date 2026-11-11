// What the kernel keeps for an open design besides OCCT's own memory: the wrapper objects of every
// step's state by kind, and the JavaScript memory of the kernel. Usage (from tests/):
//   NODE_OPTIONS=--expose-gc ../node_modules/.bin/jiti bench/kernel-objects.ts file.meercad [--profile]
// --profile also lists the code whose JavaScript objects are still alive after the build.
import { readFileSync } from "node:fs";
import { Session } from "node:inspector";
import { Arena, KernelSession, loadOcct } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";

const oc = await loadOcct();
const gc = (globalThis as { gc?: () => void }).gc;
const mem = () => {
  gc?.();
  const u = process.memoryUsage();
  return `js ${(u.heapUsed / 2 ** 20).toFixed(0)} MB, process ${(u.rss / 2 ** 20).toFixed(0)} MB, kernel heap ${((oc as unknown as { wasmMemory: { buffer: ArrayBuffer } }).wasmMemory.buffer.byteLength / 2 ** 20).toFixed(0)} MB`;
};
const all = new Set<Arena>();
const track = Arena.prototype.track;
Arena.prototype.track = function <T extends { delete(): void }>(this: Arena, o: T): T {
  all.add(this);
  return track.call(this, o) as T;
};
const s = new KernelSession(oc, await SketchSolver.create());
s.meshCoarse = 2;
const doc = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as MeercadDocument;
delete doc.versions;
console.log("before:", mem());
const insp = process.argv.includes("--profile") ? new Session() : null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const post = (m: string, p?: object) => new Promise<any>((res, rej) => insp!.post(m as never, p as never, (e: Error | null, r: unknown) => (e ? rej(e) : res(r))));
if (insp) {
  insp.connect();
  await post("HeapProfiler.startSampling", { samplingInterval: 32768 });
}
const t = performance.now();
s.rebuild(doc, { props: false });
console.log(`built in ${((performance.now() - t) / 1000).toFixed(1)} s:`, mem());
const c = new Map<string, number>();
for (const a of all) if (a.size) a.census(c);
console.log([...c].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", "));
if (insp) {
  gc?.();
  const { profile } = await post("HeapProfiler.getSamplingProfile");
  const by = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (n: any, up: string) => {
    const here = `${n.callFrame.functionName || "(anon)"} ${String(n.callFrame.url).split("/").slice(-1)[0]}:${n.callFrame.lineNumber + 1}`;
    // Built-ins (create, set, push) count for the code that called them.
    const name = n.callFrame.url ? here : `${here.split(" ")[0]} < ${up}`;
    if (n.selfSize) by.set(name, (by.get(name) ?? 0) + n.selfSize);
    for (const c of n.children) walk(c, n.callFrame.url ? here : up);
  };
  walk(profile.head, "");
  for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`${(v / 2 ** 20).toFixed(0).padStart(5)} MB  ${k}`);
}
process.exit(0);
