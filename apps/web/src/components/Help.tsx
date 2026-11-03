import { BookOpen, ChevronRight, Keyboard, PlayCircle, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Kbd, rich } from "./Kbd";
import { touchOnly } from "../lib/keyboard";
import { t } from "../lib/i18n";
import { hasPack } from "../lib/premium";

interface Guide {
  title: string;
  body: ReactNode;
}

const li = (text: string) => <li>{rich(text)}</li>;
const about = (detail?: string) => window.dispatchEvent(new CustomEvent("meercad:about", detail ? { detail } : {}));

/** Built when the panel opens, so it only describes the premium packs that are shown. */
const guides = (): { section: string; guides: Guide[] }[] => [
  {
    section: t("Getting started"),
    guides: [
      {
        title: t("Your first part in 2 minutes"),
        body: (
          <ol>
            {li(t("Hover the grid's **Top** plane (or a flat face) and press [S] — or hover **Origin** in the feature list and pick a plane."))}
            {li(t("Press [R], click a corner on the origin, click the opposite corner."))}
            {li(t("Press [D], click the bottom line, click below it and type `40` [↵]. Dimension the side the same way."))}
            {li(t("Press [↵] to finish the sketch, click inside the rectangle and **drag the arrow** up — or press [E] and type a distance."))}
            {li(t("Click a top edge and drag its arrow away from the part to round it."))}
            {li(t("Export → **STL** or **3MF** for your slicer."))}
          </ol>
        ),
      },
      {
        title: t("Navigating the 3D view"),
        body: (
          <ul>
            {li(t("**Rotate**: right-drag (or drag the view cube) · **Pan**: middle-drag or Shift + right-drag · **Zoom**: wheel, towards the cursor."))}
            {li(t("View cube: faces, edges and corners give standard views, double-click resets, arrows turn the view by 90°. [Mod+1]–[Mod+7] pick standard views, [Space] over a face looks straight at it, [Z] fits all."))}
            {li(t("The box icon at the bottom right switches perspective / orthographic."))}
          </ul>
        ),
      },
      {
        title: t("On iPhone and iPad"),
        body: (
          <ul>
            {li(t("**Fingers navigate**: one finger rotates, two fingers pan and pinch to zoom. **The Apple Pencil works**: it selects, draws in sketches and drags the arrows."))}
            {li(t("**Undo**: tap with two fingers or swipe three fingers left · **Redo**: tap with three fingers or swipe right — or use the arrows at the top right. A short note says what was undone."))}
            {li(t("Long-press for the menus a right-click opens on the Mac. Double-tap or squeeze the Pencil to switch a sketch between selecting and drawing."))}
          </ul>
        ),
      },
    ],
  },
  {
    section: t("Sketching"),
    guides: [
      {
        title: t("Drawing and snapping"),
        body: (
          <ul>
            {li(t("Tools: [L] line (keeps chaining; double-click or Esc ends, clicking the start closes), [R] rectangle, [Shift+R] center rectangle, [C] circle, [A] arc (center, start, end), [G] polygon, [P] point, [T] trim."))}
            {li(t("The cursor snaps to existing points, onto curves and onto the axes — the tip next to the cursor tells you which. Nearly horizontal/vertical lines become exactly so."))}
            {li(t("[X] toggles construction geometry (dashed, ignored for profiles). [U] uses model edges as fixed references."))}
            {li(t("Closed loops fill light blue — those are the profiles you can extrude."))}
          </ul>
        ),
      },
      {
        title: t("Dimensions and constraints"),
        body: (
          <ul>
            {li(t("[D], then click a line (length), circle (diameter), arc (radius), two points (distance — place the label to the side for horizontal/vertical) or two lines (angle). Type a value or an expression like `width / 2`."))}
            {li(t("Double-click any dimension to change it. Select geometry and add constraints with [Shift] + letter: [Shift+V] horizontal/vertical, [Shift+N] coincident, [Shift+T] tangent, [Shift+E] equal, [Shift+A] parallel, [Shift+P] perpendicular, [Shift+C] concentric, [Shift+M] midpoint, [Shift+S] symmetric, [Shift+L] lock."))}
            {li(t("The badge top-left shows the remaining degrees of freedom; “Fully defined” means nothing can move by accident."))}
            {li(t("Drag points or lines to try shapes — the solver keeps all constraints."))}
          </ul>
        ),
      },
    ],
  },
  {
    section: t("Modeling"),
    guides: [
      {
        title: t("Push, pull, round and bevel"),
        body: (
          <ul>
            {li(t("Select any face, flat or round → drag the knob: out adds material, in cuts."))}
            {li(t("Select a sketch region → drag to extrude it."))}
            {li(touchOnly() ? t("Select edges (each tap adds one) → drag away from the part for a fillet, towards it for a chamfer.") : t("Select edges (Shift-click for several) → drag away from the part for a fillet, towards it for a chamfer."))}
            {li(t("The quick-action bar next to your selection offers the matching tools with their shortcuts. Click the value next to an arrow to type an exact number; clicking empty space accepts."))}
            {li(t("Select a feature (in the list or by clicking its faces) to see its values and its sketch dimensions right on the model — click one to change it."))}
          </ul>
        ),
      },
      {
        title: t("Features with exact values"),
        body: (
          <ul>
            {li(t("Extrude [E]: New / Add / Remove / Intersect, blind, symmetric, two directions or through all."))}
            {li(t("Revolve [V] around an axis, line or edge. Fillet [F], Chamfer [C], Shell [H]."))}
            {li(t("Patterns [L] / [O] and Mirror [I] copy extrudes/revolves or whole parts. Boolean [B] combines parts. Plane [N] adds offset construction planes."))}
            {li(t("Dialogs preview live; [↵] accepts, [Esc] cancels. Drag the arrows in the viewport to set distances."))}
          </ul>
        ),
      },
      {
        title: t("History, rollback and variables"),
        body: (
          <ul>
            {li(t("Double-click a feature to edit it; everything after it updates. Drag features to reorder."))}
            {li(t("Drag the blue bar under the features to roll back and insert steps earlier."))}
            {li(t("Add variables (e.g. `wall = 2 mm`) and use them in any value; renaming a variable updates every use."))}
            {li(t("Right-click a feature to suppress, rename or delete it."))}
          </ul>
        ),
      },
    ],
  },
  {
    section: t("Files"),
    guides: [
      {
        title: t("Saving, export and import"),
        body: (
          <ul>
            {li(t("Projects save automatically as open `.meercad` files (readable JSON) — in the desktop app in Documents/meerCAD."))}
            {li(t("Export: STL and 3MF for 3D printing, STEP for other CAD tools, DXF/SVG of a sketch for laser cutting."))}
            {li(t("Multi-colour printing: give parts colours (click the swatch in the parts list) and export 3MF; parts with the same colour go to the same filament, so a multi-material slicer has them assigned already."))}
            {li(t("Materials: right-click a part in the parts list → Material. The list then shows each part's mass and, below, the total mass and centre of gravity (solid material, 100 % infill)."))}
            {hasPack("drawings") ? li(t("Technical drawing (File menu): front, top, side and isometric views with hidden edges dashed, overall dimensions and a title block on an A4–A2 sheet, as PDF, SVG or DXF for a workshop.")) : null}
            {li(t("Import: drag STEP, STL, 3MF, OBJ, DXF or SVG files into the window, or use Import [Mod+O]. In an open design the file is added to it; on the project overview it starts a new design. Meshes (STL, 3MF, OBJ) become solid bodies made of flat faces."))}
          </ul>
        ),
      },
    ],
  },
  {
    section: t("about::About"),
    guides: [
      {
        title: t("Licenses"),
        body: (
          <ul>
            {li(t("meerCAD © 2026 Torben Berger UG (haftungsbeschränkt), all rights reserved. The file-format, I/O and naming libraries are MIT licensed, so other tools can read and write .meercad files."))}
            {li(t("Geometry by **Open CASCADE Technology** and sketch solving by **PlaneGCS** (FreeCAD), both LGPL-2.1, used unmodified as WebAssembly modules."))}
            {li(t("Built with Three.js, React, Electron and other MIT/ISC/BSD/Apache-licensed packages."))}
            {li(t("Your models belong to you: projects are plain files on your device; nothing is uploaded."))}
            <li>
              <button className="link" onClick={() => about("licenses")}>
                {t("All licences")}
              </button>{" "}
              ·{" "}
              <button className="link" onClick={() => about("privacy")}>
                {t("Privacy policy")}
              </button>{" "}
              ·{" "}
              <button className="link" onClick={() => about()}>
                {t("No warranty")}
              </button>
            </li>
          </ul>
        ),
      },
    ],
  },
  {
    section: t("AI assistants"),
    guides: [
      {
        title: t("Model with Claude via MCP"),
        body: (
          <ol>
            {li(t("Click the plug icon in the top bar and enable **Allow assistants to control meerCAD**."))}
            {li(t("Copy the shown configuration into Claude Desktop (Settings → Developer → Edit Config) or run the `claude mcp add …` command for Claude Code."))}
            {li(t("Ask for parts or changes, e.g. “make the plate 10 mm wider and add a third hole”. The assistant can pick and open projects, preview ideas and apply them — you see every step live and can undo."))}
          </ol>
        ),
      },
    ],
  },
];

export function HelpPanel({ onClose, onTour, onShortcuts }: { onClose: () => void; onTour: () => void; onShortcuts: () => void }) {
  const [all] = useState(guides);
  const [open, setOpen] = useState<string | null>(all[0]!.guides[0]!.title);
  return (
    <aside className="panel-right help-panel">
      <div className="head">
        <BookOpen size={16} /> {t("Help")}
        <span className="spacer" />
        <button className="icon-btn sm" onClick={onClose} aria-label={t("Close help")}>
          <X />
        </button>
      </div>
      <div className="body">
        <div className="row">
          <button className="btn" onClick={onTour}>
            <PlayCircle /> {t("Restart tour")}
          </button>
          <button className="btn" onClick={onShortcuts}>
            <Keyboard /> {t("Shortcuts")} <Kbd k="?" />
          </button>
        </div>
        {all.map((s) => (
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
