# Multi-core geometry kernel: findings

Status: shipped. Threads are on by default wherever the page is cross-origin isolated (desktop app, iPad app, `https`, localhost); `?threads=0` turns them off. Plain-`http` network addresses run single-threaded.
Measured 27.10.2026 on an Apple M3 Max (12 performance + 4 efficiency cores) and on the user's iPad (Safari, iPadOS 27, over an https tunnel).

## Summary

- **A multi-threaded OCCT build already ships with the package we use.** `replicad-opencascadejs@1.1.0`
  exports `replicad-opencascadejs/multi` (pthreads, SharedArrayBuffer). It has the same API and the same
  `.d.ts` as the single build, the same licence (LGPL-2.1-only), and the same download size
  (22.5 MB raw, 7.2 MB gzip, 4.8 MB brotli). We do not have to build anything.
- **What gets faster: meshing, about 1.6–2× in the browser.** `ReplicadMeshExtractor` meshes faces in
  parallel as soon as threads exist, with no code change on our side. Booleans get faster
  (about 1.8×) only when one boolean has many intersecting tools. On the example parts the kernel time
  (feature evaluation) stays the same: fillets, chamfers, shells and extrudes are single-threaded in OCCT.
- **Measured on the iPad:** threads work (8 threads, the threaded build starts in 449 ms once cached).
  On the user's part, mesh drops from about 10 to 6–8 ms and a whole rebuild from about 66 to 54 ms
  (median). That is about 10–20 %, close to the run-to-run noise. The large speed-up the user noticed
  compared with the earlier 0.43 s kernel + 0.39 s mesh comes from the base branch and the production
  build, not from threads (see 2a).
- **Incremental meshing (keeping the triangulation of unchanged faces)** saves 30–55 % of meshing time
  when the edited feature is the last one, and nothing when it is an earlier one. It works with or
  without threads, and has no platform requirements.

**Recommendation (done on this branch):** threads on by default wherever the page is cross-origin isolated. The iPad
confirms a real but small gain (about 10–20 % per rebuild). The code cost is small, startup with a cached
wasm is the same, and the fallback is automatic. Don't expect more from it: on the iPad, meshing is now
only about 10 ms of a 65 ms rebuild. For the same reason, the per-face mesh cache is low priority. The time
that is left is feature evaluation, which neither change touches. The next lever there is to avoid
rebuilding at all while dragging (preview stand-ins, as the push/pull stand-in already does), or to
profile which features dominate.

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
  `new BRepAlgoAPI_Cut(a, b)` constructor form we use. The kernel sets it when the threaded build
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

### 2a. iPad (Safari, iPadOS 27, 8 threads)

Same part, same feature (`ex6.distance`), production build over an https tunnel, `?debug` Bench, ms
(round trip/kernel/mesh):

| | runs | median |
|---|---|---|
| single | 66/55/10 · 97/77/16 · 72/61/10 · 60/48/11 · 51/41/9 | 66/55/10 |
| threads | 54/44/9 · 80/68/10 · 70/61/8 · 50/43/6 · 46/38/6 | 54/44/8 |

- Startup: single 405 ms, threads 449 ms with the wasm cached. The first visit with threads took 9.1 s,
  almost all of it downloading the second 7 MB wasm through the tunnel (a cold load of the single
  build costs the same).
- Without threads, this part already rebuilds in about 65 ms. Earlier the iPad needed 0.43 s kernel +
  0.39 s mesh. That improvement comes from the base branch (looser touch meshing, volume/area after
  display) and from testing a production build instead of the dev server.
- Feature evaluation dominates now, and threads do not touch it. The kernel column moving from 55 to
  44 ms is mostly noise and warm-up; both runs get faster over the five rebuilds.

## 3. What the page needs

SharedArrayBuffer only exists when `crossOriginIsolated` is true. That needs COOP `same-origin` +
COEP `require-corp`, which we already send, **and** a secure context (https, or `localhost`/`127.0.0.1`).

- **iPad over the LAN (`http://192.168.x.x:4173`):** not a secure context, so no threads. The app
  then falls back to the single build and the HUD says "single thread: page not cross-origin isolated".
  To test threads on the iPad, serve over https: for example `tailscale serve` (real certificate, no
  setup on the iPad), a Cloudflare tunnel, or a local CA (mkcert) whose root is installed and trusted on
  the iPad. A plain self-signed certificate that you click through may not be enough for workers (untested).
- **Production web (Cloudflare Pages, `_headers`):** https plus the headers already set, so threads are on.
- **Electron:** `app://` is registered as `secure: true` and `main.ts` sets COOP/COEP/CORP, so the desktop
  app is cross-origin isolated and uses threads. Chromium has no 8-thread cap, so desktop gets one
  thread per core.
- **Capacitor iOS (WKWebView): works.** Capacitor serves the app from `capacitor://localhost` through
  its own scheme handler, which sends no COOP/COEP. Capacitor creates that handler inside a `final`
  `loadView`, so it can't be replaced by a subclass. Instead `AppViewController` returns an
  `IsolatedWebViewConfiguration` from `webViewConfiguration(for:)`; that configuration wraps whichever
  handler gets registered, and the wrapper passes every task on as a proxy that adds COOP `same-origin`,
  COEP `require-corp` and CORP `same-origin` to each HTTP response
  (`apps/ios/ios/App/App/CrossOriginIsolation.swift`). WebKit then treats the custom scheme as a
  secure, cross-origin isolated context: `crossOriginIsolated` is true in the page, the kernel worker
  and nested workers.
