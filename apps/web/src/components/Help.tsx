import { BookOpen, ChevronRight, Keyboard, PlayCircle, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Kbd } from "./Kbd";

interface Guide {
  title: string;
  body: ReactNode;
}

const GUIDES: { section: string; guides: Guide[] }[] = [
  {
    section: "Getting started",
    guides: [
      {
        title: "Your first part in 2 minutes",
        body: (
          <ol>
            <li>Hover the grid's <b>Top</b> plane (or a flat face) and press <Kbd k="S" /> — or hover <b>Origin</b> in the feature list and pick a plane.</li>
            <li>Press <Kbd k="R" />, click a corner on the origin, click the opposite corner.</li>
            <li>Press <Kbd k="D" />, click the bottom line, click below it and type <span className="mono">40</span> <Kbd k="↵" />. Dimension the side the same way.</li>
            <li>Press <Kbd k="↵" /> to finish the sketch, click inside the rectangle and <b>drag the arrow</b> up — or press <Kbd k="E" /> and type a distance.</li>
            <li>Click a top edge and drag its arrow away from the part to round it.</li>
            <li>Export → <b>STL</b> or <b>3MF</b> for your slicer.</li>
          </ol>
        ),
      },
      {
        title: "Navigating the 3D view",
        body: (
          <ul>
            <li><b>Rotate</b>: right-drag (or drag the view cube) · <b>Pan</b>: middle-drag or Shift + right-drag · <b>Zoom</b>: wheel, towards the cursor.</li>
            <li>View cube: faces, edges and corners give standard views, double-click resets, arrows turn the view by 90°. <Kbd k="Mod+1" />–<Kbd k="Mod+7" /> pick standard views, <Kbd k="Space" /> over a face looks straight at it, <Kbd k="Z" /> fits all.</li>
            <li>The box icon at the bottom right switches perspective / orthographic.</li>
          </ul>
        ),
      },
      {
        title: "On iPhone and iPad",
        body: (
          <ul>
            <li><b>Fingers navigate</b>: one finger rotates, two fingers pan and pinch to zoom. <b>The Apple Pencil works</b>: it selects, draws in sketches and drags the arrows.</li>
            <li><b>Undo</b>: tap with two fingers or swipe three fingers left · <b>Redo</b>: tap with three fingers or swipe right — or use the arrows at the top right. A short note says what was undone.</li>
            <li>Long-press for the menus a right-click opens on the Mac. Double-tap or squeeze the Pencil to switch a sketch between selecting and drawing.</li>
          </ul>
        ),
      },
    ],
  },
  {
    section: "Sketching",
    guides: [
      {
        title: "Drawing and snapping",
        body: (
          <ul>
            <li>Tools: <Kbd k="L" /> line (keeps chaining; double-click or Esc ends, clicking the start closes), <Kbd k="R" /> rectangle, <Kbd k="Shift+R" /> center rectangle, <Kbd k="C" /> circle, <Kbd k="A" /> arc (center, start, end), <Kbd k="G" /> polygon, <Kbd k="P" /> point, <Kbd k="T" /> trim.</li>
            <li>The cursor snaps to existing points, onto curves and onto the axes — the tip next to the cursor tells you which. Nearly horizontal/vertical lines become exactly so.</li>
            <li><Kbd k="X" /> toggles construction geometry (dashed, ignored for profiles). <Kbd k="U" /> uses model edges as fixed references.</li>
            <li>Closed loops fill light blue — those are the profiles you can extrude.</li>
          </ul>
        ),
      },
      {
        title: "Dimensions and constraints",
        body: (
          <ul>
            <li><Kbd k="D" />, then click a line (length), circle (diameter), arc (radius), two points (distance — place the label to the side for horizontal/vertical) or two lines (angle). Type a value or an expression like <span className="mono">width / 2</span>.</li>
            <li>Double-click any dimension to change it. Select geometry and add constraints with <Kbd k="Shift" /> + letter: <Kbd k="Shift+V" /> horizontal/vertical, <Kbd k="Shift+N" /> coincident, <Kbd k="Shift+T" /> tangent, <Kbd k="Shift+E" /> equal, <Kbd k="Shift+A" /> parallel, <Kbd k="Shift+P" /> perpendicular, <Kbd k="Shift+C" /> concentric, <Kbd k="Shift+M" /> midpoint, <Kbd k="Shift+S" /> symmetric, <Kbd k="Shift+L" /> lock.</li>
            <li>The badge top-left shows the remaining degrees of freedom; “Fully defined” means nothing can move by accident.</li>
            <li>Drag points or lines to try shapes — the solver keeps all constraints.</li>
          </ul>
        ),
      },
    ],
  },
  {
    section: "Modeling",
    guides: [
      {
        title: "Push, pull, round and bevel",
        body: (
          <ul>
            <li>Select any face, flat or round → drag the knob: out adds material, in cuts.</li>
            <li>Select a sketch region → drag to extrude it.</li>
            <li>Select edges (Shift-click for several) → drag away from the part for a fillet, towards it for a chamfer.</li>
            <li>The quick-action bar next to your selection offers the matching tools with their shortcuts. Click the value next to an arrow to type an exact number; clicking empty space accepts.</li>
            <li>Select a feature (in the list or by clicking its faces) to see its values and its sketch dimensions right on the model — click one to change it.</li>
          </ul>
        ),
      },
      {
        title: "Features with exact values",
        body: (
          <ul>
            <li>Extrude <Kbd k="E" />: New / Add / Remove / Intersect, blind, symmetric, two directions or through all.</li>
            <li>Revolve <Kbd k="V" /> around an axis, line or edge. Fillet <Kbd k="F" />, Chamfer <Kbd k="C" />, Shell <Kbd k="H" />.</li>
            <li>Patterns <Kbd k="L" /> / <Kbd k="O" /> and Mirror <Kbd k="I" /> copy extrudes/revolves or whole parts. Boolean <Kbd k="B" /> combines parts. Plane <Kbd k="N" /> adds offset construction planes.</li>
            <li>Dialogs preview live; <Kbd k="↵" /> accepts, <Kbd k="Esc" /> cancels. Drag the arrows in the viewport to set distances.</li>
          </ul>
        ),
      },
      {
        title: "History, rollback and variables",
        body: (
          <ul>
            <li>Double-click a feature to edit it; everything after it updates. Drag features to reorder.</li>
            <li>Drag the blue bar under the features to roll back and insert steps earlier.</li>
            <li>Add variables (e.g. <span className="mono">wall = 2 mm</span>) and use them in any value; renaming a variable updates every use.</li>
            <li>Right-click a feature to suppress, rename or delete it.</li>
          </ul>
        ),
      },
    ],
  },
  {
    section: "Files",
    guides: [
      {
        title: "Saving, export and import",
        body: (
          <ul>
            <li>Projects save automatically as open <span className="mono">.meercad</span> files (readable JSON) — in the desktop app in Documents/meerCAD.</li>
            <li>Export: STL and 3MF for 3D printing, STEP for other CAD tools, DXF/SVG of a sketch for laser cutting.</li>
            <li>Multi-colour printing: give parts colours (click the swatch in the parts list) and export 3MF; parts with the same colour go to the same filament, so a multi-material slicer has them assigned already.</li>
            <li>Materials: right-click a part in the parts list → Material. The list then shows each part's mass and, below, the total mass and centre of gravity (solid material, 100 % infill).</li>
            <li>Technical drawing (File menu): front, top, side and isometric views with hidden edges dashed, overall dimensions and a title block on an A4–A2 sheet, as PDF, SVG or DXF for a workshop.</li>
            <li>Import: drag STEP, STL, 3MF, OBJ, DXF or SVG files into the window, or use Import <Kbd k="Mod+O" />. In an open design the file is added to it; on the project overview it starts a new design. Meshes (STL, 3MF, OBJ) become solid bodies made of flat faces.</li>
          </ul>
        ),
      },
    ],
  },
  {
    section: "About",
    guides: [
      {
        title: "Licenses",
        body: (
          <ul>
            <li>meerCAD is free to use, also commercially, and its source is public under the Functional Source License 1.1: anything goes except building a competing product from it. Each release also becomes Apache-2.0 two years after it ships. The file-format, I/O and naming libraries are MIT licensed.</li>
            <li>Geometry by <b>Open CASCADE Technology</b> and sketch solving by <b>PlaneGCS</b> (FreeCAD), both LGPL-2.1, used unmodified as WebAssembly modules.</li>
            <li>Built with Three.js, React, Electron and other MIT/ISC/BSD/Apache-licensed packages.</li>
            <li>Your models belong to you: projects are plain files on your device; nothing is uploaded.</li>
            <li>
              <button className="link" onClick={() => window.dispatchEvent(new CustomEvent("meercad:about", { detail: "licenses" }))}>
                All licences
              </button>{" "}
              ·{" "}
              <button className="link" onClick={() => window.dispatchEvent(new CustomEvent("meercad:about", { detail: "privacy" }))}>
                Privacy policy
              </button>{" "}
              ·{" "}
              <button className="link" onClick={() => window.dispatchEvent(new CustomEvent("meercad:about"))}>
                No warranty
              </button>
            </li>
          </ul>
        ),
      },
    ],
  },
  {
    section: "AI assistants",
    guides: [
      {
        title: "Model with Claude via MCP",
        body: (
          <ol>
            <li>Click the plug icon in the top bar and enable <b>Allow assistants to control meerCAD</b>.</li>
            <li>Copy the shown configuration into Claude Desktop (Settings → Developer → Edit Config) or run the <span className="mono">claude mcp add …</span> command for Claude Code.</li>
            <li>Ask for parts or changes, e.g. “make the plate 10 mm wider and add a third hole”. The assistant can pick and open projects, preview ideas and apply them — you see every step live and can undo.</li>
          </ol>
        ),
      },
    ],
  },
];

export function HelpPanel({ onClose, onTour, onShortcuts }: { onClose: () => void; onTour: () => void; onShortcuts: () => void }) {
  const [open, setOpen] = useState<string | null>(GUIDES[0]!.guides[0]!.title);
  return (
    <aside className="panel-right help-panel">
      <div className="head">
        <BookOpen size={16} /> Help
        <span className="spacer" />
        <button className="icon-btn sm" onClick={onClose} aria-label="Close help">
          <X />
        </button>
      </div>
      <div className="body">
        <div className="row">
          <button className="btn" onClick={onTour}>
            <PlayCircle /> Restart tour
          </button>
          <button className="btn" onClick={onShortcuts}>
            <Keyboard /> Shortcuts <Kbd k="?" />
          </button>
        </div>
        {GUIDES.map((s) => (
          <section key={s.section}>
            <h4 className="help-section">{s.section}</h4>
            {s.guides.map((g) => (
              <div key={g.title} className={`guide ${open === g.title ? "open" : ""}`}>
                <button className="guide-head" onClick={() => setOpen(open === g.title ? null : g.title)}>
                  <ChevronRight /> {g.title}
                </button>
                {open === g.title ? <div className="guide-body">{g.body}</div> : null}
              </div>
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}
