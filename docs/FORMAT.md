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
- **features** — run in order. Ops: `sketch`, `plane`, `extrude`, `revolve`, `fillet`, `chamfer`, `shell`,
  `thread`, `linear_pattern`, `circular_pattern`, `mirror`, `boolean`, `transform`, `delete`, `import`.
- **Ops for materials** (Operations API): `set_material {part, material}` (null for none),
  `define_material {material}` (adds or replaces an own material by id), `delete_material {id}`
  (its parts go back to the base material).
- **thread** — `{ "op": "thread", "face": { "face": "ex2.side[sk2.c1]" }, "size": "M8", "clearance": 0.15 }`
  models an ISO metric thread on a hole wall (internal) or a shaft (external). `size`, `pitch` and
  `length` are optional (picked from the diameter, the standard coarse pitch, the whole face).
- **References** never use indices. Faces carry *tags* from the feature that made them
  (`ex1.end_cap`, `ex1.side[sk1.l3]`, `fi1.round[a|b]`) and later features select by tag, so edits
  upstream don't silently re-target downstream features.
- **Sketches** store point coordinates plus constraints (coincident, horizontal, length, diameter, …);
  values are re-solved on every rebuild.

The complete modelling guide that assistants receive (all ops, selectors and naming rules) is
`SYSTEM_PROMPT` in [`packages/ai/src/prompt.ts`](../packages/ai/src/prompt.ts).
