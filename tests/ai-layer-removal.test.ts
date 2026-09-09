import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readText, repoRoot, walk } from "./repo-tree";

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

/** Where a skill is authored; `.claude/skills/` mirrors it. */
const AUTHORED_SKILLS_ROOT = ".agents/skills/";

/**
 * Everything the removal deletes outright.
 *
 * @remarks
 * `src/server/composition.ts` is on the list because wiring an `LlmPort` is
 * the whole of what it does; if this template ever grows a second thing to
 * compose, that file splits rather than staying half-deleted here. This test
 * file is on the list too — it names every path above and would itself be the
 * first dangling reference left behind. So is its sibling
 * `tests/ai-vendor-swap.test.ts`, whose whole subject is which vendor sits
 * behind a port that is no longer there.
 *
 * The `integrating-llm` skill is deleted rather than edited, because the whole
 * of its subject is the layer that is going away. Both its authored copy and
 * its generated `.claude/skills/` mirror are named: the mirror is a real
 * committed file, and `pnpm agents:sync` will not remove a skill the source
 * tree no longer has unless the source is deleted first.
 */
const REMOVED_PATHS = [
  ".agents/skills/integrating-llm",
  ".claude/skills/integrating-llm",
  "src/ai",
  "src/app/api",
  "src/server/composition.ts",
  "src/server/handlers/ask.ts",
  "tests/ai-anthropic.test.ts",
  "tests/ai-layer-removal.test.ts",
  "tests/ai-port.test.ts",
  "tests/ai-vendor-swap.test.ts",
  "tests/fixtures/llm",
  "tests/llm-replay.ts",
  "tests/server-handler.test.ts",
];

/**
 * Vendor product names that name the AI layer without naming one of its paths.
 *
 * @remarks
 * Both are deliberately specific. `Anthropic` on its own would match
 * `scripts/lib/guard/credentials.mjs`, whose `sk-ant-` rule detects a leaked
 * key and stays whether or not this application calls a model. A name this
 * repository gives one of its own documents is not one of these —
 * `REMOVED_SKILL_NAMES` holds those, so an adapter author reading
 * `adding-an-adapter.md` adds a package and a credential here and nothing
 * else.
 */
const AI_LAYER_TOKENS = ["ANTHROPIC_API_KEY", "@anthropic-ai"];

/**
 * The bare name of every skill the removal deletes.
 *
 * @remarks
 * Derived from `REMOVED_PATHS` rather than typed again, because forgetting to
 * type it again is the bug this list exists to close: a skill goes on
 * `REMOVED_PATHS` by path, but `authoring-skills` requires a sibling skill to
 * be cross-referenced *by name, never by path*, so the path entry alone misses
 * every reference written the way the repository mandates. Deriving from a
 * hand-written constant is not the derivation `withMirror` warns against —
 * that one is about reading the tree, or importing `scripts/sync-agents.mjs`,
 * which would make the expected value agree with the thing under test.
 *
 * Only the authored `.agents/skills/` half is read; the `.claude/skills/`
 * entry beside it names the same skill. The *first* segment is the name, so an
 * entry written as a file or a subdirectory rather than as the skill directory
 * — `.agents/skills/foo/SKILL.md` — still yields `foo` rather than nothing.
 * Taking the last segment there would yield `SKILL.md`, and rejecting it would
 * reopen this list's own hole for the next skill removed: the guard below
 * cannot catch that, because a name never derived leaves the list unchanged.
 */
const REMOVED_SKILL_NAMES = [
  ...new Set(
    REMOVED_PATHS.filter((removed) => removed.startsWith(AUTHORED_SKILLS_ROOT)).map(
      (removed) => removed.slice(AUTHORED_SKILLS_ROOT.length).split("/")[0] ?? "",
    ),
  ),
].filter((name) => name !== "");

/**
 * Files that survive the removal but have to be edited by it, whose subject is
 * the repository's machinery.
 *
 * @remarks
 * The two gate configs and the two boundary tests assert against the AI
 * layer's shape; `src/server/env.ts` is the only module that reads the
 * credential, and `.env.example` is where its name is published.
 * `package.json` declares the vendor SDK, which is the AI layer's one runtime
 * dependency and leaves with it — a manifest entry, not an application module,
 * which is why it can join this half without weakening what it claims.
 * `tests/server-smoke.test.ts` asks the running application for every route it
 * publishes, `POST /api/ask` among them, so the removal deletes those cases
 * the same way it deletes the route; it is a test of the composed application,
 * not a module the layer is embedded in. This
 * half is where the separability property lives: it is the one that has to stay
 * near-empty, and an entry joining it means an application module now has to
 * be edited by the removal — the moment the layer has stopped coming out in
 * one piece.
 */
const EDITED_CODE_FILES = [
  ".env.example",
  "eslint.config.mjs",
  "package.json",
  "src/server/env.ts",
  "tests/boundaries.test.ts",
  "tests/server-env.test.ts",
  "tests/server-smoke.test.ts",
  "vitest.config.ts",
];

