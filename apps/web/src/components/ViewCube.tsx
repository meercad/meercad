import { House, RotateCcw, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { THREE, type Viewport } from "@leocad/viewport";

type V = [number, number, number];
const FACES: { label: string; n: V; u: V; v: V }[] = [
  { label: "TOP", n: [0, 0, 1], u: [1, 0, 0], v: [0, -1, 0] },
  { label: "BOTTOM", n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0] },
  { label: "FRONT", n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { label: "BACK", n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, -1] },
  { label: "RIGHT", n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, -1] },
  { label: "LEFT", n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, -1] },
];
const SIZE = 86;

/**
 * Orientation cube. Each face is split 3×3: the center looks at the face, border cells at the
 * adjacent edge, corner cells at the corner. Dragging the cube orbits the camera.
 */
export function ViewCube({ viewport }: { viewport: Viewport }) {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const [hot, setHot] = useState<string | null>(null);
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
        const m = [u.x, -u.y, u.z, 0, v.x, -v.y, v.z, 0, n.x, -n.y, n.z, 0, n.x * half, -n.y * half, n.z * half, 1];
        el.style.transform = `matrix3d(${m.map((x) => x.toFixed(5)).join(",")})`;
        el.style.visibility = n.z > 0.01 ? "visible" : "hidden";
        el.style.zIndex = String(Math.round(n.z * 100) + 100);
        el.style.filter = `brightness(${(0.82 + 0.18 * n.z).toFixed(3)})`;
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
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved && d.dir) viewport.viewFrom(d.dir);
    e.stopPropagation();
  };

  const cellDir = (f: (typeof FACES)[number], row: number, col: number): V => {
    const a = col - 1;
    const b = row - 1;
    return [0, 1, 2].map((k) => f.n[k]! + a * f.u[k]! + b * f.v[k]!) as V;
  };
  const key = (d: V) => d.map((x) => Math.round(x)).join(",");

  return (
    <div className="viewcube" onPointerMove={onMove}>
      <div className="cube" onPointerDown={onDown} onPointerUp={onUp} onDoubleClick={() => viewport.setView("iso")}>
        {FACES.map((f, i) => (
          <div key={f.label} ref={(el) => void (refs.current[i] = el)} className="face">
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
        <button className="icon-btn sm" title="Isometric view (0)" onClick={() => viewport.setView("iso")}>
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
