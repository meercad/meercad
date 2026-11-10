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

Open: a build of OCCT of our own without the leak (would also help the iPad and halve the memory
of a first build), and building independent parts in several kernels at once when a design is
opened.

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
