/**
 * More picks for a step's selection fields (FeatureDialog.tsx handlePick), as the 3D view hands
 * them over: sketch regions and curves for profiles, lofts, ribs and sweeps; faces and parts to
 * align, mirror, thread, cut into or catch in; an axis from an edge for a turn; where text and a
 * spring stand. Picks made before a tool opens seed it. Each pick lands in the field as the step's
 * own data, and picking a thing again takes it out.
 */
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Pick } from "@meercad/viewport";
import {
  apply,
  cancelDialog,
  dialogPick,
  newProject,
  rebuildNow,
  setDialogField,
  startFeature,
  updateDraft,
  useApp,
} from "../store";
import { renderUi } from "../../test/ui";
import { FeatureDialog } from "./FeatureDialog";

const rect = (p: string, x: number, y: number, w: number, h: number): SketchEntity[] => [
  { id: `${p}1`, type: "point", x, y },
  { id: `${p}2`, type: "point", x: x + w, y },
  { id: `${p}3`, type: "point", x: x + w, y: y + h },
  { id: `${p}4`, type: "point", x, y: y + h },
  { id: `${p}a`, type: "line", p1: `${p}1`, p2: `${p}2` },
  { id: `${p}b`, type: "line", p1: `${p}2`, p2: `${p}3` },
  { id: `${p}c`, type: "line", p1: `${p}3`, p2: `${p}4` },
  { id: `${p}d`, type: "line", p1: `${p}4`, p2: `${p}1` },
];
const design: Feature[] = [
  {
    id: "sk1",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("b", 0, 0, 40, 20),
    constraints: [],
  },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  {
    id: "sk2",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("c", 60, 0, 10, 10),
    constraints: [],
  },
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 25, mode: "new_body" },
  // Two squares side by side above the parts: two regions, and lines to pick.
  { id: "pl1", op: "plane", base: { ref: "origin.XY" }, offset: 40 },
  {
    id: "sk3",
    op: "sketch",
    plane: { ref: "pl1" },
    entities: [...rect("q", 0, 0, 10, 10), ...rect("r", 20, 0, 10, 10)],
    constraints: [],
  },
];
const draft = <T,>() => useApp.getState().dialog!.feature as T;
let regions: string[] = [];
const out = () => useApp.getState().output!;

/** A pick of the face of `body` whose first tag starts with `tag`. */
function face(
  body: string,
  tag: string,
  point: [number, number, number],
  normal: [number, number, number] | null,
): Pick {
  const m = out().meshes.find((x) => x.bodyId === body)!;
  const i = m.faceTags.findIndex((t) => t[0]!.startsWith(tag));
  expect(i, `${body} ${tag}`).toBeGreaterThanOrEqual(0);

  return { kind: "face", bodyId: body, face: i, tags: m.faceTags[i]!, point, normal } as Pick;
}

/** A pick of the edge of `body` between the faces tagged `a` and `b`. */
function edge(body: string, a: string, b: string, point: [number, number, number]): Pick {
  const m = out().meshes.find((x) => x.bodyId === body)!;
  const fa = m.faceTags.findIndex((t) => t[0] === a);
  const fb = m.faceTags.findIndex((t) => t[0] === b);
  const e = m.edgeFaces.findIndex((f) => f.includes(fa) && f.includes(fb));
  expect(e).toBeGreaterThanOrEqual(0);

  return { kind: "edge", bodyId: body, edge: e, point } as Pick;
}

const curve = (sketchId: string, curveId: string): Pick =>
  ({ kind: "sketch_curve", sketchId, curveId, point: [0, 0, 40] }) as Pick;
const region = (key: string): Pick => ({ kind: "region", sketchId: "sk3", key, point: [5, 5, 40] }) as Pick;

const pick = async (p: Pick, field?: string) => {
  if (field) await act(async () => setDialogField(field));

  await act(async () => dialogPick!(p, false));
};

const open = async (op: Parameters<typeof startFeature>[0]) => act(async () => startFeature(op));

beforeAll(async () => {
  await newProject(undefined, "More picks");
  apply({ type: "add_features", features: design });
  await rebuildNow();
  regions = out()
    .report.sketches.find((s) => s.id === "sk3")!
    .regions.map((r) => r.key);
  expect(regions).toHaveLength(2);
});
// A spring's preview takes a while to build on a busy machine (a coverage run).
afterEach(async () => {
  await act(async () => cancelDialog());
  cleanup();
}, 60_000);

