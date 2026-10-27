// Upper bound for parallel booleans: a plate cut by an N x N grid of cylinders in one BRepAlgoAPI_Cut.
// Usage (from tests/): ../node_modules/.bin/jiti bench/boolean.ts single|multi
import { loadOcct } from "@meercad/kernel";
const oc: any = await loadOcct(undefined, process.argv[2] === "multi");
for (const n of [4, 10, 16]) {
  for (const par of [false, true]) {
    oc.BOPAlgo_Options.SetParallelMode(par);
    const times: number[] = [];
    for (let rep = 0; rep < 3; rep++) {
      const plate = new oc.BRepPrimAPI_MakeBox(n * 10, n * 10, 5).Shape();
      const tools = new oc.NCollection_List_TopoDS_Shape();
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const ax = new oc.gp_Ax2(new oc.gp_Pnt(5 + i * 10, 5 + j * 10, -1), new oc.gp_Dir(0, 0, 1));
        tools.Append(new oc.BRepPrimAPI_MakeCylinder(ax, 3, 7).Shape());
      }
      const args = new oc.NCollection_List_TopoDS_Shape();
      args.Append(plate);
      const t = performance.now();
      const cut = new oc.BRepAlgoAPI_Cut();
      cut.SetArguments(args);
      cut.SetTools(tools);
      cut.SetRunParallel(par);
      cut.Build(new oc.Message_ProgressRange());
      times.push(performance.now() - t);
      if (!cut.IsDone()) throw new Error("cut failed");
      cut.delete();
    }
    console.log(`${process.argv[2]} ${n}x${n} holes, parallel ${par}: ${Math.min(...times).toFixed(0)} ms`);
  }
}
process.exit(0);
