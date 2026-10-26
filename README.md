# opencad (working title)

Free, open-source, parametric CAD in the browser — local-first, no account, with a BYOK AI copilot.
See [docs/PLAN.md](docs/PLAN.md) for vision, scope and roadmap.

**Status: Phase 0 spike.** Rectangle sketch → extrude → fillet, persistent edge references,
incremental rebuild in a worker, STL export, share links, AI copilot loop.

## Develop

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm test         # unit + Phase 0 acceptance tests (real OCCT kernel in Node)
pnpm typecheck
pnpm build        # static site in apps/web/dist (deploy with public/_headers for COOP/COEP)
```

Live copilot test (costs API credits): `OPENCAD_LIVE_AI=1 ANTHROPIC_API_KEY=… pnpm test tests/acceptance/ai.test.ts`

## Layout

| Path | Contents | License |
|---|---|---|
| `packages/schema` | Document + Operations-API types and JSON Schema, validation | MIT |
| `packages/naming` | Persistent references: selector resolution, tag propagation (kernel-agnostic) | MIT |
| `packages/io` | STL writer/reader, share-link encoding | MIT |
| `packages/model` | Expressions/params, document store (undo/redo), incremental rebuild engine | AGPL-3.0 |
| `packages/sketch` | Sketch evaluation (Phase 0: rectangles; PlaneGCS in Phase 1) | AGPL-3.0 |
| `packages/kernel` | OCCT (WASM) backend, tessellation, worker protocol + client | AGPL-3.0 |
| `packages/viewport` | Three.js rendering and edge/face picking | AGPL-3.0 |
| `packages/ai` | BYOK copilot: tool loop with sandbox rebuild | AGPL-3.0 |
| `apps/web` | The app (Vite, vanilla TS for now) | AGPL-3.0 |
| `tests/` | Acceptance tests and reference model corpus | — |

## How references survive edits

Every face is tagged by the feature that created it (`ex1.end_cap`, `ex1.side[sk1.r1.top]`); fillets
carry tags forward through OCCT's history (`Modified`/`Generated`) and name their own faces
(`fi1.round[ex1.end_cap|ex1.side[sk1.r1.top]]`). Features reference edges only through selectors such as
`{ "edge": ["ex1.end_cap", "ex1.side[sk1.r1.top]"] }`. A selector that no longer matches exactly is an
error on the feature — never a silent re-match.
