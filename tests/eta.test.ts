import { describe, expect, it } from "vitest";
import { PHOTOGRAMMETRY, secondsLeft, timeShare } from "../apps/web/src/lib/eta";

/**
 * A real build from 77 drone photos (Mac, full detail): [seconds, progress] as Apple reported them; done
 * after 452 s.
 */
const RUN: [number, number][] = [
  [0, 0.0],
  [1, 0.01],
  [1, 0.021],
  [2, 0.031],
  [3, 0.042],
  [4, 0.052],
  [4, 0.062],
  [5, 0.073],
  [6, 0.083],
  [6, 0.094],
  [7, 0.109],
  [8, 0.121],
  [9, 0.134],
  [10, 0.146],
  [11, 0.158],
  [13, 0.171],
  [16, 0.183],
  [20, 0.195],
  [25, 0.207],
  [31, 0.22],
  [38, 0.232],
  [48, 0.244],
  [48, 0.257],
  [49, 0.269],
  [51, 0.281],
  [52, 0.294],
  [54, 0.306],
  [56, 0.318],
  [58, 0.331],
  [59, 0.343],
  [61, 0.355],
  [63, 0.367],
  [65, 0.38],
  [66, 0.392],
  [67, 0.404],
  [68, 0.417],
  [78, 0.429],
  [79, 0.441],
  [79, 0.454],
  [80, 0.466],
  [80, 0.478],
  [80, 0.491],
  [80, 0.503],
  [80, 0.515],
  [80, 0.527],
  [113, 0.54],
  [140, 0.552],
  [142, 0.564],
  [188, 0.577],
  [188, 0.589],
  [188, 0.601],
  [213, 0.614],
  [220, 0.626],
  [224, 0.638],
  [235, 0.65],
  [236, 0.663],
  [272, 0.675],
  [272, 0.687],
  [275, 0.7],
  [278, 0.712],
  [280, 0.724],
  [283, 0.737],
  [283, 0.749],
  [286, 0.761],
  [288, 0.774],
  [292, 0.786],
  [298, 0.798],
  [307, 0.81],
  [312, 0.823],
  [325, 0.835],
  [346, 0.847],
  [346, 0.86],
  [347, 0.872],
  [352, 0.884],
  [361, 0.897],
  [366, 0.909],
  [409, 0.921],
  [438, 0.934],
  [438, 0.946],
  [438, 0.958],
  [438, 0.97],
  [438, 0.983],
  [438, 0.995],
];
const TOTAL = 452;

/** The same photos at reduced detail (as the iPad builds); done after 408 s. */
const RUN2: [number, number][] = [
  [1, 0.0],
  [1, 0.01],
  [2, 0.021],
  [3, 0.031],
  [3, 0.042],
  [4, 0.052],
  [5, 0.062],
  [5, 0.073],
  [6, 0.083],
  [7, 0.094],
  [7, 0.109],
  [8, 0.12],
  [9, 0.131],
  [9, 0.142],
  [10, 0.152],
  [11, 0.163],
  [13, 0.174],
  [14, 0.185],
  [19, 0.196],
  [23, 0.207],
  [26, 0.218],
  [29, 0.229],
  [40, 0.239],
  [51, 0.25],
  [56, 0.261],
  [56, 0.272],
  [56, 0.283],
  [56, 0.294],
  [58, 0.305],
  [60, 0.315],
  [62, 0.326],
  [63, 0.337],
  [65, 0.348],
  [66, 0.359],
  [67, 0.37],
  [69, 0.381],
  [71, 0.392],
  [72, 0.402],
  [73, 0.413],
  [74, 0.424],
  [75, 0.435],
  [76, 0.446],
  [76, 0.457],
  [86, 0.468],
  [87, 0.478],
  [87, 0.489],
  [88, 0.5],
  [88, 0.511],
  [88, 0.522],
  [88, 0.533],
  [88, 0.544],
  [88, 0.554],
  [88, 0.565],
  [121, 0.576],
  [144, 0.587],
  [156, 0.598],
  [157, 0.609],
  [203, 0.62],
  [203, 0.631],
  [203, 0.641],
  [203, 0.652],
  [228, 0.663],
  [231, 0.674],
  [239, 0.685],
  [249, 0.696],
  [250, 0.707],
  [251, 0.717],
  [251, 0.728],
  [285, 0.739],
  [288, 0.75],
  [288, 0.761],
  [291, 0.772],
  [293, 0.783],
  [294, 0.794],
  [297, 0.804],
  [297, 0.815],
  [300, 0.826],
  [303, 0.837],
  [303, 0.848],
  [313, 0.859],
  [313, 0.87],
  [324, 0.88],
  [330, 0.891],
  [343, 0.902],
  [362, 0.913],
  [364, 0.924],
  [364, 0.935],
  [364, 0.946],
  [367, 0.957],
  [375, 0.967],
  [381, 0.978],
  [397, 0.989],
  [397, 1.0],
];
const RUN2_TOTAL = 408;

/** The estimate at second `s` of a run, as the task panel shows it. */
function estimate(run: [number, number][], s: number, curve?: typeof PHOTOGRAMMETRY): number | null {
  const points: [number, number][] = [];
  for (const [at, q] of run) if (at <= s && q !== points.at(-1)?.[1]) points.push([at, q]);

  return secondsLeft(points, s, curve);
}

describe("time left", () => {
  it("reads the curve between its points", () => {
    expect(timeShare(PHOTOGRAMMETRY, 0)).toBe(0);
    expect(timeShare(PHOTOGRAMMETRY, 1)).toBe(1);
    expect(timeShare(PHOTOGRAMMETRY, 0.525)).toBeCloseTo(0.23, 5);

    for (let p = 0; p < 1; p += 0.01) {
      expect(timeShare(PHOTOGRAMMETRY, p + 0.01)).toBeGreaterThanOrEqual(timeShare(PHOTOGRAMMETRY, p));
    }
  });

  for (const [name, run, total] of [
    ["full detail", RUN, TOTAL],
    ["reduced detail", RUN2, RUN2_TOTAL],
  ] as const) {
    it(`stays within a minute of the real time on the measured photo build (${name})`, () => {
      for (let s = 20; s < total; s++) {
        const left = estimate(run, s, PHOTOGRAMMETRY)!;
        expect(Math.abs(left - (total - s)), `at ${s} s`).toBeLessThan(60);
        // The straight estimate was minutes off here: Apple's progress runs far ahead of the time.
      }

      expect(Math.abs(estimate(run, 120)! - (total - 120))).toBeGreaterThan(150);
    });
  }

  it("counts down while the progress stands still", () => {
    // Apple reports 0.527 at 80 s and nothing new until 113 s.
    expect(estimate(RUN, 110, PHOTOGRAMMETRY)!).toBeLessThan(estimate(RUN, 85, PHOTOGRAMMETRY)!);
  });

  it("evenly going work keeps the straight estimate", () => {
    expect(
      secondsLeft(
        [
          [0, 0.1],
          [60, 0.5],
        ],
        60,
      ),
    ).toBe(60);
    expect(secondsLeft([[60, 0.02]], 60)).toBeNull();
    expect(secondsLeft([[10, 0.5]], 10)).toBeNull();
  });
});
