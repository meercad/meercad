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
  (`import.data`, and a mesh's `texture.image` and `texture.uvs`) longer than 4 kB are stored once
  in `blobs` under a key (`"blob:…"`) that the states use instead, however many versions share them.
- **partOrder / partGroups** (optional) — how the parts list is ordered and grouped into folders.
- **import.texture** (optional, STL imports) — the picture on a mesh, e.g. a scan's colours:
  `{ "image": "<base64 JPEG/PNG>", "mime": "image/jpeg", "uvs": "<base64 float32 pairs>", "hidden": true }`.
  `uvs` has one little-endian float32 pair per triangle corner of `data`, in file order, with v
  counting rows from the top (as in glTF). Only the look: the part is built from `data` alone. It
  follows the part when moved, copied or patterned; a cut or combined part is shown plain.
  `hidden` shows the part without it (and exports it without).
- **seeThrough** (optional) — body ids of parts drawn see-through as a reference to model against (scans come in that way).
- **features** — run in order. Ops: `sketch`, `plane`, `extrude`, `revolve`, `fillet`, `chamfer`, `shell`,
  `thread`, `linear_pattern`, `circular_pattern`, `mirror`, `boolean`, `transform`, `delete`, `import`,
  `gridfinity`, `label` (and more: see the schema).
- **thread** — `{ "op": "thread", "face": { "face": "ex2.side[sk2.c1]" }, "size": "M8", "clearance": 0.15 }`
  models an ISO metric thread on a hole wall (internal) or a shaft (external). `size`, `pitch` and
  `length` are optional (picked from the diameter, the standard coarse pitch, the whole face).
- **gridfinity** — storage on the open Gridfinity grid (42 mm cells, 7 mm height units), built as an
  ordinary part: `{ "op": "gridfinity", "kind": "bin", "units": [2, 1], "height": 3, "dividers": [2, 0], "scoop": 8, "tab": {}, "magnets": true }`.
  Bins have one foot per cell, walls (`wall`, default 1.2 mm), a floor 7 mm above the bottom, the
  stacking lip 4.4 mm above the rim (`"lip": false` leaves it off), optional `solid`, `dividers`
  (walls across x and y), `scoop` (finger-slide radius) and label `tab` (`width`, `angle`, `style`).
  `{ "kind": "baseplate", "units": [4, 3] }` is the grid to stand them on; `drawer: [w, d]` fits as
  many cells as a drawer takes and fills the rest with a border; `magnets` / `screws` add the holes
  (and a 3.4 mm floor). A bin with `"baseplate": "gf1", "cell": [i, j]` stands in that baseplate.
  Faces: `gf1.foot`, `.floor`, `.wall`, `.inner`, `.lip`, `.top`, `.divider`, `.scoop`, `.tab`, `.pocket`, `.hole`, `.bottom`.
- **label** — a printable label: `{ "op": "label", "text": "M3×10", "symbol": "screw_socket", "width": 36, "height": 11 }`,
  a rounded plate with a symbol (`screw_pan`, `screw_countersunk`, `screw_socket`, `screw_hex`, `nut`,
  `washer`, `insert`) and text sized to fit, `style` raised or engraved (`depth`, default 0.6 mm).
  `"separate": true` makes the marking its own part `lb1_mark` for a second colour (raised on top, or
  engraved as a flush inlay). Put it on a bin's tab with `"plane": { "face": { "face": "gf1.tab" } }`.
- **References** never use indices. Faces carry *tags* from the feature that made them
  (`ex1.end_cap`, `ex1.side[sk1.l3]`, `fi1.round[a|b]`) and later features select by tag, so edits
  upstream don't silently re-target downstream features.
- **Sketches** store point coordinates plus constraints (coincident, horizontal, length, diameter, …);
  values are re-solved on every rebuild.

The complete modelling guide that assistants receive (all ops, selectors and naming rules) is
`SYSTEM_PROMPT` in [`packages/ai/src/prompt.ts`](../packages/ai/src/prompt.ts).
