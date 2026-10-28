import { House, RotateCcw, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { THREE, type Viewport } from "@meercad/viewport";
import { useKey } from "../lib/keymap";
import { withKey } from "./Kbd";

type V = [number, number, number];
// Faces carry the colour of the axis they face (the same colours as the origin planes).
const AXIS_COLORS = { x: "#e5484d", y: "#22a35a", z: "#3b82f6" };
const FACES: { label: string; n: V; u: V; v: V; tint: string }[] = [
  { label: "TOP", n: [0, 0, 1], u: [1, 0, 0], v: [0, -1, 0], tint: AXIS_COLORS.z },
  { label: "BOTTOM", n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], tint: AXIS_COLORS.z },
  { label: "FRONT", n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1], tint: AXIS_COLORS.y },
  { label: "BACK", n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, -1], tint: AXIS_COLORS.y },
  { label: "RIGHT", n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, -1], tint: AXIS_COLORS.x },
  { label: "LEFT", n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, -1], tint: AXIS_COLORS.x },
];
const AXES: { name: "x" | "y" | "z"; dir: V }[] = [
  { name: "x", dir: [1, 0, 0] },
  { name: "y", dir: [0, 1, 0] },
  { name: "z", dir: [0, 0, 1] },
];
/** Cube edge in px. Its widest projection (a corner-on view) is √3 × this, which must clear the buttons below. */
const SIZE = 70;
/** How far the axis lines run past the cube. */
const AXIS_OVERHANG = 8;
const GAP_SCALE = 0.92;

/**
 * Orientation cube. Each face is split 3×3: the center looks at the face, border cells at the
 * adjacent edge, corner cells at the corner. Dragging the cube orbits the camera.
 */
