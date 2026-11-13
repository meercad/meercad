# Testing meerCAD

## When what runs

Not everything can run on every change: all tests take minutes, performance needs a quiet machine,
and E2E needs the app. So the tests are split into levels, and each moment runs what fits it.

| Level | What it proves | Command | Time (Mac / CI) |
| --- | --- | --- | --- |
| Unit | Packages and app logic without the kernel: schema, ops, expressions, solver, readers and writers | part of `pnpm test:quick` | seconds |
| App | The app's store and logic (`apps/web/src/**/*.test.ts`, vitest project `web`) in happy-dom, with the real kernel worker in the same process and projects kept in memory: moving parts, an assistant's requests, measuring and exporting by number | part of `pnpm test:quick` | seconds |
| Integration | The kernel end to end through `KernelSession.rebuild`, the path the app uses: volumes, sizes, topology | `pnpm test:quick` (fast files) and `pnpm test` (all) | ≈ 1 min quick, ≈ 8 min all (4-core runner) |
| Test models | Real designs from simple to complex rebuild as expected, also after parameter changes | `pnpm test tests/acceptance/models.test.ts` | ≈ 1 min |
| Performance | Start, open and change times of every test model, mesh sizes, memory, export and import | `pnpm test:perf` | ≈ 4 min (4-core runner) |
| E2E | Every `tests/e2e/*.e2e.ts` in a private copy of the Mac app: the test models built through the UI, exports, functions one by one (generators, delete, undo, measure, variables, interference, import), versions, units and the overview | `pnpm test:e2e` | long |
| iPhone/iPad | Touch in the real iOS app in the Simulator: taps, double taps, drags, pinches, sheets | `pnpm test:ios` | ≈ 10 min per device |
| Hands-on | What only a person sees: looks, touch, Pencil | Checklist below | — |

| Moment | Runs | Where |
| --- | --- | --- |
| Every commit | `pnpm test:quick` (unit + fast integration) | pre-commit hook (`pnpm hooks` once per clone), and any agent before it commits |
| Pull request, before a merge | `pnpm typecheck`, `pnpm test` (all unit and integration) and the build | CI (`ci.yml`: quick and slow jobs in parallel), and locally before reporting work as done |
| Change to the kernel, meshing or a slow path | additionally `pnpm test:perf` | locally on the Mac |
| Release | `pnpm test:release`: licences, typecheck, all tests, performance, build, E2E | on the Mac with the WIP app; CI runs the same without E2E on a `v*` tag (`release.yml`) |

`pnpm test:release` runs every step even when one fails and prints a summary; `--skip e2e` leaves a
step out. It reports "not ready" while there is no `test:e2e` script.

Integration files that take long (over about 10 s on a 4-core runner) are listed in `SLOW` in
`vitest.config.ts` and only run in `pnpm test`. Move a file there when it gets slow, not out of the
suite.

**Everything covered.** `tests/coverage.test.ts` fails when a feature op, a document op or an MCP
tool has no test. MCP tools that are only checked by the E2E run are listed there by name
(`MCP_E2E_ONLY`, empty since every tool is called in `packages/mcp/src/server.inprocess.test.ts`),
so a new tool is a decision, not an oversight.

