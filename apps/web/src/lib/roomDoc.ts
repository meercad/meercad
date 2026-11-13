/**
 * A scanned room (Apple's RoomPlan, see apps/ios RoomPlugin) as a design of ordinary, editable
 * parts: the floor, each wall with its doors, windows and openings cut out, and the furniture as
 * boxes of their measured size in a group of their own. Everything is a sketch on a level plane
 * and an extrude, so walls can be pushed, moved and cut like any part.
 */
import type { Feature, MeercadDocument, SketchEntity } from "@meercad/schema";

type Vec3 = [number, number, number];

/**
 * A measured surface (mm, Z up): its middle, the direction of its width seen from above, width × height ×
 * depth.
 */
export interface RoomSurface {
  id: string;
  center: Vec3;
  along: [number, number];
  size: Vec3;
  /** Doors, windows and openings: the wall they are in. */
  wall?: string;
  /** Floors: their outline. */
  corners?: Vec3[];
}

export interface RoomObject {
  category: string;
  center: Vec3;
  along: [number, number];
  /** Width, depth, height (mm). */
  size: Vec3;
}

export interface RoomScan {
  walls: RoomSurface[];
  doors: RoomSurface[];
  windows: RoomSurface[];
  openings: RoomSurface[];
  floors: RoomSurface[];
  objects: RoomObject[];
}

/** Wall thickness the scan cannot see (it measures the room side only). */
export const WALL = 120;

const FLOOR = 100;

/** Names in the interface language (the caller passes t()). */
export interface RoomNames {
  wall: (n: number) => string;
  floor: string;
  furniture: string;
  object: (category: string) => string;
  door: string;
  window: string;
  opening: string;
}

const r = (v: number) => Math.round(v);

/** Corners of a box seen from above: middle, width direction, width and depth. */
function footprint(
  cx: number,
  cy: number,
  along: [number, number],
  width: number,
  depth: number,
): [number, number][] {
  const [ux, uy] = along;
  const [nx, ny] = [-uy, ux];

  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([a, b]) => [
    r(cx + (ux * a! * width) / 2 + (nx * b! * depth) / 2),
    r(cy + (uy * a! * width) / 2 + (ny * b! * depth) / 2),
  ]);
}

function polygon(points: [number, number][]): SketchEntity[] {
  const pts: SketchEntity[] = points.map(([x, y], i) => ({ id: `p${i + 1}`, type: "point", x, y }));
  const lines: SketchEntity[] = points.map((_, i) => ({
    id: `l${i + 1}`,
    type: "line",
    p1: `p${i + 1}`,
    p2: `p${((i + 1) % points.length) + 1}`,
  }));

  return [...pts, ...lines];
}

