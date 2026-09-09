import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// `eslint.config.mjs` states the zone edges as `no-restricted-imports`
// patterns; this file asserts the same edges from the module graph itself, so
// a rule deleted from that config still fails the suite. The two are checked
// independently on purpose — a boundary that only one layer holds is a
// boundary one edit removes.
//
// The scanner below is deliberately not a TypeScript parser, for the same
// reason `tests/workflows.test.ts` does not parse YAML: a parser would be a new
// dependency for a repository whose point is a small, reviewable dependency
// surface, and what is asserted here is the specifier *as written*, which is
// exactly what survives comment-stripping and nothing more.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// --- scanning ----------------------------------------------------------------

/**
 * Remove every comment, so a path named in TSDoc prose is not read as an
 * import.
 *
 * @remarks
 * Block comments go first: a `//` inside one would otherwise be treated as the
 * start of a line comment and swallow the rest of that line only, leaving the
 * comment's closing delimiter behind. Nothing under `src/` contains a `//`
 * inside a string literal today, and {@link SCANNER_CONTROL} pins the scanner's
 * output against a hand-written expectation so a source that did would show up
 * as a failure here rather than as a boundary silently going unchecked.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Every module specifier `source` imports, re-exports, or `import()`s.
 *
 * @remarks
 * The four spellings this repository can produce are covered in one pattern:
 * `from "x"` (a static import or a re-export), a side-effect `import "x"`, a
 * dynamic `import("x")`, and `require("x")`.
 */
