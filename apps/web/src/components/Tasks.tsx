/**
 * What the app is busy with, with progress: slow rebuilds, reading an import. A task shows
 * only once it has run for a moment, so quick rebuilds never flash a bar.
 */
import { useEffect, useState } from "react";
import { useApp } from "../store";

const SHOW_AFTER_MS = 350;

export function Tasks() {
  const tasks = useApp((s) => s.tasks);
  const [, tick] = useState(0);
  // Re-render when the youngest hidden task becomes old enough to show.
  useEffect(() => {
    const now = performance.now();
    const waits = tasks.map((t) => SHOW_AFTER_MS - (now - t.since)).filter((w) => w > 0);
    if (!waits.length) return;
    const id = window.setTimeout(() => tick((n) => n + 1), Math.min(...waits) + 5);
    return () => window.clearTimeout(id);
  }, [tasks]);
  const now = performance.now();
  const shown = tasks.filter((t) => now - t.since >= SHOW_AFTER_MS);
  if (!shown.length) return null;
  return (
    <div className="tasks" role="status" aria-live="polite">
      {shown.map((t) => (
        <div key={t.id} className="task">
          <div className="task-text">
            <span className="task-label">{t.label}</span>
            {t.detail ? <span className="task-detail">{t.detail}</span> : null}
            {t.progress !== null ? <span className="task-pct">{Math.round(t.progress * 100)} %</span> : null}
          </div>
          <div className={`task-bar ${t.progress === null ? "indeterminate" : ""}`}>
            <div className="task-fill" style={t.progress === null ? undefined : { width: `${Math.max(2, Math.min(100, t.progress * 100))}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