export function roomDocument(scan: RoomScan, names: RoomNames): MeercadDocument {
  // The floor at height 0.
  const bottoms = [...scan.walls, ...scan.floors].map(
    (surface) => surface.center[2] - (scan.floors.includes(surface) ? 0 : surface.size[1] / 2),
  );
  const floorZ = bottoms.length ? Math.min(...bottoms) : 0;
  const features: Feature[] = [];
  const planes = new Map<number, string>();
  let next = 0;
  const id = (prefix: string) => `${prefix}${++next}`;

  /** A level plane at height z (the floor is the origin plane). */
  const plane = (z: number): { ref: string } => {
    if (Math.abs(z) < 5) return { ref: "origin.XY" };

    const key = r(z / 10) * 10;

    if (!planes.has(key)) {
      const pid = id("pl");
      planes.set(key, pid);
      features.push({
        id: pid,
        op: "plane",
        name: `${(key / 1000).toFixed(2)} m`,
        base: { ref: "origin.XY" },
        offset: key,
      });
    }

    return { ref: planes.get(key)! };
  };

  const box = (
    name: string,
    z: number,
    outline: [number, number][],
    height: number,
    mode: "new_body" | "cut",
    targets?: string[],
    flip = false,
  ): string => {
    const sk = id("sk");
    const ex = id("ex");
    features.push({
      id: sk,
      op: "sketch",
      name,
      plane: plane(z),
      entities: polygon(outline),
      constraints: [],
    });
    features.push({
      id: ex,
      op: "extrude",
      name,
      profile: { sketch: sk },
      extent: "blind",
      distance: r(height),
      mode,
      ...(targets ? { targets } : {}),
      ...(flip ? { flip: true } : {}),
    });

    return ex;
  };

  // Floor: its measured outline, or the box around the walls.
  const floor = scan.floors.find((surface) => (surface.corners?.length ?? 0) >= 3);
  let outline: [number, number][] | null = floor ? floor.corners!.map((c) => [r(c[0]), r(c[1])]) : null;

  if (!outline && scan.walls.length) {
    const xs = scan.walls.flatMap((surface) => [
      surface.center[0] - (surface.along[0] * surface.size[0]) / 2,
      surface.center[0] + (surface.along[0] * surface.size[0]) / 2,
    ]);
    const ys = scan.walls.flatMap((surface) => [
      surface.center[1] - (surface.along[1] * surface.size[0]) / 2,
      surface.center[1] + (surface.along[1] * surface.size[0]) / 2,
    ]);
    outline = [
      [r(Math.min(...xs)), r(Math.min(...ys))],
      [r(Math.max(...xs)), r(Math.min(...ys))],
      [r(Math.max(...xs)), r(Math.max(...ys))],
      [r(Math.min(...xs)), r(Math.max(...ys))],
    ];
  }

  if (outline) box(names.floor, 0, outline, FLOOR, "new_body", undefined, true);

  // Walls, a little longer than measured so neighbours meet at the corners.
  const wallBody = new Map<string, string>();
  scan.walls.forEach((surface, i) => {
    const bottom = surface.center[2] - surface.size[1] / 2 - floorZ;
    wallBody.set(
      surface.id,
      box(
        names.wall(i + 1),
        bottom,
        footprint(surface.center[0], surface.center[1], surface.along, surface.size[0] + WALL, WALL),
        surface.size[1],
        "new_body",
      ),
    );
  });

  // Doors, windows and openings cut through their wall (or the nearest one).
  const nearest = (surface: RoomSurface) =>
    scan.walls.reduce<{ w: RoomSurface; d: number } | null>((best, w) => {
      const [dx, dy] = [surface.center[0] - w.center[0], surface.center[1] - w.center[1]];
      const d = Math.abs(dx * -w.along[1] + dy * w.along[0]);

      return !best || d < best.d ? { w, d } : best;
    }, null)?.w;

  for (const [list, name] of [
    [scan.doors, names.door],
    [scan.windows, names.window],
    [scan.openings, names.opening],
  ] as const) {
    for (const surface of list) {
      const wall = (surface.wall && scan.walls.find((w) => w.id === surface.wall)) || nearest(surface);
      const target = wall && wallBody.get(wall.id);
      if (!wall || !target) continue;

      const bottom = surface.center[2] - surface.size[1] / 2 - floorZ;
      box(
        name,
        Math.max(0, bottom),
        footprint(surface.center[0], surface.center[1], wall.along, surface.size[0], WALL + 100),
        surface.size[1] - Math.max(0, -bottom),
        "cut",
        [target],
      );
    }
  }

  // Furniture as boxes of their size, grouped.
  const furniture = scan.objects.map((o) =>
    box(
      names.object(o.category),
      Math.max(0, o.center[2] - o.size[2] / 2 - floorZ),
      footprint(o.center[0], o.center[1], o.along, o.size[0], o.size[1]),
      o.size[2],
      "new_body",
    ),
  );

  return {
    format: "meercad/1",
    params: {},
    features,
    ...(furniture.length
      ? {
          partGroups: [{ name: names.furniture, parts: furniture }],
          partColors: Object.fromEntries(furniture.map((f) => [f, "#c8a27c"])),
        }
      : {}),
    rollback: null,
  };
}
