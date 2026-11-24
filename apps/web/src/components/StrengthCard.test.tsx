/**
 * The strength check and the topology (StrengthCard.tsx, lib/strength.ts) on a real beam, 40 × 4 × 8
 * mm, held at one end and pushed down at the other: the faces are marked on the part; the check
 * gives the safety factor of the textbook; the topology is a new part linked to the beam, which is
 * shown as its shadow, or either alone, without the design being changed for it; a change to the
 * beam or the set-up makes the topology again by itself; the link survives closing the card and is
 * found again; wrong set-ups say why.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testCall } from "../lib/mcpBridge";
import {
  AUTO_DELAY_MS,
  checkNow,
  closeStrength,
  hasTopology,
  makeTopology,
  openStrength,
  outOfDate,
  setStrength,
  takeSelection,
  useStrength,
  viewedScene,
} from "../lib/strength";
import { apply, undo, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { StrengthCard } from "./StrengthCard";

const card = () => document.querySelector(".strength-card")?.textContent ?? "";
const beamMesh = () => useApp.getState().output!.meshes.find((mesh) => mesh.bodyId === "pr1")!;

/** The beam's face whose corners all have this x. */
function faceAt(x: number): number {
  const mesh = beamMesh();

  for (let r = 0; r < mesh.faceRanges.length; r += 3) {
    const corners = Array.from(
      mesh.indices.subarray(mesh.faceRanges[r]!, mesh.faceRanges[r]! + mesh.faceRanges[r + 1]!),
    );

    if (corners.every((corner) => Math.abs(mesh.positions[corner * 3]! - x) < 1e-6)) {
      return mesh.faceRanges[r + 2]!;
    }
  }

  throw new Error(`no face at x = ${x}`);
}

const select = (...faces: number[]) =>
  act(() =>
    useApp.setState({
      selection: faces.map((face) => ({
        kind: "face",
        bodyId: "pr1",
        face,
        tags: beamMesh().faceTags[face]!,
        point: [0, 0, 0],
        normal: null,
      })),
    }),
  );

const topologyData = () => {
  const feature = useApp.getState().doc.features.find((f) => f.id === useStrength.getState().topology);

  return feature?.op === "import" ? feature.data : undefined;
};

const settle = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

beforeAll(async () => {
  withScreen();
  localStorage.clear();
  await testCall("new_project", { name: "Strength" });
  apply({
    type: "add_features",
    features: [
      { id: "pr1", op: "primitive", shape: "box", size: [40, 4, 8], center: [20, 2, 4], mode: "new_body" },
    ],
  });
  await rebuilt();
  renderUi(<StrengthCard />);
});
afterAll(() => {
  closeStrength();
  cleanup();
});

