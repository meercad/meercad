/**
 * Boxes with lids and snap hooks: their defaults, the sizes that follow from them (shared by the
 * kernel, which builds the solids, and the dialog, which shows them), and the strain of a snap hook.
 *
 * Snap lid: the lid's lip reaches into the box, a bead round its outside clicks into a groove round
 * the inside of the box wall. Screw lid: a coarse printable thread (45° flanks, so neither the box
 * nor the cap printed upside down needs supports) on a neck narrower than the box, the cap's skirt
 * as wide as the box.
 */
import type { BoxFeature, SnapHookFeature } from "@meercad/schema";

/**
 * Play between mating printed parts per side, mm. Kept in one place: the document's printer fit
 * (`fit`) takes its place once documents carry one.
 */
export const DEFAULT_CLEARANCE = 0.2;

export const BOX = {
  wall: 2,
  corner: 4,
  snap: 0.5,
  lipHeight: 6,
  pitch: 4,
  neck: 12,
  /** Lid laid out beside the box: the gap between them. */
  layoutGap: 10,
  /** Finger-nail notch in the rim of snap boxes. */
  notchWidth: 12,
  notchDepth: 1.5,
} as const;

export const SNAP_HOOK = {
  length: 10,
  thickness: 1.6,
  width: 6,
  overhang: 0.8,
  insertAngle: 30,
  retainAngle: 90,
} as const;

export class ClosureError extends Error {}

export interface ResolvedBox extends Omit<
  BoxFeature,
  | "width"
  | "depth"
  | "height"
  | "wall"
  | "floor"
  | "corner"
  | "lidThickness"
  | "clearance"
  | "snap"
  | "lipHeight"
  | "pitch"
  | "neck"
  | "starts"
  | "position"
  | "shape"
> {
  shape: "rect" | "round";
  width: number;
  depth: number;
  height: number;
  wall: number;
  floor: number;
  corner: number;
  lidThickness: number;
  clearance: number;
  snap: number;
  lipHeight: number;
  pitch: number;
  neck: number;
  starts: number;
  position: [number, number];
}

export interface ResolvedSnapHook extends Omit<
  SnapHookFeature,
  | "points"
  | "angle"
  | "length"
  | "thickness"
  | "width"
  | "overhang"
  | "insertAngle"
  | "retainAngle"
  | "clearance"
> {
  points: [number, number][];
  angle: number;
  length: number;
  thickness: number;
  width: number;
  overhang: number;
  insertAngle: number;
  retainAngle: number;
  clearance: number;
}

/** Fills in the defaults of a box whose numbers are known (`num` gives an optional field's value). */
export function boxDefaults(
  f: BoxFeature,
  num: (field: string, e: BoxFeature[keyof BoxFeature]) => number | undefined,
): ResolvedBox {
  const n = (k: keyof BoxFeature) => num(k, f[k]);
  const wall = n("wall") ?? BOX.wall;
  const width = n("width")!;
  const shape = f.lid === "screw" ? "round" : (f.shape ?? "rect");
  const starts = Math.round(n("starts") ?? 1);

  return {
    ...f,
    shape,
    width,
    depth: shape === "round" ? width : (n("depth") ?? width),
    height: n("height")!,
    wall,
    floor: n("floor") ?? wall,
    corner: shape === "round" ? width / 2 : (n("corner") ?? BOX.corner),
    lidThickness: n("lidThickness") ?? wall,
    clearance: n("clearance") ?? DEFAULT_CLEARANCE,
    snap: n("snap") ?? BOX.snap,
    lipHeight: n("lipHeight") ?? BOX.lipHeight,
    pitch: n("pitch") ?? BOX.pitch,
    neck: n("neck") ?? BOX.neck,
    starts,
    position: f.position ? [num("position[0]", f.position[0])!, num("position[1]", f.position[1])!] : [0, 0],
  };
}

/** Sizes of a snap-lid box (local frame: the box from z = 0 to `height`, centred on the origin). */
export interface SnapBoxSizes {
  /** Inside of the box. */
  inner: [number, number];
  innerCorner: number;
  /** Outside of the lid's lip, its thickness and how far it reaches down (to z = height − lipHeight). */
  lipOuter: [number, number];
  lipCorner: number;
  lip: number;
  /** Middle of the bead (and the groove) above the box's bottom. */
  beadZ: number;
  /** Half the height of the bead's flat; the flanks are 45°. */
  beadFlat: number;
  /** Inside height of the box, from its floor to the rim. */
  depthInside: number;
}

