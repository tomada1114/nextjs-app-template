import { describe, expect, it } from "vitest";

import { readText, repoRoot, walk } from "./repo-tree";

// `tests/ai-layer-removal.test.ts` pins the rare path — taking the whole AI
// layer out in one piece. This file pins the common one: keeping `LlmPort` and
// swapping the vendor behind it. A project built from this template usually
// wants a language model; it does not necessarily want this one.
//
// The property is that a swap is a *bounded* edit, and the bound is stated in
// two halves that fail for different reasons:
//
//   - `SWAP_EDITS` is exhaustive and has to stay small. It is the whole cost of
//     a swap in code, and an entry joining it means the cost went up.
//   - `VENDOR_TREES` and `NOT_THE_MODEL_PROVIDER` are prefixes, not files. A
//     tree whose subject *is* the vendor grows a file whenever the adapter is
//     documented or tested better, and enumerating those files would be a list
//     edited on every unrelated commit — which is a gate that gets deleted
//     rather than obeyed. What they still forbid is the leak this file exists
//     for: a vendor name reaching a tree that has no business carrying one.

/**
 * The one string every mention of this vendor contains, matched
 * case-insensitively.
 *
 * @remarks
 * One pattern rather than the three tokens a reader would reach for
 * (`@anthropic-ai`, `ANTHROPIC_API_KEY`, `Anthropic`), because all three
 * contain it and so does the adapter directory's own name — and a leak worth
 * catching is just as likely to arrive as a path in a config or a sentence in
 * a document as it is as an identifier. The two files this over-matches are
 * named in {@link NOT_THE_MODEL_PROVIDER} rather than narrowed away, so the
 * pattern stays the simplest thing that cannot be spelled around.
 */
const VENDOR = /anthropic/i;

/** The vendor SDK, as a package specifier rather than as a bare name. */
const VENDOR_SDK = "@anthropic-ai";

/** The private tree the swap replaces wholesale. */
const ADAPTER_TREE = "src/ai/adapters/anthropic/";

/** The layer's published surface, which decides what a caller can reach. */
const AI_LAYER_SURFACE = "src/ai/index.ts";

/** The suite the port contract is written once in, and called from per adapter. */
const CONTRACT_SUITE = "tests/ai-port.test.ts";

/**
 * Every file outside {@link ADAPTER_TREE} that a vendor swap edits, exhaustively.
 *
 * @remarks
 * This is the list the property lives on, and the one that has to stay short.
 * Three are application modules: `src/server/composition.ts` is the single line
 * choosing which vendor answers, `src/ai/index.ts` republishes the adapter that
 * line names, and `src/server/env.ts` declares the credential it is handed.
 * Four are manifests and gate configs, which name the vendor as a dependency,
 * an import restriction, an environment variable, and a test file — a swap
 * rewrites each once. An entry joining this list is the signal: it means the
 * choice of vendor has escaped the composition root into a module that had no
 * reason to know it.
 */
const SWAP_EDITS = [
  ".env.example",
  "eslint.config.mjs",
  "package.json",
  "src/ai/index.ts",
  "src/server/composition.ts",
  "src/server/env.ts",
  "vitest.config.ts",
];

/** The half of {@link SWAP_EDITS} that is application code. */
const SRC_SEAM = SWAP_EDITS.filter((relative) => relative.startsWith("src/"));

/**
 * Trees whose subject is this vendor, where naming it is the point.
 *
 * @remarks
 * Prefixes rather than files, deliberately. The adapter is private to the AI
 * layer and may say the name as often as it likes; the skills document the
 * adapter and the swap; and the suites under `tests/` are what hold every
 * assertion in this file, the adapter's own behaviour, and its recorded
 * fixtures. Each grows for reasons that have nothing to do with the seam, so
 * pinning them file by file would produce failures that say nothing and get
 * fixed by editing the expectation.
 */
const VENDOR_TREES = [ADAPTER_TREE, ".agents/skills/", ".claude/skills/", "tests/"];

/**
 * Files naming the vendor for a reason a swap does not touch.
 *
 * @remarks
 * `.claude/settings.json` enables a plugin published by this vendor as an
 * author of agent skills, which has nothing to do with which model this
 * application calls. `scripts/lib/guard/credentials.mjs` matches `sk-ant-` so a
 * leaked key is caught before it is committed, and a repository stops wanting
 * that only when no contributor anywhere holds such a key. Neither is edited by
 * a swap, and listing them here is what lets {@link VENDOR} stay a single
 * unspellable-around pattern instead of three tokens chosen to dodge them.
 */
const NOT_THE_MODEL_PROVIDER = [
  ".claude/settings.json",
  "scripts/lib/guard/credentials.mjs",
];

/**
 * Modules that must name no vendor at all, asserted one by one.
 *
 * @remarks
 * Implied by the exhaustive comparison over `src/` below, and written out
 * anyway: these three are what "the port is vendor-neutral" actually means, and
 * a named failure says which promise broke rather than handing a reader a diff
 * of two lists. The port and the shared error vocabulary are the interface a
 * second vendor implements; the fake is the proof that something other than
 * this vendor can.
 */
const VENDOR_FREE_MODULES = [
  "src/ai/port.ts",
  "src/ai/errors.ts",
  "src/ai/adapters/fake/index.ts",
];

const everyFile = walk(repoRoot);

/** Whether `relative` is one of `allowed`, or lives under one of its trees. */
function isAllowed(relative: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) =>
    entry.endsWith("/") ? relative.startsWith(entry) : relative === entry,
  );
}