- **WebKit quirk in the app:** even when isolated, the `capacitor://` page has no global
  `SharedArrayBuffer` constructor (in the page and in workers), while shared `WebAssembly.Memory`,
  `Atomics` and posting shared memory to nested workers all work. The pthreads build checks
  `globalThis.SharedArrayBuffer` in `pthread_create` and returns `EAGAIN` without it. The kernel still
  reported "8 threads", but OCCT's thread pool then waited forever and the first rebuild never finished.
  `loadOcct` now puts the constructor back from a shared memory's buffer before it loads the threaded
  build (a no-op wherever the global exists).

  iOS Simulator (iPad Pro 11-inch M5, iOS 27, on the M3 Max; debug app, production web build), Project
  box, `?debug` Bench on `sh1.thickness`, ms (round trip/kernel/mesh):

  | | runs | median |
  |---|---|---|
  | single (`?threads=0`) | 58/6/51 · 48/5/43 · 49/4/43 · 45/4/41 · 47/4/42 | 48/4/43 |
  | threads (8) | 33/6/26 · 23/5/17 · 21/5/15 · 19/4/14 · 18/5/13 | 21/5/15 |

  Opening the part (first full build): single 543 ms (kernel 210, mesh 204), threads 219 ms (kernel 180,
  mesh 32). Startup with threads 227–252 ms, single 215–313 ms. The simulator runs on the Mac's cores,
  so these numbers show that threads work, not how fast a real iPad is.

  **Real iPad** (iPad Pro 12.9" 6th gen, M2, iPadOS 27; debug app, production web build, over USB).
  The same quirk shows there: `crossOriginIsolated` true, no `SharedArrayBuffer` global, 8 threads.
  Three of the user's saved parts, `?debug` Bench three times per part and mode (15 rebuilds each),
  ms (round trip/kernel/mesh):

  | part (benched value) | single, median | threads, median |
  |---|---|---|
  | Mounting plate 6 (`ch1.distance`) | 22/5/17 | 17/5/11 |
  | Mounting plate 7 (`ch1.distance`) | 22/5/17 | 18/6/10 |
  | Mounting plate 8 (`ex4.distance`) | 36/15/20 | 30/18/12 |

  - Meshing gets about 1.6× faster (17 → 10–11 ms, 20 → 12 ms); a whole rebuild about 20–25 % faster.
    The kernel column does not change, as on the Mac.
  - Startup: kernel ready in 96–110 ms single, 110–115 ms with threads.
  - **The first build after launch is slower with threads:** opening a part right after the kernel is
    ready took 337/386/623 ms with threads against 201/199/272 ms single (plates 6/7/8), almost all in
    the kernel column. Likely cause (not verified): the 8 pthread workers are still instantiating the
    22 MB wasm module in the background and take CPU from that first build. Later rebuilds don't show it.
  - In a real session the gain is a few milliseconds per rebuild on these parts. It grows with parts
    whose meshing is a larger share of the rebuild.


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

- **Pool size:** iPadOS Safari reports 8 (`navigator.hardwareConcurrency`), the same cap as on macOS.
- **Shared memory:** reserving 4 GB worked on the user's iPad. If the threaded build fails to start
  elsewhere, the worker falls back to the single build ("threaded build failed to start" in the HUD)
  instead of reporting a fatal kernel error.
- **Download:** turning threads on by default means a first-time visitor downloads the multi wasm
  instead of the single one (same size). Switching an existing user costs one extra 7 MB download.
- **Nested workers** (pthreads inside the kernel worker) work in Safari 15.5+ and in all current Chromium versions.
- **Dev server + WebKit:** under `vite dev`, WebKit blocks the pthread worker (COEP on a Vite dev-only
  module). Use the production build (`vite preview`) to test threads in Safari.
- **Fixed: reload in Safari.** `vite preview` answered revalidations with a `304` that had no
  COOP/COEP headers, and WebKit then refused to load the kernel worker after a reload ("Worker load was
  blocked by Cross-Origin-Embedder-Policy"), with or without threads. A small plugin in
  `apps/web/vite.config.ts` now sets the headers on every dev and preview response.

## Implementation

- `loadOcct(wasmUrl, threads)` loads the multi build and turns on BOP parallel mode (`packages/kernel/src/occt.ts`).
- The kernel worker takes `wasm.occtThreads`, falls back to the single build if that fails, and reports
  `threads` in its `ready` message.
- The web app uses it whenever the page is cross-origin isolated. `?threads=0` or
  `localStorage["meercad.threads"] = "0"` turns it off. The `?debug` HUD shows "Kernel ready (… ms, N threads)"
  or why it stayed single-threaded (turned off, page not isolated, threaded build failed to start).
- `tests/acceptance/threads.test.ts` checks that the multi build rebuilds the examples to the same bodies
  (faces, edges, volume, area). Benchmarks are in `tests/bench/` (run with `../node_modules/.bin/jiti` from `tests/`).
