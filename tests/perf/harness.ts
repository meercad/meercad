/**
 * Measuring for the performance tests (docs/TESTING.md, "Performance tests").
 *
 * Every measurement is checked two ways:
 * - against its **budget**: what a person would still accept on a Mac (ms, or MB, or triangles).
 *   `MEERCAD_PERF_SCALE` widens all time budgets for slower machines (the CI runner uses 3).
 * - against the **baseline** in `baseline.json`, measured on the machine named in it. On that
 *   machine a value may be at most `MEERCAD_PERF_TOLERANCE` (default 0.3 = 30 %) worse, plus a small
 *   absolute slack so 2 ms → 3 ms is no regression. On any other machine only time budgets apply,
 *   counts (triangles, faces) are checked everywhere since they don't depend on the machine.
 *
 * `MEERCAD_PERF_UPDATE=1 pnpm test:perf` writes the values of this run as the new baseline.
 * Every run writes its values to `test-results/perf.json` and prints a table.
 */
import { cpus, platform, totalmem } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, expect } from "vitest";

export type Unit = "ms" | "MB" | "tris" | "faces";

export interface Measurement {
  value: number;
  unit: Unit;
  /** All runs (time only). */
  runs?: number[];
}

interface Baseline {
  machine: string;
  date: string;
  values: Record<string, Measurement>;
}

const BASELINE_URL = new URL("./baseline.json", import.meta.url);
const RESULTS_URL = new URL("../../test-results/perf.json", import.meta.url);

export const MACHINE = `${cpus()[0]?.model.trim() ?? "unknown cpu"}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB, ${platform()}`;
const SCALE = Number(process.env["MEERCAD_PERF_SCALE"] ?? 1);
const TOLERANCE = Number(process.env["MEERCAD_PERF_TOLERANCE"] ?? 0.3);
const UPDATE = process.env["MEERCAD_PERF_UPDATE"] === "1";

const baseline: Baseline | null = existsSync(BASELINE_URL) ? (JSON.parse(readFileSync(BASELINE_URL, "utf8")) as Baseline) : null;
const sameMachine = baseline?.machine === MACHINE;
const results = new Map<string, Measurement & { budget: number; base?: number }>();

/** Slack on top of the relative tolerance, so tiny values don't flap. */
const SLACK: Record<Unit, number> = { ms: 5, MB: 8, tris: 0, faces: 0 };

export const median = (a: readonly number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;

/** Median time of `runs` calls of `fn` (after `warmup` calls that don't count), in ms. */
export function time(fn: () => void, runs = 5, warmup = 0): Measurement {
  for (let i = 0; i < warmup; i++) fn();
  const all: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    all.push(performance.now() - t);
  }
  return { value: median(all), unit: "ms", runs: all };
}

/** Same as `time` for an async function. */
export async function timeAsync(fn: () => Promise<unknown>, runs = 5): Promise<Measurement> {
  const all: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    all.push(performance.now() - t);
  }
  return { value: median(all), unit: "ms", runs: all };
}

/**
 * Records a measurement under `key` and checks it: within `budget` (time budgets × MEERCAD_PERF_SCALE),
 * and no worse than the baseline beyond the tolerance. Counts must match the baseline within 10 %
 * either way, so a mesh that suddenly gets much coarser is noticed as well.
 */
export function check(key: string, m: Measurement, budget: number): void {
  const limit = m.unit === "ms" ? budget * SCALE : budget;
  const base = baseline?.values[key];
  results.set(key, { ...m, budget: limit, base: base?.value });
  expect.soft(m.value, `${key}: ${fmt(m.value, m.unit)} over the budget of ${fmt(limit, m.unit)}`).toBeLessThanOrEqual(limit);
  if (!base || UPDATE) return;
  const isCount = m.unit === "tris" || m.unit === "faces";
  if (isCount) {
    expect.soft(Math.abs(m.value - base.value) / Math.max(base.value, 1), `${key}: ${m.value} ${m.unit}, baseline ${base.value}`).toBeLessThanOrEqual(0.1);
  } else if (sameMachine) {
    const max = base.value * (1 + TOLERANCE) + SLACK[m.unit];
    expect.soft(m.value, `${key}: ${fmt(m.value, m.unit)}, baseline ${fmt(base.value, m.unit)} (+${Math.round(TOLERANCE * 100)} % allowed)`).toBeLessThanOrEqual(max);
  }
}

const fmt = (v: number, unit: Unit) => `${unit === "ms" || unit === "MB" ? v.toFixed(1) : Math.round(v)} ${unit}`;

/** Call once per perf file: prints the table and writes results (and the baseline when updating). */
export function report(): void {
  afterAll(() => {
    if (!results.size) return;
    const rows = [...results].map(([k, r]) => {
      const delta = r.base ? `${r.value >= r.base ? "+" : ""}${Math.round(((r.value - r.base) / r.base) * 100)} %` : "";
      return `${k.padEnd(58)} ${fmt(r.value, r.unit).padStart(12)} ${(r.base === undefined ? "" : fmt(r.base, r.unit)).padStart(12)} ${delta.padStart(7)}`;
    });
    const head = `${"measurement".padEnd(58)} ${"now".padStart(12)} ${"baseline".padStart(12)} ${"Δ".padStart(7)}`;
    const note = baseline && !sameMachine ? `\n(baseline is from "${baseline.machine}", this is "${MACHINE}": only budgets and counts are checked)` : "";
    console.log(`\n${head}\n${rows.join("\n")}${note}\n`);

    mkdirSync(new URL(".", RESULTS_URL), { recursive: true });
    const all = existsSync(RESULTS_URL) ? (JSON.parse(readFileSync(RESULTS_URL, "utf8")) as Baseline) : null;
    const merged: Baseline = { machine: MACHINE, date: new Date().toISOString(), values: { ...(all?.machine === MACHINE ? all.values : {}) } };
    for (const [k, r] of results) merged.values[k] = { value: round(r.value), unit: r.unit };
    writeFileSync(RESULTS_URL, `${JSON.stringify(merged, null, 1)}\n`);

    if (UPDATE) {
      const next: Baseline = { machine: MACHINE, date: new Date().toISOString().slice(0, 10), values: { ...(sameMachine ? baseline!.values : {}) } };
      for (const [k, r] of results) next.values[k] = { value: round(r.value), unit: r.unit };
      const sorted = Object.fromEntries(Object.entries(next.values).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(BASELINE_URL, `${JSON.stringify({ ...next, values: sorted }, null, 1)}\n`);
    }
  });
}

const round = (v: number) => Math.round(v * 10) / 10;