export function ViewCube({ viewport }: { viewport: Viewport }) {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const axisRefs = useRef<(SVGGElement | null)[]>([]);
  const [hot, setHot] = useState<string | null>(null);
  const isoKey = useKey("view.iso");
  useEffect(() => {
    const half = SIZE / 2;
    const update = () => {
      const r = new THREE.Matrix4().makeRotationFromQuaternion(viewport.cameraQuaternion.clone().invert());
      FACES.forEach((f, i) => {
        const el = refs.current[i];
        if (!el) return;
        const tr = (v: V) => new THREE.Vector3(...v).applyMatrix4(r);
        const [u, v, n] = [tr(f.u), tr(f.v), tr(f.n)];
        // Camera space is y-up, CSS is y-down.
        // Faces are drawn slightly smaller than the cube, leaving a thin gap along every edge.
        const k = GAP_SCALE;
        const m = [u.x * k, -u.y * k, u.z * k, 0, v.x * k, -v.y * k, v.z * k, 0, n.x, -n.y, n.z, 0, n.x * half, -n.y * half, n.z * half, 1];
        el.style.transform = `matrix3d(${m.map((x) => x.toFixed(5)).join(",")})`;
        el.style.visibility = n.z > 0.01 ? "visible" : "hidden";
        el.style.zIndex = String(Math.round(n.z * 100) + 100);
        el.style.filter = `brightness(${(0.86 + 0.14 * n.z).toFixed(3)})`;
      });
      // Axis triad from the left-front-bottom corner, along the cube's edges and a little beyond.
      const corner = new THREE.Vector3(-half, -half, -half).applyMatrix4(r);
      AXES.forEach((a, i) => {
        const g = axisRefs.current[i];
        if (!g) return;
        const end = new THREE.Vector3(...a.dir).multiplyScalar(SIZE + AXIS_OVERHANG).add(new THREE.Vector3(-half, -half, -half)).applyMatrix4(r);
        const [x1, y1, x2, y2] = [corner.x + half, -corner.y + half, end.x + half, -end.y + half];
        const line = g.querySelector("line")!;
        line.setAttribute("x1", x1.toFixed(1));
        line.setAttribute("y1", y1.toFixed(1));
        line.setAttribute("x2", x2.toFixed(1));
        line.setAttribute("y2", y2.toFixed(1));
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const label = g.querySelector("text")!;
        label.setAttribute("x", (x2 + (dx / len) * 7).toFixed(1));
        label.setAttribute("y", (y2 + (dy / len) * 7).toFixed(1));
        // An axis pointing at or away from the viewer collapses to a dot: hide its label.
        g.style.opacity = len < 12 ? "0" : "1";
      });
    };
    update();
    return viewport.onChange(update);
  }, [viewport]);

  // Drag anywhere on the cube to orbit; a short click selects a view.
  const drag = useRef<{ x: number; y: number; moved: boolean; dir: V | null } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    // Remember which cell was pressed: pointer capture below would retarget the pointerup.
    const raw = (e.target as HTMLElement).dataset["dir"];
    drag.current = { x: e.clientX, y: e.clientY, moved: false, dir: raw ? (raw.split(",").map(Number) as V) : null };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    viewport.orbit(-dx * 0.012, -dy * 0.012);
  };
  // Fingers and pens get no dblclick on iPad: two quick taps reset the view like a double click.
  const lastTap = useRef(0);
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    e.stopPropagation();
    if (!d || d.moved) return;
    const now = performance.now();
    const double = e.pointerType !== "mouse" && now - lastTap.current < 350;
    lastTap.current = double ? 0 : now;
    if (double) viewport.setView("iso");
    else if (d.dir) viewport.viewFrom(d.dir);
  };

  const cellDir = (f: (typeof FACES)[number], row: number, col: number): V => {
    const a = col - 1;
    const b = row - 1;
    return [0, 1, 2].map((k) => f.n[k]! + a * f.u[k]! + b * f.v[k]!) as V;
  };
  const key = (d: V) => d.map((x) => Math.round(x)).join(",");

  return (
    <div className="viewcube" onPointerMove={onMove}>
      <svg className="cube-axes" viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
        {AXES.map((a, i) => (
          <g key={a.name} ref={(el) => void (axisRefs.current[i] = el)} style={{ color: AXIS_COLORS[a.name] }}>
            <line />
            <text>{a.name.toUpperCase()}</text>
          </g>
        ))}
      </svg>
      <div className="cube" onPointerDown={onDown} onPointerUp={onUp} onDoubleClick={() => viewport.setView("iso")}>
        {FACES.map((f, i) => (
          <div key={f.label} ref={(el) => void (refs.current[i] = el)} className="face" style={{ "--tint": f.tint } as React.CSSProperties}>
            <span className="face-label">{f.label}</span>
            {[0, 1, 2].map((row) =>
              [0, 1, 2].map((col) => {
                const dir = cellDir(f, row, col);
                const k = key(dir);
                return (
                  <div
                    key={`${row}${col}`}
                    className={`cell ${row === 1 && col === 1 ? "center" : row === 1 || col === 1 ? "edge" : "corner"} ${hot === k ? "hot" : ""}`}
                    style={{ gridRow: row + 1, gridColumn: col + 1 }}
                    onPointerEnter={() => setHot(k)}
                    onPointerLeave={() => setHot((h) => (h === k ? null : h))}
                    data-dir={dir.join(",")}
                    title={row === 1 && col === 1 ? `${f.label.toLowerCase()} view` : "view from here"}
                  />
                );
              }),
            )}
          </div>
        ))}
      </div>
      <div className="cube-tools">
        <button className="icon-btn sm" title={withKey("Isometric view", isoKey)} onClick={() => viewport.setView("iso")}>
          <House />
        </button>
        <button className="icon-btn sm" title="Rotate view 90° left" onClick={() => viewport.orbit(Math.PI / 2, 0)}>
          <RotateCcw />
        </button>
        <button className="icon-btn sm" title="Rotate view 90° right" onClick={() => viewport.orbit(-Math.PI / 2, 0)}>
          <RotateCw />
        </button>
      </div>
    </div>
  );
}
