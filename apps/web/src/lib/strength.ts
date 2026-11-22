/**
 * Strength check and topology suggestion of a part (a beta function): the part is held at some
 * faces and pushed at others; the check colours it by how much of the material's strength is used
 * and gives the safety factor, the suggestion adds a lighter part that keeps material along the
 * load paths. Both are estimates on a grid of cubes, not a verification.
 */
import { writeStl } from "@meercad/io";
import {
  nextFeatureId,
  partMaterial,
  STRENGTHS,
  strengthColors,
  strengthOf,
  type StrengthAnswer,
  type StrengthJob,
  type StrengthReport,
} from "@meercad/model";
import type { Feature } from "@meercad/schema";
import { create } from "zustand";
import { apply, currentDoc, startTask, toast, useApp } from "../store";
import { partName } from "./features";
import { t } from "./i18n";
import { refine } from "./meshSamples";
import { faceTriangles, loadForce, type LoadDirection } from "./strengthFaces";
import { runStrength, type StrengthRun } from "./strengthRunner";

/** About how many cubes the check and the (much longer) optimisation calculate with. */
export const CHECK_CELLS = 30_000;
export const TOPOLOGY_CELLS = 12_000;

export interface StrengthSummary {
  safety: number;
  /** mm */
  deflection: number;
  converged: boolean;
}

interface StrengthState {
  body: string | null;
  /** Faces of the part it is held at, and pushed at. */
  holds: number[];
  loads: number[];
  /** The whole force on the pushed faces, N, and where it goes. */
  newton: number;
  direction: LoadDirection;
  /** The axis the printed layers are stacked along. */
  up: 0 | 1 | 2;
  /** The share of material the suggestion keeps. */
  share: number;
  /** About how many cubes the check and the suggestion calculate with. */
  cells: { check: number; topology: number };
  /** Rounds of the optimisation at most. */
  steps: number;
  running: "check" | "topology" | null;
  report: StrengthSummary | null;
  /** The last suggestion: the part added, its share of the volume, and both checks. */
  suggestion: { part: string; share: number; before: StrengthSummary; after: StrengthSummary } | null;
  error: "hold" | "load" | "failed" | "gone" | null;
  maps: Map<string, { positions: Float32Array; colors: Float32Array }>;
}

const CLOSED: StrengthState = {
  body: null,
  holds: [],
  loads: [],
  newton: 100,
  direction: "into",
  up: 2,
  share: 0.5,
  cells: { check: CHECK_CELLS, topology: TOPOLOGY_CELLS },
  steps: 40,
  running: null,
  report: null,
  suggestion: null,
  error: null,
  maps: new Map(),
};

export const useStrength = create<StrengthState>(() => CLOSED);

let current: StrengthRun | null = null;

export function openStrength(body: string): void {
  current?.cancel();
  useStrength.setState({ ...CLOSED, body });
}

export function closeStrength(): void {
  current?.cancel();
  useStrength.setState(CLOSED);
}

/** Changes the force, the directions or the share; a result shown no longer fits and goes. */
export function setStrength(
  patch: Partial<Pick<StrengthState, "newton" | "direction" | "up" | "share">>,
): void {
  useStrength.setState({ ...patch, report: null, error: null, maps: new Map() });
}

/** Takes the selected faces of the part as the faces it is held or pushed at. */
export function takeSelection(as: "holds" | "loads"): void {
  const { body } = useStrength.getState();
  const faces = useApp
    .getState()
    .selection.flatMap((pick) => (pick.kind === "face" && pick.bodyId === body ? [pick.face] : []));

  useStrength.setState({ [as]: [...new Set(faces)], report: null, error: null, maps: new Map() });
}

const summary = (report: StrengthReport): StrengthSummary => ({
  safety: report.safety,
  deflection: report.deflection,
  converged: report.converged,
});

/** The job for the part as it is now, or null when the part is gone. */
function job(cells: number): StrengthJob | null {
  const state = useStrength.getState();
  const mesh = useApp.getState().output?.meshes.find((part) => part.bodyId === state.body);
  if (!mesh) return null;

  const material = partMaterial(currentDoc(), state.body!);
  const pushed = faceTriangles(mesh, state.loads);
  const up: [number, number, number] = [0, 0, 0];

  up[state.up] = 1;

  return {
    positions: mesh.positions,
    indices: mesh.indices,
    holds: faceTriangles(mesh, state.holds),
    loads: pushed.length
      ? [{ triangles: pushed, force: loadForce(mesh.positions, pushed, state.newton, state.direction) }]
      : [],
    material: (material && strengthOf(material)) ?? STRENGTHS.pla!,
    up,
    cells,
  };
}

async function run(kind: "check" | "topology", label: string): Promise<StrengthAnswer | null> {
  const request = job(useStrength.getState().cells[kind]);

  current?.cancel();
  useStrength.setState({ report: null, error: request ? null : "gone", maps: new Map() });
  if (!request) return null;

  const task = startTask(label, kind === "check" ? null : 0, {
    cancel: () => current?.cancel(),
    long: kind === "topology",
  });
  const mine = runStrength(
    kind === "check"
      ? { kind, job: request }
      : {
          kind,
          job: { ...request, share: useStrength.getState().share, steps: useStrength.getState().steps },
        },
    (share) => task.update(share),
  );

  current = mine;
  useStrength.setState({ running: kind });

  try {
    const answer = await mine.answer;

    if (answer?.kind === "error") useStrength.setState({ error: answer.reason });

    return answer;
  } finally {
    task.done();

    if (current === mine) {
      current = null;
      useStrength.setState({ running: null });
    }
  }
}

/** Checks the part and colours it. */
export async function checkNow(): Promise<void> {
  const answer = await run("check", t("Checking the strength"));
  const { body } = useStrength.getState();
  const mesh = useApp.getState().output?.meshes.find((part) => part.bodyId === body);
  if (answer?.kind !== "check" || !mesh) return;

  const positions = refine(mesh);

  useStrength.setState({
    report: summary(answer.report),
    maps: new Map([[body!, { positions, colors: strengthColors(answer.report, positions) }]]),
  });
}

/** Adds the lighter part next to the part (which turns see-through, so the new one shows). */
export async function suggestNow(): Promise<void> {
  const answer = await run("topology", t("Optimising the topology"));
  const { body } = useStrength.getState();
  if (answer?.kind !== "topology" || !body) return;

  const doc = currentDoc();
  const { suggestion } = answer;
  const feature: Feature = {
    id: nextFeatureId(doc, "import"),
    name: t("Topology suggestion for {part}", { part: partName(body, doc.features) }),
    op: "import",
    format: "stl",
    fileName: "topology.stl",
    data: toBase64(writeStl([suggestion.mesh])),
  };

  if (
    !apply(
      { type: "add_features", features: [feature] },
      { type: "set_see_through", parts: [body], on: true },
    )
  ) {
    return;
  }

  useStrength.setState({
    suggestion: {
      part: feature.id,
      share: suggestion.share,
      before: summary(suggestion.before),
      after: summary(suggestion.after),
    },
  });
  toast(t("Topology suggestion added as a new part. It is a suggestion, not a verified part."));
}

function toBase64(bytes: Uint8Array): string {
  let text = "";

  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(text);
}

// Another project closes it; a changed model makes the colours and numbers stale.
useApp.subscribe((state, prev) => {
  if (!useStrength.getState().body) return;

  if (state.project?.id !== prev.project?.id || state.screen !== "editor") {
    closeStrength();
  } else if (state.output !== prev.output && !state.previewing && useStrength.getState().report) {
    useStrength.setState({ report: null, maps: new Map() });
  }
});