/** Sizes of a screw-lid jar (radii; local frame as for snap boxes). */
export interface ScrewBoxSizes {
  radius: number;
  /** Inside radius below the neck and in the neck. */
  inner: number;
  neckInner: number;
  /** Outside radius of the neck (the thread's root). */
  neckOuter: number;
  /** Inside radius of the cap's skirt. */
  skirt: number;
  /** Thread depth, root width and tip width (axial). */
  threadDepth: number;
  rootWidth: number;
  tipWidth: number;
  /** z of the shoulder the neck rises from. */
  shoulder: number;
  /** Gap between the cap's skirt and the shoulder when closed. */
  capGap: number;
  /** Turns of thread on the neck. */
  turns: number;
  depthInside: number;
}

const check = (ok: boolean, message: string) => {
  if (!ok) throw new ClosureError(message);
};

function common(b: ResolvedBox) {
  check(b.wall >= 0.8 && b.wall <= 10, "the wall must be between 0.8 and 10 mm thick");
  check(
    b.floor >= 0.6 && b.floor <= b.height - 2,
    "the bottom must be at least 0.6 mm thick and leave room inside",
  );
  check(b.lidThickness >= 0.6 && b.lidThickness <= 20, "the lid must be between 0.6 and 20 mm thick");
  check(b.clearance >= 0 && b.clearance <= 1, "the clearance must be between 0 and 1 mm");
  check(
    b.width >= 15 && b.width <= 1000 && b.depth >= 15 && b.depth <= 1000,
    "the box must be between 15 and 1000 mm wide and deep",
  );
  check(b.height >= 8 && b.height <= 1000, "the box must be between 8 and 1000 mm high");
}

export function snapBoxSizes(b: ResolvedBox): SnapBoxSizes {
  common(b);

  const t = b.wall,
    c = b.clearance,
    s = b.snap;
  check(s >= 0.2 && s <= 2, "the snap must be between 0.2 and 2 mm");
  check(
    s + 0.6 <= t,
    `a ${s} mm snap needs a wall of at least ${(s + 0.6).toFixed(1)} mm (the groove is cut into it)`,
  );

  const inner: [number, number] = [b.width - 2 * t, b.depth - 2 * t];
  const innerCorner = Math.max(0, b.corner - t);

  if (b.shape === "rect") {
    check(b.corner >= 0 && b.corner <= Math.min(b.width, b.depth) / 2, "the corner radius must fit the box");
  }

  const lip = Math.min(Math.max(0.75 * t, 1.2), 2);
  const lipOuter: [number, number] = [inner[0] - 2 * c, inner[1] - 2 * c];
  check(Math.min(...lipOuter) > 2 * lip + 4, "the box is too small for its lid's lip");

  const beadFlat = 0.4;
  const depthInside = b.height - b.floor;
  const minLip = 2 * (s + beadFlat) + 1.6;
  check(
    b.lipHeight >= minLip && b.lipHeight <= depthInside - 1,
    `the lip must reach between ${minLip.toFixed(1)} and ${(depthInside - 1).toFixed(1)} mm into the box`,
  );

  // The bead sits near the lip's free end, where it gives most easily.
  const beadZ = b.height - b.lipHeight + 0.8 + s + beadFlat;

  return {
    inner,
    innerCorner,
    lipOuter,
    lipCorner: Math.max(0, innerCorner - c),
    lip,
    beadZ,
    beadFlat,
    depthInside,
  };
}

export function screwBoxSizes(b: ResolvedBox): ScrewBoxSizes {
  common(b);

  const R = b.width / 2,
    t = b.wall,
    c = b.clearance,
    P = b.pitch;
  check(P >= 1.5 && P <= 10, "the pitch must be between 1.5 and 10 mm");
  check(b.starts >= 1 && b.starts <= 4, "a thread has 1 to 4 starts");

  const threadDepth = 0.25 * P;
  const skirt = R - t;
  const neckOuter = skirt - threadDepth - c;
  const neckInner = neckOuter - t;
  check(
    neckInner >= 4,
    `the jar is too narrow for its wall and thread: make it at least ${(2 * (R - neckInner + 4)).toFixed(0)} mm wide`,
  );

  const shoulder = b.height - b.neck;
  check(
    b.neck >= P + 3 && b.neck <= b.height - b.floor - 2,
    `the neck must be between ${(P + 3).toFixed(1)} and ${(b.height - b.floor - 2).toFixed(1)} mm high`,
  );
  // Inside, the wall narrows from the box to the neck at 45° below the shoulder.
  check(
    shoulder - (R - neckOuter) >= b.floor + 1,
    "the jar is too low for its neck: make it taller or the neck shorter",
  );

  const capGap = Math.max(0.5, 2 * c);

  return {
    radius: R,
    inner: R - t,
    neckInner,
    neckOuter,
    skirt,
    threadDepth,
    rootWidth: 0.7 * P,
    tipWidth: 0.7 * P - 2 * threadDepth,
    shoulder,
    capGap,
    turns: (b.neck - 2) / (P * b.starts),
    depthInside: b.height - b.floor,
  };
}

