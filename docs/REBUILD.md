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

OCCT (the prebuilt `replicad-opencascadejs` WebAssembly) never gives back part of the memory of a
cut, join or common: 130 to 230 KB for two boxes, about 1 MB per step of the robot. Deleting the
algorithm and its result does not help; it is inside the package
(`tests/bench/leak3.ts` shows it per call). The kernel can hold 4 GB.

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

The heap a kernel reports (`wasmMemory.buffer.byteLength`) is what it has reserved, not what it
uses: OCCT's allocator takes memory in large steps, so the same build reports 1.6 to 2.4 GB. Compare
the process (`footprint`, or the RSS in `heap.ts`) instead.

`tests/bench/open-memory.ts file [--threads] [--by-step]` gives the kernel heap of a first build and
the size of the meshes sent to the page (robot: meshes only 56 MB).

Open: a build of OCCT of our own without the leak. Native OCCT 7.9 (Homebrew) keeps nothing of a cut
or a meshing done 3000 times; the WebAssembly package keeps 250 KB per cut of two boxes and 20 KB per
meshed box. Also building independent parts in several kernels at once when a design is opened.

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
| `export-time.ts file` | export meshes part by part (cables apart), writing the 3MF |

Robot design, calls as an assistant makes them (fresh app):

| call | before | after |
|---|---|---|
| change a cut in one part (step 300) | 25.1 s | 0.8 s |
| change a cut late in the design (step 900) | 11.1 s | 0.2 s |
| change the servo template (step 3) | 31.8 s | 2.9 s |
| change one cable (45 cables on) | whole design | 1 step, 0.6 s |
| open the project | 28.3 s | 26.8 s |
| export 3MF again | 26.9 s | 13.1 s |
