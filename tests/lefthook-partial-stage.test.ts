import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isolatedGitEnv } from "../scripts/lib/git-env.mjs";

// Pins both halves of the behaviour `lefthook.yml`'s caveat beside the
// `format` job now describes: `stage_fixed` re-stages only the reformatted
// staged content, and lefthook hides an unstaged hunk around the job the
// same way lint-staged does, so a partial stage (`git add -p`) usually
// survives a Prettier rewrite intact — but when the unstaged hunk overlaps a
// line Prettier itself rewrites, restoring it fails and the whole commit
// aborts, with the worktree recovered rather than losing the edit. Without
// this test, a future lefthook major that changed either half would pass
// silently rather than fail here.
//
// This runs against a throwaway repository, isolated from the checkout the
// suite itself runs in (see scripts/lib/git-env.mjs), and drives this
// repository's own pinned `prettier` and `lefthook` packages by their JS
// entry points under `node.execPath` rather than the `node_modules/.bin`
// shims, which are platform-specific `.cmd`/`.ps1` files on Windows — so the
// suite stays portable if a second OS joins `ci.yml`'s matrix.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const prettierScript = path.join(repoRoot, "node_modules/prettier/bin/prettier.cjs");
const lefthookScript = path.join(repoRoot, "node_modules/lefthook/bin/index.js");

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/**
 * Build a throwaway git repository with one seed commit and the `format` job
 * from `lefthook.yml` installed as its real `.git/hooks/pre-commit` — the
 * same way `pnpm hooks:install` installs it here — so a plain `git commit`
 * below exercises the git-driven path developers actually use, not a manual
 * `lefthook run`.
 */
function initRepo(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(path.join(tmpdir(), "lefthook-partial-stage-"));
  directories.push(dir);
  const env = isolatedGitEnv();

  execFileSync("git", ["init", "-q"], { cwd: dir, env });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
    env,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, env });
  writeFileSync(path.join(dir, "README.md"), "seed\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir, env });

  writeFileSync(
    path.join(dir, "lefthook.yml"),
    [
      "pre-commit:",
      "  jobs:",
      "    - name: format",
      `      run: '"${process.execPath}" "${prettierScript}" --write --ignore-unknown {staged_files}'`,
      "      stage_fixed: true",
      "",
    ].join("\n"),
  );

  execFileSync(process.execPath, [lefthookScript, "install"], {
    cwd: dir,
    env,
    stdio: "pipe",
  });

  return { dir, env };
}

describe("lefthook's format job (stage_fixed)", () => {
  it("keeps a non-overlapping unstaged hunk out of the commit when the format job re-stages a file", () => {
    const { dir, env } = initRepo();

    const filePath = path.join(dir, "file.js");
    writeFileSync(filePath, "const a   =   1;\nconst b = 2;\n");
    execFileSync("git", ["add", "file.js"], { cwd: dir, env });
    // Leave an unstaged hunk that does not overlap what Prettier rewrites.
    writeFileSync(
      filePath,
      "const a   =   1;\nconst b = 999; // UNSTAGED_SWEEP_MARKER\n",
    );

    execFileSync("git", ["commit", "-q", "-m", "add file.js"], {
      cwd: dir,
      env,
      stdio: "pipe",
    });

    const committed = execFileSync("git", ["show", "HEAD:file.js"], {
      cwd: dir,
      encoding: "utf8",
      env,
    });
    expect(committed).toBe("const a = 1;\nconst b = 2;\n");

    const worktree = readFileSync(filePath, "utf8");
    expect(worktree).toContain("UNSTAGED_SWEEP_MARKER");

    const status = execFileSync("git", ["status", "--short"], {
      cwd: dir,
      encoding: "utf8",
      env,
    });
    expect(status).toMatch(/^ M file\.js$/m);
  });

  it("aborts the commit, with the worktree edit intact, when the unstaged hunk overlaps a line Prettier rewrites", () => {
    const { dir, env } = initRepo();

    const filePath = path.join(dir, "file.js");
    writeFileSync(filePath, "const a   =   1;\nconst b = 2;\n");
    execFileSync("git", ["add", "file.js"], { cwd: dir, env });
    // Leave an unstaged edit on the SAME line Prettier will rewrite, so the
    // saved patch can no longer apply once the format job reformats it.
    const unstagedContent = "const a   =   111;\nconst b = 2;\n";
    writeFileSync(filePath, unstagedContent);

    expect(() =>
      execFileSync("git", ["commit", "-q", "-m", "add file.js"], {
        cwd: dir,
        env,
        stdio: "pipe",
      }),
    ).toThrow();

    // No commit landed: the hook aborted before `git commit` could complete.
    const log = execFileSync("git", ["log", "--oneline"], {
      cwd: dir,
      encoding: "utf8",
      env,
    });
    expect(log.trim().split("\n")).toHaveLength(1);

    // The worktree edit survives untouched — the no-data-loss half the
    // failed restore has to preserve.
    expect(readFileSync(filePath, "utf8")).toBe(unstagedContent);
  });
});
