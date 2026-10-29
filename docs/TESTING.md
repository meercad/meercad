# Testing meerCAD

meerCAD is tested on three levels. The first two run in seconds and catch most regressions. The
third one is a person (or an agent driving the browser) using the app as a maker would, and it is the
only one that sees what the model *looks* like. Run all three before a release and after any change
to the kernel, the viewport or a tool.

| Level | What it proves | How |
| --- | --- | --- |
| 1. Unit and acceptance tests | Geometry is right: volumes, sizes, topology, threads, imports, units | `pnpm test` |
| 2. Test models | Real designs from simple to complex rebuild with the expected result, also after parameter changes | `pnpm test tests/acceptance/models.test.ts` |
| 3. Hands-on run | Tools, dialogs, picking, keyboard, touch, views and rendering behave as a person expects | Checklist below, in the browser and in the apps |

Before reporting work as done: `pnpm typecheck` (every package plus the tests) and `pnpm test`, and
read the whole output.

## 1. Unit and acceptance tests

- `packages/*/src/**/*.test.ts`: schema, expressions, sketch solver, readers and writers.
- `tests/acceptance/*.test.ts`: the kernel end to end through `KernelSession.rebuild`, the same path
  the app uses. Each feature has a test that checks the result by numbers (volume to 0.5 % or better,
  bounding box, face count), never only "no error".
- `tests/*.test.ts`: app logic without a browser (grid levels, units, mesh parts).

A new feature or a fixed bug gets a test here first: the smallest document that shows it, and the
number that must come out.

## 2. Test models

`tests/models/models.ts` holds designs a person would actually make, ordered from simple to complex:

| # | Model | Exercises |
| --- | --- | --- |
| 01 | Cube | sketch, extrude |
| 02 | Plate with four holes | nested regions become holes |
| 03 | Chamfered cylinder | circles, chamfer on a round edge |
| 04 | Rounded block | fillet by edge selectors |
| 05 | Open tray | shell with an open face |
| 06 | Revolved tube | revolve about a construction line |
| 07 | Flange with bolt circle | sketch on a face, cut through all, circular pattern, parameter change |
| 08 | Pin strip | join, linear pattern |
| 09 | Mirrored T profile | sketch on XZ, mirror bodies, boolean union |
| 10 | M8 bolt | polygon, flipped extrude, external thread |
| 11 | M8 nut | internal thread in a polygon |
| 12 | Boolean and copy | offset plane, two bodies, transform copy, boolean subtract |
| 13 | Symmetric spacer | symmetric extrude |
| 14 | Block with pocket | chamfer by face selector, pocket from a face sketch |
| 15 | Parametric toothed wheel | expressions, circular pattern count from a variable, variants |
| 16 | Enclosure with lid | fillet, shell, offset planes, 2-D pattern, two parts |
| 17 | Spur gear with bore | gear from variables, bore, variants (teeth, module) |
| 18 | Gear pair 1:2 | meshWith at an angle, D-shaft bore with allowance, gear joints with a coupling |
| 19 | Herringbone pair with chamfered teeth | herringbone, opposite hand of the mate, tooth chamfer |
| 20 | Planetary gear set | ring gear, three planets, sun meshing with a planet |
| 21 | Rack and pinion | rack, pinion placed on it |
| 22 | Hinged lid | fixed and revolute joints on a pin's axis, limits |
| 23 | Four-bar linkage | links with round ends, a closed loop of four revolute joints |
| 24 | Mounting plate with standard holes | hole tool: counterbore, countersink, heat-set inserts, tapped with thread |
| 25 | Funnel adapter and pipe bend | hollow loft from square to round, sweep of a ring along lines and an arc |
| 26 | Bar split for the printer | split at an offset plane into two parts |
| 27 | Angle bracket with ribs | two ribs from open lines filled to wall and base |
| 28 | Moulded cap with draft | 3° draft on four sides from the bottom, rounded top edges |
| 29 | Name plate with text | raised bold text centred on a face, engraved small text |

