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

  it("walks the whole src/ tree, not a subdirectory of it", () => {
    expect(sourceModules.map((module) => module.file)).toStrictEqual([
      "src/ai/adapters/anthropic/client.ts",
      "src/ai/adapters/anthropic/deadline.ts",
      "src/ai/adapters/anthropic/errors.ts",
      "src/ai/adapters/anthropic/index.ts",
      "src/ai/adapters/anthropic/request.ts",
      "src/ai/adapters/anthropic/retry-after.ts",
      "src/ai/adapters/fake/index.ts",
      "src/ai/errors.ts",
      "src/ai/index.ts",
      "src/ai/port.ts",
      "src/app/[locale]/layout.tsx",
      "src/app/[locale]/page.tsx",
      "src/app/api/ask/route.ts",
      "src/app/layout.tsx",
      "src/core/result.ts",
      "src/i18n/locales.ts",
      "src/i18n/messages.ts",
      "src/i18n/navigation.ts",
      "src/i18n/request.ts",
      "src/i18n/routing.ts",
      "src/proxy.ts",
      "src/server/composition.ts",
      "src/server/env.ts",
      "src/server/handlers/ask.ts",
    ]);
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
  it("imports no adapter directly", () => {
    const offenders = modulesIn("src/app", "src/server").flatMap((module) =>
      module.specifiers
        .filter((specifier) => importsAdapter(module.file, specifier))
        .map((specifier) => `${module.file}: ${specifier}`),
    );
    expect(offenders).toStrictEqual([]);
  });

  it("imports no vendor SDK", () => {
    const offenders = modulesIn("src/app", "src/server").flatMap((module) =>
      module.specifiers
        .filter((specifier) => importsPackage(specifier, "@anthropic-ai"))
        .map((specifier) => `${module.file}: ${specifier}`),
    );
    expect(offenders).toStrictEqual([]);
  });

  it("still reaches the AI layer, so the edges above are not vacuous", () => {
    const throughTheEntryPoint = modulesIn("src/app", "src/server").filter((module) =>
      module.specifiers.some(
        (specifier) => resolveWithin(module.file, specifier) === "src/ai/index",
      ),
    );
    expect(throughTheEntryPoint.map((module) => module.file)).toStrictEqual([
      "src/server/composition.ts",
      "src/server/handlers/ask.ts",
    ]);
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

/** The AI layer's whole surface, as a repo-relative module. */
const AI_SURFACE = "src/ai/index";

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
