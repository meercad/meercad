# Native geometry kernel: findings

Status: investigated, **not built**. We don't recommend a native kernel for now (see Recommendation).
Measured 28.10.2026 on an Apple M3 Max (12 performance + 4 efficiency cores), macOS 27, Node 24,
Electron 45, Safari 27. Native OCCT is the Homebrew bottle `opencascade` 7.9.3 (Release build, clang).

## Summary

- **On Apple Silicon, the WASM kernel is about as fast as native OCCT.** We replayed the 133 boolean
  and UnifySameDomain calls of a Raspberry Pi 4 case rebuild (70 % of its rebuild time) with the
  same operands in each runtime. Single-threaded: Node 1.88 s, the Electron renderer 1.83 s, Safari 1.93 s,
  native 2.02 s. Meshing the case body: 295–320 ms everywhere. The assumed 1.5–3× WASM penalty does not
  show up for this workload. Only volume/area integration is faster natively (1.1–1.4×), and it is
  a small share of the time.
- **Threads matter more than native code.** The threaded WASM build that the desktop app already uses
  runs the same calls in about 1.0 s. Native OCCT with parallel booleans needs 1.46 s. Meshing is
  equally parallel in both (85–94 ms).
- **On the Mac, a native kernel would gain nothing.** The desktop app already runs the threaded WASM
  build in a worker, at the same speed as Node. Moving it to a Node process (option A) changes nothing,
  and a native addon (option B) would be at best about 5 % faster on booleans, and in our runs it was slower.
- **On the iPad, the real gap is threads, not WASM.** The Capacitor app runs single-threaded because
  its WKWebView is not cross-origin isolated. Getting threads there (option C) is worth up to 1.4× on
  rebuilds and 3× on meshing for the Pi case. Sending COOP/COEP headers from Capacitor's scheme handler
  may be enough, which is days of work, not the weeks a native port would take.
- **The biggest win is in our own feature code, and it helps every platform.** The Pi case spends
  1.5 s in one thread feature, and about 600 ms of that is a groove cut that is thrown away. Its three
  vent patterns cut 40 copies one by one. One multi-tool boolean does the same 40 cuts 2.2–3.4× faster
  with an identical result, and it also saves 39 rounds of tag bookkeeping.

## 1. How the kernel works today

- `packages/kernel/src/worker.ts`: `startKernelWorker(scope, wasm)` answers the messages in
  `protocol.ts` (`rebuild`, `sandbox`, `export_step`, `export_mesh`, `configure`, `props`, `measure`).
  It only needs `postMessage`/`addEventListener`, so any message channel can host it: a Web Worker
  today, but also a Node `worker_threads` worker or an Electron utility process. Newer rebuilds replace
  queued ones (latest wins).
- `client.ts`: `KernelClient` wraps a `Worker` and matches replies by `seq`. The web app creates
  it in `apps/web/src/store.ts` with `kernel-threads` whenever the page is cross-origin isolated
  (desktop: yes, through `app://` with COOP/COEP in `apps/desktop/src/main.ts`; iPad app: no).
- `occt.ts`: `loadOcct` loads `replicad-opencascadejs` (single or `/multi` pthreads build, about 22.5 MB of
  wasm each) and turns on parallel booleans for the threaded build.
- `session.ts` → `@meercad/model`'s `RebuildEngine` (incremental, per-feature cache) →
  `backend.ts` (`OcctBackend`: extrude, revolve, fillet, chamfer, shell, patterns, booleans, threads,
  imports), `boolean.ts` (boolean + UnifySameDomain + geometric re-tagging), `thread.ts`, `body.ts`
  (face/edge maps, tags, sample points), `mesh.ts` (`ReplicadMeshExtractor` + edge polylines),
  `tools.ts` (STEP, export meshes, measuring).
- Sketches are solved by PlaneGCS (`@salusoft89/planegcs`, also WASM) in `packages/sketch`. In
  every part we measured, sketch time is under 7 ms per rebuild.
- OCCT surface used: about 45 OCCT classes in about 110 call sites in `packages/kernel/src`, plus many
  `gp_*` value objects, all through embind. Calls from JS into WASM are cheap (a few ns), so the
  kernel can afford a chatty, object-by-object style.

## 2. Where the time goes (WASM, Node)

`tests/bench/corpus.ts` runs a cold rebuild (fresh session, median of 7) of every example, every
`tests/corpus` file and every part in `~/Documents/leocad`. ms:

