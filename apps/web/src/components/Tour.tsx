import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { Kbd } from "./Kbd";

interface Step {
  /** CSS selector of the element to highlight; none = centered card. */
  target?: string;
  title: string;
  body: React.ReactNode;
}

const STEPS: Step[] = [
  {
    title: "Welcome to leocad",
    body: (
      <>
        A free, parametric CAD for makers. This short tour shows the basics — it takes about a minute. You can skip it now and restart it any time from <b>Help</b>.
      </>
    ),
  },
  {
    target: ".toolbar",
    title: "Tools",
    body: (
      <>
        Tools live in this rail, grouped like in Shapr3D: hover a group to open it. Every tool shows its shortcut, e.g. <Kbd k="S" /> Sketch, <Kbd k="E" /> Extrude, <Kbd k="F" /> Fillet. <Kbd k="X" /> searches all commands, <Kbd k="?" /> lists every shortcut.
      </>
    ),
  },
  {
    target: ".tree",
    title: "Start with a sketch",
    body: (
      <>
        Hover <b>Origin</b> and pick <b>Top</b>, <b>Front</b> or <b>Right</b> — or select a flat face and press <Kbd k="S" />. Draw lines, rectangles and circles; dimensions and constraints keep them exact.
      </>
    ),
  },
  {
    target: ".view",
    title: "Move around",
    body: (
      <>
        <b>Right-drag</b> rotates, <b>middle-drag</b> or <b>Shift + right-drag</b> pans, the <b>wheel</b> zooms. <Kbd k="Z" /> fits everything.
      </>
    ),
  },
  {
    target: ".viewcube",
    title: "View cube",
    body: <>Click a face, edge or corner for a standard view, drag the cube to orbit, or use the arrows to turn the view by 90°.</>,
  },
  {
    target: ".view",
    title: "Edit directly",
    body: (
      <>
        Click a face and <b>drag its arrow</b>: out adds material, in removes it. Click an edge and drag: away rounds it (fillet), towards the body bevels it (chamfer). Right-click anything for more actions.
      </>
    ),
  },
  {
    target: ".side",
    title: "History and variables",
    body: (
      <>
        Every step is recorded and stays editable — double-click to change it, drag the blue bar to roll back. <b>Variables</b> like <span className="mono">wall = 2 mm</span> can drive any dimension.
      </>
    ),
  },
  {
    target: ".mcp-anchor",
    title: "Work with AI",
    body: <>Connect Claude or another assistant through MCP: it can build and change parts while you watch the live preview.</>,
  },
  {
    title: "You're ready",
    body: (
      <>
        Your projects are saved automatically. Find guides and how-tos under <b>Help</b>. Have fun building!
      </>
    ),
  },
];

const KEY = "leocad.tourDone";
export const tourDone = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return true;
  }
};
const markDone = () => {
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
    const measure = () => setRect(step.target ? (document.querySelector(step.target)?.getBoundingClientRect() ?? null) : null);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [i, step.target]);
  const close = () => {
    markDone();
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight" || e.key === "Enter") i < STEPS.length - 1 ? setI(i + 1) : close();
      if (e.key === "ArrowLeft" && i > 0) setI(i - 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const pad = 6;
  const hole = rect ? { left: rect.left - pad, top: rect.top - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad } : null;
  // Place the card beside the highlighted area, preferring below, then right, then inside.
  let card: React.CSSProperties = { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
  if (hole) {
    const W = 340;
    if (hole.top + hole.height + 200 < innerHeight) card = { left: Math.min(Math.max(12, hole.left), innerWidth - W - 12), top: hole.top + hole.height + 12 };
    else if (hole.left + hole.width + W + 24 < innerWidth) card = { left: hole.left + hole.width + 12, top: Math.max(12, hole.top) };
    else card = { left: hole.left + hole.width / 2, top: hole.top + hole.height / 2, transform: "translate(-50%, -50%)" };
  }
  return (
    <div className="tour" role="dialog" aria-label="Introduction">
      {hole ? <div className="tour-hole" style={hole} /> : <div className="tour-dim" />}
      <div className="tour-card" style={card}>
        <div className="row">
          <b style={{ fontSize: 14 }}>{step.title}</b>
          <span className="spacer" />
          <button className="icon-btn sm" onClick={close} title="Skip tour (Esc)">
            <X />
          </button>
        </div>
        <div className="tour-body">{step.body}</div>
        <div className="row">
          <div className="tour-dots">
            {STEPS.map((_, k) => (
              <span key={k} className={k === i ? "on" : ""} />
            ))}
          </div>
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Skip
          </button>
          {i > 0 ? (
            <button className="btn" onClick={() => setI(i - 1)}>
              <ArrowLeft />
            </button>
          ) : null}
          <button className="btn primary" onClick={() => (i < STEPS.length - 1 ? setI(i + 1) : close())}>
            {i < STEPS.length - 1 ? (
              <>
                Next <ArrowRight />
              </>
            ) : (
              "Start modeling"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
