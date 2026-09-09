import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isolatedGitEnv } from "../scripts/lib/git-env.mjs";

// Pins the behaviour `lefthook.yml`'s caveat beside the `format` job now
// describes: `stage_fixed` re-stages only the reformatted staged content, and
// lefthook hides an unstaged hunk around the job the same way lint-staged
// does, so a partial stage survives a Prettier rewrite. Without this test, a
// future lefthook major that reintroduced the sweep #95 disproved would pass
// silently rather than fail here.
//
// This runs against a throwaway repository, isolated from the checkout the
// suite itself runs in (see scripts/lib/git-env.mjs), and drives this
// repository's own pinned `prettier` and `lefthook` binaries directly rather
// than through `pnpm exec`, since the fixture has no pnpm workspace of its
// own.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const prettierBin = path.join(repoRoot, "node_modules/.bin/prettier");
const lefthookBin = path.join(repoRoot, "node_modules/.bin/lefthook");

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("lefthook's format job (stage_fixed)", () => {
  it("keeps an unstaged hunk out of the commit when the format job re-stages a file", () => {
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

    // The `format` job copied from `lefthook.yml`, pointed at this
    // checkout's own pinned prettier binary.
    writeFileSync(
      path.join(dir, "lefthook.yml"),
      [
        "pre-commit:",
        "  jobs:",
        "    - name: format",
        `      run: '"${prettierBin}" --write --ignore-unknown {staged_files}'`,
        "      stage_fixed: true",
        "",
      ].join("\n"),
    );

    const filePath = path.join(dir, "file.js");
    writeFileSync(filePath, "const a   =   1;\nconst b = 2;\n");
    execFileSync("git", ["add", "file.js"], { cwd: dir, env });
    // Leave an unstaged hunk on top of the staged, badly formatted content.
    writeFileSync(
      filePath,
      "const a   =   1;\nconst b = 999; // UNSTAGED_SWEEP_MARKER\n",
    );

    // What the installed `.git/hooks/pre-commit` script itself runs.
    execFileSync(lefthookBin, ["run", "pre-commit"], { cwd: dir, env });
    execFileSync("git", ["commit", "-q", "-m", "add file.js"], { cwd: dir, env });

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
});
