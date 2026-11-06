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
- **partOrder / partGroups** (optional) — how the parts list is ordered and grouped into folders.
- **import.texture** (optional, STL imports) — the picture on a mesh, e.g. a scan's colours:
  `{ "image": "<base64 JPEG/PNG>", "mime": "image/jpeg", "uvs": "<base64 float32 pairs>", "hidden": true }`.
  `uvs` has one little-endian float32 pair per triangle corner of `data`, in file order, with v
  counting rows from the top (as in glTF). Only the look: the part is built from `data` alone. It
  follows the part when moved, copied or patterned; a cut or combined part is shown plain.
  `hidden` shows the part without it (and exports it without).
- **seeThrough** (optional) — body ids of parts drawn see-through as a reference to model against (scans come in that way).
- **features** — run in order. Ops: `sketch`, `plane`, `extrude`, `revolve`, `fillet`, `chamfer`, `shell`,
  `thread`, `linear_pattern`, `circular_pattern`, `mirror`, `boolean`, `transform`, `delete`, `import`, `texture` (and more: see the schema).
- **thread** — `{ "op": "thread", "face": { "face": "ex2.side[sk2.c1]" }, "size": "M8", "clearance": 0.15 }`
  models an ISO metric thread on a hole wall (internal) or a shaft (external). `size`, `pitch` and
  `length` are optional (picked from the diameter, the standard coarse pitch, the whole face).
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