/**
 * The files among `files` whose text names the vendor, sorted.
 *
 * @remarks
 * `read` is a parameter only so the falsification case can pose a file in a
 * tree that carries no vendor name today, without writing one into a real file
 * and trusting a later edit to take it out again.
 */
function filesNamingTheVendor(
  files: readonly string[],
  read: (relative: string) => string | undefined,
): string[] {
  return files.filter((relative) => VENDOR.test(read(relative) ?? "")).sort();
}

/** The vendor-naming files among `files` that no entry above accounts for. */
function leaks(files: readonly string[]): string[] {
  const allowed = [...SWAP_EDITS, ...VENDOR_TREES, ...NOT_THE_MODEL_PROVIDER];
  return files.filter((relative) => !isAllowed(relative, allowed));
}

const vendorFiles = filesNamingTheVendor(everyFile, readText);

/** The `create…` factories the AI layer's surface publishes, in file order. */
const adapterFactories = [
  ...new Set((readText(AI_LAYER_SURFACE) ?? "").match(/\bcreate[A-Z]\w*/g) ?? []),
].sort();

/**
 * The name each top-level `describeLlmPortContract` call runs the suite under.
 *
 * @remarks
 * Anchored to the start of a line rather than comment-stripped: the only other
 * place that identifier appears in the file is its own TSDoc, where every line
 * begins with ` * `. A fourth scanner for the two spellings this needs to tell
 * apart would cost more than the anchor does.
 */
const contractSubjects = [
  ...(readText(CONTRACT_SUITE) ?? "").matchAll(
    /^describeLlmPortContract\(\s*"([^"]+)"/gm,
  ),
]
  .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
  .sort();

describe("swapping the vendor behind LlmPort is a bounded edit", () => {
  it("walked a tree that actually contains the adapter", () => {
    // Guards the inverse of everything below: a walk that found nothing would
    // report no leak either.
    expect(everyFile).toContain("src/ai/port.ts");
    expect(
      vendorFiles.filter((relative) => relative.startsWith(ADAPTER_TREE)),
    ).not.toStrictEqual([]);
  });

  it("names the vendor only where an entry above accounts for it", () => {
    expect(leaks(vendorFiles)).toStrictEqual([]);
  });

  it("leaves the vendor named under src/ only in the adapter tree and at the seam", () => {
    const named = vendorFiles.filter(
      (relative) => relative.startsWith("src/") && !relative.startsWith(ADAPTER_TREE),
    );

    expect(named).toStrictEqual(SRC_SEAM);
  });

  it.each(VENDOR_FREE_MODULES)("names no vendor in %s", (relative) => {
    expect(readText(relative)).not.toMatch(VENDOR);
  });

  it("keeps the vendor SDK itself inside the adapter tree", () => {
    // `tests/boundaries.test.ts` asserts the same thing from the module graph,
    // but only for `src/app/`, `src/core/` and `src/server/`. Inside `src/ai/`
    // — where the rule matters most, because that is where the port lives
    // beside the adapter that must not contaminate it — nothing checked it.
    const naming = everyFile.filter(
      (relative) =>
        relative.startsWith("src/") && (readText(relative) ?? "").includes(VENDOR_SDK),
    );

    expect(
      naming.filter((relative) => !relative.startsWith(ADAPTER_TREE)),
    ).toStrictEqual([]);
    expect(naming).not.toStrictEqual([]);
  });

  it.each(SWAP_EDITS)("still has something for a swap to edit in %s", (relative) => {
    // The other half of the exhaustive comparison: an entry that stopped
    // naming the vendor is a stale instruction, and a stale instruction is how
    // a swap checklist rots into one nobody trusts.
    expect(readText(relative)).toMatch(VENDOR);
  });

  it.each([...VENDOR_TREES, ...NOT_THE_MODEL_PROVIDER])(
    "still names the vendor somewhere under %s",
    (entry) => {
      expect(
        vendorFiles.filter((relative) => isAllowed(relative, [entry])),
      ).not.toStrictEqual([]);
    },
  );

  it("catches a vendor name in a tree that carries none today", () => {
    const posed = "scripts/deploy.mjs";
    const readingPosedAs = (body: string) => (relative: string) =>
      relative === posed ? body : readText(relative);
    const files = [...everyFile, posed];

    // Adding the mention: the suite's own expected value no longer holds.
    expect(
      leaks(
        filesNamingTheVendor(files, readingPosedAs("const model = 'anthropic';\n")),
      ),
    ).toStrictEqual([posed]);
    // Removing it: back to exactly what the suite asserts today.
    expect(
      leaks(filesNamingTheVendor(files, readingPosedAs("const model = 'fake';\n"))),
    ).toStrictEqual([]);
  });
});

describe("a replacement adapter inherits the same conformance bar", () => {
  it("derives the adapter factories from the layer's published surface", () => {
    // A literal an author wrote, so the derivation is checked rather than
    // trusted, and a third adapter fails here until it is acknowledged.
    expect(adapterFactories).toStrictEqual([
      "createAnthropicAdapter",
      "createFakeLlmPort",
    ]);
  });

  it("runs the port contract suite against every adapter the surface publishes", () => {
    // Both directions matter. An adapter published without a contract call is
    // one whose failures no caller can handle uniformly; a contract call for
    // something the surface does not publish is a suite asserting against a
    // module nothing above the layer can reach.
    expect(contractSubjects).toStrictEqual(adapterFactories);
  });
});
