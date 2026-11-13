// One boolean step of a design with OCCT's options switched: oriented boxes (OBB) as the first
// filter of face pairs, parallel mode. The design is built up to the step, then the step's boolean
// runs again with each setting.
// Usage (from tests/): ../node_modules/.bin/jiti bench/boolean-options.ts file.meercad stepId [--threads]
import { readFileSync } from "node:fs";
import { KernelSession, loadOcct } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";

const threads = process.argv.includes("--threads");
const [file, step] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const oc = await loadOcct(undefined, threads);
const solver = await SketchSolver.create();
const doc = JSON.parse(readFileSync(file!, "utf8")) as MeercadDocument;
const at = doc.features.findIndex((f) => f.id === step);
const f = doc.features[at] as { op: string; operation?: string; target?: string; tools?: string[] };
if (f.op !== "boolean") throw new Error(`${step} is no boolean step`);
const s = new KernelSession(oc, solver);
s.rebuild({ ...doc, features: doc.features.slice(0, at) }, { mesh: false, props: false });
const bodies = s.state!.bodies;
const target = bodies.get(f.target!)!.shape;
const tools = f.tools!.map((t) => bodies.get(t)!.shape);
const Algo = f.operation === "union" ? oc.BRepAlgoAPI_Fuse : f.operation === "subtract" ? oc.BRepAlgoAPI_Cut : oc.BRepAlgoAPI_Common;
const run = (obb: boolean) => {
  const algo = new Algo();
  const list = (xs: typeof tools) => {
    const l = new oc.NCollection_List_TopoDS_Shape();
    for (const x of xs) l.Append(x);
    return l;
  };
  algo.SetArguments(list([target]));
  algo.SetTools(list(tools));
  algo.SetUseOBB(obb);
  const t = performance.now();
  algo.Build(new oc.Message_ProgressRange());
  const ms = performance.now() - t;
  const props = new oc.GProp_GProps();
  oc.BRepGProp.VolumeProperties(algo.Shape(), props, false, false, false);
  console.log(`${step} ${f.operation} obb=${obb}${threads ? " threads" : ""}: ${(ms / 1000).toFixed(1)} s, ok ${algo.IsDone() && !algo.HasErrors()}, volume ${props.Mass().toFixed(1)}`);
};
run(false);
run(true);
run(false);
run(true);
process.exit(0);
