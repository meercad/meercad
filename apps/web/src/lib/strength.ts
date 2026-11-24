/**
 * Strength check and topology of a part (a beta function). The part is held at some faces and
 * pushed at others; the check colours it by how much of the material's strength is used and gives
 * the safety factor. The topology is a second, lighter part that keeps material only along the load
 * paths: it stays linked to the part it was made from, which remains as its shadow, and is made
 * again when that part or the set-up changes. Both are estimates on a grid of cubes, not a
 * verification.
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
import type { Feature, MeercadDocument } from "@meercad/schema";
import { create } from "zustand";
import { apply, currentDoc, startTask, toast, useApp } from "../store";
import { partName } from "./features";
import { t } from "./i18n";
import { refine } from "./meshSamples";
import {
  faceKey,
  faceMarkers,
  facesByKey,
  faceTriangles,
  loadForce,
  shapeKey,
  type LoadDirection,
} from "./strengthFaces";
import { runStrength, type StrengthRun } from "./strengthRunner";

/** About how many cubes the check calculates with, and the topology at its two levels of detail. */
export const CHECK_CELLS = 30_000;
export const TOPOLOGY_CELLS = { fast: 50_000, fine: 100_000 } as const;

export type Detail = keyof typeof TOPOLOGY_CELLS;
/** What the 3D view shows of a part with a topology: both (the part as a shadow), or one of them. */
export type TopologyView = "both" | "original" | "topology";

export interface StrengthSummary {
  safety: number;
  /** mm */
  deflection: number;
  converged: boolean;
}

/** What a topology is made from: kept with the project on this device, so it can be made again. */
interface Setup {
  body: string | null;
  /** The faces of the part it is held at, and pushed at, by name (see faceKey). */
  holds: string[];
  loads: string[];
  /** The whole force on the pushed faces, N, and where it goes. */
  newton: number;
  direction: LoadDirection;
  /** The axis the printed layers are stacked along. */
  up: 0 | 1 | 2;
  /** The share of material the topology keeps. */
  share: number;
  detail: Detail;
  /** Whether the topology is made again by itself when the part or the set-up changes. */
  auto: boolean;
  /** The topology part made from this, if any. */
  topology: string | null;
  view: TopologyView;
}

interface StrengthState extends Setup {
  /** Whether the card is shown. */
  open: boolean;
  /** About how many cubes the check and the topology calculate with (the tests take fewer). */
  cells: { check: number; fast: number; fine: number };
  /** Rounds of the optimisation at most. */
  steps: number;
  running: "check" | "topology" | null;
  report: StrengthSummary | null;
  /** The topology as last made: its share of the volume, and both checks. */
  result: { share: number; before: StrengthSummary; after: StrengthSummary } | null;
  /** The shape of the part and the set-up the topology was last made from; differing: out of date. */
  madeFrom: string | null;
  error: "hold" | "load" | "failed" | "gone" | null;
  maps: Map<string, { positions: Float32Array; colors: Float32Array }>;
}

const NO_SETUP: Setup = {
  body: null,
  holds: [],
  loads: [],
  newton: 100,
  direction: "into",
  up: 2,
  share: 0.2,
  detail: "fast",
  auto: true,
  topology: null,
  view: "both",
};

const CLOSED: StrengthState = {
  ...NO_SETUP,
  open: false,
  cells: { check: CHECK_CELLS, ...TOPOLOGY_CELLS },
  steps: 40,
  running: null,
  report: null,
  result: null,
  madeFrom: null,
  error: null,
  maps: new Map(),
};

export const useStrength = create<StrengthState>(() => CLOSED);

const SETUP_KEYS = Object.keys(NO_SETUP) as (keyof Setup)[];
const storageKey = (project: string) => `meercad.topology.${project}`;

/** The set-ups kept for a project, by the part they belong to. */
function saved(project: string | undefined): Record<string, Setup> {
  try {
    return JSON.parse((project && localStorage.getItem(storageKey(project))) || "{}") as Record<
      string,
      Setup
    >;
  } catch {
    return {};
  }
}

function save(): void {
  const state = useStrength.getState();
  const project = useApp.getState().project?.id;
  if (!project || !state.body) return;

  const setup = Object.fromEntries(SETUP_KEYS.map((key) => [key, state[key]]));

  try {
    localStorage.setItem(storageKey(project), JSON.stringify({ ...saved(project), [state.body]: setup }));
  } catch {
    // the set-up just won't be there next time
  }
}

let current: StrengthRun | null = null;
let pending: ReturnType<typeof setTimeout> | undefined;

const partMesh = (body: string | null) =>
  useApp.getState().output?.meshes.find((part) => part.bodyId === body);

const hasFeature = (id: string | null) => !!id && currentDoc().features.some((feature) => feature.id === id);

