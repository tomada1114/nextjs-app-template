import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Not every app built from this template wants a language model in it, so the
// AI layer has to come out in one piece: delete `src/ai/`, the handlers that
// depend on it, the environment key, the skill that documents it and the
// matching `.env.example` lines, and the repository that remains must still
// build, lint, and test — with nothing left pointing at what was removed.
//
// `scripts/bootstrap.mjs` used to assert exactly this, through an
// `AI_LAYER_TARGETS` list and a dangling-reference scan over the tree it was
// about to generate. Issue #3 deleted that script, and the property went with
// it. The idea is worth keeping and the implementation is not — it was
// profile-driven and self-deleting — so it is rebuilt here as a test over the
// real tree.
//
// What makes the property checkable without actually deleting anything: the
// removal set is named, and everything that mentions it is named too. A file
// that starts referring to the AI layer without joining one of those two lists
// fails this suite, which is the moment the layer stops being removable.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Everything the removal deletes outright.
 *
 * @remarks
 * `src/server/composition.ts` is on the list because wiring an `LlmPort` is
 * the whole of what it does; if this template ever grows a second thing to
 * compose, that file splits rather than staying half-deleted here. This test
 * file is on the list too — it names every path above and would itself be the
 * first dangling reference left behind.
 */
const REMOVED_PATHS = [
  "src/ai",
  "src/app/api",
  "src/server/composition.ts",
  "src/server/handlers/ask.ts",
  "tests/ai-layer-removal.test.ts",
  "tests/ai-port.test.ts",
  "tests/server-handler.test.ts",
];

/**
 * Paths the removal deletes when they exist.
 *
 * @remarks
 * The `integrating-llm` skill and its generated mirror are issue #16's to
 * write. Listing them now means the removal set is already complete when they
 * land, instead of silently missing them; until then they contribute nothing.
 */
const OPTIONAL_REMOVED_PATHS = [
  ".agents/skills/integrating-llm",
  ".claude/skills/integrating-llm",
];

/**
 * Strings that name the AI layer without naming one of its paths.
 *
 * @remarks
 * Both are deliberately specific. `Anthropic` on its own would match
 * `scripts/lib/guard/credentials.mjs`, whose `sk-ant-` rule detects a leaked
 * key and stays whether or not this application calls a model.
 */
const AI_LAYER_TOKENS = ["ANTHROPIC_API_KEY", "@anthropic-ai"];

/**
 * Files that survive the removal but have to be edited by it.
 *
 * @remarks
 * Every entry is a file whose subject is the repository rather than the
 * application: the two gate configs, the two boundary tests that assert
 * against the AI layer's shape, the environment schema and its example, and
 * the documents that describe the layer to a reader — AGENTS.md's Architecture
 * section, the README's description of the one route, the `starting-an-app`
 * skill, which carries the removal procedure and so names the removal set in
 * prose, `building-app-routes`, which teaches the Route Handler pattern
 * through the one endpoint this template ships, `localizing-ui`, which owns
 * the one mapping from a UI locale to the port's `outputLanguage`, and
 * `writing-typescript`, `designing-errors`, `writing-tests` and `type-testing`,
 * which illustrate rules that outlive the layer with worked examples drawn from
 * it — the port contract suite and the handler test as the seams a test is
 * written through, and the port's generic request/response types as what a
 * compile-time assertion is worth making about. This list existing — and being
 * short — is the property: an app-level module that had to be edited here would
 * mean the layer is no longer separable.
 *
 * Each skill's `.claude/skills/` copy is listed too because it is a real
 * committed file, but it is never hand-edited: the removal edits the
 * `.agents/` source and runs `pnpm agents:sync`.
 */
const EDITED_FILES = [
  ".agents/skills/building-app-routes/SKILL.md",
  ".agents/skills/designing-errors/SKILL.md",
  ".agents/skills/localizing-ui/SKILL.md",
  ".agents/skills/starting-an-app/SKILL.md",
  ".agents/skills/type-testing/SKILL.md",
  ".agents/skills/writing-tests/SKILL.md",
  ".agents/skills/writing-typescript/SKILL.md",
  ".claude/skills/building-app-routes/SKILL.md",
  ".claude/skills/designing-errors/SKILL.md",
  ".claude/skills/localizing-ui/SKILL.md",
  ".claude/skills/starting-an-app/SKILL.md",
  ".claude/skills/type-testing/SKILL.md",
  ".claude/skills/writing-tests/SKILL.md",
  ".claude/skills/writing-typescript/SKILL.md",
  ".env.example",
  "AGENTS.md",
  "README.md",
  "eslint.config.mjs",
  "src/server/env.ts",
  "tests/boundaries.test.ts",
  "tests/server-env.test.ts",
  "vitest.config.ts",
];

