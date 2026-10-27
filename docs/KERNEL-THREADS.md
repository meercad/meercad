# Multi-core geometry kernel: findings

Status: prototype on branch `claude/kernel-multicore` (based on `claude/gallant-swartz-2ebb6d`), behind a flag.
Measured 27.10.2026 on an Apple M3 Max (12 performance + 4 efficiency cores). No iPad numbers yet.

## Summary

- **A multi-threaded OCCT build already ships with the package we use.** `replicad-opencascadejs@1.1.0`
  exports `replicad-opencascadejs/multi` (pthreads, SharedArrayBuffer). It has the same API and the same
  `.d.ts` as the single build, the same licence (LGPL-2.1-only), and the same download size
  (22.5 MB raw, 7.2 MB gzip, 4.8 MB brotli). We do not have to build anything.
- **What gets faster: meshing, about 1.6–2× in the browser.** `ReplicadMeshExtractor` meshes faces in
  parallel as soon as threads exist, with no code change on our side. Booleans get faster
  (about 1.8×) only when one boolean has many intersecting tools. On the example parts the kernel time
  (feature evaluation) stays the same: fillets, chamfers, shells and extrudes are single-threaded in OCCT.
- **Expected effect on the iPad:** mesh 0.39 s → roughly 0.2–0.25 s, kernel 0.43 s unchanged. That makes
  each rebuild about 20 % faster, if Safari on iPadOS gives the page several threads and lets it reserve
  the shared memory (both still unverified, see risks).
- **Incremental meshing (keeping the triangulation of unchanged faces)** saves 30–55 % of meshing time
  when the edited feature is the last one, and nothing when it is an earlier one. It works with or
  without threads, and has no platform requirements.

**Recommendation:** ship the threaded build behind the flag and measure it on the iPad first. The code
cost is small and the fallback is automatic. If the iPad confirms the gain, turn it on by default
wherever the page is cross-origin isolated. Do the per-face mesh cache after that, as a separate step:
it only helps when you edit the last feature, which is the common case while dragging a value.
Neither change makes the kernel itself faster. For that, the next lever is to avoid rebuilding at all
while dragging (preview stand-ins, as the push/pull stand-in already does).

## 1. The multi-threaded build

| | single (today) | multi |
|---|---|---|
| import | `replicad-opencascadejs` | `replicad-opencascadejs/multi` |
| wasm | 22 980 267 B | 22 481 415 B |
| gzip / brotli | 7.19 MB / 4.84 MB | 7.19 MB / 4.83 MB |
| API / `.d.ts` | — | byte-identical |
| licence | LGPL-2.1-only | LGPL-2.1-only |
| init (Chromium / WebKit) | 95–108 ms / 203–238 ms | 91–107 ms / 222–241 ms |

The multi build creates its pthread pool at start-up: one worker per `navigator.hardwareConcurrency`
(16 in Chromium here; WebKit reports at most 8). Each pthread is a nested module worker inside our kernel
worker that loads `replicad_multi.js`; Vite bundles that as its own worker chunk. The memory is a shared
`WebAssembly.Memory` with a 4 GB maximum. Both wasm files end up in `dist/`; only the one in use is
downloaded, but the desktop installer gets 22 MB bigger while both ship.

## 2. What runs in parallel

Node (same wasm, `tests/bench/threads.ts`), median of 5, ms. "extract" is our current meshing call:

| part | build | feature rebuild | mesh (lin 0.03) | mesh (lin 0.005) |
|---|---|---|---|---|
| Mounting plate | single | 27.9 | 5.1 | 9.2 |
| | multi | 28.2 | 2.6 | 3.6 |
| Project box | single | 20.4 | 10.3 | 24.8 |
| | multi | 20.8 | 3.7 | 5.3 |
| Flange | single | 28.6 | 13.0 | 32.2 |
| | multi | 26.5 | 5.3 | 11.6 |

- **Meshing:** `ReplicadMeshExtractor.extract` evidently creates `BRepMesh_IncrementalMesh` with
  `isInParallel` set. That is a no-op in the single build and parallel in the multi build. Calling
  `BRepMesh_IncrementalMesh(shape, lin, false, ang, true)` ourselves does not help: the extractor
  re-meshes anyway (see 4).
- **Booleans:** `BOPAlgo_Options.SetParallelMode(true)` is a global default that also applies to the
  `new BRepAlgoAPI_Cut(a, b)` constructor form we use. The prototype sets it when the threaded build
  loads. Plate cut by an N×N grid of cylinders (`tests/bench/boolean.ts`):

  | holes | single | multi, serial | multi, parallel |
  |---|---|---|---|
  | 4×4 | 21 | 21 | 12 |
  | 10×10 | 95 | 94 | 52 |
  | 16×16 | 242 | 254 | 140 |

  Our booleans usually have one tool body with few faces, so this rarely shows up.
- **Not parallel in OCCT:** fillet/chamfer (`BRepFilletAPI_*`), shell (`BRepOffsetAPI_MakeThickSolid`),
  extrude/revolve, sketch solving, UnifySameDomain. Most of the kernel time is spent there.
- `unify()` meshes every boolean result coarsely to get face sample points (`Body.facePoints`). That is
  part of the "kernel" time and also gets the parallel speed-up.

### Browser, `?debug` Bench (production build via `vite preview`, headless, median of 12 runs, ms, round trip / kernel / mesh)

| part | Chromium single | Chromium threads (16) | WebKit single | WebKit threads (8) |
|---|---|---|---|---|
| Mounting plate | 13/3/7 | 14/3/4–5 | 12–15/4–5/8–9 | 9–10/4/5 |
| Project box | 31–32/3/14 | 18/3/8 | 16–17/4/13 | 12–13/4/8 |
| Flange | 27/3/13 | 15/3/7 | 17/3/13–14 | 12–13/3/7–9 |