/**
 * Whether the part has its topology in the design. A deleted one is remembered, so undoing the
 * deletion links it again.
 */
export const hasTopology = (): boolean => hasFeature(useStrength.getState().topology);

/**
 * Opens the card for a part, with the set-up kept for it. Opened on a topology, it shows the part
 * that topology was made from.
 */
export function openStrength(body: string): void {
  const all = saved(useApp.getState().project?.id);
  const origin = Object.values(all).find((setup) => setup.topology === body)?.body ?? body;
  const kept = all[origin];

  current?.cancel();
  clearTimeout(pending);
  useStrength.setState({
    ...CLOSED,
    cells: useStrength.getState().cells,
    steps: useStrength.getState().steps,
    ...(kept ? { ...kept, topology: hasFeature(kept.topology) ? kept.topology : null } : {}),
    body: origin,
    open: true,
  });
  showMarkers();
}

/** Closes the card. A topology stays linked to its part and is still kept up to date. */
export function closeStrength(): void {
  const linked = hasTopology();

  if (!linked) {
    current?.cancel();
    clearTimeout(pending);
  }

  useStrength.setState(linked ? { open: false, report: null, maps: new Map() } : CLOSED);
}

/** The faces of the part as it is now that the set-up names. */
function facesNow(): { holds: number[]; loads: number[] } {
  const state = useStrength.getState();
  const mesh = partMesh(state.body);

  return mesh
    ? { holds: facesByKey(mesh, state.holds), loads: facesByKey(mesh, state.loads) }
    : { holds: [], loads: [] };
}

/** How many faces the part is held and pushed at right now (for the card). */
export const faceCounts = (): { holds: number; loads: number } => {
  const faces = facesNow();

  return { holds: faces.holds.length, loads: faces.loads.length };
};

/** Colours the part by where it is held and pushed, while the card is open and no result is shown. */
function showMarkers(): void {
  const state = useStrength.getState();
  const mesh = partMesh(state.body);
  const faces = facesNow();

  // With a topology the part is its shadow (or not shown): marks on it would cover the topology.
  const shown = state.open && (!hasTopology() || state.view === "original");

  useStrength.setState({
    maps:
      shown && mesh && faces.holds.length + faces.loads.length
        ? new Map([[state.body!, faceMarkers(mesh, faces.holds, faces.loads)]])
        : new Map(),
  });
}

/** The set-up and the part's shape as one text: a topology made from another one is out of date. */
function setupKey(): string | null {
  const state = useStrength.getState();
  const mesh = partMesh(state.body);
  const material = partMaterial(currentDoc(), state.body ?? "")?.id ?? "";

  return mesh
    ? [
        shapeKey(mesh),
        state.holds,
        state.loads,
        state.newton,
        state.direction,
        state.up,
        state.share,
        state.detail,
        material,
      ].join(";")
    : null;
}

/** Whether the topology no longer fits the part or the set-up. */
export const outOfDate = (): boolean => {
  const state = useStrength.getState();

  return hasFeature(state.topology) && state.madeFrom !== setupKey();
};

/** After a change: the result shown no longer fits; the topology is made again shortly, if asked for. */
function changed(): void {
  useStrength.setState({ report: null, error: null });
  showMarkers();
  save();
  clearTimeout(pending);

  const state = useStrength.getState();

  if (state.auto && outOfDate()) {
    pending = setTimeout(() => void makeTopology(), AUTO_DELAY_MS);
  }
}

/** How long after the last change a topology is made again, ms: not after every step of an edit. */
export const AUTO_DELAY_MS = 1500;

/** Changes the force, the directions, the share or how the topology is kept up to date. */
export function setStrength(
  patch: Partial<Pick<Setup, "newton" | "direction" | "up" | "share" | "detail" | "auto">>,
): void {
  useStrength.setState(patch);
  changed();
}

/** Takes the selected faces of the part as the faces it is held or pushed at. */
export function takeSelection(as: "holds" | "loads"): void {
  const { body } = useStrength.getState();
  const faces = useApp
    .getState()
    .selection.flatMap((pick) => (pick.kind === "face" && pick.bodyId === body ? [faceKey(pick.tags)] : []));

  useStrength.setState({ [as]: [...new Set(faces)].filter(Boolean) });
  changed();
}

/** What the 3D view shows: the part and its topology, or one of them. */
export function setTopologyView(view: TopologyView): void {
  useStrength.setState({ view, report: null });
  showMarkers();
  save();
}

/**
 * The document and the hidden parts as the 3D view should show them: with a topology, its part is
 * a see-through shadow, or one of the two is left out. Nothing of this is written to the design.
 */
