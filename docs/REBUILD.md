# Rebuilding big designs

How a change to a design of a thousand steps and several hundred parts is rebuilt in a second or
two, and what keeps a long session alive. Measured on a robot design of 1127 steps and 558 parts
(2026-11-10, Mac, 16 cores).

## Only what a change touches is built again

The engine (`packages/model/src/rebuild.ts`) keeps every step's state. After a change, the steps
before it come from the cache as before. Every later step is asked whether it can keep its earlier
result (`Footprint.replay`): it can when its own definition is unchanged and everything it read of
the state before it is the very same object as then. Parts are never changed once made, so
identity is a safe test.

What a step reads is noted while it runs (`packages/kernel/src/tracking.ts`):

- Entries it looks up in one of the state's maps (parts, sketches, planes, …) by key.
- Questions it puts to all parts (`ask`, used through `packages/kernel/src/lookup.ts`): which
  parts carry this face name, which parts reach into this box. On the new state the question is
  asked again; the step is kept when the answer is the same. Without this, every hole, rounding and
  untargeted cut counted as having read all parts and was built again after any change.
- Going through a whole map any other way still counts as reading all of it.

Two more things keep a change from spreading:

- A cut that takes nothing away returns the part it was given (`booleanBodies`), not an equal new
  one. A through hole reaches into the boxes of many parts it never touches.