describe("picks for profiles and paths", () => {
  it("takes regions in and out of an extrusion's profile", async () => {
    renderUi(<FeatureDialog />);
    await open("extrude");
    // A new extrusion starts with every region of the last sketch: a pick takes one out...
    expect(draft<{ profile: unknown }>().profile).toMatchObject({ sketch: "sk3" });
    await pick(region(regions[0]!), "profile");
    expect(draft<{ profile: unknown }>().profile).toEqual({ sketch: "sk3", regions: [regions[1]] });
    // ...and back in; with none left the profile is empty.
    await pick(region(regions[0]!));
    expect(draft<{ profile: { regions: string[] } }>().profile.regions).toEqual([regions[1], regions[0]]);
    await pick(region(regions[0]!));
    await pick(region(regions[1]!));
    expect(draft<{ profile: unknown }>().profile).toEqual({ sketch: "" });
    // A curve of a sketch takes the whole sketch.
    await pick(curve("sk3", "qa"));
    expect(draft<{ profile: unknown }>().profile).toEqual({ sketch: "sk3" });
  });

  it("lines up a loft's profiles in the order picked", async () => {
    renderUi(<FeatureDialog />);
    await open("loft");
    await pick(region(regions[1]!), "profiles");
    await pick(curve("sk1", "ba"));
    await pick(face("ex2", "ex2.end_cap", [65, 5, 25], [0, 0, 1]));

    const ps = draft<{ profiles: unknown[] }>().profiles;
    expect(ps.slice(0, 2)).toEqual([{ sketch: "sk3", regions: [regions[1]] }, { sketch: "sk1" }]);
    expect(ps[2]).toMatchObject({ face: expect.anything() });
    await pick(curve("sk1", "ba"));
    expect(draft<{ profiles: unknown[] }>().profiles).toHaveLength(2);
  });

  it("takes rib lines and a sweep's path from one sketch, starting over in another", async () => {
    renderUi(<FeatureDialog />);
    await open("rib");
    await pick(curve("sk3", "qa"), "curves");
    await pick(curve("sk3", "qb"));
    expect(draft<{ sketch: string; curves: string[] }>()).toMatchObject({
      sketch: "sk3",
      curves: ["qa", "qb"],
    });
    await pick(curve("sk1", "ba"));
    expect(draft<{ sketch: string; curves: string[] }>()).toMatchObject({ sketch: "sk1", curves: ["ba"] });
    await pick(curve("sk1", "ba"));
    expect(draft<{ sketch: string }>().sketch).toBe("");
    expect(draft<{ curves?: string[] }>().curves).toBeUndefined();
    await act(async () => cancelDialog());
    await open("sweep");
    await pick(curve("sk3", "ra"), "path");
    await pick(curve("sk3", "rb"));
    expect(draft<{ path: unknown }>().path).toEqual({ sketch: "sk3", curves: ["ra", "rb"] });
    await pick(curve("sk3", "ra"));
    await pick(curve("sk3", "rb"));
    expect(draft<{ path: unknown }>().path).toEqual({ sketch: "" });
  });
});

