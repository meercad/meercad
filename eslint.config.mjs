// Readability rules that keep the code laid out the same way everywhere (run: pnpm lint).
// Prettier owns line breaks and spacing inside a statement (pnpm format); these rules own the
// structure around statements: blank lines between logical steps and braces around wrapped bodies.
import stylistic from "@stylistic/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const BLANK_LINES = [
  // After a guard clause the next step starts apart; a run of one-line guards may stay together.
  { blankLine: "always", prev: "if", next: "*" },
  { blankLine: "any", prev: "if", next: "if" },
  // A declaration after other work starts a new step; declarations in a row stay together.
  { blankLine: "always", prev: "*", next: ["const", "let"] },
  { blankLine: "any", prev: ["const", "let"], next: ["const", "let"] },
  // The result of a function stands apart from the work before it.
  { blankLine: "always", prev: "*", next: ["return", "throw"] },
  { blankLine: "always", prev: "import", next: "*" },
  { blankLine: "any", prev: "import", next: "import" },
  // A block that spans lines (if/for/while/switch/try/function) has a blank line before and after it.
  { blankLine: "always", prev: "*", next: "multiline-block-like" },
  { blankLine: "always", prev: "multiline-block-like", next: "*" },
  // `case` labels follow each other directly.
  { blankLine: "any", prev: ["case", "default"], next: ["case", "default"] },
];

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "apps/ios/ios/**",
      "apps/web/public/**",
      ".claude/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx,mjs,js}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    // The last two are registered for the `eslint-disable` comments in the code; their rules are not switched on.
    plugins: { "@stylistic": stylistic, "@typescript-eslint": tseslint.plugin, "react-hooks": reactHooks },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "@stylistic/padding-line-between-statements": ["error", ...BLANK_LINES],
      "@stylistic/lines-between-class-members": ["error", "always", { exceptAfterSingleLine: true }],
      // `if (x) return;` may stay on one line; a body on its own line gets braces.
      curly: ["error", "multi-line", "consistent"],
      "@stylistic/max-len": [
        "error",
        {
          code: 110,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
          ignoreComments: false,
        },
      ],
    },
  },
];