- A step that moves or copies many parts keeps the parts it does not have to move again
  (`transformBody`, `KernelBackend.execute`'s `earlier`). The new state then owns the earlier
  state's objects (`Arena.adopt`).

A part that is the same object keeps its display mesh (`KernelSession`), is not sent to the page
again (`KeptMesh`), keeps its buffers in the view (`Viewport.rebuildBodies`) and its export mesh
(`exportMeshes`).

Previews (`fork`) take results over the same way and never change the cache.

`tests/acceptance/incremental.test.ts` (quick) and `incremental-all.test.ts` (every corpus file and
test model) change each step in turn and compare with a build from scratch.

## The kernel's memory

**Since 2026-11-13 the kernel gives memory back** (`replicad-opencascadejs` 1.2.1). What follows in
this chapter was written while it did not, and the measures it describes stay as a safety net.

What was wrong: in the package up to 1.1.0 `delete()` did nothing for most classes. The function
the bindings call to destroy a `gp_Pnt`, a `TopoDS_Shape`, a `BRepPrimAPI_MakeBox` or a
`BRepAlgoAPI_Cut` was one empty function (340 entries of the function table pointed to it; found by
calling `delete()` with the table watched and reading that function's body in the .wasm: `00 0b`).
A shape "deleted" in JavaScript kept its reference, so nothing of a cut was ever freed: not the
algorithm, not its arguments, not the result. That was the "leak inside the package" below, and why
native OCCT showed none. 1.2.1 has real destructors (upstream issue 282, with a test of its own).

Robot design (a copy, 1180 steps, 58 MB file), first build:

| | 1.1.0 | 1.2.1 |
|---|---|---|
| kernel heap after the build (Mac, no threads) | 1079 MB | 207 MB |
| peak footprint of the process (`open-memory.ts`) | 1.65 GB | 1.0 GB |
| two boxes cut, kept per call (`leak3.ts`) | 235 KB | 0 |
| iPhone simulator: web process, growth while opening | 1.37 GB | 0.48 GB |

The iPhone ends the page at about 1.6 GB above its idle size, so the robot sat at 86 % of that and
is now at 30 %. The result is the same (570 parts, the same triangles and face names); the quick
tests and the slow comparison of every corpus file and test model pass. With destructors that work,
using an object after `delete()` is now a real error (before it went unnoticed): the arenas free a
step's working objects (`Arena.trim`) and keep its shapes, which is safe because a shape holds what
it needs itself. `packages/kernel/src/arena-occt.test.ts` keeps 1500 cuts from growing the heap.

With threads the first build still takes 1.8 GB against 1.0 GB (each thread has memory of its own)
and 22 s against 32 s on the Mac: big designs stay without threads on the iPad and iPhone.

### How it was before

OCCT (the prebuilt `replicad-opencascadejs` WebAssembly) never gave back part of the memory of a
cut, join or common: 130 to 230 KB for two boxes, about 1 MB per step of the robot. Deleting the
algorithm and its result did not help (see above for why;
`tests/bench/leak3.ts` shows it per call). The kernel can hold 4 GB.

Before this work a small change built 200 to 500 steps again, about 500 MB lost each time: after
some five changes the kernel broke, was replaced by a single-threaded one and built everything
again, which is where calls of several minutes came from.

What is done about it:

- Far fewer steps are built again (above), so a change loses some 20 MB.
- A finished step's working objects are freed at once and only its shapes are kept
  (`Arena.trim`).
- Each rebuild reports the kernel's memory (`RebuildReport.kernelMemory`). On the Mac, once it is
  above 2.6 GB and has grown by 600 MB, a second worker builds the open design in the background and
  takes over between two requests (`Renewal` in `packages/kernel/src/client.ts`). A kernel that
  breaks while nearly full is replaced by one of the same kind, not by the single-threaded one.
  The iPad has no room for two kernels and keeps the old behaviour.

### iPad and iPhone: one big kernel at a time

The page of the iOS app is ended by the system once it grows past a few GB, and the app then loads
again: "dies when Emil is opened" (2026-11-10). Measured in the iPad simulator with the robot design
(footprint of the web process): the overview alone went to 2.6 GB, opening the design right after
start to over 4 GB. The overview was building the design in its background kernel for a picture
(pictures are kept per device, so every change on the Mac asks for a new one there) while the editor
built it once more in its own, 1.5 GB each.

So on the iPad and iPhone (`oneKernel` in `apps/web/src/lib/thumbnails.ts`):

- The overview builds a design for its picture only while no project is open, and only when it has
  at most `BIG_STEPS` (300) steps; a bigger one gets its picture from the editor when it is opened.
- Opening a project stops waiting for a picture (it is tried again later, not marked as failed).
- Before the editor builds another design, a kernel still holding more than 600 MB starts over
  fresh (`KernelClient.restartIfAbove`); the same design again, back from the overview, keeps it.

Same steps afterwards (fresh install, opening the design 20 s after start): 2.1 GB at most instead
of 4.1 GB, the design shown in full.

That was not enough on a real iPhone (2026-11-11, robot then 1062 steps in a 42 MB file): it broke
off at the end and loaded again, over and over. Two more things grew the page:

- **Threads.** Each OCCT thread keeps memory of its own: the robot took 1.9 to 2.3 GB in the
  threaded kernel and 1.1 GB without threads, in about the same time on the Mac (37 s against
  27 to 40 s; meshing is faster with threads, the cuts are not). On the iPad and iPhone a design of
  more than `BIG_STEPS` steps is built without threads (`kernelKindFor` in `pictureState.ts`; the
  editor's kernel is swapped when such a design is opened, `KernelClient.restart`).
- **Reading the file.** The Filesystem plugin hands a file over as one escaped string in a message;
  for 42 MB the page held several copies at once. Projects are now read by the web view itself
  (`fetch` of `Capacitor.convertFileSrc`, `readDoc` in `native.ts`), and the overview does not read
  files over 8 MB at all for a picture (`BIG_FILE_BYTES`).

iPhone simulator, opening the robot 20 s after a fresh start: 2.3 to 2.5 GB before, 1.6 GB after.

On the real iPhone the app then went round in circles already in the overview: a second kernel for
a picture, even of a box of 7 steps, took the page down (OCCT takes memory in blocks of up to a GB:
that box with a shell and three roundings goes from 100 MB to over 1 GB of kernel heap), the page
loaded again and wanted the same picture. On the iPad and iPhone there is now never a second kernel:
pictures are built in the editor's own kernel while no project is open, which starts over once they
have taken 600 MB (`freshKernelIfAbove`), and a picture whose build took the page down is not tried
again until its file changes (`meercad.picture-building` in the web storage).

What finally let the robot open on the iPhone (measured there with a debug build over Wi-Fi; the
app's console comes with `xcrun devicectl device process launch --console`):

- **The limit.** The page is ended at about 1.6 GB above its idle size (an iPhone 18 Pro Max with
  12 GB; found by filling memory until it died). There is no crash report for it.
- **Growing memory is copied.** A WebAssembly memory that grows is copied on the iPhone, so at 1 GB
  it is there twice for a moment. The kernel without threads now takes 1.5 GB at once while it is
  small (`reserveHeap`, worker name "kernel-reserve"); memory not written to costs nothing
  (measured: the full 1.55 GB stayed free). The build then ran through every time.
- **Wrapper objects.** After that the robot sat 50 MB below the limit. Half a GB of the kernel
  worker was JavaScript: every state kept the shape wrappers its explorers had handed out, 2 million
  objects of which 1.5 million were never used again. `Body` now frees them at once: 540 MB to
  283 MB of JavaScript, 390 MB less for the process (`tests/bench/kernel-objects.ts`). This helps
  the Mac as well.
- **Edges only when asked for.** A long design keeps every step's parts, and a part cut thirty
  times is there thirty times: the robot kept 141 000 faces and 346 000 edges, its final parts have
  10 000 and 22 000. `Body` now works out its edges, their index and the faces at each edge when
  first asked (few parts ever are), and the shape index is a number per shape: 283 MB to 143 MB of
  JavaScript. All in all the process needs 1.29 GB for the robot instead of 1.95 GB.
- **One result at a time.** A big design's last result is not kept for its next opening on the
  iPad and iPhone (`keepsOutput` in the store): shown first and then replaced, both were in memory.
- After all this the iPhone showed the robot in full with 250 MB to spare.
- **iCloud.** Opening waited for the newest version of a file the Mac kept saving, 30 s, and then
  failed. A file that is on the device in an older version now opens as it is (`ICloudPlugin`), and
  reading shows as a task ("Opening …").

A day later (2026-11-12) the robot had grown to 1169 steps (53 MB) and went round in circles on
the iPhone again. On the Mac its first build now takes 1.49 GB (peak footprint, `open-memory.ts`)
against 1.39 GB for the 1112 steps of the afternoon before: about 1.7 MB per step, which ate the
250 MB to spare. Tried and dropped: a lean build that keeps no step's result and frees what later
steps no longer use while building. It gave the same result (every step and part) but no less
memory (1.28 against 1.26 GB): what the kernel holds is OCCT's own leak, not the kept steps. Only an
OCCT build of our own helps here (see below). What was fixed instead:

- **The circle.** The page loaded again after it was ended and opened the same design from its
  address, which ended it again. The big design being opened is noted (`meercad.opening`) until its
  first build shows; a page that finds it still noted at start shows the overview and says the
  design did not fit (`openingDied` in the store, `route(true)` in `App.tsx`). A tap tries again.
- **Two taps.** A second tap while the file was still being read opened it a second time (two
  "Opening …" tasks, the file read and built twice). `openProject` now joins the opening under way.

The heap a kernel reports (`wasmMemory.buffer.byteLength`) is what it has reserved, not what it
uses: OCCT's allocator takes memory in large steps, so the same build reports 1.6 to 2.4 GB. Compare
the process (`footprint`, or the RSS in `heap.ts`) instead.

`tests/bench/open-memory.ts file [--threads] [--by-step]` gives the kernel heap of a first build and
the size of the meshes sent to the page (robot: meshes only 56 MB).

The build of OCCT of our own that was planned here is not needed for memory any more (see the top
of this chapter). Still open for the time a first build takes: building independent parts in
several kernels at once when a design is opened.

With the memory back, a big design's last result is kept for its next opening on the iPad and
iPhone as well (`showKeptOutput` in the store): an unchanged design shows at once while the kernel
builds it.

## Copies of a part share its mesh

A design with a mirrored half, or the same part in many places, meshed every copy anew: of the
robot's 570 parts 503 are another part moved, turned or mirrored, from 199 first parts. A part made
by `transformBody` without scaling, whose faces come in the same order, knows the first part of its
chain and the way from there (`Body.copyOf`). Its display mesh is then that part's mesh moved the
same way (`CopyMeshes` in `packages/kernel/src/copymesh.ts`): the same triangles, turned round for
a mirrored copy so they face outwards, with the copy's own face names. Nothing gets coarser: the
tolerance follows the size of a part's box, which changes when a part is turned, so new parts are
meshed finest first and a copy takes a mesh only when it is at least as fine as its own would be.
A copy that is changed afterwards is an ordinary part again.

Robot: meshing 12.1 s to 8.6 s of a first build (329 of 570 meshes taken over in 8 ms; the 241
meshed ones are the costly ones). `tests/bench/copy-meshes.ts file` holds every such mesh against
the mesh the part gets alone (faces, edges, names, which way the triangles face): no difference in
the robot's 528 parts concerned; `tests/acceptance/copy-meshes.test.ts` does it for small designs.

## After the kernel breaks: back to all cores

On the Mac the kernel is the multi-threaded OCCT build: booleans run on all cores. When OCCT breaks
on a model, a single-threaded kernel answers the request again (it copes with more). Until
2026-11-14 that kernel then stayed until the app was restarted, and every later change ran on one
core. The XGO head (a loft of 12 polygons of 99 lines, 9 booleans on it, 45 cut holes) shows the
cost: the union of the lip took 5 s on all cores and 53 s on one, a whole build 23 s against
about 90 s. Exports themselves take 0.4 s (one part) to 2 s (3MF), but wait for the build before
them, so after one break every change plus export took minutes.

Now the single-threaded kernel only answers the request that broke the other one. Then a
multi-threaded kernel builds the design in the background and takes over between two requests, as
a Renewal does (`KernelClient.backToThreads`). If that one breaks on the design too, the
single-threaded kernel stays; after two such returns it stays for good.

XGO head in the real app (`tests/bench/app-kernel-break.ts`, change of the lip, step 56 of 143):

| | change | export STL (hood) |
|---|---|---|
| before the break | 23.9 s | 0.4 s |
| right after (single-threaded) | 86.0 s | 3.1 s |
| after the take-over (20 s later) | 22.2 s | 0.4 s |

What broke it there: `check_interference` with the imported STL (30,000 triangles, one face each)
against the hood. The gap alone took 63 s, the shared volume broke OCCT, and in the app the check
stood 12 minutes first. Imported meshes with more than 2,000 faces (`FINE_MESH_FACES`) are now left
out of the pairs and named (`meshesNotChecked`, a notice in the app).

## For assistants (MCP)

- `open_project` answers with counts and what is not in order (830 characters instead of 112 000);
  `get_model` has the rest.
- Saving, renaming or deleting a version answers at once, without waiting for a rebuild.
- Brief answers no longer list suppressed steps the ops were not about (`featuresOff` counts them).
- `check_interference` takes `parts`, `box` and `seconds`; what is not checked in time is counted.
- `check_motion` checks every pair at the first pose and after that only pairs that moved against
  each other.
- Every call may wait behind a running rebuild instead of giving up after 60 s.
- A tab without requests goes back to the user after 30 minutes (was 10).

## Measuring

All in `tests/bench/`, run from `tests/` with `../node_modules/.bin/jiti bench/<name>.ts`:

| script | what |
|---|---|
| `app-mcp.ts file ids…` | an assistant's calls in the real app (a private copy): open, edits, version, export, checks |
| `app-renew.ts file ids…` | the fresh kernel taking over in the real app |
| `app-open.ts file ids…` | opening and editing as a user |
| `incremental.ts file ids…` | edits in the kernel, each compared with a build from scratch |
| `why.ts file id` | which steps a change builds again, and what they had read that changed |
| `feature-times.ts file` | time by kind of step |
| `heap.ts`, `leak.ts`, `leak2.ts`, `leak3.ts` | kernel memory over edits, and per kernel call |
| `mesh-density.ts file` | triangles and meshing time at several tolerances |
| `mesh-breakdown.ts file` | meshing time part by part, and how much of it goes into copies |
| `copy-meshes.ts file` | meshes taken over by copies against meshes made alone |
| `export-time.ts file` | export meshes part by part, writing the 3MF |
| `app-kernel-break.ts file id` | a change and an export in the real app before a kernel break, right after, and after the take-over |
| `boolean-options.ts file id` | one boolean step with OCCT's options (oriented boxes) switched |
| `pair-time.ts file a b` | gap and shared volume of two parts, as the interference check computes them |

Robot design, calls as an assistant makes them (fresh app):

| call | before | after |
|---|---|---|
| change a cut in one part (step 300) | 25.1 s | 0.8 s |
| change a cut late in the design (step 900) | 11.1 s | 0.2 s |
| change the servo template (step 3) | 31.8 s | 2.9 s |
| change one cable (45 cables on) | whole design | 1 step, 0.6 s |
| open the project | 28.3 s | 26.8 s |
| export 3MF again | 26.9 s | 13.1 s |
