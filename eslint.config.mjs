import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import { defineConfig, globalIgnores } from "eslint/config";
import next from "eslint-config-next";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

/**
 * The `enum` ban, applied to every file this config sees.
 *
 * @remarks
 * `tsconfig.json` used to carry this as `erasableSyntaxOnly`, which existed
 * because `src/` had to run under Node's type stripping unbuilt. Next.js
 * compiles the tree instead, so the premise is gone and the ban is stated
 * here, where it can name the reason rather than a whole syntax class.
 */
const NO_ENUM = {
  selector: "TSEnumDeclaration",
  message:
    "`enum` emits a runtime object no other TypeScript construct needs. Use a union of string literals, or an `as const` object.",
};

/**
 * The `export *` ban, shared by the whole `src/` tree and by the extra
 * entry-point rules below.
 *
 * @remarks
 * `no-restricted-syntax` options replace rather than merge across config
 * objects, so every narrower block that sets this rule has to restate the
 * entries it still wants — otherwise it silently switches them back on.
 */
const NO_EXPORT_STAR = {
  selector: "ExportAllDeclaration",
  message:
    "`export *` publishes symbols implicitly. Re-export each public symbol by name.",
};

/** What `src/internal/**` is, in the words of the rule that made it private. */
const INTERNAL_IS_PRIVATE =
  'src/internal/ is private: see "Architecture" in AGENTS.md. Tests reach it through the public surface of the module that owns it (see the `writing-tests` skill), and repository automation must not depend on package internals at all.';

