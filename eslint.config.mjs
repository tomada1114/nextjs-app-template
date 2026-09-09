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
 * Each zone under `src/`, as every relative specifier that can reach into it.
 *
 * @remarks
 * This repository has no `@/*` path alias — `tsconfig.json` declares neither
 * `baseUrl` nor `paths` — so leaving your own zone always costs at least one
 * `../`, and the same module is `../ai/index` from one file and
 * `../../ai/index` from another. The globstar after the `../` absorbs the rest
 * whatever the importer's depth, so one pattern covers every caller; the bare
 * form is listed alongside the recursive one because a directory import
 * (`../ai`) has no trailing segment for a trailing globstar to match.
 *
 * The leading `../` is load-bearing, not decoration. An unanchored
 * `**\/server` also matches the package subpath `next-intl/server`, which
 * `src/i18n/request.ts` imports — the anchored form cannot, because a bare
 * specifier never starts with `..` or `.`.
 *
 * Each entry also carries a `./../**` twin of every `../**` pattern, because
 * `no-restricted-imports` matches the specifier text through the `ignore`
 * package rather than resolving it, and `ignore` treats a leading `./` as a
 * different string from a leading `../` — so `./../ai/errors` matches
 * neither the `../**\/ai/**` pattern nor the `!../**\/ai/index` exemption below
 * without its own `./../**` copy. A bare specifier still cannot start with
 * `./..`, so the twin is exactly as safe as the pattern it doubles.
 */
const ZONE = {
  app: ["../**/app", "../**/app/**", "./../**/app", "./../**/app/**"],
  server: ["../**/server", "../**/server/**", "./../**/server", "./../**/server/**"],
  ai: ["../**/ai", "../**/ai/**", "./../**/ai", "./../**/ai/**"],
  i18n: ["../**/i18n", "../**/i18n/**", "./../**/i18n", "./../**/i18n/**"],
};

/**
 * Every module inside the AI layer except the one it publishes.
 *
 * @remarks
 * An allow-list stated as a negation, so a module added under `src/ai/` is
 * private by default rather than private only once someone remembers to list
 * it. Order matters: both negations must follow both patterns they exempt,
 * because the last matching entry wins. The `./../**` twin exists for the
 * same reason as {@link ZONE}'s: `./../ai/errors` and `./../ai/index` are
 * invisible to the `../**` forms, so each needs its own pattern and its own
 * exemption.
 */
const AI_LAYER_PRIVATE = [
  "../**/ai/**",
  "./../**/ai/**",
  "!../**/ai/index",
  "!./../**/ai/index",
];

/** Why everything under `src/ai/` but its surface is off limits to a caller. */
const AI_LAYER_IS_PRIVATE =
  "src/ai/index.ts is the AI layer's whole surface. Everything else under src/ai/ — the port, the error vocabulary, every adapter — is private to the layer, and naming one from here is what makes the vendor choice leak out of src/server/composition.ts, which is the one file allowed to make it.";

/** Why the AI layer names no zone above it, stated by two blocks. */
const AI_LAYER_LOOKS_ONLY_DOWNWARD =
  "src/ai/ sits below src/server/ and src/app/ in the import order, and src/i18n/ is read by those two rather than by the port. A locale, a request, or a handler concern reaching in here is what stops the layer coming out in one piece — take it as an argument on the LlmPort call instead.";