| part | features | faces | rebuild single / threads | mesh single / threads | volume+area |
|---|---|---|---|---|---|
| Mounting plate (example) | 6 | 14 | 28.6 / 27.4 | 38.9 / 12.5 | 2.2 |
| Project box (example) | 5 | 35 | 19.4 / 20.5 | 165 / 27.9 | 5.6 |
| Flange (example) | 6 | 11 | 28.8 / 26.6 | 86.2 / 39.8 | 2.2 |
| Flange (user) | 15 | 14 | 245 / 193 | 92.5 / 40.4 | 2.8 |
| Mounting plate (user) | 11 | 20 | 88.7 / 89.2 | 41.9 / 11.3 | 2.8 |
| Project box (user) | 6 | 43 | 29.3 / 29.5 | 247 / 32.8 | 7.2 |
| **Raspberry Pi 4 case** | 46 | 259 | **2684 / 1865** | **336 / 108** | 47.9 |

Pi 4 case by feature type, single / threads: thread 1510 / 642, linear_pattern 652 / 683, extrude
471 / 501, fillet 20, shell 6, sketch 3.5. The slowest single features are `th1` (thread) 1510,
`vents_back` 239, `vents_end` 213, `ex4` 141 and `vents_floor` 110.

- Small parts rebuild in 20–90 ms. Meshing dominates there, and threads already cut it by 3–6×.
- The large part is dominated by booleans: 50 cuts, 16 fuses and 2 commons, plus 65 UnifySameDomain
  calls, which add up to 1.9 of 2.7 s. The rest goes to the sweep, prisms, distance queries for
  re-tagging, face sample points and JS bookkeeping.

## 3. Native vs WASM, same calls

`tests/bench/native/record.ts` rebuilds a part with the boolean and UnifySameDomain constructors
wrapped. It writes every call's operands as BREP files and records the call's WASM time. `replay.ts`
(Node), a small browser page (same code, run in Electron and Safari) and `bench.cpp` (native, linked
against Homebrew OCCT) replay exactly those calls from the BREP files, median of 5 each, and then mesh
and integrate the final bodies with `BRepMesh_IncrementalMesh` at the display tolerance.

Raspberry Pi 4 case, 133 calls, ms (single-threaded / threaded):

| runtime | booleans + unify | mesh (case body, 259 faces) | volume + area |
|---|---|---|---|
| Node 24, WASM | 1878 / 1058 | 320 / 94 | 42 |
| Electron 45 renderer, WASM | 1828 / 995 | 308 / 85 | 32 |
| Safari 27 (JavaScriptCore), WASM | 1934 / 1045 | 295 / 84 | 32 |
| native OCCT 7.9.3, arm64 | 2022 / 1455 | 312 / 90 | 29 |

Per call type (single-threaded, Node WASM vs native): Cut 1333 vs 1444, Common 290 vs 325, Fuse 92 vs
105, UnifySameDomain 163 vs 148.

User's Flange (31 calls): booleans + unify 130 (Node) / 123 (Electron) / 138 (Safari) vs 132 native;
mesh 90 vs 71 (single), 37–44 vs 32 (threads).

- Native is no faster at booleans, the operation that dominates the large part. Parallel booleans
  scale worse natively than in the threaded WASM build (1.39× vs 1.8×). One reason may be that the
  Homebrew build uses TBB and the WASM build uses OCCT's own thread pool.
- Native meshing is 0–20 % faster single-threaded and the same with threads.
- OCCT's memory manager makes no difference natively (`MMGT_OPT` 0/1/2: 2005/2013/2029 ms).
- JavaScriptCore (iPad engine) is within 5 % of V8 on this code, so the Safari result carries over
  to the iPad as a ratio. The absolute iPad times are about 1.5–2× the Mac's (see `KERNEL-THREADS.md` 2a).

**Caveats.** The WASM build's OCCT version is not stated by the package. Its source layout says 7.9 or
newer, so it could be newer than 7.9.3. A version difference could hide or exaggerate a native
advantage. We could not build OCCT ourselves with `-O3`/LTO in this session (blocked as running
downloaded code). Such tuning usually gains single-digit percentages. Everything was measured on one
Mac, and native OCCT was not measured on an iPad.

## 4. Options

### A. Same TypeScript kernel, run in Node in the Electron app (utility process or worker_threads)

