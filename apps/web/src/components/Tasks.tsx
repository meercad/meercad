/**
 * What the app is busy with, with progress: slow rebuilds, reading an import, a model built from
 * photos. A task shows only once it has run for a moment, so quick rebuilds never flash a bar; a
 * long one also shows how long it has run, about how long is left, and a button to stop it.
 */
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useApp, type Task } from "../store";
import { t } from "../lib/i18n";
import { secondsLeft } from "../lib/eta";

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
  // Long tasks count their time every second.
  const long = tasks.some((t) => t.long);
  useEffect(() => {
    if (!long) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [long]);
  const now = performance.now();
  const shown = tasks.filter((t) => now - t.since >= SHOW_AFTER_MS);
  if (!shown.length) return null;
  return (
    <div className="tasks" role="status" aria-live="polite">
      {shown.map((task) => (
        <div key={task.id} className="task">
          <div className="task-text">
            <span className="task-label">{task.label}</span>
            {task.detail ? <span className="task-detail">{task.detail}</span> : null}
            {task.progress !== null ? <span className="task-pct">{Math.round(task.progress * 100)} %</span> : null}
            {task.cancel ? (
              <button className="task-cancel" title={t("Stop")} onClick={task.cancel}>
                <X />
              </button>
            ) : null}
          </div>
          <div className={`task-bar ${task.progress === null ? "indeterminate" : ""}`}>
            <div className="task-fill" style={task.progress === null ? undefined : { width: `${Math.max(2, Math.min(100, task.progress * 100))}%` }} />
          </div>
          {task.long ? <div className="task-time">{timeText(task, now)}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** "3:12 so far · about 5 min left" (the estimate once there is progress to go by). */
function timeText(task: Task, now: number): string {
  const ran = (now - task.since) / 1000;
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const so = t("{time} so far", { time: clock(ran) });
  // Counted from the first progress, so choosing the photos does not count as work.
  const left = task.progress === null ? null : secondsLeft(task.progressLog ?? [], (now - (task.progressFrom ?? task.since)) / 1000, task.pace);
  if (left === null) return so;
  return `${so} · ${left < 60 ? t("less than a minute left") : t("about {n} min left", { n: Math.round(left / 60) })}`;
}
