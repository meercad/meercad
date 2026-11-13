/**
 * Shown while a new sketch waits for its plane: a name tag on every plane (click to start there)
 * and a bar with the three origin planes, so the choice never depends on hitting a faint fill.
 */
import { useEffect, useRef } from "react";
import type { PlaneView, Viewport } from "@meercad/viewport";
import { t } from "../lib/i18n";
import { startSketch, useApp } from "../store";

export const PLANE_COLORS: Record<string, number> = {
  "origin.XY": 0x3b82f6,
  "origin.XZ": 0x22a35a,
  "origin.YZ": 0xe5484d,
};
export const CUSTOM_PLANE_COLOR = 0xd98a1c;

const css = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
const colorOf = (id: string) => css(PLANE_COLORS[id] ?? CUSTOM_PLANE_COLOR);

export function PlaneChooser({ viewport, planes }: { viewport: Viewport; planes: PlaneView[] }) {
  const layer = useRef<HTMLDivElement>(null);

  // Tags sit at the middle of each plane's square and follow the camera.
  useEffect(() => {
    const place = () => {
      for (const element of layer.current?.querySelectorAll<HTMLElement>("[data-plane]") ?? []) {
        const plane = planes.find((x) => x.id === element.dataset["plane"]);
        if (!plane) continue;

        const h = plane.size / 2;
        const { origin: o, u, v } = plane.frame;
        const s = viewport.worldToScreen([
          o[0] + (u[0] + v[0]) * h,
          o[1] + (u[1] + v[1]) * h,
          o[2] + (u[2] + v[2]) * h,
        ]);
        element.style.display = s ? "" : "none";
        if (s) element.style.transform = `translate(${s[0]}px, ${s[1]}px) translate(-50%, -50%)`;
      }
    };

    place();

    const off = viewport.onChange(place);
    const observer = new ResizeObserver(place);
    observer.observe(viewport.canvas);

    return () => {
      off();
      observer.disconnect();
    };
  }, [viewport, planes]);

  const hover = (id: string | null) =>
    viewport.setHover(id ? { kind: "plane", planeId: id, point: [0, 0, 0] } : null);

  const pick = (id: string) => {
    hover(null);
    startSketch({ ref: id });
  };

  return (
    <>
      <div className="plane-tags" ref={layer}>
        {planes.map((plane) => (
          <button
            key={plane.id}
            data-plane={plane.id}
            className="plane-tag"
            style={{ "--plane": colorOf(plane.id) } as React.CSSProperties}
            onPointerEnter={() => hover(plane.id)}
            onPointerLeave={() => hover(null)}
            onClick={() => pick(plane.id)}
          >
            {plane.label}
          </button>
        ))}
      </div>
      <div className="plane-bar" role="toolbar" aria-label={t("Sketch plane")}>
        <span>{t("Sketch on")}</span>
        {planes
          .filter((plane) => plane.id.startsWith("origin."))
          .map((plane) => (
            <button
              key={plane.id}
              style={{ "--plane": colorOf(plane.id) } as React.CSSProperties}
              onPointerEnter={() => hover(plane.id)}
              onPointerLeave={() => hover(null)}
              onClick={() => pick(plane.id)}
            >
              <i />
              {plane.label}
            </button>
          ))}
        <span className="muted">{t("or click a flat face")}</span>
        <button
          className="plane-bar-cancel"
          onClick={() => useApp.setState({ pickingSketchPlane: false })}
          title={t("Cancel (Esc)")}
        >
          {t("Cancel")}
        </button>
      </div>
    </>
  );
}
