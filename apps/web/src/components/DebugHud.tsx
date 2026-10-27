import { useEffect, useState } from "react";
import { currentDoc, kernel, useApp } from "../store";

/** Open the app with `?debug` to show it. */
export const debugHud = new URLSearchParams(location.search).has("debug");

type Counts = { moves: number; pen: number; touch: number; frames: number; requests: number; results: number; superseded: number; rebuildMs: number[] };
const zero = (): Counts => ({ moves: 0, pen: 0, touch: 0, frames: 0, requests: 0, results: 0, superseded: 0, rebuildMs: [] });

// Round trip, worker rebuild and meshing times of the latest results.
type Timing = { trip: number; rebuild: number; mesh: number };
const recent: Timing[] = [];

/**
 * Live counters for diagnosing input and rebuild timing on devices without developer tools
 * (iPad): pointer moves, animation frames, kernel requests and results per second, plus totals
 * for the last press-to-release.
 */

export function DebugHud() {
  const [bench, setBench] = useState<string>("");
  const [copied, setCopied] = useState(false);
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
          const trip = performance.now() - t0;
          both((c) => {
            c.results++;
            c.rebuildMs.push(trip);
          });
          recent.unshift({ trip, rebuild: r.report.rebuildMs, mesh: r.report.meshMs });
          recent.length = Math.min(recent.length, 4);
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
  const lines = [
    `per second: moves ${sec.moves} (pen ${sec.pen}, touch ${sec.touch}) · frames ${sec.frames} · rebuilds ${sec.requests} → ${sec.results} done, ${sec.superseded} skipped · ${avg(sec.rebuildMs)} ms`,
    `${view.down ? "pressing" : "last press"}: moves ${press.moves} · frames ${press.frames} · rebuilds ${press.requests} → ${press.results} done, ${press.superseded} skipped · ${avg(press.rebuildMs)} ms${view.afterUpMs !== null ? ` · last result ${view.afterUpMs} ms after release` : ""} · ${previewing ? "preview" : "model"}`,
    `last results: ${recent.map((t) => `${Math.round(t.trip)} ms (kernel ${Math.round(t.rebuild)} + mesh ${Math.round(t.mesh)})`).join(" · ") || "none"}`,
    `bench: ${bench || "not run"}`,
  ];
  return (
    <div className="debug-hud">
      {lines.slice(0, 3).map((l) => (
        <div key={l.slice(0, 10)}>{l}</div>
      ))}
      <div className="debug-bench">
        <button onClick={() => void runBench(setBench)}>Bench</button>
        <button onClick={() => (copyText([navigator.userAgent, ...lines].join("\n")), setCopied(true), window.setTimeout(() => setCopied(false), 1500))}>{copied ? "Copied" : "Copy"}</button> {bench}
      </div>
    </div>
  );
}

/** Copies text; plain http on the local network has no clipboard API, so it falls back to execCommand. */
function copyText(text: string): void {
  if (navigator.clipboard && isSecureContext) {
    void navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  Object.assign(ta.style, { position: "fixed", top: "0", left: "0", opacity: "0", fontSize: "16px" });
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  document.execCommand("copy");
  ta.remove();
}

/**
 * Rebuilds the open part five times with its last size value nudged, without any input going on,
 * to tell a slow kernel apart from one starved while the pen moves.
 */
async function runBench(show: (s: string) => void): Promise<void> {
  const doc = currentDoc();
  const f = [...doc.features].reverse().find((x) => x.op === "extrude" || x.op === "fillet" || x.op === "chamfer" || x.op === "shell");
  const key = f ? (["distance", "radius", "thickness"] as const).find((k) => k in f) : undefined;
  if (!f || !key) return show("needs an extrude, fillet, chamfer or shell");
  const base = parseFloat(String((f as unknown as Record<string, unknown>)[key])) || 2;
  const out: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const d = structuredClone(doc);
    const g = d.features.find((x) => x.id === f.id) as unknown as Record<string, unknown>;
    g[key] = +(base * (1 + i * 0.03)).toFixed(3);
    const t = performance.now();
    const r = await kernel.rebuild(d);
    out.push(`${Math.round(performance.now() - t)}/${Math.round(r.report.rebuildMs)}/${Math.round(r.report.meshMs)}`);
    show(`${f.id}.${key}: ${out.join("  ")} ms (round trip/kernel/mesh)`);
  }
  await kernel.rebuild(doc);
}