/**
 * Files that survive the removal but have to be edited by it, because they
 * describe the layer to a reader.
 *
 * @remarks
 * AGENTS.md's Architecture section, the README's description of the one route,
 * the `starting-an-app` skill, which carries the removal procedure and so
 * names the removal set in prose, `building-app-routes`, which teaches the
 * Route Handler pattern through the one endpoint this template ships,
 * `localizing-ui`, which owns the one mapping from a UI locale to the port's
 * `outputLanguage`, and `writing-typescript`, `designing-errors`,
 * `writing-tests` and `type-testing`, which illustrate rules that outlive the
 * layer with worked examples drawn from it — the port contract suite and the
 * handler test as the seams a test is written through, and the port's generic
 * request/response types as what a compile-time assertion is worth making
 * about. This half claims completeness and nothing else: it grows whenever a
 * skill teaches a rule through the port or the handler, that growth is
 * expected rather than a signal, and each entry is here so the removal edits
 * it instead of leaving a dangling instruction behind.
 *
 * Only the authored `.agents/` path is listed. `withMirror` derives each
 * skill's `.claude/skills/` copy, which is a real committed file but is never
 * hand-edited: the removal edits the `.agents/` source and runs
 * `pnpm agents:sync`.
 */
const EDITED_DOCUMENT_FILES = [
  ".agents/skills/building-app-routes/SKILL.md",
  ".agents/skills/changing-gates/SKILL.md",
  ".agents/skills/designing-errors/SKILL.md",
  ".agents/skills/localizing-ui/SKILL.md",
  ".agents/skills/starting-an-app/SKILL.md",
  ".agents/skills/type-testing/SKILL.md",
  ".agents/skills/writing-tests/SKILL.md",
  ".agents/skills/writing-typescript/SKILL.md",
  "AGENTS.md",
  "README.md",
];

/**
 * `paths`, plus the generated `.claude/skills/` copy of every authored skill
 * among them.
 *
 * @remarks
 * A literal string replacement, deliberately: reading the tree, or importing
 * the mapping from `scripts/sync-agents.mjs`, would make the expected value
 * agree with the thing it is asserting against instead of with what an author
 * wrote down.
 */
function withMirror(paths: readonly string[]): string[] {
  return paths.flatMap((relative) =>
    relative.startsWith(AUTHORED_SKILLS_ROOT)
      ? [relative, relative.replace(AUTHORED_SKILLS_ROOT, ".claude/skills/")]
      : [relative],
  );
}

/** Both halves as the one exhaustive expected value the assertions compare. */
const EDITED_FILES = [
  ...EDITED_CODE_FILES,
  ...withMirror(EDITED_DOCUMENT_FILES),
].sort();

/** Whether `relative` is one of the removed paths, or lives under one. */
function isRemoved(relative: string): boolean {
  return REMOVED_PATHS.some(
    (removed) => relative === removed || relative.startsWith(`${removed}/`),
  );
}

const everyFile = walk(repoRoot);
const survivingFiles = everyFile.filter((relative) => !isRemoved(relative));

/** The removed paths, tokens and skill names `text` names, if any. */
function referencesInText(text: string): string[] {
  return [...REMOVED_PATHS, ...AI_LAYER_TOKENS, ...REMOVED_SKILL_NAMES].filter(
    (needle) => text.includes(needle),
  );
}

/** The same, for a file in the tree; `[]` for a binary one. */
function referencesIn(relative: string): string[] {
  const text = readText(relative);
  return text === undefined ? [] : referencesInText(text);
}

/**
 * The files among `files` whose text still names the AI layer, sorted.
 *
 * @remarks
 * `read` is a parameter only so the falsification case can pose a skill whose
 * one mention of the layer is a by-name cross-reference, without writing that
 * mention into a real skill and then trusting a later edit to take it out.
 */
function survivorsNaming(
  files: readonly string[],
  read: (relative: string) => string | undefined,
): string[] {
  return files
    .filter((relative) => {
      const text = read(relative);
      return text !== undefined && referencesInText(text).length > 0;
    })
    .sort();
}

const survivorsNamingTheAiLayer = survivorsNaming(survivingFiles, readText);

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

  it("derives the bare name of every skill the removal deletes", () => {
    // A literal an author wrote, so the derivation is checked rather than
    // trusted, and a second removed skill fails here until it is acknowledged.
    expect(REMOVED_SKILL_NAMES).toStrictEqual(["integrating-llm"]);
  });

  it("catches a skill whose only mention of the layer is a by-name cross-reference", () => {
    const posed = ".agents/skills/posed-by-this-test/SKILL.md";
    const withReference =
      "**BACKGROUND:** `integrating-llm` for the port behind the handler.\n";
    const withoutReference =
      "**BACKGROUND:** `writing-tests` for the contract suite.\n";
    const readingPosedAs = (body: string) => (relative: string) =>
      relative === posed ? body : readText(relative);
    const files = [...survivingFiles, posed];

    // Adding the mention: the suite's own expected value no longer holds.
    expect(survivorsNaming(files, readingPosedAs(withReference))).toStrictEqual(
      [...EDITED_FILES, posed].sort(),
    );
    // Removing it: back to exactly what the suite asserts today.
    expect(survivorsNaming(files, readingPosedAs(withoutReference))).toStrictEqual(
      EDITED_FILES,
    );
  });
});