Bench only re-evaluates the last feature, so on these small examples the kernel column is tiny and
meshing dominates. The mesh column also includes the copies out of wasm memory, `repairNormals` and the
summary, which stay single-threaded. That is why the browser gain (1.6–1.9×) is smaller than in Node.

## 3. What the page needs

SharedArrayBuffer only exists when `crossOriginIsolated` is true. That needs COOP `same-origin` +
COEP `require-corp`, which we already send, **and** a secure context (https, or `localhost`/`127.0.0.1`).

- **iPad over the LAN (`http://192.168.x.x:4173`):** not a secure context, so no threads. The prototype
  then falls back to the single build and the HUD says "single thread: page not cross-origin isolated".
  To test threads on the iPad, serve over https: for example `tailscale serve` (real certificate, no
  setup on the iPad), a Cloudflare tunnel, or a local CA (mkcert) whose root is installed and trusted on
  the iPad. A plain self-signed certificate that you click through may not be enough for workers (untested).
- **Production web (Cloudflare Pages, `_headers`):** https plus the headers already set. Works once the flag
  defaults to on.
- **Electron:** `app://` is registered as `secure: true` and `main.ts` sets COOP/COEP/CORP, so the desktop
  app is cross-origin isolated already. The flag is `?threads`, which desktop users can't type, so the
  prototype also reads `localStorage["meercad.threads"] = "1"` (set it in DevTools, then reload).
  Chromium has no 8-thread cap, so desktop gets one thread per core.
- **Capacitor iOS (WKWebView):** unverified. Capacitor serves the app from `capacitor://localhost`
  through a scheme handler, which does not send COOP/COEP by default. The handler (or a small plugin)
  would have to add them, and whether WKWebView then counts the custom scheme as a cross-origin isolated
  secure context needs a test on a device. Until then, assume single-threaded in the Capacitor app.

## 4. Incremental meshing

Today every rebuild re-meshes every changed body completely. `ReplicadMeshExtractor` always re-meshes,
even when the faces already carry a triangulation.

Within one session, OCCT keeps faces that a feature did not touch as the same `TShape`. Measured with
`tests/bench/face-reuse.ts`: nudge one size value, then count faces of the new body that are `IsSame` with
a face of the previous body. Times are for meshing each face separately with the extractor:

| edit | unchanged faces | mesh all faces | mesh only changed faces |
|---|---|---|---|
| Mounting plate, countersink (last feature) | 9/14 | 6.2 | 3.8 |
| Mounting plate, holes | 8/14 | 6.3 | 4.6 |
| Mounting plate, corner fillet / plate thickness | 0/14 | 5.4–5.9 | same |
| Project box, shell thickness (last feature) | 17/35 | 11.1 | 6.1 |
| Project box, fillets | 0/35 | 12.2 | same |
| Flange, chamfer (last feature) | 8/11 | 13.5 | 5.9 |
| Flange, bolt holes / disc | 0–1/11 | 13.6–14.1 | same |

- Meshing face by face costs the same as meshing the whole body (6.1 vs 6.2 ms), so a per-face cache has
  no overhead when nothing can be reused.
- Faces that are unchanged after an early edit are still new `TShape`s, because every downstream feature
  is rebuilt. Saving those would mean matching faces by geometry, which is not worth the cost.
- OCCT's own reuse (`BRepMesh_IncrementalMesh` skips faces that are already meshed) barely helps
  (6.0 vs 7.0 ms): it re-meshes every face that borders a changed edge to keep the mesh watertight. We
  don't need that, because our faces don't share vertices.

Sketch of the implementation, not built yet. In `meshBody`, run the extractor per face, and keep a
`Map` keyed by the face's `TShape` in `KernelSession`, using `IsSame` as the check. Hold a handle to the
face from outside the arena so it outlives the feature that made it. Build the `BodyMesh` from the cached
arrays plus the new ones. Edge polylines would get the same treatment per edge.

## 5. Risks and open questions (iPad)

- **`navigator.hardwareConcurrency` in iPadOS Safari** decides the pool size. WebKit caps it at 8 on
  macOS; what an iPad reports needs checking on the device (the HUD shows the thread count).
- **Reserving 4 GB of shared memory** may fail on iOS. If the threaded build fails to start, the worker
  now falls back to the single build ("threaded build failed to start" in the HUD) instead of
  reporting a fatal kernel error.
- **Nested workers** (pthreads inside the kernel worker) work in Safari 15.5+ and in all current Chromium versions.
- **Dev server + WebKit:** under `vite dev`, WebKit blocks the pthread worker (COEP on a Vite dev-only
  module). Use the production build (`vite preview`) to test threads in Safari.
- **Separate, existing issue:** `vite preview` answers revalidations with `304` without COOP/COEP headers.
  WebKit then refuses to load the kernel worker after a reload ("Worker load was blocked by
  Cross-Origin-Embedder-Policy"), with or without threads. This probably also affects `pnpm ipad` reloads
  in Safari.

## Prototype

- `loadOcct(wasmUrl, threads)` loads the multi build and turns on BOP parallel mode (`packages/kernel/src/occt.ts`).
- The kernel worker takes `wasm.occtThreads`, falls back to the single build if that fails, and reports
  `threads` in its `ready` message.
- The web app enables it with `?threads` or `localStorage["meercad.threads"] = "1"`, but only on a
  cross-origin isolated page. The `?debug` HUD shows "Kernel ready (… ms, N threads)" or why it stayed
  single-threaded.
- `tests/acceptance/threads.test.ts` checks that the multi build rebuilds the examples to the same bodies
  (faces, edges, volume, area). Benchmarks are in `tests/bench/` (run with `../node_modules/.bin/jiti` from `tests/`).
