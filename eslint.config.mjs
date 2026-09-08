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
  "src/internal/ is private. Tests reach it through the public surface of the module that owns it (see the `writing-tests` skill), and repository automation must not depend on module internals at all.";

/**
 * The Anthropic SDK, under every subpath it publishes.
 *
 * @remarks
 * `no-restricted-imports` matches the specifier as written and never resolves
 * it, so this ban holds before the package is a dependency and keeps holding
 * if it stops being one. That is what lets the zone boundaries below be
 * stated once, ahead of the adapter that will consume the SDK.
 */
const ANTHROPIC_SDK = ["@anthropic-ai/**"];

/**
 * Any module inside an `ai/adapters/` tree, however the importer spells the
 * way there.
 *
 * @remarks
 * This repository has no `@/*` path alias — `tsconfig.json` declares neither
 * `baseUrl` nor `paths` — so every intra-`src/` import is relative and the
 * same adapter is `../ai/adapters/fake/index` from one file and
 * `../../ai/adapters/fake/index` from another. A leading globstar absorbs any
 * number of `../` segments, so one pattern covers every depth rather than one
 * pattern per caller. The bare form is listed alongside the recursive one
 * because a directory import (`../ai/adapters`) has no trailing segment for a
 * trailing globstar to match.
 */
const AI_ADAPTER_MODULES = ["**/ai/adapters", "**/ai/adapters/**"];

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
    // unnamed hole in one. The other two entries are the same case one
    // directory over: Next.js loads `src/proxy.ts` by that exact path, and
    // `createNextIntlPlugin` in next.config.ts loads `src/i18n/request.ts` by
    // that exact path, both reading a default export — so the name is the
    // file's and the export cannot carry one. All three are framework-owned
    // entry points, named one by one; everywhere else under `src/` the surface
    // stays named exports, which is what a reviewer can read a diff of.
    ignores: ["src/app/**", "src/i18n/request.ts", "src/proxy.ts"],
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
    name: "src/size-budget",
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      // Blank lines and comments count, deliberately: the budget is on how
      // much a reader has to hold at once, and a file is not easier to follow
      // because two thirds of it is prose. 200 is a ceiling, not a target —
      // every module under `src/` is well under it today, so the rule fires
      // only on a file that grew past the point where it does one thing.
      // Splitting is the answer; raising the number or writing a disable
      // directive is what AGENTS.md's "never weaken a gate" rules out.
      //
      // `tests/**` and `scripts/**` are deliberately outside this: a table-
      // driven suite and a repository automation entry point are both long by
      // nature, and capping them would buy nothing but split files.
      "max-lines": ["error", { max: 200, skipBlankLines: false, skipComments: false }],
    },
  },
  // --- zone boundaries -------------------------------------------------------
  //
  // Four of `src/`'s zones — `core`, `ai`, `server`, `app` — have edges worth
  // stating, and those edges are what stop a later edit from collapsing them
  // back into one tree. The three blocks below state them;
  // `tests/boundaries.test.ts` asserts the same shape from the module graph, so
  // deleting a block here still fails the suite. `src/i18n/` carries no rule on
  // purpose: it is a leaf every other zone may read, so it has no edge to
  // protect.
  //
  // `no-restricted-imports` options replace rather than merge across config
  // objects, exactly like `no-restricted-syntax` (see NO_EXPORT_STAR above).
  // The three blocks match disjoint file sets on purpose, so none of them can
  // silently drop another's patterns; keep them disjoint when adding a fourth.
  {
    name: "boundaries/core-is-framework-free",
    files: ["src/core/**/*.ts", "src/core/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "next",
                "next/**",
                "react",
                "react/**",
                "react-dom",
                "react-dom/**",
                ...ANTHROPIC_SDK,
              ],
              message:
                "src/core/ holds the vocabulary the other zones are written in — a Result, a domain type, a pure function — and it stays free of the framework and of any vendor SDK so it survives a change of either. Put the framework-aware code in src/app/ or src/server/ and the vendor-aware code behind src/ai/.",
            },
          ],
        },
      ],
    },
  },
  {
    name: "boundaries/adapters-are-reached-through-src-ai",
    files: [
      "src/app/**/*.ts",
      "src/app/**/*.tsx",
      "src/server/**/*.ts",
      "src/server/**/*.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: AI_ADAPTER_MODULES,
              message:
                "src/ai/index.ts is the AI layer's whole surface. Importing an adapter directly is what makes the vendor choice leak out of src/server/composition.ts, which is the one file allowed to make it.",
            },
            {
              group: ANTHROPIC_SDK,
              message:
                "Only an adapter under src/ai/adapters/ talks to a vendor SDK. A request or a response crossing this zone is an LlmPort call, so the layer can be swapped — or removed whole — without touching src/app/ or src/server/.",
            },
          ],
        },
      ],
    },
  },
  {
    name: "boundaries/port-does-not-know-its-adapters",
    files: ["src/ai/port.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/adapters", "**/adapters/**"],
              message:
                "The port is the interface adapters implement, so it cannot depend on one. An import here inverts the dependency and makes the fake — or the next vendor — impossible to remove.",
            },
          ],
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
    name: "boundaries/private-trees-are-not-importable",
    files: ["tests/**/*.ts", "tests/**/*.tsx", "scripts/**/*.mjs"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // `dist/internal` used to be listed beside this: the same module
              // after a build, back when this repository published a tarball.
              // Nothing builds to `dist/` any more (issue #4 removed the
              // packaging gates), so the built spelling is gone and the source
              // one is the whole rule.
              group: ["**/src/internal", "**/src/internal/**"],
              message: INTERNAL_IS_PRIVATE,
            },
            {
              // The zone equivalent, for the trees outside `src/`: an adapter
              // is private to the AI layer, and a test asserts against it
              // through `src/ai/index.ts` — which is what makes the contract
              // suite in tests/ai-port.test.ts run unchanged against whichever
              // adapter src/ai/index.ts publishes.
              group: ["**/src/ai/adapters", "**/src/ai/adapters/**"],
              message:
                "src/ai/adapters/ is private to the AI layer: import what src/ai/index.ts publishes instead.",
            },
          ],
        },
      ],
    },
  },
  // Must stay last: turns off stylistic rules that would fight Prettier.
  eslintConfigPrettier,
]);