`startKernelWorker` would run unchanged behind a `MessagePort`. **Speed gain: none.** The renderer
worker already runs the threaded WASM build at Node's speed (Electron 1828/995 ms vs Node 1878/1058 ms).
It would only help if we wanted one kernel shared between windows or with the MCP server, or a kernel
that survives a renderer reload. None of that is needed now. Effort: 1–2 days.

### B. Real native OCCT (C++ addon on the Mac, static library + Capacitor plugin on the iPad)

- **What it would take.** The kernel talks to OCCT in about 110 places, object by object (`gp_Pnt`,
  explorers, lists). There are two ways to do that natively:
  - **Mirror the bindings over N-API.** Every crossing costs about 50–100 ns plus allocations instead of
    a few ns, and every shape would need a JS wrapper with a finalizer. The chatty style would get
    slower, not faster, and there is no ready-made generator (opencascade.js generates embind code,
    not N-API code).
  - **Port the backend to C++.** Feature ops, body/tag bookkeeping and meshing would move to C++, and
    a coarse API would stay (rebuild a feature, mesh a body). That is `backend.ts`, `boolean.ts`,
    `thread.ts`, `body.ts`, `mesh.ts` and `tools.ts` (about 1500 lines of TS) plus the parts of
    `@meercad/naming` they call. We estimate 3–5 weeks, then keeping two implementations or giving up
    the web build's kernel.
- **Build and release.** A macOS addon for arm64 + x64, built against Electron's headers, signed and
  notarized in the existing GitHub Actions release. An iOS arm64 static OCCT (or xcframework) plus a
  Swift/ObjC++ Capacitor plugin. Windows/Linux would each need their own build later.
- **Size.** The native modeling toolkits are 25 MB (Homebrew arm64 dylibs, TKernel … TKFeat), plus 7 MB
  for STEP. That is about the size of today's 22.5 MB wasm, so nothing is saved.
- **Licence.** OCCT is LGPL-2.1 with the Open CASCADE exception (the exception covers code pulled in
  from OCCT headers). Linking statically on iOS is allowed if users can relink the app against a
  modified OCCT. Because meerCAD is source-available, that is covered by publishing the source and
  build scripts, but it needs a short note in `THIRD_PARTY_NOTICES.md` and a look at App Store terms.
  A dynamic framework inside the app avoids the question. Today's WASM file is already a separate,
  replaceable LGPL component. (This is not legal advice.)
- **Speed gain:** about 0 % on booleans, 0–20 % on single-threaded meshing, and 1.1–1.4× on volume/area,
  going by section 3. On the iPad, the real gain would be native threads, which option C gets for
  much less.

### C. iPad: threads for the existing WASM build

The iPad app is single-threaded only because `capacitor://localhost` responses carry no COOP/COEP,
so `crossOriginIsolated` is false. Capacitor 8's `WebViewAssetHandler` (an `open class`) builds the
`HTTPURLResponse` headers in `webView(_:start:)`. Adding `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp` there is the whole change. It can be done as a
subclass, or by wrapping the `WKURLSchemeTask` to add headers to the response, plus a way to install
the handler, because `CAPBridgeViewController.loadView` creates it directly. The open question is
whether WebKit treats a custom scheme as a secure context that can be cross-origin isolated. That
needs a device test. Expected gain on the Pi case, going by the Node numbers: rebuild 2.7 → 1.9 s,
mesh 336 → 108 ms. iPadOS reports 8 threads. Effort: 0.5–2 days including the device test.

### D. Faster feature code (all platforms)

**Done** (branch `claude/faster-patterns-thread`). Measured with `bench/corpus.ts` on the same Mac,
median of 7 cold rebuilds, Node WASM:

| Pi 4 case | single before | single after | threads before | threads after |
|---|---|---|---|---|
| rebuild | 2927 ms | 1590 ms | 1970 ms | 1111 ms |
| thread (th1) | 1620 ms | 887 ms | 666 ms | 418 ms |
| linear_pattern (3 features) | 747 ms | 161 ms | 727 ms | 136 ms |

The Flange example's circular pattern went from 37 to 8 ms. (Baseline differs a little from the
2684/1865 ms above: other work was running on the machine; before and after were measured back to back.)
`bench/snapshot.ts` writes every corpus part's bodies (faces, volume, sorted face tags); the files
before and after are identical, so all corpus bodies and all face tags are unchanged.