**The app in tests.** The vitest project `web` runs in happy-dom. `vitest.config.ts` swaps the
app's `./kernel.worker.ts?worker` for `apps/web/test/kernelWorker.ts`, the real kernel worker in the
same process (messages copied both ways like a Worker's), so `rebuildNow()` builds designs as the
app does. `apps/web/test/setup.ts` gives the app the Mac app's file interface with projects and
folders in memory (`testFiles`). `testCall` (lib/mcpBridge) runs an assistant's request without a
server.

**The MCP server in tests.** `server.ts` starts its stdio transport only when
`MEERCAD_MCP_INPROCESS` is not set and exports `server` and `bridge`: `server.inprocess.test.ts`
connects an MCP client over an in-memory transport and a stand-in app over the bridge, so the
coverage run counts the server. `server.test.ts` still starts the built server over stdio.

## Coverage

`pnpm test:coverage` measures every level but perf and E2E (unit, web, web-slow, integration,
integration-slow) and fails when a package's line coverage drops below its threshold in
`vitest.config.ts`; CI runs it as the job "coverage". The goal is 100 % everywhere. Each threshold
is where its package stands, so coverage can only go up: raise it when tests are added, never lower
it. Nov 2026: ai and naming 100 %, schema 100 %, io 99.0 %, sketch 99.6 %, model 98.4 %, kernel
97.7 %, MCP 96.7 %, viewport 95.3 %, the app 87.2 % (≈ 1760 tests, 20 min on a Mac mini with 4 workers: more workers starve each other of memory there). `E2E_COVERAGE=1 pnpm test:e2e` records which of the app's
code a Mac E2E run executed; `node scripts/e2e-coverage.mjs [--files]` prints it per folder and file.

Known answers live in `tests/acceptance/reference-values.test.ts` (sizes, booleans, fillets and
chamfers by formula, mass, STL/3MF/STEP read back), `packages/sketch/src/constraints.test.ts` (every
constraint) and `packages/model/src/expr.test.ts` (formulas and units).

## iPhone and iPad (`pnpm test:ios`)

`apps/ios/uitests` is an XCUITest project of its own. `scripts/test-ios.mjs` builds the web app and
the iOS app for the Simulator, installs it fresh on its own simulators ("meerCAD UITest iPad" and
"… iPhone", created on first use; never the simulators a person or another run uses) and runs
`TouchTests` with real touches. Started with `-meercadUITest`, the app shows its state to the tests
in a hidden text (`apps/web/src/lib/uitestProbe.ts`): zoom, open sheets, steps, variables, part sizes,
errors. Failures keep a screenshot in `test-results/ios/<device>.xcresult`.

Each run erases its simulator first. On the iPad a double tap near the top edge resizes the app's window (iPadOS), so touch tests stay
below 60 pt.

## Performance tests

`tests/perf/*.perf.ts` (vitest project `perf`, one file at a time):

- `rebuild.perf.ts`: kernel start; for every test model and corpus part the time to open it (fresh
  session, rebuild and meshes, median of 3 (9 for parts under 300 ms)), to rebuild without a change, and to change a value
  (the model's first variant, back and forth); triangles and faces of the result.
- `memory-io.perf.ts`: WASM memory over ten open/change/close rounds of a big model; STEP, print
  mesh, 3MF and STL export; reading an STL of a million triangles.

Each value is checked against a budget (what a person still accepts on a Mac; times ×
`MEERCAD_PERF_SCALE`, 3 on CI) and against `tests/perf/baseline.json`. Times are compared only on
the machine the baseline was measured on, at most 30 % worse (`MEERCAD_PERF_TOLERANCE`); triangle
and face counts on every machine, within 10 %. Every run writes `test-results/perf.json` and prints a
table with the change against the baseline.

After a change that makes things faster on purpose, or on a new Mac, write a new baseline and commit
it: `MEERCAD_PERF_UPDATE=1 pnpm test:perf`. A slower result is a finding, not a reason to update.

Opening a design the app has built before does not wait for the kernel: the last result (report
and meshes) is kept per project in IndexedDB (`apps/web/src/lib/openCache.ts`, 768 MB on a Mac,
256 MB on touch devices, least recently used first out) and shown at once while the kernel builds
it again in the background. It is used only for exactly the same document, mesh settings and
kernel build. `rebuild.perf.ts` measures the kernel path, which is what a first opening costs.
To see where an opening's time goes, `tests/bench/open-profile.ts` (kernel vs. meshing per model,
`MEERCAD_PROFILE_DIR` adds a folder of `.meercad` files) and `tests/bench/mesh-breakdown.ts`
(meshing per part and face kind) help.

The older scripts in `tests/bench/` are for digging into one question (threads, booleans, native vs
WASM); they don't check anything.

## Before reporting work as done

`pnpm typecheck` (every package plus the tests) and `pnpm test`, and read the whole output.

## MCP tools end to end

Each Mac build has its own bridge port (App Store 47821, RC 47822, WIP 47823, TestFlight 47824, see
docs/RELEASE.md), and the user's assistants may hold it. For a test run, start the server with
`MEERCAD_MCP_PORT=47999` (e.g. the WIP's own `Contents/Resources/mcp/server.js` with
`ELECTRON_RUN_AS_NODE=1`), set `sessionStorage["meercad.mcp.port"] = "47999"` in the app window
(through `scripts/drive-app.mjs eval`) and reload it; then drive the tools with an MCP client
(`@modelcontextprotocol/sdk` client over stdio). The override ends with the window.
A server whose `MEERCAD_MCP_PORT` is not a build's port never opens an app; set `MEERCAD_NO_LAUNCH=1`
to keep any other server from opening its app when it finds none connected.
Check what comes back and the files written (unzip a 3MF, count STEP solids), not only "no error".

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
| 30 | Tray from sketch tools | corners rounded in the sketch, pocket from an inward offset, a bevelled corner |
| 31 | Handle from splines | closed spline outline extruded with a hole, a rod swept along an open spline |
| 32 | Plate with standard parts | M4 screws seated in counterbores, a 608 bearing |
| 33 | Assembly by aligning | pin set into a hole by its axis and flush, block set onto a face and turned |
| 34 | Scaled to a measured size | a scan-sized block scaled by wanted ÷ measured to exact size |
| 35 | Holder with moved faces | top moved up, hole wall moved in for a press fit, an end moved up to a plane |

Each model states what must come out (parts, volume worked out by hand where possible, size) and what
a person should see when looking at it (`look`). The test rebuilds each one, checks the numbers and
the parameter variants.

To look at them in the app, write them as files:

```bash
MEERCAD_MODELS_OUT="$HOME/Documents/meerCAD/Test models" pnpm test tests/acceptance/models.test.ts
```

Use the projects folder the Mac app shows in Settings (the WIP and the RC share one folder). The
files appear as a folder on the overview. Open each one and compare it with its `look` text, from
every side (see "Looking at a result" below).

Add a model when a bug shows up that a real design would hit: the design that broke goes in, with
what it must come out as.

## 3. Hands-on run

### Setup

- **Mac:** `pnpm wip` installs "meerCAD WIP" next to the user's "meerCAD RC" (never rebuild or
  quit the RC, see docs/RELEASE.md). An agent starts it with
  `"/Applications/meerCAD WIP.app/Contents/MacOS/meerCAD WIP" --remote-debugging-port=9334` and clicks, reads and takes
  screenshots with `node scripts/drive-app.mjs` (eval / shot). There is no browser version: in a
  plain browser the interface only says it runs as the app. Check once with a narrow window (phone
  layout).
