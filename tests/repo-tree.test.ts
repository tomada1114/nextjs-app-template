import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { walk } from "./repo-tree";

// Several suites under `tests/` build their assertions on `walk` from
// `tests/repo-tree.ts`. Every path it returns is opened by `readText`, and
// AGENTS.md counts the read itself as the disclosure, so what it must *not*
// return is a property worth pinning once here rather than in each caller.
// Driven over a synthetic tree because a checkout usually has no `secrets/`
// in it, and an assertion over the real one would then hold for the wrong
// reason.

describe("the walk that feeds tests/repo-tree.ts's callers", () => {
  const body = "fixture body, nothing sensitive\n";
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "repo-tree-walk-"));
    mkdirSync(path.join(root, "secrets"));
    mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
    for (const relative of [
      "secrets/token.txt",
      ".env",
      ".env.local",
      ".envrc",
      ".env.example",
      ".claude/settings.local.json",
      ".claude/settings.json",
      ".claude/skills/example.md",
      "README.md",
    ]) {
      writeFileSync(path.join(root, relative), body);
    }
    // What `.git` is inside a linked worktree: a pointer file, not a directory.
    writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/1\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("does not read anything under secrets/", () => {
    expect(walk(root)).not.toContain("secrets/token.txt");
  });

  it("does not read a linked worktree's .git, which is a file and not a directory", () => {
    expect(walk(root)).not.toContain(".git");
  });

  it("does not read the personal .claude/settings.local.json", () => {
    expect(walk(root)).not.toContain(".claude/settings.local.json");
  });

  it("still walks .claude/skills/, which the generated skill mirror lives under", () => {
    expect(walk(root)).toContain(".claude/skills/example.md");
  });

  it("reads the tracked env example, the shared Claude settings and no real dotenv, direnv, or personal settings file", () => {
    expect(walk(root).sort()).toStrictEqual([
      ".claude/settings.json",
      ".claude/skills/example.md",
      ".env.example",
      "README.md",
    ]);
  });
});
