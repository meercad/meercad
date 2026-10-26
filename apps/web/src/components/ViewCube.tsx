import { House } from "lucide-react";
import { useEffect, useRef } from "react";
import { THREE, type StandardView, type Viewport } from "@opencad/viewport";

const FACES: { view: StandardView; label: string; n: [number, number, number]; u: [number, number, number]; v: [number, number, number] }[] = [
  { view: "top", label: "TOP", n: [0, 0, 1], u: [1, 0, 0], v: [0, -1, 0] },
  { view: "bottom", label: "BOTTOM", n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0] },
  { view: "front", label: "FRONT", n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { view: "back", label: "BACK", n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, -1] },
  { view: "right", label: "RIGHT", n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, -1] },
  { view: "left", label: "LEFT", n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, -1] },
];

/** Orientation cube: each face is a CSS-transformed div following the camera. */
export function ViewCube({ viewport }: { viewport: Viewport }) {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    const half = 30;
    const update = () => {
      const r = new THREE.Matrix4().makeRotationFromQuaternion(viewport.cameraQuaternion.clone().invert());
      FACES.forEach((f, i) => {
        const el = refs.current[i];
        if (!el) return;
        const tr = (v: [number, number, number]) => new THREE.Vector3(...v).applyMatrix4(r);
        const u = tr(f.u);
        const v = tr(f.v);
        const n = tr(f.n);
        // Camera space is y-up; CSS is y-down.
        const m = [u.x, -u.y, u.z, 0, v.x, -v.y, v.z, 0, n.x, -n.y, n.z, 0, n.x * half, -n.y * half, n.z * half, 1];
        el.style.transform = `matrix3d(${m.map((x) => x.toFixed(5)).join(",")})`;
        el.style.visibility = n.z > 0.02 ? "visible" : "hidden";
        el.style.zIndex = String(Math.round(n.z * 100) + 100);
        el.style.opacity = String(0.55 + 0.45 * n.z);
      });
    };
    update();
    return viewport.onChange(update);
  }, [viewport]);
  return (
    <div className="viewcube">
      <div className="cube">
        {FACES.map((f, i) => (
          <div key={f.view} ref={(el) => void (refs.current[i] = el)} className="face" onClick={() => viewport.setView(f.view)} title={`${f.label.toLowerCase()} view`}>
            {f.label}
          </div>
        ))}
      </div>
      <button className="icon-btn sm home" title="Isometric view" onClick={() => viewport.setView("iso")}>
        <House />
      </button>
    </div>
  );
}