function importSpecifiers(source: string): string[] {
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;
  return [...withoutComments(source).matchAll(pattern)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** Every `.ts`/`.tsx` file under `directory`, as repo-relative POSIX paths. */
function modulesUnder(directory: string): string[] {
  const absolute = path.join(repoRoot, directory);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return modulesUnder(relative);
    }
    return /\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

/** The repo-relative module a relative specifier names, or `undefined`. */
function resolveWithin(module: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  return path.posix.normalize(path.posix.join(path.posix.dirname(module), specifier));
}

/** Whether `specifier` reaches `pkg` — the package itself or any subpath. */
function importsPackage(specifier: string, pkg: string): boolean {
  return specifier === pkg || specifier.startsWith(`${pkg}/`);
}

/** Whether `specifier` reaches a module inside the AI layer's adapter tree. */
function importsAdapter(module: string, specifier: string): boolean {
  return resolveWithin(module, specifier)?.startsWith("src/ai/adapters/") === true;
}

interface Module {
  /** Repo-relative POSIX path, e.g. `src/server/handlers/ask.ts`. */
  readonly file: string;
  readonly specifiers: readonly string[];
}

const sourceModules: readonly Module[] = modulesUnder("src")
  .sort()
  .map((file) => ({
    file,
    specifiers: importSpecifiers(readFileSync(path.join(repoRoot, file), "utf8")),
  }));

function modulesIn(...zones: readonly string[]): Module[] {
  return sourceModules.filter((module) =>
    zones.some((zone) => module.file.startsWith(`${zone}/`)),
  );
}

// --- the scanner itself ------------------------------------------------------

// A boundary test whose scanner quietly finds nothing passes forever while
// enforcing nothing, so the scanner is pinned before the zones are asserted
// with it. Every case that could silence it is here: a specifier inside a
// block comment, one inside a line comment, and one inside an ordinary string.
const SCANNER_CONTROL = `
import defaultExport from "next";
import { named } from "../core/result";
import "./globals.css";
import type { OnlyAType } from "@anthropic-ai/sdk";
export { re } from "./errors";
const lazy = await import("../ai/index");
const legacy = require("node:fs");
const message = "imported from ../ai/adapters/fake/index by hand";
// import { commented } from "./line-comment-only";
/* import { blocked } from "./block-comment-only"; */
`;

/**
 * Modules the walk has to come back with, chosen for the shapes they cover.
 *
 * @remarks
 * A named subset rather than the whole tree: enumerating every module made the
 * suite fail on each legal new file, which teaches its reader to edit the
 * expectation. Each entry earns its place — three directories deep (the
 * recursion), a `.tsx` inside a bracketed segment (the extension filter and the
 * directory name), a zone holding exactly one module, a file at the root of
 * `src/`, and a nested module in the zone the surface rules are about. What the
 * exhaustive list was really standing in for — a scan that quietly found
 * nothing — is asserted directly by this and by the zone-coverage case below.
 */
const SCAN_ANCHORS = [
  "src/ai/adapters/fake/index.ts",
  "src/app/[locale]/page.tsx",
  "src/core/result.ts",
  "src/proxy.ts",
  "src/server/handlers/ask.ts",
];

describe("the import scanner the zone assertions run on", () => {
  it("finds every spelling of an import and nothing that only looks like one", () => {
    expect(importSpecifiers(SCANNER_CONTROL)).toStrictEqual([
      "next",
      "../core/result",
      "./globals.css",
      "@anthropic-ai/sdk",
      "./errors",
      "../ai/index",
      "node:fs",
    ]);
  });

  it.each([
    [
      "src/ai/adapters/fake/index.ts",
      ["zod", "../../../core/result", "../../errors", "../../port"],
    ],
    [
      "src/server/handlers/ask.ts",
      ["node:crypto", "zod", "../../ai/index", "../../i18n/locales"],
    ],
    ["src/app/api/ask/route.ts", ["../../../server/composition"]],
  ])("reads %s as %p", (file, expected) => {
    const module = sourceModules.find((candidate) => candidate.file === file);
    expect(module?.specifiers).toStrictEqual(expected);
  });

  it("reaches every anchor, so the walk is not stuck in a subdirectory of src/", () => {
    expect(sourceModules.map((module) => module.file)).toEqual(
      expect.arrayContaining(SCAN_ANCHORS),
    );
  });

  // `arrayContaining` above only proves presence: it would still pass if
  // `modulesUnder`'s `/\.tsx?$/` filter were dropped and every `.css` or
  // binary file under `src/` joined `sourceModules` too. This is the
  // assertion the old exhaustive `toStrictEqual` list stood in for — that the
  // filter actually excludes something — asserted directly instead of by
  // enumerating every file the walk must return.
  it("returns nothing but .ts and .tsx files", () => {
    expect(sourceModules.every((module) => /\.tsx?$/.test(module.file))).toBe(true);
  });

  it("resolves a relative specifier to the module it names", () => {
    expect(resolveWithin("src/server/handlers/ask.ts", "../../ai/index")).toBe(
      "src/ai/index",
    );
    expect(resolveWithin("src/ai/port.ts", "./adapters/fake/index")).toBe(
      "src/ai/adapters/fake/index",
    );
    expect(resolveWithin("src/core/result.ts", "next")).toBeUndefined();
  });
});

// --- the zone edges ----------------------------------------------------------

/**
 * Every zone under `src/`, and the zones a module in it may not import.
 *
 * @remarks
 * AGENTS.md's `app → server → ai → core` written as a table, with `i18n` the
 * leaf the page tree and the handlers read. A zone added to `src/` has to be
 * given a row here before this suite passes, which is the review the table
 * exists to force. `eslint.config.mjs` states the same edges as
 * `no-restricted-imports` groups; the two layers are checked independently, so
 * a rule deleted there still fails here.
 */
const FORBIDDEN_ZONE_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "src/ai": ["src/app", "src/i18n", "src/server"],
  "src/app": [],
  "src/core": ["src/ai", "src/app", "src/i18n", "src/server"],
  "src/i18n": ["src/ai", "src/app", "src/server"],
  "src/server": ["src/app"],
};

/** The AI layer's whole surface, as a repo-relative module. */
const AI_SURFACE = "src/ai/index";

/**
 * The only two spellings of that surface a caller outside the layer may use.
 *
 * @remarks
 * Derived from {@link AI_SURFACE} rather than typed again: the bare directory
 * import resolves to the same module, and `eslint.config.mjs`'s
 * `AI_LAYER_PRIVATE` leaves both alone, so the two layers have to agree on
 * exactly this pair.
 */
const AI_SURFACE_MODULES = [path.posix.dirname(AI_SURFACE), AI_SURFACE];

/** Whether `resolved` is `zone` itself or a module inside it. */
function inZone(resolved: string, zone: string): boolean {
  return resolved === zone || resolved.startsWith(`${zone}/`);
}

/**
 * `"<file>: <specifier>"` for every import crossing an edge the table forbids.
 *
 * @remarks
 * The module list is a parameter rather than {@link sourceModules} closed over,
 * so the checker can be driven with a synthetic module and proved to report as
 * well as to stay silent.
 */
function crossZoneOffenders(modules: readonly Module[]): string[] {
  return modules.flatMap((module) => {
    const zone = Object.keys(FORBIDDEN_ZONE_IMPORTS).find((candidate) =>
      inZone(module.file, candidate),
    );
    const forbidden = zone === undefined ? [] : (FORBIDDEN_ZONE_IMPORTS[zone] ?? []);
    return module.specifiers
      .filter((specifier) => {
        const resolved = resolveWithin(module.file, specifier);
        return (
          resolved !== undefined && forbidden.some((other) => inZone(resolved, other))
        );
      })
      .map((specifier) => `${module.file}: ${specifier}`);
  });
}

/** The same, for an AI-layer import that is not one of its surface spellings. */
function aiLayerBypasses(modules: readonly Module[]): string[] {
  return modules.flatMap((module) =>
    module.specifiers
      .filter((specifier) => {
        const resolved = resolveWithin(module.file, specifier);
        return (
          resolved !== undefined &&
          inZone(resolved, path.posix.dirname(AI_SURFACE)) &&
          !AI_SURFACE_MODULES.includes(resolved)
        );
      })
      .map((specifier) => `${module.file}: ${specifier}`),
  );
}

describe("src/ imports run one way, app → server → ai → core", () => {
  it("reaches every zone the table names", () => {
    const unscanned = Object.keys(FORBIDDEN_ZONE_IMPORTS).filter(
      (zone) => !sourceModules.some((module) => inZone(module.file, zone)),
    );
    expect(unscanned).toStrictEqual([]);
  });

  it("gives every zone under src/ a row, so a new one needs a decision", () => {
    const zones = readdirSync(path.join(repoRoot, "src"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `src/${entry.name}`)
      .sort();
    expect(zones).toStrictEqual(Object.keys(FORBIDDEN_ZONE_IMPORTS).sort());
  });

  it("keeps exactly one module at the root of src/, which belongs to no zone", () => {
    const atRoot = sourceModules
      .map((module) => module.file)
      .filter((file) => file.split("/").length === 2);
    expect(atRoot).toStrictEqual(["src/proxy.ts"]);
  });

  it.each(Object.entries(FORBIDDEN_ZONE_IMPORTS))(
    "leaves %s importing none of %p",
    (zone) => {
      expect(crossZoneOffenders(modulesIn(zone))).toStrictEqual([]);
    },
  );

  it("reports a crossing when there is one, so the rows above are not vacuous", () => {
    const offenders = crossZoneOffenders([
      {
        file: "src/core/probe.ts",
        specifiers: ["../server/env", "./result", "next"],
      },
    ]);
    expect(offenders).toStrictEqual(["src/core/probe.ts: ../server/env"]);
  });
});

describe("src/core/ is framework-free and vendor-free", () => {
  // The zone holds the vocabulary the other three are written in. A framework
  // or SDK import here makes that vocabulary un-reusable and un-testable
  // without the thing it imported.
  const forbidden = ["next", "react", "react-dom", "@anthropic-ai"];

  it.each(forbidden)("imports no %s", (pkg) => {
    const offenders = modulesIn("src/core").flatMap((module) =>
      module.specifiers
        .filter((specifier) => importsPackage(specifier, pkg))
        .map((specifier) => `${module.file}: ${specifier}`),
    );
    expect(offenders).toStrictEqual([]);
  });
});

describe("src/app/ and src/server/ reach the AI layer only through src/ai/index.ts", () => {
  it("names no module inside the layer but its surface", () => {
    expect(aiLayerBypasses(modulesIn("src/app", "src/server"))).toStrictEqual([]);
  });

  // The check above passes just as well if nothing under src/app/ or
  // src/server/ imports the AI layer at all — "names no module but its
  // surface" is vacuously true of an empty set. This asserts the real tree
  // actually exercises the surface, without pinning which file does: a
  // minimum count survives a legal refactor that moves the call between
  // src/server/composition.ts and src/server/handlers/ask.ts, where an
  // exhaustive file list would not.
  it("has at least one real src/app or src/server module reaching the AI surface", () => {
    const surfaceImporters = modulesIn("src/app", "src/server").filter((module) =>
      module.specifiers.some((specifier) => {
        const resolved = resolveWithin(module.file, specifier);
        return resolved !== undefined && AI_SURFACE_MODULES.includes(resolved);
      }),
    );
    expect(surfaceImporters.length).toBeGreaterThan(0);
  });

  it("reports a bypass when there is one, so the check above is not vacuous", () => {
    // Both legal spellings and both private ones in one module: this is what
    // pins the allow-list, and what keeps it agreeing with `AI_LAYER_PRIVATE`.
    const offenders = aiLayerBypasses([
      {
        file: "src/server/probe.ts",
        specifiers: [
          "../ai/index",
          "../ai",
          "../ai/errors",
          "../ai/adapters/fake/index",
        ],
      },
    ]);
    expect(offenders.sort()).toStrictEqual([
      "src/server/probe.ts: ../ai/adapters/fake/index",
      "src/server/probe.ts: ../ai/errors",
    ]);
  });

  it("imports no vendor SDK", () => {
    const offenders = modulesIn("src/app", "src/server").flatMap((module) =>
      module.specifiers
        .filter((specifier) => importsPackage(specifier, "@anthropic-ai"))
        .map((specifier) => `${module.file}: ${specifier}`),
    );
    expect(offenders).toStrictEqual([]);
  });
});

describe("src/ai/port.ts does not know its adapters", () => {
  it("imports nothing from src/ai/adapters/", () => {
    const port = sourceModules.find((module) => module.file === "src/ai/port.ts");
    expect(port).toBeDefined();
    const offenders = (port?.specifiers ?? []).filter((specifier) =>
      importsAdapter("src/ai/port.ts", specifier),
    );
    expect(offenders).toStrictEqual([]);
  });
});

// --- the composition root's access gate --------------------------------------

// `src/server/composition.ts` holds two declarations that have to agree:
// `ADAPTER_BILLS_A_PROVIDER`, which is what makes `readServerEnv` demand
// `API_ACCESS_KEY`, and the adapter it wires a few lines below. Nothing but the
// TSDoc on both held them together, so the documented one-line swap — fake
// adapter out, provider adapter in — could leave `POST /api/ask` open and
// billed. The two cannot be moved next to each other: the environment read has
// to sit between them, because a provider adapter is handed
// `env.ANTHROPIC_API_KEY`. So the agreement is asserted here instead.
//
// This lives in this file rather than beside the handler tests for two reasons.
// It reads a source file off disk with the scanner above, which is what this
// suite is and what puts it in `vitest.config.ts`'s `automation` project. And
// the zone edges asserted above are what make a name-based read sound at all:
// `src/server/` may not import an adapter directly and may not import a vendor
// SDK, so `src/ai/index.ts` is the only door a model call can come through, and
// which names composition.ts calls from that door is a real signal rather than
// a guess.

const COMPOSITION_ROOT = "src/server/composition.ts";

/**
 * Names `src/ai/index.ts` publishes that the composition root can call while
 * an answer still costs nobody anything.
 *
 * @remarks
 * The list is what makes the check below fail *closed*: every other name — a
 * provider adapter's factory, one that does not exist yet, or a helper nobody
 * has classified — reads as billing a provider. Adding a name here is a claim
 * that calling it bills no one, and is the deliberate act that says so.
 */
const NON_BILLING_AI_CALLS = new Set(["createFakeLlmPort"]);

const IMPORT_CLAUSE = /import\s*\{([^}]*)\}\s*from\s*["']([^"'\n]+)["']/g;

/** The value bindings `module` imports by name from the module `target`. */
function valueImportsOf(module: string, source: string, target: string): string[] {
  return [...withoutComments(source).matchAll(IMPORT_CLAUSE)].flatMap((match) => {
    const clause = match[1];
    const specifier = match[2];
    if (clause === undefined || specifier === undefined) {
      return [];
    }
    if (resolveWithin(module, specifier) !== target) {
      return [];
    }
    return (
      clause
        .split(",")
        .map((entry) => entry.trim())
        // `import { type X, y }` — a type-only binding is not something called.
        .filter((entry) => entry !== "" && !entry.startsWith("type "))
        // `a as b` binds `b`; a bare `a` binds itself.
        .map((entry) => {
          const parts = entry.split(/\s+as\s+/);
          return parts[1] ?? parts[0] ?? "";
        })
        .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
    );
  });
}

/** Whether `source` calls `name`, as opposed to merely importing it. */
function isCalled(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(withoutComments(source));
}

/**
 * Whether a composition root's text wires an adapter that bills a provider.
 *
 * @remarks
 * What it catches: the AI surface's factory names this file actually calls. A
 * source calling anything from `src/ai/index.ts` outside
 * {@link NON_BILLING_AI_CALLS}, and a source calling nothing from it at all,
 * both read as billed — an unrecognised wiring is treated as the expensive one.
 *
 * What it does not: this reads a name, never what the name does. A
 * `createFakeLlmPort` rewritten to proxy a real provider, or a paid call made
 * inline *beside* a still-wired fake adapter, would pass here. The zone edges
 * above narrow that considerably — reaching a provider needs either the vendor
 * SDK or an adapter module, and `src/server/` may import neither — but the
 * residue is real, and this assertion is a guard against the documented
 * one-line swap being made half-way, not a proof that no money can be spent.
 */
function wiresABilledAdapter(module: string, source: string): boolean {
  const called = valueImportsOf(module, source, AI_SURFACE).filter((name) =>
    isCalled(source, name),
  );
  return called.length === 0 || called.some((name) => !NON_BILLING_AI_CALLS.has(name));
}

/** The literal `name` is declared as, or `undefined` if it is not declared. */
function declaredBoolean(source: string, name: string): boolean | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(true|false)\\b`).exec(
    withoutComments(source),
  );
  return match?.[1] === undefined ? undefined : match[1] === "true";
}

const compositionSource = readFileSync(path.join(repoRoot, COMPOSITION_ROOT), "utf8");

describe("src/server/composition.ts declares the cost of the adapter it wires", () => {
  // The reader is pinned before it is trusted, the same way SCANNER_CONTROL
  // pins the import scanner: a classifier that quietly recognises nothing would
  // agree with a `false` flag forever. The first control is the exact edit this
  // assertion exists to stop — a provider adapter wired with the flag left
  // `false`.
  it.each([
    [
      "a provider adapter wired with the flag left false",
      `
        import { createAnthropicAdapter } from "../ai/index";
        import { readServerEnv } from "./env";
        const ADAPTER_BILLS_A_PROVIDER = false;
        const env = readServerEnv({ requiresAccessKey: ADAPTER_BILLS_A_PROVIDER });
        const llm = createAnthropicAdapter({ apiKey: env.ANTHROPIC_API_KEY });
      `,
      true,
      false,
    ],
    [
      "the fake adapter wired with the flag false",
      `
        import { createFakeLlmPort } from "../ai/index";
        const ADAPTER_BILLS_A_PROVIDER = false;
        const llm = createFakeLlmPort({ response: { answer: "x" } });
      `,
      false,
      false,
    ],
    [
      "a provider adapter wired with the flag flipped to true",
      `
        import { createAnthropicAdapter } from "../ai/index";
        const ADAPTER_BILLS_A_PROVIDER = true;
        const llm = createAnthropicAdapter({ apiKey: "" });
      `,
      true,
      true,
    ],
    [
      "an adapter imported under a different name, which is not recognised",
      `
        import { createFakeLlmPort as buildPort } from "../ai/index";
        const ADAPTER_BILLS_A_PROVIDER = false;
        const llm = buildPort({ response: { answer: "x" } });
      `,
      true,
      false,
    ],
    [
      "a factory named only in a comment, which is not a wiring",
      `
        import { createFakeLlmPort } from "../ai/index";
        // Swap in createAnthropicAdapter({ apiKey: env.ANTHROPIC_API_KEY }) here.
        const ADAPTER_BILLS_A_PROVIDER = false;
        const llm = createFakeLlmPort({ response: { answer: "x" } });
      `,
      false,
      false,
    ],
    [
      "nothing from the AI surface called at all",
      `
        const ADAPTER_BILLS_A_PROVIDER = false;
        const llm = { async ask() { return { ok: true }; } };
      `,
      true,
      false,
    ],
  ])("reads %s", (_case, source, billed, declared) => {
    expect(wiresABilledAdapter(COMPOSITION_ROOT, source)).toBe(billed);
    expect(declaredBoolean(source, "ADAPTER_BILLS_A_PROVIDER")).toBe(declared);
  });

  it("still declares the flag the environment read is gated on", () => {
    expect(declaredBoolean(compositionSource, "ADAPTER_BILLS_A_PROVIDER")).toBeTypeOf(
      "boolean",
    );
    expect(compositionSource).toContain(
      "readServerEnv({ requiresAccessKey: ADAPTER_BILLS_A_PROVIDER })",
    );
  });

  // The one that bites: wiring anything other than a recognised free adapter
  // while the flag stays `false` leaves `POST /api/ask` open on an endpoint
  // that costs money to answer, which is the whole of what issue #82 closes.
  it("declares ADAPTER_BILLS_A_PROVIDER true if and only if it wires a billed adapter", () => {
    expect(declaredBoolean(compositionSource, "ADAPTER_BILLS_A_PROVIDER")).toBe(
      wiresABilledAdapter(COMPOSITION_ROOT, compositionSource),
    );
  });
});