- **Test projects stay out of the user's list.** The WIP saves to the user's real projects folder
  (iCloud, shared with the RC and the iPad). What an assistant creates there over MCP
  (`open_example`, `new_project`, `import_file`) goes instead to the WIP's own test folder
  (`~/Library/Application Support/meerCAD WIP/Test projects`, ids `.tests/…`, not in the overview,
  dropped after a week untouched). Only `keep: true` (or `move_project`) puts a project into the
  user's projects, for work meant for them (e.g. importing their own files). Projects made by
  clicking through the WIP's interface (`drive-app.mjs`, `meercadTest.store.newProject`) do land in
  the user's folder: test those in an own app copy with `MEERCAD_PROJECTS_DIR`, or move what you
  made to the Trash before reporting.
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
- Export STL, 3MF, OBJ and STEP; open the files in a slicer: watertight, right size, smooth curves.
- Share link opens the same design.

**Phone layout** (iPhone, or a Mac window up to 600 px wide; `html[data-compact]`)
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
- Mac: projects folder, file names, thumbnails, MCP connection.
- iPad: everything above with touch and Pencil; no keyboard pops up unless a field is tapped.
- iPhone (TestFlight build, `pnpm testflight`): the phone layout above in the real app, including the
  safe areas around the notch and the home indicator.

### Known limits (not bugs)

- A mirror or pattern cannot take another mirror or pattern as its source; pattern in two directions
  instead.
- When driving the app by script, ⌘A in a text field does not select all (the synthetic key event has no
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

### 2026-10-30 (Mac app, main after 3eaf66a)

Run in the Electron app in development mode with a copy of the test models as its projects folder
(`MEERCAD_PROJECTS_DIR=… electron . --dev --user-data-dir=… --remote-debugging-port=…`), driven over
the DevTools protocol with real mouse and key events. A scan after each step lists every button or
label that is cut off, wraps or sticks out of its panel. A covered window runs no animation frames:
set views without animation and draw a frame before clicking into the model.

Fixed:
- Missing overview pictures built in the editor's kernel; one slow project blocked all later
  pictures (the examples' too) and every project being opened. Pictures now use their own kernel,
  ended on opening a project or after 60 s.
- A boolean merging many faces (a mesh rebuilt as 20 layers) spent 15 s matching face names, and
  ran out of memory in the multi-threaded kernel. A bounding-box filter: 16.7 s → 2.3 s.
- A kernel that hit a WebAssembly runtime error was used on; it is now replaced by a fresh
  single-threaded one and the open requests are sent again.
- Playing a linkage past 180° solved most of a turn back in 120 steps every frame (about 15 frames a
  second); joint values showed counting on. Now 60 frames a second, shown as −180° to 180°.
- German labels that did not fit: tour buttons, the sketch rail's tools group, the result buttons of
  the shape tools, the update banner's buttons.

Added: joint symbols are handles; Move takes jointed parts along; the drawing's material field
starts with the parts' material.

Checked and fine: all 34 test models and 6 examples open in the app and build alike in the single-
and multi-threaded kernels; sketch → extrude → fillet by hand (volumes as calculated); undo/redo;
measuring; mass and inertia; drawing; STEP/STL export data; clearance check, GIF, gear joints;
language switch; MCP `status` and `get_model`.
