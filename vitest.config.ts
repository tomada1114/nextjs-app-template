import { createRequire } from "node:module";
import path from "node:path";

import { defineConfig } from "vitest/config";

// Without this, a fixture suite written to fail is collected as one of this
// repository's own tests.
const fixtures = "tests/fixtures/**";

// Tests that import repository automation, touch the filesystem, spawn a
// subprocess, or use git. They are listed explicitly so a new test defaults to
// the short-timeout unit project until its I/O needs are deliberately reviewed.
// The files not listed here are pure unit tests; guard-rules.test.ts is the
// intentional exception to the usual `src/**` rule because it calls the guard
// engine's pure functions directly.
//
// The three boundary suites — ai-layer-removal, boundaries, placeholders —
// are listed for the same reason workflows.test.ts is: they assert against
// files on disk rather than against imported code, walking whole trees to do
// it. They are fast today, but their cost scales with the repository rather
// than with what they import, which is exactly the case the short unit budget
// is not meant to cover.
const automationTests = [
  "tests/ai-layer-removal.test.ts",
  "tests/boundaries.test.ts",
  "tests/check-staged.test.ts",
  "tests/ci-sync.test.ts",
  "tests/clean.test.ts",
  "tests/git-env.test.ts",
  "tests/labels.test.ts",
  "tests/messages.test.ts",
  "tests/node-tools.test.ts",
  "tests/placeholders.test.ts",
  "tests/server-env.test.ts",
  "tests/skills-frontmatter.test.ts",
  "tests/sync-agents.test.ts",
  "tests/sync-labels.test.ts",
  "tests/tooling-ignores.test.ts",
  "tests/workflows.test.ts",
];

// `server-only` is a build-time marker rather than a runtime module: its only
// entry throws on import, and a React Server Components bundler never loads it
// because the package's `react-server` export condition points at an empty
// file instead. Nothing outside such a bundler resolves that condition, so a
// test importing anything under `src/server/` would fail on the marker rather
// than on the behavior it asserts. Point the runner at the very file the RSC
// graph gets. Vite's own condition options do not reach it — the package is
// externalised and loaded by Node — and `server-only/empty.js` is not a
// subpath its `exports` map publishes, so the path is derived from the
// resolved entry instead. This narrows what the runner resolves; it turns no
// check off.
const serverOnlyEmptyModule = path.join(
  path.dirname(createRequire(import.meta.url).resolve("server-only")),
  "empty.js",
);

export default defineConfig({
  test: {
    environment: "node",
    alias: { "server-only": serverOnlyEmptyModule },
    server: {
      deps: {
        // `next` ships no `exports` map, so `next/server` — which
        // `next-intl/middleware` imports, and `proxy.ts` therefore reaches —
        // is only resolvable by a bundler's extension search, never by Node's
        // ESM resolver. Letting Vite transform `next-intl` rather than handing
        // it to Node is what makes that import resolve the way it does in a
        // real build. This changes who resolves the module, not what is
        // executed.
        inline: [/next-intl/],
      },
    },
    // Cleanup is the runner's job, not each test's. A spy, a stubbed env var or
    // a stubbed global that outlives the test that created it turns a later
    // failure into a mystery whose cause is in a different file, and makes the
    // "each test passes when run alone" rule in AGENTS.md unenforceable.
    restoreMocks: true,
    clearMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    // A focused test silently shrinks the suite to one case. Failing on it
    // everywhere — not only under CI, which is the default — means the author
    // finds it before the commit rather than the pipeline finding it after.
    allowOnly: false,
    // Three projects, split by what a test actually touches rather than by
    // where it lives: a new `.test.ts` file is unit by default, a `.test.tsx`
    // file needs a DOM and joins `component` instead, and the explicit
    // automation list receives the long budget only after its I/O needs are
    // known. A hung unit or component test (no I/O, so it can only be looping
    // or awaiting forever) is a bug that should be visible in seconds.
    // `coverage` below is unaffected by this split — Vitest collects and
    // thresholds coverage once for the whole run, never per project.
    //
    // `extends: true` is what carries `allowOnly: false` and the
    // restore/clear/unstub settings above into every project below; a
    // hand-written project object without it would silently drop them.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: [...automationTests, fixtures],
          testTimeout: 5_000,
          hookTimeout: 5_000,
        },
      },
      {
        extends: true,
        test: {
          name: "component",
          // A React Client Component needs `document`/`window` to render, so
          // this project alone runs under jsdom; `tests/**/*.test.ts` stays on
          // the faster `node` environment inherited from the top level. An
          // asynchronous Server Component is out of scope for both — see
          // `writing-tests`.
          environment: "jsdom",
          include: ["tests/**/*.test.tsx"],
          exclude: [fixtures],
          setupFiles: ["./tests/dom-setup.ts"],
          // No I/O here either: rendering a component and querying the
          // result is the same budget as a unit test.
          testTimeout: 5_000,
          hookTimeout: 5_000,
        },
      },
      {
        extends: true,
        test: {
          name: "automation",
          include: automationTests,
          // Repository automation tests shell out to git/node in temp
          // directories, which is slower than a unit test but must not be
          // allowed to hang CI.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "lcov"],
      // Report every source and automation file, so an untested module shows
      // up as 0% instead of vanishing from the denominator.
      include: ["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.mjs"],
      // No top-level lines/functions/statements/branches here: Vitest's v8
      // provider checks those against the coverage of *all* included files
      // combined (src and scripts together), which would let a well-tested
      // src/ subsidize an untested scripts/ file or vice versa. Each glob
      // below is its own independent threshold set instead, so the src/ zones,
      // scripts/**, and scripts/lib/guard/** are each judged only against
      // their own coverage.
      thresholds: {
        // The floor covers the zones whose code is this repository's own
        // logic. `src/app/**` and `src/components/**` are deliberately absent:
        // they are Next.js entry points and rendered markup, exercised by the
        // browser-level tooling issue #12 introduces rather than by a unit
        // test, and a floor they cannot meet would only teach the next author
        // to move the number. They stay inside `include` above, so they still
        // report as a percentage — they simply have no floor to trip. This is
        // a narrower threshold glob, not a `coverage.exclude` entry, which
        // AGENTS.md forbids by name.
        "src/{core,ai,server}/**": {
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 80,
        },
        // scripts/lib/guard/** is the credential/path-detection rule engine —
        // the most security-critical code in the repository — so it carries a
        // higher floor than the rest of scripts/**. Measured baseline at the
        // time this floor was set: 90.9% statements, 82.35% branches, 100%
        // functions, 90% lines. Each value below is that measurement rounded
        // down to the nearest multiple of 5.
        "scripts/lib/guard/**": {
          lines: 90,
          functions: 100,
          statements: 90,
          branches: 80,
        },
        // Last raised by issue #98 against a measured baseline of 88.52%
        // statements, 80.05% branches, 93.79% functions and 88.48% lines,
        // each rounded down to the nearest multiple of 5 — the convention
        // every raise here has used (#44, #88, #98). Three of the scripts
        // that baseline was measured over have since left the tree with the
        // packaging gates (issue #4); the floor is deliberately left where it
        // was rather than re-fitted to whatever the smaller tree now scores.
        // It exists so a new automation script can't ship with zero tests and
        // nothing reporting the number moving; scripts/lib/guard/** also
        // counts toward this aggregate, on top of its own stricter floor
        // above.
        "scripts/**": {
          lines: 85,
          functions: 90,
          statements: 85,
          branches: 80,
        },
      },
    },
  },
});
