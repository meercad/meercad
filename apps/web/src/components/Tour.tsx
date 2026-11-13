import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { rich } from "./Kbd";
import { t } from "../lib/i18n";
import { desktop } from "../lib/persistence";

interface Step {
  /** CSS selector of the element to highlight; none = centered card. */
  target?: string;
  title: string;
  body: React.ReactNode;
}

const STEPS: Step[] = [
  {
    title: t("Welcome to meerCAD"),
    body: rich(
      t(
        "A parametric CAD for makers. This short tour shows the basics — it takes about a minute. You can skip it now and restart it any time from **Help**.",
      ),
    ),
  },
  {
    target: ".toolbar",
    title: t("Tools"),
    body: rich(
      t(
        "Tools live in this rail, grouped by what they do: hover a group to open it. Every tool shows its shortcut, e.g. [S] Sketch, [E] Extrude, [F] Fillet. [X] searches all commands, [?] lists every shortcut.",
      ),
    ),
  },
  {
    target: ".tree",
    title: t("Start with a sketch"),
    body: rich(
      t(
        "Hover **Origin** and pick **Top**, **Front** or **Right** — or select a flat face and press [S]. Draw lines, rectangles and circles; dimensions and constraints keep them exact.",
      ),
    ),
  },
  {
    target: ".view",
    title: t("Move around"),
    body: rich(
      t(
        "**Right-drag** rotates, **middle-drag** or **Shift + right-drag** pans, the **wheel** zooms. [Z] fits everything.",
      ),
    ),
  },
  {
    target: ".viewcube",
    title: t("View cube"),
    body: t(
      "Click a face, edge or corner for a standard view, drag the cube to orbit, or use the arrows to turn the view by 90°.",
    ),
  },
  {
    target: ".view",
    title: t("Edit directly"),
    body: rich(
      t(
        "Click a face and **drag its arrow**: out adds material, in removes it. Click an edge and drag: away rounds it (fillet), towards the body bevels it (chamfer). Right-click anything for more actions.",
      ),
    ),
  },
  {
    target: ".side",
    title: t("History and variables"),
    body: rich(
      t(
        "Every step is recorded and stays editable — double-click to change it, drag the blue bar to roll back. **Variables** like `wall = 2 mm` can drive any dimension.",
      ),
    ),
  },
  {
    target: ".mcp-anchor",
    title: t("Work with AI"),
    body: t(
      "Connect Claude or another assistant through MCP: it can build and change parts while you watch the live preview.",
    ),
  },
  {
    title: t("You're ready"),
    body: rich(
      t("Your projects are saved automatically. Find guides and how-tos under **Help**. Have fun building!"),
    ),
  },
];

const KEY = "meercad.tourDone";

/**
 * Seen once on this Mac counts for every meerCAD on it (release, WIP, test copies); elsewhere this app's own
 * storage.
 */
export const tourDone = () => {
  if (desktop?.shared?.initial["tourDone"] === true) return true;

  try {
    const done = localStorage.getItem(KEY) === "1";
    // Seen before this was shared: tell the other copies too.
    if (done && desktop?.shared) void desktop.shared.set("tourDone", true).catch(() => undefined);

    return done;
  } catch {
    return true;
  }
};

const markDone = () => {
  void desktop?.shared?.set("tourDone", true).catch(() => undefined);

  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // tour may show again next time
  }
};

export function Tour({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = STEPS[i]!;
  useLayoutEffect(() => {
    const measure = () =>
      setRect(step.target ? (document.querySelector(step.target)?.getBoundingClientRect() ?? null) : null);
    measure();
    window.addEventListener("resize", measure);

    return () => window.removeEventListener("resize", measure);
  }, [i, step.target]);

  const close = () => {
    markDone();
    onClose();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === "Escape") close();
      if (event.key === "ArrowRight" || event.key === "Enter") i < STEPS.length - 1 ? setI(i + 1) : close();
      if (event.key === "ArrowLeft" && i > 0) setI(i - 1);
    };

    window.addEventListener("keydown", onKey, true);

    return () => window.removeEventListener("keydown", onKey, true);
  });

  const pad = 6;
  const hole = rect
    ? {
        left: rect.left - pad,
        top: rect.top - pad,
        width: rect.width + 2 * pad,
        height: rect.height + 2 * pad,
      }
    : null;
  // Place the card beside the highlighted area, preferring below, then right, then inside.
  let card: React.CSSProperties = { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };

  if (hole) {
    const W = 340;

    if (hole.top + hole.height + 200 < innerHeight) {
      card = {
        left: Math.min(Math.max(12, hole.left), innerWidth - W - 12),
        top: hole.top + hole.height + 12,
      };
    } else if (hole.left + hole.width + W + 24 < innerWidth) {
      card = { left: hole.left + hole.width + 12, top: Math.max(12, hole.top) };
    } else {
      card = {
        left: hole.left + hole.width / 2,
        top: hole.top + hole.height / 2,
        transform: "translate(-50%, -50%)",
      };
    }
  }

  return (
    <div className="tour" role="dialog" aria-label={t("Introduction")}>
      {hole ? <div className="tour-hole" style={hole} /> : <div className="tour-dim" />}
      <div className="tour-card" style={card}>
        <div className="row">
          <b style={{ fontSize: 14 }}>{step.title}</b>
          <span className="spacer" />
          <button className="icon-btn sm" onClick={close} title={t("Skip tour (Esc)")}>
            <X />
          </button>
        </div>
        <div className="tour-body">{step.body}</div>
        <div className="tour-dots">
          {STEPS.map((_, k) => (
            <span key={k} className={k === i ? "on" : ""} />
          ))}
        </div>
        <div className="row tour-buttons">
          <button className="btn" onClick={close}>
            {t("Skip")}
          </button>
          {i > 0 ? (
            <button className="btn" onClick={() => setI(i - 1)}>
              <ArrowLeft />
            </button>
          ) : null}
          <button className="btn primary" onClick={() => (i < STEPS.length - 1 ? setI(i + 1) : close())}>
            {i < STEPS.length - 1 ? (
              <>
                {t("Next")} <ArrowRight />
              </>
            ) : (
              t("Start modeling")
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