Each model states what must come out (parts, volume worked out by hand where possible, size) and what
a person should see when looking at it (`look`). The test rebuilds each one, checks the numbers and
the parameter variants.

To look at them in the app, write them as files:

```bash
MEERCAD_MODELS_OUT="$HOME/Documents/meerCAD/Test models" pnpm test tests/acceptance/models.test.ts
```

Use the projects folder the Mac app shows in Settings (the WIP build uses the release's folder). The
files appear as a folder on the overview. Open each one and compare it with its `look` text, from
every side (see "Looking at a result" below).

Add a model when a bug shows up that a real design would hit: the design that broke goes in, with
what it must come out as.

## 3. Hands-on run

### Setup

- **Browser:** `pnpm dev` (or the `web` entry in `.claude/launch.json`), a window of at least
  1400 × 900, and once at phone width.
- **Mac:** `pnpm wip` installs "meerCAD WIP" next to the release.
- **iPad:** build and install the iOS app (`apps/ios`). Every check below runs on the iPad with touch
  and Pencil and no keyboard as well.
- In development builds `window.meercadTest` gives scripts the document, the result and the store
  actions:

  ```js
  const s = meercadTest.app.getState();
  s.doc;                                  // the document
  s.output.report.bodies;                 // volume, bbox, faces per part
  s.output.report.features.filter((f) => f.status !== "ok"); // anything that failed
  await meercadTest.store.newProject(doc, "Name");          // open a document as a new project
  meercadTest.store.undo(); meercadTest.store.redo();
  ```

  Use it to read back results, not to replace the clicks: a check is only done when it was done
  through the UI the way a person does it.

### Looking at a result

After every step that changes the model:

1. Look at it isometric (`1`), then front, back, top, bottom, right, left (`2`–`7`), and fit (`Z`).
2. Check: right shape and size; holes go through where they should; round things are round (no
   facets, no seam lines); no lines showing through the model; nothing hidden that should be seen.
3. Read the parts list: right number of parts, readable names, plausible volume.
4. Check the status line: no failed features, no error toasts, no console errors.

### Checklist

Each line: do it, then compare with the expected result.

**Overview and projects**
- Overview shows your projects, folders and the three examples; the footer links open About, Privacy
  and Licences.
- New part opens an empty part in the isometric view (not the previous tab's view).
- Open an example, change a variable (e.g. width 60 → 80): the model updates and the volume changes
  by the expected amount.
- Sort by last edited (default, newest first), created and name; reverse the order; the choice is
  remembered. Folders follow the name order.
- A project file copied into the projects folder from outside (Finder, iCloud) gets its picture
  while the overview is open, without moving in the "last edited" order.
- Many tabs open: titles stay readable, the strip scrolls, the open tab stays in view.
- Rename a tab (double-click), close it (⌘W), reopen it (⇧⌘T), reorder by dragging.
- Import from the overview creates a new project; import inside a project adds to it.

**Sketching**
- Sketch on Top, Front, Right and on a flat face; the view turns to face the plane.
- Rectangle by two clicks and by typing `40 Tab 30 Enter` quickly: exactly 40 × 30, fully defined.
- Circle with a typed diameter; 3-point arc and centre arc with typed angles; polygon; point.
- Dimensions: add, edit by double-click, use a variable (`wall * 2`); the DOF badge goes to
  "Fully defined".
- Constraints from the palette and with ⇧+letter; over-constraining shows "Over-constrained".
- Snapping to the grid, to model edges with the magnet and with grid snap off; Alt places freely.
- Trim, construction geometry, project edges; Esc steps back (drawing → tool → selection → leave).
- The sketch header shows the sketch's name.

**Features** (each: start from the toolbar and its key, preview while editing, accept, edit again from
the history, then check the result as above)
- Extrude: new, add, remove, intersect; blind, symmetric, two-sided, through all; flip; profile chips
  name the sketch.
- Revolve about an axis and a sketch line.
- Fillet and chamfer on single edges, on all edges of a face, on round edges.
- Shell with and without open faces.
- Thread: external and internal, M3–M10, shorter length, left-hand, clearance.
- Linear (1 and 2 directions) and circular patterns of features and of parts; mirror.
- Boolean union, subtract, intersect; transform move, rotate and copy; delete parts.
- Offset and angled planes; sketches on them.
- Push/pull a face by dragging (flat and curved), drag handles move in fine steps.
- Mesh import (STL, 3MF, OBJ): stays a whole part, "Mesh" badge, no face picking.

**Editing**
- Undo and redo every kind of change (⌘Z, ⇧⌘Z; two- and three-finger taps on the iPad).
- Reorder, suppress, roll back and delete features; dependent features report clearly.
- Variables: add, rename, use in dimensions, delete (blocked while in use).
- Inch design: values show and type in inches, the grid steps in fractions, the volume in in³.

**Measure, view and export**
- Measure face–face, edge–edge, point distances, angles and radii; the panel explains what to click.
- View cube: faces, edges, corners, drag, the 90° arrows; tooltips name the keys of the selected
  key preset.
- Display modes, planes, sketches and dimensions toggles; perspective and orthographic.
- Export STL, 3MF and STEP; open the files in a slicer: watertight, right size, smooth curves.
- Share link opens the same design.

**Phone layout** (iPhone, or a browser window up to 600 px wide; `html[data-compact]`)
- Top bar: Home, project name (tap: open projects, new part, rename, close), undo, redo, "⋯" with the
  File items first. Nothing is cut off at 375 and 440 px width.
- Tools in a bar at the bottom; groups open a menu above the bar; "Finish" stays visible in sketches.
- "Parts" opens history, parts and variables as a sheet; the grip closes it. Dialogs and measuring are
  sheets at the bottom, the tool bar steps aside, and the model moves up into the free space.
- Sketching: "Constrain" opens the constraint sheet; one finger draws and drags points, two fingers pan
  and zoom (until a Pencil is used, then fingers only navigate).
- Turning the phone keeps the model framed the same width; new parts and fit frame the model in portrait.
- The overview shows two columns of parts.

**Apps**
- Mac: projects folder, file names, thumbnails, update check, MCP connection.
- iPad: everything above with touch and Pencil; no keyboard pops up unless a field is tapped.
- iPhone (TestFlight build, `pnpm testflight`): the phone layout above in the real app, including the
  safe areas around the notch and the home indicator.

### Known limits (not bugs)

- A mirror or pattern cannot take another mirror or pattern as its source; pattern in two directions
  instead.
- In the browser test tools, ⌘A in a text field does not select all (the synthetic key event has no
  editing command); triple-click the field instead.

## Findings log

Record each hands-on run: date, build, what was checked, what was wrong, and the fix or issue.

### 2026-10-28 (main after 6f4e687)

Fixed:
- Typing a rectangle's size quickly (`40 Tab 30`) lost digits: keys arriving before the value fields
  had focus reset them.
- A new part opened in the previous tab's view instead of the isometric one.
- Origin axes showed through parts like scratches on the surface.
- Parts, profile chips, context menus and the sketch header showed internal ids (`ex1`, `sk1`)
  instead of names ("Extrude 1", "Sketch 1", "Move 1 (Cube)").
- Internal threads in some holes (e.g. an M8 nut 6.5 mm tall) failed with "could not cut the thread";
  more helix starts are now tried.
- Part sizes were millimetres too big after threads (loose bounding box).
- The view cube and fit tooltips named fixed keys instead of the selected key preset.
- With many tabs the titles shrank to single letters.
- The measure hint banner duplicated the measure panel and overlapped the tab strip.
- Projects that were never opened in the app (files from outside) had no picture on the overview;
  the overview now makes the missing ones.

Added: sorting on the overview (last edited, created, name; either direction).

### 2026-10-28 (iPhone)

Added: phone layout (see the checklist), finger drawing in sketches without a Pencil, camera framing
for portrait windows and when the phone turns, thumbnails always from the iso corner, the iOS app on
iPhone and TestFlight uploads.

Checked and fine: examples and variables, sketch → extrude → fillet by hand, the 16 test models from
all sides, measure, undo/redo, inch designs.