describe("picks of faces and parts", () => {
  it("aligns a face to another: flat ones mate, then the field moves on", async () => {
    renderUi(<FeatureDialog />);
    await open("align");
    await pick(face("ex2", "ex2.start_cap", [65, 5, 0], [0, 0, -1]), "from");
    expect(draft<{ from: unknown }>().from).toMatchObject({ face: expect.anything() });
    expect(useApp.getState().dialog!.field).toBe("to");
    await pick(face("ex1", "ex1.end_cap", [20, 10, 10], [0, 0, 1]));
    expect(draft<{ to: unknown }>().to).toMatchObject({ face: expect.anything() });
    // A round face lines up by its axis.
    await pick(face("ex1", "ex1.side", [0, 10, 5], null), "to");
    expect(draft<{ to: unknown }>().to).toMatchObject({ axisOf: expect.anything() });
  });

  it("threads a face, cuts into chosen parts, catches a hook in a part, converts a part", async () => {
    renderUi(<FeatureDialog />);
    await open("thread");
    await pick(face("ex2", "ex2.side", [70, 5, 10], [1, 0, 0]), "face");
    expect(draft<{ face: unknown }>().face).toBeTruthy();
    await act(async () => cancelDialog());
    await open("extrude");
    await pick(face("ex2", "ex2.end_cap", [65, 5, 25], [0, 0, 1]), "targets");
    await pick(face("ex1", "ex1.end_cap", [5, 5, 10], [0, 0, 1]));
    expect(draft<{ targets: string[] }>().targets).toEqual(["ex2", "ex1"]);
    await pick(face("ex2", "ex2.end_cap", [65, 5, 25], [0, 0, 1]));
    expect(draft<{ targets: string[] }>().targets).toEqual(["ex1"]);
    await act(async () => cancelDialog());
    await open("snap_hook");
    await pick(face("ex2", "ex2.end_cap", [65, 5, 25], [0, 0, 1]), "catchIn");
    expect(draft<{ catchIn: string[] }>().catchIn).toEqual(["ex2"]);
    await act(async () => cancelDialog());
    await open("mesh_convert" as never);
    await pick(face("ex1", "ex1.end_cap", [5, 5, 10], [0, 0, 1]), "body");
    expect(draft<{ body: string }>().body).toBe("ex1");
  });

  it("mirrors the steps of a picked face, or whole parts", async () => {
    renderUi(<FeatureDialog />);
    await open("mirror");
    await act(async () => updateDraft({ source: { features: [] } } as Partial<Feature>));
    await pick(face("ex2", "ex2.end_cap", [65, 5, 25], [0, 0, 1]), "source");
    expect(draft<{ source: unknown }>().source).toEqual({ features: ["ex2"] });
    await act(async () => updateDraft({ source: { bodies: [] } } as Partial<Feature>));
    await pick(face("ex1", "ex1.end_cap", [5, 5, 10], [0, 0, 1]));
    expect(draft<{ source: unknown }>().source).toEqual({ bodies: ["ex1"] });
  });

  it("turns parts about an edge picked as the axis", async () => {
    renderUi(<FeatureDialog />);
    await open("transform");
    await act(async () =>
      updateDraft({ bodies: ["ex2"], rotate: { axis: { ref: "origin.Z" }, angle: 90 } } as Partial<Feature>),
    );
    await pick(edge("ex1", "ex1.end_cap", "ex1.side[sk1.ba]", [20, 0, 10]), "axis");
    expect(draft<{ rotate: { axis: unknown } }>().rotate.axis).toMatchObject({ edge: expect.anything() });
  });

  it("stands text and a spring where the face was tapped", async () => {
    renderUi(<FeatureDialog />);
    await open("text");
    await pick(face("ex1", "ex1.end_cap", [12.345, 6.789, 10], [0, 0, 1]), "plane");
    expect(draft<{ position: number[] }>().position).toEqual([12.35, 6.79]);
    await act(async () => cancelDialog());
    await open("spring");
    // Two coils: quick to build.
    await act(async () => updateDraft({ coils: 2 } as Partial<Feature>));
    // The text's preview (its letters split the top) has gone once the spring's is built.
    await act(async () => void (await rebuildNow()));
    await pick(face("ex1", "ex1.end_cap", [30, 5, 10], [0, 0, 1]), "plane");
    expect(draft<{ center: number[] }>().center).toEqual([30, 5]);
  }, 60_000);
});

describe("picks made before the tool opens", () => {
  it("make a whole selected part the parts to move, or the mirror's source", async () => {
    renderUi(<FeatureDialog />);

    const all = out()
      .meshes.find((m) => m.bodyId === "ex2")!
      .faceTags.map(
        (tags, i) =>
          ({ kind: "face", bodyId: "ex2", face: i, tags, point: [65, 5, 25], normal: null }) as Pick,
      );
    useApp.setState({ selection: all });
    await open("transform");
    expect(draft<{ bodies: string[] }>().bodies).toEqual(["ex2"]);
    expect(useApp.getState().selection).toEqual([]);
    await act(async () => cancelDialog());
    useApp.setState({ selection: all });
    await open("mirror");
    expect(draft<{ source: unknown }>().source).toEqual({ bodies: ["ex2"] });
  });

  it("seed a new step's first field: edges picked first are the fillet's", async () => {
    renderUi(<FeatureDialog />);
    useApp.setState({ selection: [edge("ex1", "ex1.end_cap", "ex1.side[sk1.ba]", [20, 0, 10])] });
    await open("fillet");
    expect(draft<{ edges: unknown[] }>().edges).toHaveLength(1);
    expect(useApp.getState().selection).toEqual([]);
  });
});