export default defineConfig([
  // Only generated trees are ignored; everything hand-written is linted,
  // including repository automation and config files. `.claude/skills/` is a
  // generated mirror of `.agents/skills/` (`pnpm agents:sync`), where the real
  // files are linted at their real path — linting the copy too would report
  // the same violation twice, at a path nobody may edit.
  // `.claude/worktrees/` holds full working copies created by agent sessions,
  // linted in their own checkout.
  // A `tests/fixtures/` file is malformed on purpose, so linting it reports
  // the very defect a test asserts on.
  // `.next/` and `next-env.d.ts` are written by `next dev`/`next build`.
  globalIgnores([
    "dist/",
    ".next/",
    "next-env.d.ts",
    "coverage/",
    ".claude/skills/",
    ".claude/worktrees/",
    "tests/fixtures/",
  ]),
  {
    linterOptions: {
      // A disable directive that no longer suppresses anything is dead weight
      // that hides the next real violation.
      reportUnusedDisableDirectives: "error",
    },
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          // `@ts-ignore` hides an error forever; `@ts-expect-error` fails once
          // the underlying problem is gone, so it is the only allowed escape
          // hatch and it must say why.
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          "ts-expect-error": "allow-with-description",
          minimumDescriptionLength: 10,
        },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "no-console": "error",
      "no-restricted-syntax": ["error", NO_ENUM],
    },
  },
  // `eslint-config-next` states its two rule blocks against `**/*`, which here
  // would also mean `scripts/**/*.mjs` and `tests/**/*.ts` — trees this
  // repository parses with typescript-eslint and lints with its own rules.
  // Narrow them to the tree the Next.js compiler owns. The config's third
  // entry has no `files` key (it is a global-ignores entry) and is taken as
  // published.
  ...next.map((entry) =>
    "files" in entry ? { ...entry, files: ["src/**/*.{ts,tsx}"] } : entry,
  ),
  {
    name: "next/pinned-react-version",
    files: ["src/**/*.{ts,tsx}"],
    settings: {
      // `eslint-config-next` asks eslint-plugin-react to *detect* the React
      // version, and that detection path calls an ESLint 9 context API that
      // ESLint 10 removed — every react/* rule throws while loading. Naming
      // the version skips detection entirely. Keep this in step with the
      // `react` major/minor in package.json, and drop it once
      // eslint-plugin-react declares eslint 10 in its peer range.
      react: { version: "19.2" },
    },
  },
  {
    name: "src/shared-syntax",
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": ["error", NO_ENUM, NO_EXPORT_STAR],

      // A `switch` over a union is the one place where adding a member to that
      // union silently changes behavior instead of failing to compile. With
      // `considerDefaultExhaustiveForUnions`, a `default` branch is accepted as
      // the deliberate answer, so this asks for a decision rather than for a
      // case per member.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
  },
  {
    name: "public-api/explicit-surface",
    files: ["src/**/*.ts", "src/**/*.tsx"],
    // Next.js finds a page, layout, loading/error boundary or route handler by
    // its file name and reads it through its default export, so `src/app/**`
    // is the one tree where a default export is the interface rather than an
    // unnamed hole in one. Everywhere else under `src/` the surface stays
    // named exports, which is what a reviewer can read a diff of.
    ignores: ["src/app/**"],
    rules: {
      "no-restricted-exports": [
        "error",
        {
          restrictDefaultExports: {
            direct: true,
            named: true,
            defaultFrom: true,
            namedFrom: true,
            namespaceFrom: true,
          },
        },
      ],
    },
  },
  {
    // Parked, not retired: `src/index.ts` no longer exists — the demo library
    // it fronted is gone — and issue #10 re-targets this at the zone entry
    // points. Deleting it here would lose the rule before its replacement
    // lands.
    name: "public-api/internal-stays-private",
    files: ["src/index.ts"],
    rules: {
      // src/index.ts is the whole published contract, so a re-export here is
      // the one edit that can publish a private symbol by accident. The
      // directory name is not the boundary — this line is.
      //
      // Anchored on the path segment, not on the bare word: an unanchored
      // /internal/ also matches a specifier that merely starts with those
      // letters, so a legitimate `./internal-format.js` re-export would be
      // rejected for a private directory it is not in. src/index.ts sits
      // beside the directory, so `./internal/` is the only spelling that can
      // reach it.
      "no-restricted-syntax": [
        "error",
        NO_ENUM,
        NO_EXPORT_STAR,
        {
          selector: "ExportNamedDeclaration[source.value=/^\\.\\/internal\\//]",
          message:
            "exporting an internal symbol publishes it — move it to a public module first",
        },
        {
          selector: "ExportAllDeclaration[source.value=/^\\.\\/internal\\//]",
          message:
            "exporting an internal symbol publishes it — move it to a public module first",
        },
      ],
    },
  },
  {
    name: "automation/node-scripts",
    files: ["scripts/**/*.mjs", ".agents/skills/**/*.mjs"],
    rules: {
      // These files are the CLI surface of repository automation.
      "no-console": "off",

      // Automation must run on plain Node before `pnpm install`, so it is
      // authored as `.mjs` and declares its boundary types in JSDoc, which
      // `checkJs` enforces just as strictly. This rule only recognises
      // TypeScript annotations, so leaving it on would demand syntax that is
      // not valid JavaScript.
      "@typescript-eslint/explicit-module-boundary-types": "off",
    },
  },
  {
    // The `writing-tests` skill states these rules in prose; this is what enforces the
    // ones a linter can see. The recommended set is taken as published and the
    // escalations below are the entries this repository will not run on
    // "warn", starting with the two that quietly shrink the suite.
    ...vitest.configs.recommended,
    name: "tests/vitest-rules",
    files: ["tests/**/*.ts", "tests/**/*.tsx"],
    rules: {
      ...vitest.configs.recommended.rules,

      // "No it.skip/it.todo left on main" and "a focused test never lands".
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "error",

      // An assertion outside a test reports nothing when it fails, and a test
      // with no assertion passes whatever the code does. `expectTypeOf` is
      // listed because tests/types.test.ts asserts entirely at compile time —
      // those tests have no runtime `expect` and are not meant to.
      "vitest/no-standalone-expect": "error",
      "vitest/expect-expect": [
        "error",
        { assertFunctionNames: ["expect", "expectTypeOf"] },
      ],
      "vitest/valid-expect": "error",

      // One spelling, so a search for a test finds every one of them.
      "vitest/consistent-test-it": ["error", { fn: "it" }],

      // `vitest/require-top-level-describe` is deliberately left off. Several
      // suites here own a fixture for the whole file — a temp git repository,
      // a packed tarball — and set it up in a file-level `beforeAll`, which
      // this rule forbids. Satisfying it would mean wrapping five whole files
      // in an extra describe for no gain in what the tests assert.
      //
      // `vitest/no-conditional-expect` comes from the recommended set and is
      // turned off for the same kind of reason: AGENTS.md prescribes
      // asserting on a caught error inside `catch`, and the workflow suite
      // branches on what the repository actually contains before asserting
      // against it.
      "vitest/no-conditional-expect": "off",
    },
  },
  {
    name: "tests/relaxations",
    files: ["tests/**/*.ts", "tests/**/*.tsx"],
    rules: {
      // Tests deliberately construct invalid input to prove it is rejected.
      "@typescript-eslint/no-confusing-void-expression": "off",
    },
  },
  {
    name: "boundaries/internal-is-not-importable",
    files: ["tests/**/*.ts", "tests/**/*.tsx", "scripts/**/*.mjs"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // Both trees: `src/internal` is the module, `dist/internal` is
              // the same module after a build, and neither is importable from
              // outside `src/**`.
              group: [
                "**/src/internal",
                "**/src/internal/**",
                "**/dist/internal",
                "**/dist/internal/**",
              ],
              message: INTERNAL_IS_PRIVATE,
            },
          ],
        },
      ],
    },
  },
  // Must stay last: turns off stylistic rules that would fight Prettier.
  eslintConfigPrettier,
]);
