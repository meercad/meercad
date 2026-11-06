import type { ResolvedTexture } from "@meercad/model";
import type { BooleanMode } from "@meercad/schema";
import type { PlaneFrame, Region, SolvedSketch } from "@meercad/sketch";
import type { Arena } from "./arena.js";
import type { Body } from "./body.js";
import type { GearRecord } from "./gear.js";
import type { GridRecord } from "./gridfinity.js";

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

/** A texture step: the part as it was then, and the face indices on it (see texture.ts). */
export interface TextureRecord {
  feature: ResolvedTexture;
  body: Body;
  faces: number[];
  /** Which way the picture's top points, for a lithophane's picture (world). */
  up?: [number, number, number];
}

export interface ModelState {
  readonly bodies: ReadonlyMap<string, Body>;
  readonly sketches: ReadonlyMap<string, SketchResult>;
  readonly planes: ReadonlyMap<string, PlaneFrame>;
  readonly tools: ReadonlyMap<string, ToolRecord>;
  readonly references: ReadonlyMap<string, ReferenceMesh>;
  /** Gears by feature id, for gears that mesh with them. */
  readonly gears: ReadonlyMap<string, GearRecord>;
  /** Gridfinity baseplates by feature id, for bins set into them (absent in older states). */
  readonly grids?: ReadonlyMap<string, GridRecord>;
  /** Surface textures by feature id; they change only the triangles, never the solid. */
  readonly textures?: ReadonlyMap<string, TextureRecord>;
  /** Objects created by the feature that produced this state. */
  readonly arena: Arena;
}
