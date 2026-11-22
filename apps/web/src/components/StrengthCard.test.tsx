/**
 * The strength check and the topology suggestion (StrengthCard.tsx, lib/strength.ts) on a real
 * beam, 40 × 4 × 8 mm, held at one end and pushed down at the other: the menu entry exists only with
 * the beta function on; the check gives the safety factor of the textbook and colours the part; the
 * suggestion adds a lighter part and turns the beam see-through; wrong set-ups say why.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useBeta } from "../lib/beta";
import { testCall } from "../lib/mcpBridge";
import {
  checkNow,
  closeStrength,
  openStrength,
  suggestNow,
  takeSelection,
  useStrength,
} from "../lib/strength";
import { apply, undo, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { StrengthCard } from "./StrengthCard";

const card = () => document.querySelector(".strength-card")?.textContent ?? "";

/** The beam's face whose corners all have this x. */
function faceAt(x: number): number {
  const mesh = useApp.getState().output!.meshes[0]!;

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
        tags: [],
        point: [0, 0, 0],
        normal: null,
      })),
    }),
  );

beforeAll(async () => {
  withScreen();
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
  useBeta.setState({ available: false, on: {} });
  cleanup();
});

describe("the strength card", () => {
  it("is closed until opened for a part, and asks for faces first", async () => {
    expect(card()).toBe("");
    await act(async () => openStrength("pr1"));
    // Cubes of 1 mm and few rounds, so the test is quick.
    await act(async () => useStrength.setState({ cells: { check: 1280, topology: 1280 }, steps: 16 }));
    expect(card()).toContain("Strength of");
    expect(card()).toContain("calculated as PLA");
    expect(card()).toContain("Select faces of the part");
    expect((screen.getByText("Check strength") as HTMLButtonElement).disabled).toBe(true);
  });

  it("takes the selected faces of the part as held and as pushed", async () => {
    await select(faceAt(0));
    await act(async () => void fireEvent.click(screen.getAllByText("Use selected faces")[0]!));
    await select(faceAt(40));
    await act(async () => void fireEvent.click(screen.getAllByText("Use selected faces")[1]!));
    expect(useStrength.getState()).toMatchObject({ holds: [faceAt(0)], loads: [faceAt(40)] });
    expect(card()).toContain("Faces held: 1");
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
    const { report, maps } = useStrength.getState();

    expect(report!.converged).toBe(true);
    expect(report!.safety).toBeGreaterThan(4);
    expect(report!.safety).toBeLessThan(8);
    expect(maps.get("pr1")!.colors.length).toBe(maps.get("pr1")!.positions.length);
    expect(card()).toContain("This part: safety factor");
  });

  it("drops the result when the force changes, and into the faces pushes along the beam", async () => {
    await act(
      async () =>
        void fireEvent.change(screen.getByLabelText("Direction of the force"), { target: { value: "into" } }),
    );
    expect(useStrength.getState().report).toBeNull();
    await act(async () => checkNow());
    // Pressed along its length the beam is far from its limit.
    expect(useStrength.getState().report!.safety).toBeGreaterThan(50);
    await act(
      async () =>
        void fireEvent.change(screen.getByLabelText("Direction of the force"), { target: { value: "-z" } }),
    );
  });

  it("suggests a lighter part next to the beam, which turns see-through; undo takes both back", async () => {
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Share of material to keep, per cent"), {
        target: { value: "5" },
      });
      fireEvent.change(screen.getByLabelText("Share of material to keep, per cent"), {
        target: { value: "60" },
      });
    });
    expect(useStrength.getState().share).toBe(0.6);
    await act(async () => void fireEvent.click(screen.getByText("Suggest lighter part")));
    await waitFor(() => expect(useStrength.getState().suggestion).not.toBeNull(), { timeout: 30000 });

    const { suggestion } = useStrength.getState();
    const doc = useApp.getState().doc;
    const added = doc.features.find((feature) => feature.id === suggestion!.part)!;

    expect(added).toMatchObject({
      op: "import",
      format: "stl",
      name: "Topology suggestion for Basic solid 1",
    });
    expect(doc.seeThrough).toContain("pr1");
    expect(suggestion!.share).toBeGreaterThan(0.4);
    expect(suggestion!.share).toBeLessThan(0.8);
    expect(suggestion!.after.converged).toBe(true);
    expect(card()).toContain("Suggestion: safety factor");
    expect(card()).toContain("Before: safety factor");

    await act(async () => undo());
    expect(useApp.getState().doc.features).toHaveLength(1);
    expect(useApp.getState().doc.seeThrough ?? []).not.toContain("pr1");
  }, 40000);

  it("says why when the part is not held, or gone", async () => {
    await act(async () => useStrength.setState({ holds: [999] }));
    await act(async () => checkNow());
    expect(card()).toContain("No material found at the faces the part is held at.");
    await act(async () => useStrength.setState({ holds: [faceAt(0)], loads: [999] }));
    await act(async () => suggestNow());
    expect(card()).toContain("No material found at the faces the part is pushed at.");
    await act(async () => useStrength.setState({ body: "nothing" }));
    await act(async () => checkNow());
    expect(useStrength.getState().error).toBe("gone");
    await act(async () => takeSelection("holds"));
    expect(useStrength.getState().holds).toEqual([]);
  });

  it("closes with its button", async () => {
    await act(async () => void fireEvent.click(screen.getByTitle("Close")));
    expect(card()).toBe("");
  });
});