- **Patterns: one boolean with all copies as tools.** `replicate` (`backend.ts`) now hands all copies
  of a cut or join feature to `applyCopies`: one `BRepAlgoAPI_Cut`/`Fuse` per target body
  (`SetArguments`/`SetTools`), then one unify and re-tag. `booleanBodies` takes several tools and feeds
  the history of every tool into `propagateTags`, so the patterned faces keep their `@feature.k` tags.
  Copies that don't map simply onto bodies (a copy touching nothing, a joined copy bridging bodies,
  intersect, a boolean that fails) go copy by copy as before.
- **Thread: pick the start that works.** OCCT misses the groove/cylinder intersection depending on
  where the helix starts relative to the cylinder seam. A sweep over 160 threads (M3–M8 holes and
  shafts, 8 lengths, both hands, both axis directions) showed the old order was backwards for holes:
  52 of the 134 threads that work needed a second groove. The rule is now: start a quarter turn ahead
  of the seam in the helix's own sense, unless the groove's far end would land 170–320° (holes) or
  170–250° (shafts) past the seam; then start behind it. Only 4 of 134 need the second try now, the
  Pi case's hole is not one of them, and all 160 cases give the same result (status, volume, faces) as
  before. The other start is still tried as a fallback.
- **Not done: cut against a local cylinder first.** A probe cut of the groove against a small ring of
  the face's radius reproduces the miss, but costs as much as the cut against the whole body (≈ 450 ms):
  the time is in the helical-groove/cylinder intersection, not in the body's other faces.
- The remaining thread time on the Pi case is one sweep + `common` (≈ 180 ms) and one cut (≈ 550 ms).
- Incremental meshing (keep triangles of unchanged faces) is already sketched in `KERNEL-THREADS.md`, section 4.

These are ordinary changes in `packages/kernel/src`, need no new build tooling and help the web
version too.

## Recommendation

1. **Don't build a native kernel now.** Measured on the operations that dominate real parts, it gains
   nothing on the Mac and little on the iPad. In return it would need a C++ port of the backend (or a
   slower binding layer), two native build pipelines and LGPL bookkeeping for static linking.
2. **Do D first:** multi-tool pattern booleans and the thread-start fix. Done: on the Pi case
   2.9 → 1.6 s single-threaded and 2.0 → 1.1 s threaded, on every platform, with unchanged bodies and face tags.
3. **Then C:** COOP/COEP in the Capacitor scheme handler, tested on the iPad. If WebKit refuses
   isolation there, native threads on the iPad (B, iPad only) become the fallback worth reconsidering.
4. Revisit native only if a later profile shows OCCT-internal hot spots where native has a measured
   edge, or if we need something WASM can't give (more than 4 GB of memory, OCCT modules missing
   from the replicad build). For custom C++ helpers, our own opencascade.js build with extra bindings is
   the cheaper middle path. It keeps one WASM kernel for web, desktop and iPad.

No prototype is on this branch, because the measurements removed the reason for one: neither option A
nor option B speeds up the Mac. The branch adds the measuring tools instead, so the comparison can be
repeated, for example after D, or with a newer OCCT.

## Effort overview

| option | gain (Pi case) | effort | risk |
|---|---|---|---|
| A. Node-side WASM kernel (Mac) | none | 1–2 days | low |
| B. Native OCCT, Mac + iPad | ≈ 0–10 % per thread count; iPad threads | 3–5 weeks + upkeep | high: two kernels, native CI, licence |
| C. iPad threads via COOP/COEP | ≈ 1.4× rebuild, 3× mesh (iPad only) | 0.5–2 days | medium: WebKit may refuse isolation on a custom scheme |
| D. Pattern + thread algorithms | 1.8× rebuild (measured), everywhere | done | low: bodies and face tags unchanged |

## Reproducing

From `tests/`:

```
../node_modules/.bin/jiti bench/corpus.ts single|multi [stepDir]
../node_modules/.bin/jiti bench/snapshot.ts <out.json>     # bodies + face tags, diff before/after a change
../node_modules/.bin/jiti bench/native/record.ts "<part>.meercad" <recordDir>
../node_modules/.bin/jiti bench/native/replay.ts <recordDir> single|multi
brew install opencascade && bench/native/build.sh        # prints the binary path
<binary> <recordDir> [par]
```

For the browser numbers, serve `replicad_*.js/.wasm` and the record directory with COOP/COEP headers,
and run the same replay as `replay.ts` in a module worker. That page lives outside the repo and was not
committed.
