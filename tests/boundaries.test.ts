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
    ["src/server/handlers/ask.ts", ["zod", "../../ai/index", "../../i18n/locales"]],
    ["src/app/api/ask/route.ts", ["../../../server/composition"]],
  ])("reads %s as %p", (file, expected) => {
    const module = sourceModules.find((candidate) => candidate.file === file);
    expect(module?.specifiers).toStrictEqual(expected);
  });

  it("walks the whole src/ tree, not a subdirectory of it", () => {
    expect(sourceModules.map((module) => module.file)).toStrictEqual([
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