describe("the strength card", () => {
  it("is closed until opened for a part, and asks for faces first", async () => {
    expect(card()).toBe("");
    await act(async () => openStrength("pr1"));
    // Cubes of 1 mm and few rounds, so the test is quick.
    await act(async () =>
      useStrength.setState({ cells: { check: 1280, fast: 1280, fine: 1280 }, steps: 16, share: 0.6 }),
    );
    expect(card()).toContain("Strength of");
    expect(card()).toContain("calculated as PLA");
    expect(card()).toContain("Select faces of the part");
    expect((screen.getByText("Check strength") as HTMLButtonElement).disabled).toBe(true);
    expect(useStrength.getState().maps.size).toBe(0);
  });

  it("takes the selected faces as held and as pushed, by name, and marks them on the part", async () => {
    await select(faceAt(0));
    await act(async () => void fireEvent.click(screen.getAllByText("Use selected faces")[0]!));
    await select(faceAt(40));
    await act(async () => void fireEvent.click(screen.getAllByText("Use selected faces")[1]!));

    const { holds, loads, maps } = useStrength.getState();

    expect(holds).toEqual([beamMesh().faceTags[faceAt(0)]!.join("|")]);
    expect(loads).toEqual([beamMesh().faceTags[faceAt(40)]!.join("|")]);
    expect(card()).toContain("Faces held: 1");
    expect(card()).toContain("Faces pushed: 1");
    // The part is laid over with its faces coloured.
    expect(maps.get("pr1")!.positions.length).toBe(beamMesh().indices.length * 3);
    expect((screen.getByText("Check strength") as HTMLButtonElement).disabled).toBe(false);
  });

  it("checks the beam: the safety factor of the textbook, the part coloured", async () => {
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Force in newtons"), { target: { value: "10" } });
      fireEvent.change(screen.getByLabelText("Direction of the force"), { target: { value: "-z" } });
      fireEvent.change(screen.getByLabelText("Layers stacked along"), { target: { value: "1" } });
    });
    await act(async () => void fireEvent.click(screen.getByText("Check strength")));
    await waitFor(() => expect(useStrength.getState().report).not.toBeNull(), { timeout: 20000 });

    // σ = F·L / (b·h² / 6) = 10 · 40 / (4 · 64 / 6) = 9.4 MPa against 50 MPa: a little over 5.
    const { report } = useStrength.getState();

    expect(report!.converged).toBe(true);
    expect(report!.safety).toBeGreaterThan(4);
    expect(report!.safety).toBeLessThan(8);
    expect(card()).toContain("This part: safety factor");

    // Another force: the result goes, the marks come back.
    await act(async () => setStrength({ direction: "into" }));
    expect(useStrength.getState().report).toBeNull();
    await act(async () => checkNow());
    // Pressed along its length the beam is far from its limit.
    expect(useStrength.getState().report!.safety).toBeGreaterThan(50);
    await act(async () => setStrength({ direction: "-z" }));
  });
});

