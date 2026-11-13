/**
 * Wall thickness of a part as a colour map, with no reference needed: from every spot of the
 * surface a ray goes straight into the material, and how far it runs before it comes out again is
 * the wall there. Red where it is thinner than the wall a printer needs, through yellow to green
 * at three times that. Kept up to date while the part changes, until it is closed.
 */
import { create } from "zustand";
import { startTask, useApp } from "../store";
import { t } from "./i18n";
import { measureWalls, type ThicknessStats, type WallMeasure } from "./wallMeasure";

export {
  measureWalls,
  thinSpots,
  WALL_SAMPLES,
  type ThicknessStats,
  type ThinSpot,
  type WallMeasure,
} from "./wallMeasure";

export const useThickness = create<{
  body: string | null;
  minWall: number;
  maps: Map<string, { positions: Float32Array; colors: Float32Array }>;
  stats: ThicknessStats | null;
  error?: string;
}>(() => ({
  body: null,
  minWall: 1,
  maps: new Map(),
  stats: null,
}));

export function showThickness(body: string): void {
  useThickness.setState({ body });
  void update();
}

export function hideThickness(): void {
  useThickness.setState({ body: null, maps: new Map(), stats: null, error: undefined });
}

export function setMinWall(minWall: number): void {
  useThickness.setState({ minWall });
  void update();
}

let run = 0;

/** Shows a measurement taken already as the colour map of `body`. */
export function showMeasured(body: string, m: WallMeasure): void {
  run++;

  const colors = new Float32Array(m.wall.length * 9);

  for (let k = 0; k < m.wall.length; k++) {
    for (let c = 0; c < 3; c++) colorFor(m.wall[k]!, m.stats.minWall, colors, k * 9 + c * 3);
  }

  useThickness.setState({
    body,
    minWall: m.stats.minWall,
    maps: new Map([[body, { positions: m.positions, colors }]]),
    stats: m.stats,
    error: undefined,
  });
}

async function update(): Promise<void> {
  const me = ++run;
  const { body, minWall } = useThickness.getState();
  if (!body) return;

  const part = useApp.getState().output?.meshes.find((mesh) => mesh.bodyId === body);
  if (!part) return useThickness.setState({ maps: new Map(), stats: null, error: "gone" });

  const task = startTask(t("Measuring the wall thickness"));
  let m: WallMeasure | null;

  try {
    m = await measureWalls(part, minWall, { aborted: () => me !== run, progress: (f) => task.update(f) });
  } finally {
    task.done();
  }

  if (m && me === run) showMeasured(body, m);
}

// Red below the minimum wall, then yellow, green from three times it; grey where nothing was measured.
const RED = [0.86, 0.22, 0.2];
const YELLOW = [0.95, 0.78, 0.25];
const GREEN = [0.3, 0.72, 0.45];
const GREY = [0.6, 0.6, 0.62];
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function colorFor(d: number, minWall: number, out: Float32Array, o: number): void {
  let rgb = GREY;

  if (!Number.isNaN(d)) {
    const u = Math.max(0, Math.min(1, (d - minWall) / (2 * minWall)));
    const [from, to, k] =
      d < minWall ? [RED, RED, 0] : u < 0.5 ? [RED, YELLOW, u * 2] : [YELLOW, GREEN, (u - 0.5) * 2];
    rgb = [0, 1, 2].map((c) => from[c]! + (to[c]! - from[c]!) * k);
  }

  for (let c = 0; c < 3; c++) out[o + c] = linear(rgb[c]!);
}

/** CSS gradient of the scale, for the legend (minimum wall to three times it). */
export const THICKNESS_GRADIENT = `linear-gradient(90deg, rgb(${RED.map((c) => c * 255).join(",")}), rgb(${YELLOW.map((c) => c * 255).join(",")}), rgb(${GREEN.map((c) => c * 255).join(",")}))`;

useApp.subscribe((state, prev) => {
  if (!useThickness.getState().body) return;
  if (state.project?.id !== prev.project?.id || state.screen !== "editor") hideThickness();
  else if (state.output !== prev.output && !state.previewing) void update();
});
