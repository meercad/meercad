import { useEffect, useState } from "react";
import { kernel, useApp } from "../store";

/** Open the app with `?debug` to show it. */
export const debugHud = new URLSearchParams(location.search).has("debug");

type Counts = { moves: number; pen: number; touch: number; frames: number; requests: number; results: number; superseded: number; rebuildMs: number[] };
const zero = (): Counts => ({ moves: 0, pen: 0, touch: 0, frames: 0, requests: 0, results: 0, superseded: 0, rebuildMs: [] });

/**
 * Live counters for diagnosing input and rebuild timing on devices without developer tools
 * (iPad): pointer moves, animation frames, kernel requests and results per second, plus totals
 * for the last press-to-release.
 */
export function DebugHud() {
  const [view, setView] = useState<{ sec: Counts; press: Counts; afterUpMs: number | null; down: boolean }>({ sec: zero(), press: zero(), afterUpMs: null, down: false });
  useEffect(() => {
    let sec = zero();
    let press = zero();
    let down = false;
    let upAt = 0;
    let afterUpMs: number | null = null;
    const both = (f: (c: Counts) => void) => {
      f(sec);
      if (down) f(press);
    };
    const onMove = (e: PointerEvent) => both((c) => {
      c.moves++;
      if (e.pointerType === "pen") c.pen++;
      if (e.pointerType === "touch") c.touch++;
    });
    const onDown = () => {
      down = true;
      press = zero();
      afterUpMs = null;
    };
    const onUp = () => {
      down = false;
      upAt = performance.now();
    };
    const original = kernel.rebuild.bind(kernel);
    kernel.rebuild = (doc) => {
      const t0 = performance.now();
      both((c) => c.requests++);
      return original(doc).then(
        (r) => {
          both((c) => {
            c.results++;
            c.rebuildMs.push(performance.now() - t0);
          });
          if (!down && upAt) afterUpMs = Math.round(performance.now() - upAt);
          return r;
        },
        (e: unknown) => {
          both((c) => c.superseded++);
          throw e;
        },
      );
    };
    let raf = 0;
    const frame = () => {
      both((c) => c.frames++);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const tick = window.setInterval(() => {
      setView({ sec, press: { ...press, rebuildMs: [...press.rebuildMs] }, afterUpMs, down });
      sec = zero();
    }, 1000);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      kernel.rebuild = original;
      cancelAnimationFrame(raf);
      window.clearInterval(tick);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, []);
  const previewing = useApp((s) => s.previewing);
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const { sec, press } = view;
  return (
    <div className="debug-hud">
      <div>
        <b>per second</b> moves {sec.moves} (pen {sec.pen}, touch {sec.touch}) · frames {sec.frames} · rebuilds {sec.requests} → {sec.results} done, {sec.superseded} skipped · {avg(sec.rebuildMs)} ms
      </div>
      <div>
        <b>{view.down ? "pressing" : "last press"}</b> moves {press.moves} · frames {press.frames} · rebuilds {press.requests} → {press.results} done, {press.superseded} skipped · {avg(press.rebuildMs)} ms
        {view.afterUpMs !== null ? ` · last result ${view.afterUpMs} ms after release` : ""} · {previewing ? "preview" : "model"}
      </div>
    </div>
  );
}