// Mirrors tests/placeholders.test.ts: dependencies, version-control internals,
// build and coverage output, data under test, and agent worktrees hold nothing
// hand-written.
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "coverage",
  "fixtures",
  "worktrees",
  ".idea",
  ".vscode",
]);

const SKIPPED_FILES = new Set([
  "pnpm-lock.yaml",
  ".eslintcache",
  ".DS_Store",
  "next-env.d.ts",
]);

/** `.env` and friends are off limits; the tracked example variants are not. */
function isOffLimits(name: string): boolean {
  if (!name.startsWith(".env")) {
    return false;
  }
  return ![".env.example", ".env.sample", ".env.template"].includes(name);
}

function walk(directory: string): string[] {
  const absolute = directory === "" ? repoRoot : path.join(repoRoot, directory);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : walk(relative);
    }
    if (!entry.isFile() || SKIPPED_FILES.has(entry.name) || isOffLimits(entry.name)) {
      return [];
    }
    return entry.name.endsWith(".tsbuildinfo") || entry.name.endsWith(".log")
      ? []
      : [relative];
  });
}

/** `undefined` for a binary file, which cannot carry a textual reference. */
function readText(relative: string): string | undefined {
  const bytes = readFileSync(path.join(repoRoot, relative));
  return bytes.includes(0) ? undefined : bytes.toString("utf8");
}

/** Whether `relative` is one of the removed paths, or lives under one. */
function isRemoved(relative: string): boolean {
  return removedPaths.some(
    (removed) => relative === removed || relative.startsWith(`${removed}/`),
  );
}

const removedPaths = [
  ...REMOVED_PATHS,
  ...OPTIONAL_REMOVED_PATHS.filter((relative) =>
    existsSync(path.join(repoRoot, relative)),
  ),
];

const everyFile = walk("");
const survivingFiles = everyFile.filter((relative) => !isRemoved(relative));

/** The removed paths and tokens `relative` still names, if any. */
function referencesIn(relative: string): string[] {
  const text = readText(relative);
  if (text === undefined) {
    return [];
  }
  return [...removedPaths, ...AI_LAYER_TOKENS].filter((token) => text.includes(token));
}

const survivorsNamingTheAiLayer = survivingFiles
  .filter((relative) => referencesIn(relative).length > 0)
  .sort();

// --- imports -----------------------------------------------------------------

/** Mirrors tests/boundaries.test.ts; see the reasoning for hand-rolling it there. */
function importSpecifiers(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;
  return [...withoutComments.matchAll(pattern)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** Every module a surviving `.ts`/`.tsx`/`.mjs` file imports, resolved in-tree. */
function danglingImports(): string[] {
  return survivingFiles
    .filter((relative) => /\.(?:tsx?|mjs)$/.test(relative))
    .flatMap((relative) => {
      const text = readText(relative);
      if (text === undefined) {
        return [];
      }
      return importSpecifiers(text)
        .filter((specifier) => specifier.startsWith("."))
        .map((specifier) =>
          path.posix.normalize(
            path.posix.join(path.posix.dirname(relative), specifier),
          ),
        )
        .filter((resolved) => isRemoved(resolved))
        .map((resolved) => `${relative}: ${resolved}`);
    })
    .sort();
}

describe("the AI layer can be removed whole", () => {
  it.each(REMOVED_PATHS)("still has %s to remove", (relative) => {
    expect(existsSync(path.join(repoRoot, relative))).toBe(true);
  });

  it("walked a tree that actually contains the removal set", () => {
    // Guards the inverse of every assertion below: a walk that found nothing
    // would report no dangling reference either.
    expect(everyFile).toContain("src/ai/port.ts");
    expect(everyFile.length).toBeGreaterThan(survivingFiles.length);
  });

  it("leaves no surviving module importing a removed one", () => {
    expect(danglingImports()).toStrictEqual([]);
  });

  it("leaves the AI layer named only by the files the removal edits", () => {
    expect(survivorsNamingTheAiLayer).toStrictEqual(EDITED_FILES);
  });

  it.each(EDITED_FILES)("has something for the removal to edit in %s", (relative) => {
    // The other half of the assertion above: an entry that stopped naming the
    // AI layer is a stale instruction, and a stale instruction is how a
    // removal checklist rots into one nobody trusts.
    expect(referencesIn(relative).length).toBeGreaterThan(0);
  });
});