export function viewedScene<D extends Pick<MeercadDocument, "seeThrough" | "features">>(
  doc: D,
  hidden: Set<string>,
  link: Pick<Setup, "body" | "topology" | "view">,
): { doc: D; hidden: Set<string> } {
  if (!link.body || !link.topology || !doc.features.some((feature) => feature.id === link.topology)) {
    return { doc, hidden };
  }

  if (link.view === "both") {
    return { doc: { ...doc, seeThrough: [...(doc.seeThrough ?? []), link.body] }, hidden };
  }

  return { doc, hidden: new Set([...hidden, link.view === "original" ? link.topology : link.body]) };
}

const summary = (report: StrengthReport): StrengthSummary => ({
  safety: report.safety,
  deflection: report.deflection,
  converged: report.converged,
});

/** The job for the part as it is now, or null when the part is gone. */
function job(cells: number): StrengthJob | null {
  const state = useStrength.getState();
  const mesh = partMesh(state.body);
  if (!mesh) return null;

  const material = partMaterial(currentDoc(), state.body!);
  const faces = facesNow();
  const pushed = faceTriangles(mesh, faces.loads);
  const up: [number, number, number] = [0, 0, 0];

  up[state.up] = 1;

  return {
    positions: mesh.positions,
    indices: mesh.indices,
    holds: faceTriangles(mesh, faces.holds),
    loads: pushed.length
      ? [{ triangles: pushed, force: loadForce(mesh.positions, pushed, state.newton, state.direction) }]
      : [],
    material: (material && strengthOf(material)) ?? STRENGTHS.pla!,
    up,
    cells,
  };
}

async function run(kind: "check" | "topology", label: string): Promise<StrengthAnswer | null> {
  const state = useStrength.getState();
  const request = job(kind === "check" ? state.cells.check : state.cells[state.detail]);

  current?.cancel();
  clearTimeout(pending);
  useStrength.setState({ report: null, error: request ? null : "gone" });
  if (!request) return null;

  const task = startTask(label, kind === "check" ? null : 0, {
    cancel: () => current?.cancel(),
    long: kind === "topology",
  });
  const mine = runStrength(
    kind === "check"
      ? { kind, job: request }
      : { kind, job: { ...request, share: state.share, steps: state.steps, checkCells: state.cells.check } },
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
  const mesh = partMesh(body);
  if (answer?.kind !== "check" || !mesh) return;

  const positions = refine(mesh);

  useStrength.setState({
    report: summary(answer.report),
    maps: new Map([[body!, { positions, colors: strengthColors(answer.report, positions) }]]),
  });
}

/**
 * Makes the topology of the part: a new part the first time, the same part with its new shape from
 * then on. The part it is made from stays as it is.
 */
export async function makeTopology(): Promise<void> {
  const from = setupKey();
  const answer = await run("topology", t("Optimising the topology"));
  const state = useStrength.getState();
  if (answer?.kind !== "topology" || !state.body) return;

  const doc = currentDoc();
  const { suggestion } = answer;
  const data = toBase64(writeStl([suggestion.mesh]));
  const existing = hasFeature(state.topology) ? state.topology : null;
  const id = existing ?? nextFeatureId(doc, "import");
  const feature: Feature = {
    id,
    name: t("Topology of {part}", { part: partName(state.body, doc.features) }),
    op: "import",
    format: "stl",
    fileName: "topology.stl",
    data,
  };

  if (
    !apply(
      existing
        ? { type: "edit_feature", id, patch: { data } }
        : { type: "add_features", features: [feature] },
    )
  ) {
    return;
  }

  useStrength.setState({
    topology: id,
    madeFrom: from,
    result: {
      share: suggestion.share,
      before: summary(suggestion.before),
      after: summary(suggestion.after),
    },
  });
  save();

  if (!existing) toast(t("Topology added as a new part. It is a suggestion, not a verified part."));
}

function toBase64(bytes: Uint8Array): string {
  let text = "";

  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(text);
}

/** A topology of the open project made earlier is linked to its part again (the card stays closed). */
function restore(): void {
  const kept = Object.values(saved(useApp.getState().project?.id)).find((setup) =>
    hasFeature(setup.topology),
  );
  if (!kept) return;

  const { cells, steps } = useStrength.getState();

  useStrength.setState({ ...CLOSED, cells, steps, ...kept });
  // As it was left: only changes from now on make it out of date.
  useStrength.setState({ madeFrom: setupKey() });
}

// Another project ends it; a changed model makes the colours stale and a topology out of date.
useApp.subscribe((state, prev) => {
  if (state.project?.id !== prev.project?.id || state.screen !== "editor") {
    if (!useStrength.getState().body) return;

    current?.cancel();
    clearTimeout(pending);
    useStrength.setState({
      ...CLOSED,
      cells: useStrength.getState().cells,
      steps: useStrength.getState().steps,
    });

    return;
  }

  if (state.output === prev.output || state.previewing) return;
  if (!useStrength.getState().body) return restore();

  changed();
});
