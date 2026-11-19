# Code style

The code has to read well for people and for AI assistants alike. Two tools keep the layout the same
everywhere, so nobody has to think about it:

- `pnpm format` formats everything (Prettier, then the ESLint fixes, see `eslint.config.mjs`).
- `pnpm lint` checks it; CI runs it before the tests.

## What the tools enforce

- Lines are at most 110 characters long. Long strings may run over; comments may not
  (`node scripts/wrap-comments.mjs <files>` re-wraps them).
- A blank line follows every block that spans lines (`if`, `for`, `while`, `switch`, `try`,
  function) and stands before it.
- A blank line follows a guard clause (`if (…) return …;`); several guards in a row stay together.
- A blank line stands before `return` and `throw`, and before a declaration that follows other work.
- A body on its own line gets braces; `if (x) return;` may stay on one line.

## What the tools cannot check

- **Names say what a thing is.** `feature`, `entity`, `chordLength`, not `f`, `e`, `L`. Short names
  are fine where mathematics uses them: `a`, `b` for the two ends, `x`, `y`, `i`, `n`, `t` in a
  formula.
- **No formula twice.** Vector arithmetic goes through the helpers in `packages/sketch/src/geometry.ts`
  (`add2`, `sub2`, `dot2`, `distance2`, `midpoint2`, … and their `…3` counterparts) instead of being
  written out per component.
- **One function, one job.** A function that needs comments as section headings is several
  functions; give each step a name. Magic numbers get a named constant with a comment on its unit.
- **Comments say why**, in plain words, not what the next line does.

## Refactoring a calculating package

Behaviour must not change. Rename with the editor's rename (it follows scope), never with search and
replace. Where a formula is rewritten, keep the order of the operations: floating point results
differ otherwise. Run the package's tests after every step and `pnpm test:coverage` before a merge.
The test models in `tests/models` are never reformatted.

## Calculating files of the app are fully tested

A `.ts` file under `apps/web/src` that only computes (geometry, units, parsers, lookups: no React,
no app store, no kernel worker, no Capacitor plugin and no browser API such as `document`,
`localStorage` or `indexedDB` at run time) is a calculating file. `scripts/calculating.mjs` finds
them by those imports and globals, so a new one is caught without a list to keep:

- It needs a test file of its own next to it: `<name>.test.ts` (or `<name>.<topic>.test.ts`).
  `pnpm lint` fails otherwise (`node scripts/calculating.mjs --list` shows all of them).
- It needs 100 % of its lines, branches, functions and statements covered, on its own: `vitest.config.ts`
  sets that floor per file, and `pnpm test:coverage` fails below it.

Test the calculation with plain inputs and known answers, not through the UI. A branch no input can
reach is dead code: remove it (without changing behaviour) instead of excluding it from coverage. A
file that needs the store or the page belongs with the UI code, which the app's overall floor covers;
keep the formulas it uses in a calculating file of their own.
