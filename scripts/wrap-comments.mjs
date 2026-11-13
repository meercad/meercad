// Re-wraps comments that are longer than the line limit (run: node scripts/wrap-comments.mjs <files>).
// Prettier leaves comments alone, so `pnpm format` would stop at them. Only comments change: the
// script checks that the tokens of the file are the same before and after, and skips the file if not.
import { readFileSync, writeFileSync } from "node:fs";
import tseslint from "typescript-eslint";

const LIMIT = 110;
// Comments that tools read keep their exact place and wording.
const DIRECTIVE = /^\s*(eslint|@ts-|v8 |c8 |istanbul |prettier-|@vitest|#region|#endregion|\/ <reference)/;

function parseFile(source, file) {
  const options = { comment: true, tokens: true, loc: true, range: true, ecmaFeatures: { jsx: /x$/.test(file) } };

  return tseslint.parser.parseForESLint(source, options).ast;
}

function tokensOf(source, file) {
  return parseFile(source, file)
    .tokens.map((token) => `${token.type}:${token.value}`)
    .join("\u0000");
}

/** Breaks `text` into lines of at most `width` characters; a word longer than that gets a line of its own. */
function wrapWords(text, width) {
  const lines = [];
  let line = "";

  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }

  if (line) lines.push(line);

  return lines;
}

function wrapFile(file) {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  const comments = parseFile(source, file).comments;
  // Line index → replacement lines. Applied bottom-up so the indices above stay valid.
  const edits = new Map();

  for (const comment of comments) {
    if (DIRECTIVE.test(comment.value)) continue;

    const first = comment.loc.start.line - 1;
    const last = comment.loc.end.line - 1;
    const before = lines[first].slice(0, comment.loc.start.column);
    const after = lines[last].slice(comment.loc.end.column);
    const ownLines = before.trim() === "" && after.trim() === "";

    if (comment.type === "Line") {
      if (lines[first].length <= LIMIT) continue;

      if (ownLines) {
        const prefix = `${before}// `;

        edits.set(first, wrapWords(comment.value, LIMIT - prefix.length).map((text) => prefix + text));
      } else if (!/x$/.test(file) && before.trim() !== "") {
        // A trailing comment moves above its line.
        const indent = before.match(/^\s*/)[0];
        const prefix = `${indent}// `;
        const moved = wrapWords(comment.value, LIMIT - prefix.length).map((text) => prefix + text);

        edits.set(first, [...moved, before.trimEnd()]);
      }

      continue;
    }

    if (!ownLines) continue;

    const isDoc = comment.value.startsWith("*");

    if (first === last) {
      if (lines[first].length <= LIMIT) continue;

      const prefix = `${before} * `;
      const body = wrapWords(comment.value.replace(/^\*/, ""), LIMIT - prefix.length);

      edits.set(first, [`${before}/*${isDoc ? "*" : ""}`, ...body.map((text) => prefix + text), `${before} */`]);

      continue;
    }

    for (let index = first + 1; index < last; index++) {
      const match = lines[index].match(/^(\s*\*\s?)(\s*)(.*)$/);

      if (lines[index].length <= LIMIT || !match) continue;

      const [, star, inner, text] = match;
      // A list item or a tag keeps its hanging indent on the lines that follow.
      const hang = /^(- |\d+\. |@)/.test(text) ? "  " : "";
      const wrapped = wrapWords(text, LIMIT - star.length - inner.length - hang.length);

      edits.set(index, wrapped.map((part, n) => star + inner + (n ? hang : "") + part));
    }
  }

  if (edits.size === 0) return false;

  const result = [...lines];

  for (const index of [...edits.keys()].sort((a, b) => b - a)) result.splice(index, 1, ...edits.get(index));

  const output = result.join("\n");

  if (tokensOf(output, file) !== tokensOf(source, file)) {
    console.error(`skipped (the code would change): ${file}`);

    return false;
  }

  writeFileSync(file, output);

  return true;
}

let changed = 0;

for (const file of process.argv.slice(2)) changed += wrapFile(file) ? 1 : 0;

console.log(`${changed} file(s) re-wrapped`);
