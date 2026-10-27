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
- **partOrder / partGroups** (optional) — how the parts list is ordered and grouped into folders.
- **features** — run in order. Ops: `sketch`, `plane`, `extrude`, `revolve`, `fillet`, `chamfer`, `shell`,
  `thread`, `linear_pattern`, `circular_pattern`, `mirror`, `boolean`, `transform`, `delete`, `import`.
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
