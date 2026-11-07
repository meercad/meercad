# The `.meercad` file format (`meercad/1`)

An `.meercad` file is UTF-8 JSON describing a part as a **parametric feature history** — not as
triangles or B-rep. Opening the file replays the history to rebuild the geometry, so every value
stays editable. The authoritative JSON Schema is `documentSchema` in
[`packages/schema/src/schema.ts`](../packages/schema/src/schema.ts) (MIT licensed, free to reuse).

```json
{
  "format": "meercad/1",
  "params": { "width": "60 mm", "hole": "4.5 mm" },
  "features": [
    { "id": "sk1", "op": "sketch", "plane": { "ref": "origin.XY" }, "entities": [ … ], "constraints": [ … ] },
    { "id": "ex1", "op": "extrude", "profile": { "sketch": "sk1" }, "extent": "blind", "distance": "width / 10", "mode": "new_body" },
    { "id": "fi1", "op": "fillet", "edges": { "select": "edges", "of": "ex1", "where": { "face": "end_cap" } }, "radius": "1 mm" }
  ],
  "rollback": null
}
```

- **params** — named values; any numeric field may be an expression (`"wall * 2"`, `"5 mm"`, `"30 deg"`).
  `autoParams` (optional) lists the ones an assistant created; the app shows them apart from your own.
- **variants / variant** (optional) — named sets of parameter values, e.g. one holder for three pipe
  sizes: `"variants": [{ "name": "Pipe 25", "params": { "pipe": "25 mm" } }], "variant": "Pipe 25"`.
  The variant in use replaces the values of the parameters it lists; without `variant` the values in
  `params` apply.
- **versions / blobs** (optional) — named states of the design the user saved:
  `"versions": [{ "name": "Before the fillets", "at": 1793366400000, "state": { "params": …, "features": …, "rollback": null } }]`.
  A state is the whole document without `format`, `versions` and `blobs`. Imported files' contents
  (`import.data`, a mesh's `texture.image` and `texture.uvs`, and a surface texture's `image.pixels`) longer than 4 kB are stored once
  in `blobs` under a key (`"blob:…"`) that the states use instead, however many versions share them.
- **partOrder / partGroups** (optional) — how the parts list is ordered and grouped into folders (op `set_part_list {groups?, order?}`; null clears).
- **import.texture** (optional, STL imports) — the picture on a mesh, e.g. a scan's colours:
  `{ "image": "<base64 JPEG/PNG>", "mime": "image/jpeg", "uvs": "<base64 float32 pairs>", "hidden": true }`.
  `uvs` has one little-endian float32 pair per triangle corner of `data`, in file order, with v
  counting rows from the top (as in glTF). Only the look: the part is built from `data` alone. It
  follows the part when moved, copied or patterned; a cut or combined part is shown plain.
  `hidden` shows the part without it (and exports it without).
- **partColors / partMaterials / materials** (optional) — what parts look like and are made of, by
  body id. `partColors`: `{ "ex1": "#2f6fd6" }`, the colour picked for a part (its filament colour).
  `partMaterials`: `{ "ex1": "petg", "ex2": "own1" }`, an id from the built-in library (`pla`,
  `plamatte`, `plasilk`, `petg`, `abs`, `asa`, `tpu` = TPU 95A, `tpu85a`, `pa12`, `pc`, `placf`,
  `petgcf`, `woodfill`, `metalfill`, `resin`, `resinclear`, `aluminium`, `steel`, `stainless`,
  `brass`, `copper`, `wood`, `plywood`, `acrylic`; see `MATERIALS` in
  [`packages/model/src/materials.ts`](../packages/model/src/materials.ts) for density, print data
  and finish) or of an own material. `materials`: the user's own materials, each a library material
  under an own name, optionally with its own colour and density:
  `[{ "id": "own1", "name": "Black TPU", "base": "tpu", "color": "#1c1c1c", "density": 1.2 }]`.
  A part's colour is the picked one, else its material's own colour (carbon, wood, metal, own
  materials), else an automatic one. All three are optional; files without them open as before.
- **seeThrough** (optional) — body ids of parts drawn see-through as a reference to model against (scans come in that way; op `set_see_through {parts, on}`).
- **units** (optional) — `"in"` for an inch design (op `set_units {units}`); stored values keep their units.
- **fit** (optional) — the design's fit (Spiel): the gap per side the printer needs between parts that fit into each other, measured with the fit test part (op `set_fit {fit}`, default 0.2 mm). Every expression can use it as `fit`; an own parameter called `fit` from older files takes its place. Bores for shafts use `2 * fit` on the diameter, lids `fit` per side, threads `fit / 2`; print-in-place checks use at least `max(fit, 0.3 mm)`.
- **Ops for what the parts list shows**: `set_part_color {part, color|null}`, `set_see_through {parts, on}`,
  `set_part_list {groups?, order?}` (null clears). `replace` sends the whole document; one without
  `versions` keeps the saved versions and their blobs.
