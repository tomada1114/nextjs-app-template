import consoleModule from "node:console";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { clean } from "../scripts/clean.mjs";

// scripts/clean.mjs imports `console` from "node:console" (AGENTS.md's
// "Repository automation" convention), which is a distinct object from the
// ambient global under Vitest, so the spy has to target the same module —
// see tests/sync-labels.test.ts for the established pattern.

const workspaces: string[] = [];

/**
 * A throwaway directory, registered for cleanup: a stand-in "repository root", or —
 * for the symlink cases — a place outside one that a link can point at. No test here
 * touches the real project directory.
 */
function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "clean-test-"));
  workspaces.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (workspaces.length > 0) {
    const dir = workspaces.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("clean", () => {
  it("returns 2 and logs usage when no targets are given", () => {
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);

    expect(clean([], makeRoot())).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/no targets given/));
  });

  it("removes an existing directory recursively", () => {
    const root = makeRoot();
    const target = path.join(root, "dist");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "index.js"), "export const a = 1;\n");

    expect(clean(["dist"], root)).toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it("does not error when the target does not exist (force semantics)", () => {
    const root = makeRoot();
    const target = path.join(root, "never-created");

    expect(clean(["never-created"], root)).toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it("removes every listed target", () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "a"));
    mkdirSync(path.join(root, "b"));

    expect(clean(["a", "b"], root)).toBe(0);
    expect(existsSync(path.join(root, "a"))).toBe(false);
    expect(existsSync(path.join(root, "b"))).toBe(false);
  });

  it("accepts a target given as an absolute path already inside the root", () => {
    const root = makeRoot();
    const target = path.join(root, "dist");
    mkdirSync(target);

    expect(clean([target], root)).toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it.each([
    ["a parent traversal", "../outside"],
    ["an absolute path outside the root", "/etc/passwd"],
  ])("refuses %s without removing anything", (_label, target) => {
    const root = makeRoot();
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);

    expect(clean([target], root)).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^ERR_CLEAN_OUTSIDE_ROOT: /),
    );
  });

  it("refuses the root itself", () => {
    const root = makeRoot();
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);

    expect(clean(["."], root)).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^ERR_CLEAN_OUTSIDE_ROOT: /),
    );
  });

  it("stops at the first unsafe target and never processes the rest", () => {
    const root = makeRoot();
    const unreached = path.join(root, "unreached");
    mkdirSync(unreached);
    vi.spyOn(consoleModule, "error").mockImplementation(() => undefined);

    // "../outside" is refused before "unreached" (a legitimate target) would
    // ever be reached, proving the loop returns immediately instead of
    // continuing past an unsafe entry.
    expect(clean(["../outside", "unreached"], root)).toBe(2);
    expect(existsSync(unreached)).toBe(true);
  });

  it("accepts an ordinary nested path inside the root", () => {
    const root = makeRoot();
    const nested = path.join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });

    expect(clean(["a/b/c"], root)).toBe(0);
    expect(existsSync(nested)).toBe(false);
    expect(existsSync(path.join(root, "a", "b"))).toBe(true);
  });

  it("tolerates a target several levels below a directory that does not exist", () => {
    // Nothing on this path exists, so there is no real path to canonicalize;
    // `force: true` still makes the removal a no-op rather than an error.
    const root = makeRoot();

    expect(clean(["never/created/at/all"], root)).toBe(0);
  });

  it("refuses a target reached through a directory symlink pointing outside the root", () => {
    // The lexical check alone accepts "escape/keep-me": it resolves to a
    // string under the root. Following the link is what shows it does not.
    const root = makeRoot();
    const outside = makeRoot();
    const victim = path.join(outside, "keep-me");
    mkdirSync(victim);
    symlinkSync(outside, path.join(root, "escape"), "dir");
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);

    expect(clean(["escape/keep-me"], root)).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^ERR_CLEAN_SYMLINK_ESCAPE: /),
    );
    expect(existsSync(victim)).toBe(true);
  });

  it("refuses a target through a directory symlink even when its leaf is absent", () => {
    // The escaping component is the link, not the leaf, so an absent leaf
    // must not be mistaken for "nothing to check here".
    const root = makeRoot();
    const outside = makeRoot();
    symlinkSync(outside, path.join(root, "escape"), "dir");
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);

    expect(clean(["escape/never-created"], root)).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^ERR_CLEAN_SYMLINK_ESCAPE: /),
    );
    expect(existsSync(outside)).toBe(true);
  });

  it("removes nothing when a later target escapes through a directory symlink", () => {
    // Every target is judged before the first removal, so the legitimate one
    // listed ahead of the bad one survives.
    const root = makeRoot();
    const outside = makeRoot();
    const legitimate = path.join(root, "dist");
    mkdirSync(legitimate);
    symlinkSync(outside, path.join(root, "escape"), "dir");
    vi.spyOn(consoleModule, "error").mockImplementation(() => undefined);

    expect(clean(["dist", "escape/anything"], root)).toBe(2);
    expect(existsSync(legitimate)).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it("unlinks a symlinked final component instead of following it", () => {
    // The known, deliberate half of the containment story: a link named as
    // the target itself is removed as a link, so what it points at is
    // untouched and the containment check has no reason to refuse it.
    const root = makeRoot();
    const outside = makeRoot();
    const kept = path.join(outside, "keep-me");
    mkdirSync(kept);
    const link = path.join(root, "cache");
    symlinkSync(outside, link, "dir");

    expect(clean(["cache"], root)).toBe(0);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it("defaults to this repository's own root when none is given", () => {
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);

    // A path far outside this checkout is refused under the default root,
    // proving the parameter really does default to it rather than requiring
    // every caller — including the CLI entry point — to pass one explicitly.
    expect(clean(["../../../etc"])).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^ERR_CLEAN_OUTSIDE_ROOT: /),
    );
  });
});