describe("the topology", () => {
  it("is a new part linked to the beam; the design itself is not changed for the shadow", async () => {
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Share of material to keep, per cent"), {
        target: { value: "2" },
      });
      fireEvent.change(screen.getByLabelText("Share of material to keep, per cent"), {
        target: { value: "60" },
      });
      fireEvent.change(screen.getByLabelText("Detail of the topology"), { target: { value: "fine" } });
    });
    expect(useStrength.getState()).toMatchObject({ share: 0.6, detail: "fine" });
    await act(async () => void fireEvent.click(screen.getByText("Make topology")));
    await waitFor(() => expect(useStrength.getState().topology).not.toBeNull(), { timeout: 30000 });
    await rebuilt();

    const { topology, result } = useStrength.getState();
    const doc = useApp.getState().doc;

    expect(doc.features.find((feature) => feature.id === topology)).toMatchObject({
      op: "import",
      format: "stl",
      name: "Topology of Basic solid 1",
    });
    expect(doc.seeThrough ?? []).toEqual([]);
    expect(result!.share).toBeGreaterThan(0.4);
    expect(result!.share).toBeLessThan(0.8);
    expect(result!.after.converged).toBe(true);
    expect(card()).toContain("Topology: safety factor");
    expect(card()).toContain("Original: safety factor");
    expect(outOfDate()).toBe(false);
    expect(screen.getByText("Update topology")).toBeTruthy();
  }, 40000);

  it("is shown with the beam as its shadow, or either alone", async () => {
    const { topology } = useStrength.getState();
    const doc = useApp.getState().doc;
    const scene = () => viewedScene(doc, new Set(["x"]), useStrength.getState());

    expect(scene().doc.seeThrough).toEqual(["pr1"]);
    expect([...scene().hidden]).toEqual(["x"]);
    // As a shadow the beam carries no marks: they would cover the topology.
    expect(useStrength.getState().maps.size).toBe(0);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Original" })));
    expect(useStrength.getState().maps.has("pr1")).toBe(true);
    expect(scene().doc).toBe(doc);
    expect([...scene().hidden]).toEqual(["x", topology]);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Topology" })));
    expect([...scene().hidden]).toEqual(["x", "pr1"]);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Both" })));
    expect(useStrength.getState().view).toBe("both");
    // Without a topology in the design nothing is changed.
    expect(
      viewedScene({ ...doc, features: [] }, new Set(), useStrength.getState()).doc.seeThrough,
    ).toBeUndefined();
  });

  it("is made again by itself when the beam changes, the same part with a new shape", async () => {
    const before = topologyData();
    const features = useApp.getState().doc.features.length;

    apply({ type: "edit_feature", id: "pr1", patch: { size: [40, 4, 10], center: [20, 2, 5] } });
    await rebuilt();
    expect(outOfDate()).toBe(true);
    await settle(AUTO_DELAY_MS + 200);
    await waitFor(() => expect(topologyData()).not.toBe(before), { timeout: 30000 });
    await rebuilt();
    expect(useApp.getState().doc.features).toHaveLength(features);
    expect(outOfDate()).toBe(false);
    // The faces were found again by name on the changed beam.
    expect(card()).toContain("Faces held: 1");
  }, 40000);

  it("only says it is out of date when it is not kept up to date", async () => {
    const before = topologyData();

    await act(async () => void fireEvent.click(screen.getByLabelText("Keep up to date")));
    // Less material: another shape (a larger force alone would give the same one).
    await act(async () => setStrength({ share: 0.5 }));
    await settle(AUTO_DELAY_MS + 200);
    expect(useStrength.getState().running).toBeNull();
    expect(topologyData()).toBe(before);
    expect(card()).toContain("has changed since the topology was made");
    await act(async () => void fireEvent.click(screen.getByText("Update topology")));
    await waitFor(() => expect(topologyData()).not.toBe(before), { timeout: 30000 });
    expect(outOfDate()).toBe(false);
  }, 40000);

  it("stays linked with the card closed, and is found again from either part", async () => {
    const { topology } = useStrength.getState();

    await act(async () => void fireEvent.click(screen.getByTitle("Close")));
    expect(card()).toBe("");
    expect(useStrength.getState()).toMatchObject({ body: "pr1", topology, open: false });
    // Opened on the topology, the card shows the beam it was made from, with its set-up.
    await act(async () => openStrength(topology!));
    expect(useStrength.getState()).toMatchObject({
      body: "pr1",
      topology,
      share: 0.5,
      auto: false,
      open: true,
    });
    expect(card()).toContain("Faces pushed: 1");
  });

  it("says why when the part is not held, or gone", async () => {
    // A result of the model still on its way would clear the message again.
    await rebuilt();
    await settle(50);
    await act(async () => useStrength.setState({ holds: ["nothing"] }));
    await act(async () => checkNow());
    expect(useStrength.getState().error).toBe("hold");
    expect(card()).toContain("No material found at the faces the part is held at.");
    await act(async () => useStrength.setState({ holds: useStrength.getState().loads, loads: ["nothing"] }));
    await act(async () => makeTopology());
    expect(card()).toContain("No material found at the faces the part is pushed at.");
    await select();
    await act(async () => takeSelection("loads"));
    expect(useStrength.getState().loads).toEqual([]);
  });

  it("is an ordinary part again once the topology is deleted; a broken store keeps nothing", async () => {
    const { topology } = useStrength.getState();

    apply({ type: "delete_feature", id: topology! });
    await rebuilt();
    expect(hasTopology()).toBe(false);
    expect(screen.getByText("Make topology")).toBeTruthy();
    // Undoing the deletion links it again.
    await act(async () => undo());
    await rebuilt();
    expect(hasTopology()).toBe(true);

    // A new session knows nothing; the next result of the model finds the topology kept for the project.
    await act(async () => useStrength.setState({ body: null, topology: null, open: false }));
    apply({ type: "edit_feature", id: "pr1", patch: { size: [40, 4, 8], center: [20, 2, 4] } });
    await rebuilt();
    expect(useStrength.getState()).toMatchObject({ body: "pr1", topology, open: false });
    expect(outOfDate()).toBe(false);
    // Closing without a topology in the design forgets the part.
    apply({ type: "delete_feature", id: topology! });
    await rebuilt();
    await act(async () => closeStrength());
    expect(useStrength.getState().body).toBeNull();

    localStorage.setItem(`meercad.topology.${useApp.getState().project!.id}`, "{");
    await act(async () => openStrength("pr1"));
    expect(useStrength.getState()).toMatchObject({ body: "pr1", topology: null, holds: [] });
    await act(async () => useStrength.setState({ body: "gone" }));
    await act(async () => checkNow());
    expect(useStrength.getState().error).toBe("gone");
  });
});