- **features** — run in order. Ops: `sketch`, `plane`, `extrude`, `revolve`, `fillet`, `chamfer`, `shell`,
  `thread`, `linear_pattern`, `circular_pattern`, `mirror`, `boolean`, `transform`, `delete`, `import`,
  `gridfinity`, `label`, `box`, `snap_hook`, `bend`, `texture` (and more: see the schema).
- **Ops for materials** (Operations API): `set_material {part, material}` (null for none),
  `define_material {material}` (adds or replaces an own material by id), `delete_material {id}`
  (its parts go back to the base material).
- **thread** — `{ "op": "thread", "face": { "face": "ex2.side[sk2.c1]" }, "size": "M8", "clearance": 0.15 }`
  models an ISO metric thread on a hole wall (internal) or a shaft (external). `size`, `pitch` and
  `length` are optional (picked from the diameter, the standard coarse pitch, the whole face).
- `standard_part` also makes machine parts: `"kind": "profile"` (aluminium profiles `2020`, `2040`,
  `3030`, `4040`, standing on the face, `length`), `corner_bracket`, `t_nut`, `linear_bearing`
  (`LM6UU` … `LM12UU`), `shaft`, `lead_screw` (`Tr8x8`, `Tr8x2`, `Tr10x2`, `Tr12x3`) and `rail`
  (`MGN7` … `MGN15`, lying along the plane's u axis, turned by `angle`). `"withMoving": true` adds
  a rail's carriage (`np1_carriage`) or a lead screw's nut (`np1_nut`); the app and MCP add their
  joints (`j_np1_carriage`; `j_np1` turning, `j_np1_nut` sliding, coupled by the lead).
- **gridfinity** — storage on the open Gridfinity grid (42 mm cells, 7 mm height units), built as an
  ordinary part: `{ "op": "gridfinity", "kind": "bin", "units": [2, 1], "height": 3, "dividers": [2, 0], "scoop": 8, "tab": {}, "magnets": true }`.
  Bins have one foot per cell, walls (`wall`, default 1.2 mm), a floor 7 mm above the bottom, the
  stacking lip 4.4 mm above the rim (`"lip": false` leaves it off), optional `solid`, `dividers`
  (walls across x and y), `scoop` (finger-slide radius) and label `tab` (`width`, `angle`, `style`).
  `{ "kind": "baseplate", "units": [4, 3] }` is the grid to stand them on; `drawer: [w, d]` fits as
  many cells as a drawer takes and fills the rest with a border; `magnets` / `screws` add the holes
  (and a 3.4 mm floor). A bin with `"baseplate": "gf1", "cell": [i, j]` stands in that baseplate.
  Faces: `gf1.foot`, `.floor`, `.wall`, `.inner`, `.lip`, `.top`, `.divider`, `.scoop`, `.tab`, `.pocket`, `.hole`, `.bottom`.
- **wall** — wall storage built as ordinary parts, flat for printing (back on the plane, front +z,
  y up the wall): `{ "op": "wall", "system": "opengrid", "kind": "board", "units": [4, 4] }` is an
  openGrid board (28 mm cells, `variant` `"full"` 6.8 mm or `"lite"` 4 mm, `screws` adds countersunk
  holes at the crossings next to the corners); `"system": "pegboard"` a perforated board (`grid`:
  `us_quarter`, `us_eighth`, `metric_25`, `square_38`; `pitch`, `hole`, `thickness` override).
  `{ "kind": "holder", "units": [1, 1], "accessory": "hook", "board": "wl1", "cell": [0, 3] }` hangs
  a holder on an earlier board: snaps (openGrid) or pegs (pegboard, the top ones hooking up behind)
  in its corner cells, a back plate (`plate`, 3 mm) and `accessory` `plain`, `hook` (`depth` reach,
  `size` tip rise), `ring` (`size` inner diameter, `depth` gap), `shelf` (`depth`, `size` lip),
  `bin` (a shelf with Gridfinity cells for `size` bins) or `screw` (openGrid: a bare snap with a
  countersunk hole of diameter `size`). Faces: `wl1.back`, `.front`, `.side`, `.opening`, `.hole`,
  `.snap`, `.peg`, `.plate`, `.hook`, `.ring`, `.shelf`.
- **label** — a printable label: `{ "op": "label", "text": "M3×10", "symbol": "screw_socket", "width": 36, "height": 11 }`,
  a rounded plate with a symbol (`screw_pan`, `screw_countersunk`, `screw_socket`, `screw_hex`, `nut`,
  `washer`, `insert`) and text sized to fit, `style` raised or engraved (`depth`, default 0.6 mm).
  `"separate": true` makes the marking its own part `lb1_mark` for a second colour (raised on top, or
  engraved as a flush inlay). Put it on a bin's tab with `"plane": { "face": { "face": "gf1.tab" } }`.
- **box** — a printable box and its lid as two parts (`bx1`, `bx1_lid`): `{ "op": "box", "lid": "snap", "width": 80, "depth": 60, "height": 40 }`.
  `lid: "snap"` (rectangular or `"shape": "round"`): the lid's lip reaches into the box and its bead
  (`snap`, default 0.5 mm) clicks into a groove inside the wall. `lid: "screw"`: a round jar
  (`width` = diameter) with a threaded neck (`neck`, `pitch`, `starts`) and a cap as wide as the jar;
  the thread's 45° flanks print without supports. `clearance` (default 0.2 mm per side) is the play
  between box and lid. The lid lies upside down beside the box (`"layout": "closed"` puts it on).
- **snap_hook** — cantilever snap hooks on a face at `points`: `{ "op": "snap_hook", "plane": { "face": { "face": "bx1.lid_under" } }, "points": [[0, 20]], "angle": 90, "catchIn": ["bx1"] }`.
  `length`, `thickness`, `width`, `overhang`, `insertAngle`, `retainAngle` (90 holds for good), joined
  to the part under the face; `catchIn` cuts the window the barb clicks into (with `clearance`).
- **bend** — `{ "op": "bend", "bodies": ["ex1"], "mode": "spiral", "axis": { "ref": "origin.Z" }, "radius": 20, "gap": 1 }`
  bends parts as if flexible: `"bend"` round the axis by `angle` (degrees, at most 360) or with
  `radius` (of the middle of the thickness); `"wrap"` onto a cylinder of `radius` (inner face on it;
  a flat pattern becomes a ring); `"spiral"` rolls the part into a flat Archimedean coil with inner
  `radius` and `gap` between turns (default 1 mm; 0 or less is refused, as the turns would touch).
  `axis` gives only the direction; the part's length is its longest extent across it and is kept
  (in the middle of the thickness for bend and spiral, on the inner face for wrap). `flip` bends
  the other way, `reverse` starts a spiral at the other end, `tolerance` (mm) is how far the
  triangles may stray from the exact shape. Ends that meet are joined into a closed ring. The
  parts become mesh parts and keep their ids.
- **texture** — a printable surface texture on faces of one part:
  `{ "op": "texture", "faces": [{ "face": "ex1.side[*]" }], "pattern": "ribs", "depth": 0.8, "pitch": 4 }`.
  `pattern` is one of `ribs`, `ribs_square`, `ribs_v`, `knurl`, `cross_knurl`, `hex`, `dots`, `waves`,
  `brick`, `wood`, `leather`, `weave`, `image`; `depth` (mm) raises the pattern (positive) or cuts it in
  (negative), `pitch` (mm) is one repeat. Optional: `angle` (degrees; 0 = ribs run up a wall or along
  a round face's axis), `ratio` (raised share 0.1–0.95), `fade` (mm at the border, default half the
  pitch up to 2 mm), `seed` (wood, leather), `invert`, and for `image` a greyscale height picture
  `{ "width": 64, "height": 64, "pixels": "<base64 of width × height bytes, row by row from the top, 255 = high>" }`
  (kept in `blobs` by versions like imported files). Only the triangles change: the display and STL,
  3MF and OBJ export carry the texture; the solid, its volume and mass, STEP and later steps keep the
  smooth faces.
- **References** never use indices. Faces carry *tags* from the feature that made them
  (`ex1.end_cap`, `ex1.side[sk1.l3]`, `fi1.round[a|b]`) and later features select by tag, so edits
  upstream don't silently re-target downstream features.
- **Sketches** store point coordinates plus constraints (coincident, horizontal, length, diameter, …);
  values are re-solved on every rebuild.

The complete modelling guide that assistants receive (all ops, selectors and naming rules) is
`SYSTEM_PROMPT` in [`packages/ai/src/prompt.ts`](../packages/ai/src/prompt.ts).