// `pnpm clean` and `pnpm clean:deep` are the reviewable alternative to typing
// `rm -rf` at a prompt: the target list lives in package.json where a diff
// shows it, and scripts/clean.mjs refuses anything resolving outside the
// repository. That only holds while the two scripts stay honest about each
// other, which is what this block pins.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** The targets one `clean*` script passes to `scripts/clean.mjs`, in order. */
function cleanTargets(scriptName: string): string[] {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const scripts =
    typeof manifest === "object" && manifest !== null && "scripts" in manifest
      ? manifest.scripts
      : undefined;
  const command =
    typeof scripts === "object" && scripts !== null && scriptName in scripts
      ? (scripts as Record<string, unknown>)[scriptName]
      : undefined;
  if (typeof command !== "string") {
    throw new Error(`package.json has no "${scriptName}" script to check.`);
  }
  const invocation = "node scripts/clean.mjs ";
  if (!command.startsWith(invocation)) {
    throw new Error(`"${scriptName}" no longer calls scripts/clean.mjs: ${command}`);
  }
  return command
    .slice(invocation.length)
    .split(" ")
    .filter((target) => target !== "");
}

describe("the clean scripts", () => {
  it("both route through scripts/clean.mjs rather than a shell rm", () => {
    expect(cleanTargets("clean").length).toBeGreaterThan(0);
    expect(cleanTargets("clean:deep").length).toBeGreaterThan(0);
  });

  it("clean:deep removes everything clean removes", () => {
    // Otherwise "deep" is a lie: someone reaching for it after `pnpm clean`
    // left something behind would still be left with that something.
    const shallow = cleanTargets("clean");
    const deep = cleanTargets("clean:deep");
    expect(deep).toEqual(expect.arrayContaining(shallow));
  });

  it("clean:deep is the only one that removes node_modules", () => {
    // The split is the whole point: `clean` is cheap and keeps the checkout
    // usable, `clean:deep` costs a reinstall. Merging them would make the
    // everyday command the expensive one.
    expect(cleanTargets("clean")).not.toContain("node_modules");
    expect(cleanTargets("clean:deep")).toContain("node_modules");
  });

  it("names only paths scripts/clean.mjs will accept", () => {
    // A target that resolves outside the repository is refused at runtime and
    // exits 2, which would make the script fail rather than clean. Catch it
    // here, where the message names the offending entry.
    for (const scriptName of ["clean", "clean:deep"]) {
      for (const target of cleanTargets(scriptName)) {
        const resolved = path.resolve(repoRoot, target);
        const relative = path.relative(repoRoot, resolved);
        expect(
          relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative),
          `${scriptName} target ${target} resolves outside the repository`,
        ).toBe(true);
      }
    }
  });
});