/** Fills in a snap hook's defaults. */
export function snapHookDefaults(
  f: SnapHookFeature,
  num: (field: string, e: SnapHookFeature[keyof SnapHookFeature]) => number | undefined,
): ResolvedSnapHook {
  const n = (k: keyof SnapHookFeature) => num(k, f[k]);

  return {
    ...f,
    points: f.points.map(
      ([u, v], i) => [num(`points[${i}][0]`, u)!, num(`points[${i}][1]`, v)!] as [number, number],
    ),
    angle: n("angle") ?? 0,
    length: n("length") ?? SNAP_HOOK.length,
    thickness: n("thickness") ?? SNAP_HOOK.thickness,
    width: n("width") ?? SNAP_HOOK.width,
    overhang: n("overhang") ?? SNAP_HOOK.overhang,
    insertAngle: n("insertAngle") ?? SNAP_HOOK.insertAngle,
    retainAngle: n("retainAngle") ?? SNAP_HOOK.retainAngle,
    clearance: n("clearance") ?? DEFAULT_CLEARANCE,
  };
}

export function checkSnapHook(
  h: Pick<
    ResolvedSnapHook,
    "length" | "thickness" | "width" | "overhang" | "insertAngle" | "retainAngle" | "clearance"
  >,
): void {
  check(h.length >= 2 && h.length <= 200, "the hook must be between 2 and 200 mm long");
  check(h.thickness >= 0.6 && h.thickness <= 20, "the hook must be between 0.6 and 20 mm thick");
  check(h.width >= 1 && h.width <= 200, "the hook must be between 1 and 200 mm wide");
  check(h.overhang >= 0.1 && h.overhang <= 10, "the overhang must be between 0.1 and 10 mm");
  check(h.insertAngle >= 10 && h.insertAngle <= 60, "the lead-in angle must be between 10° and 60°");
  check(h.retainAngle >= 20 && h.retainAngle <= 90, "the holding angle must be between 20° and 90°");
  check(h.clearance >= 0 && h.clearance <= 2, "the clearance must be between 0 and 2 mm");
}

/**
 * Outline of a snap hook across its width, in its own plane: x towards the barb (the beam's front
 * at x = 0, its back at −thickness), z up the beam from the face. Counter-clockwise, closed. A 45°
 * fillet-like web at the back of the root takes the bending stress there.
 */
export function snapHookProfile(
  h: Pick<ResolvedSnapHook, "length" | "thickness" | "overhang" | "insertAngle" | "retainAngle">,
): { points: [number, number][]; top: number; catchZ: number } {
  const t = h.thickness,
    y = h.overhang,
    L = h.length;
  const rad = (d: number) => (d * Math.PI) / 180;
  const catchOuter = L + (h.retainAngle >= 89.999 ? 0 : y / Math.tan(rad(h.retainAngle)));
  const land = Math.min(0.5, y * 0.5);
  const leadTop = catchOuter + land + y / Math.tan(rad(h.insertAngle));
  const web = Math.min(0.5 * t, L * 0.25);
  const e = 0.05;
  const points: [number, number][] = [
    [-t - web, -e],
    [0, -e],
    [0, L],
    [y, catchOuter],
    [y, catchOuter + land],
    [0, leadTop],
    [-t, leadTop],
    [-t, web],
  ];

  return { points, top: leadTop, catchZ: L };
}

/** Largest strain in a hook's beam when it bends back by its overhang (straight cantilever, 1.5·t·y/L²). */
export function snapHookStrain(h: Pick<ResolvedSnapHook, "length" | "thickness" | "overhang">): number {
  return (1.5 * h.thickness * h.overhang) / (h.length * h.length);
}

/**
 * Strain a printed snap may take again and again, by filament type (rough values for prints:
 * about half of what the moulded plastic allows). Unknown: PLA's.
 */
export const SNAP_STRAIN: Readonly<Record<string, number>> = {
  PLA: 0.02,
  "PLA-CF": 0.012,
  PETG: 0.035,
  "PETG-CF": 0.02,
  ABS: 0.035,
  ASA: 0.035,
  PA: 0.05,
  PC: 0.04,
  TPU: 0.3,
};

export function allowedSnapStrain(filament: string | undefined): number {
  return (filament && SNAP_STRAIN[filament]) || SNAP_STRAIN["PLA"]!;
}
