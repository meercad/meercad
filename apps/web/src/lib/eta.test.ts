/** Time left for long work, straight and along a pace curve. */
import { describe, expect, it } from "vitest";
import { PHOTOGRAMMETRY, secondsLeft, timeShare, type PaceCurve } from "./eta";

const curve: PaceCurve = [
  [0.1, 0.2],
  [0.5, 0.5],
  [0.5, 0.6],
  [1, 1],
];

describe("timeShare", () => {
  it("reads the curve straight between its points", () => {
    expect(timeShare(curve, 0)).toBe(0.2);
    expect(timeShare(curve, 0.3)).toBeCloseTo(0.35);
    expect(timeShare(curve, 0.75)).toBeCloseTo(0.8);
    expect(timeShare(curve, 2)).toBe(1);
    expect(timeShare(PHOTOGRAMMETRY, 0.5)).toBe(0.197);
  });

  it("takes the first point of a step in the curve", () => {
    expect(
      timeShare(
        [
          [0, 0],
          [0, 0.4],
          [1, 1],
        ],
        0,
      ),
    ).toBe(0);
    expect(
      timeShare(
        [
          [0, 0],
          [0.5, 0.3],
          [0.5, 0.5],
        ],
        0.5,
      ),
    ).toBe(0.3);
  });
});

describe("secondsLeft", () => {
  it("waits for some progress and some time", () => {
    expect(secondsLeft([], 100)).toBeNull();
    expect(secondsLeft([[10, 0.02]], 100)).toBeNull();
    expect(secondsLeft([[10, 0.5]], 10)).toBeNull();
  });

  it("estimates straight from the latest progress without a curve", () => {
    expect(secondsLeft([[30, 0.25]], 40)).toBe(120);
  });

  it("averages the whole time each report gives along a curve", () => {
    const linear: PaceCurve = [
      [0, 0],
      [1, 1],
    ];

    // Both reports say 100 s in all; 40 s have gone by.
    expect(
      secondsLeft(
        [
          [20, 0.2],
          [40, 0.4],
        ],
        40,
      ),
    ).toBe(60);
    expect(
      secondsLeft(
        [
          [20, 0.2],
          [40, 0.4],
        ],
        40,
        linear,
      ),
    ).toBeCloseTo(60);
  });

  it("never counts down below what the next step still leaves", () => {
    const linear: PaceCurve = [
      [0, 0],
      [1, 1],
    ];

    expect(secondsLeft([[50, 0.5]], 99, linear)).toBeCloseTo(45);
  });

  it("needs a report past the first few percent for a curve", () => {
    expect(secondsLeft([[25, 0.04]], 30, PHOTOGRAMMETRY)).toBeNull();
  });
});
