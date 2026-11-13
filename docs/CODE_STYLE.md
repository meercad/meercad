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