/** Why a vendor SDK stops at the adapter that wraps it. */
const VENDOR_SDK_IS_AN_ADAPTERS_BUSINESS =
  "Only an adapter under src/ai/adapters/ talks to a vendor SDK. A request or a response crossing this zone is an LlmPort call, so the layer can be swapped — or removed whole — without touching src/app/ or src/server/.";

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
  // AGENTS.md states one import order — `app` → `server` → `ai` → `core`, with
  // `i18n` a leaf the page tree and the handlers read — and the six blocks below
  // are that order, written per zone as the zones each one may not name. The
  // leaf property is an edge like any other: `src/i18n/` may read `src/core/`
  // and nothing above it. On top of the order, `src/app/` and `src/server/`
  // reach the AI layer only through `src/ai/index.ts`.
  // `tests/boundaries.test.ts` asserts the same shape from the module graph, so
  // deleting a block here still fails the suite.
  //
  // `no-restricted-imports` options replace rather than merge across config
  // objects, exactly like `no-restricted-syntax` (see NO_EXPORT_STAR above).
  // The blocks match disjoint file sets on purpose, so none of them can silently
  // drop another's patterns — which is why `src/app` and `src/server` are stated
  // apart, and why the `src/ai` block excludes `src/ai/port.ts`, whose own block
  // restates what it still wants. Keep a new block disjoint from them too.
  {
    name: "boundaries/core-is-framework-free-and-imports-no-zone",
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
            {
              group: [...ZONE.ai, ...ZONE.server, ...ZONE.app, ...ZONE.i18n],
              message:
                "src/core/ is the bottom of the import order app → server → ai → core, so it names no zone above it. A type only one zone needs belongs in that zone; one they share belongs here, with nothing imported to define it.",
            },
          ],
        },
      ],
    },
  },
  {
    name: "boundaries/ai-imports-only-core",
    files: ["src/ai/**/*.ts", "src/ai/**/*.tsx"],
    // `src/ai/port.ts` has its own block below, which restates these patterns
    // alongside the adapter ban only the port carries.
    ignores: ["src/ai/port.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...ZONE.app, ...ZONE.server, ...ZONE.i18n],
              message: AI_LAYER_LOOKS_ONLY_DOWNWARD,
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
              // Unanchored on purpose: from the port the specifier is
              // `./adapters/…`, which no `../`-anchored pattern can match.
              group: ["**/adapters", "**/adapters/**"],
              message:
                "The port is the interface adapters implement, so it cannot depend on one. An import here inverts the dependency and makes the fake — or the next vendor — impossible to remove.",
            },
            {
              group: [...ZONE.app, ...ZONE.server, ...ZONE.i18n],
              message: AI_LAYER_LOOKS_ONLY_DOWNWARD,
            },
          ],
        },
      ],
    },
  },
  {
    name: "boundaries/i18n-is-a-leaf",
    files: ["src/i18n/**/*.ts", "src/i18n/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...ZONE.app, ...ZONE.server, ...ZONE.ai],
              message:
                "src/i18n/ is a leaf: the page tree and the handlers read it, and it reads nothing but src/core/ and its own catalogs. An import here inverts that and makes the locale list depend on the code that renders it.",
            },
          ],
        },
      ],
    },
  },
  {
    name: "boundaries/app-reaches-the-ai-layer-through-src-ai",
    files: ["src/app/**/*.ts", "src/app/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: AI_LAYER_PRIVATE,
              message: AI_LAYER_IS_PRIVATE,
            },
            {
              group: ANTHROPIC_SDK,
              message: VENDOR_SDK_IS_AN_ADAPTERS_BUSINESS,
            },
          ],
        },
      ],
    },
  },
  {
    name: "boundaries/server-reaches-ai-through-src-ai-and-never-app",
    files: ["src/server/**/*.ts", "src/server/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: AI_LAYER_PRIVATE,
              message: AI_LAYER_IS_PRIVATE,
            },
            {
              group: ANTHROPIC_SDK,
              message: VENDOR_SDK_IS_AN_ADAPTERS_BUSINESS,
            },
            {
              group: [...ZONE.app],
              message:
                "src/server/ sits below src/app/ in the import order app → server → ai → core. A handler or the composition root naming a page, a layout or a route module inverts that: the App Router tree imports the server layer, never the other way round.",
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
      // listed because a case whose whole assertion is type-level — see the
      // `type-testing` skill — has no runtime `expect` and is not meant to;
      // without it here, `expect-expect` would report such a case as
      // assertion-less.
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
