import type { BooleanMode } from "@opencad/schema";
import type { PlaneFrame, Region, SolvedSketch } from "@opencad/sketch";
import type { Arena } from "./arena.js";
import type { Body } from "./body.js";

export interface SketchResult {
  id: string;
  frame: PlaneFrame;
  solved: SolvedSketch;
  regions: Region[];
}

/** The solid a feature adds or removes, kept so patterns and mirrors can replay it. */
export interface ToolRecord {
  mode: BooleanMode;
  body: Body;
}

export interface ReferenceMesh {
  id: string;
  positions: Float32Array;
  indices: Uint32Array;
}

export interface ModelState {
  readonly bodies: ReadonlyMap<string, Body>;
  readonly sketches: ReadonlyMap<string, SketchResult>;
  readonly planes: ReadonlyMap<string, PlaneFrame>;
  readonly tools: ReadonlyMap<string, ToolRecord>;
  readonly references: ReadonlyMap<string, ReferenceMesh>;
  /** Objects created by the feature that produced this state. */
  readonly arena: Arena;
}
