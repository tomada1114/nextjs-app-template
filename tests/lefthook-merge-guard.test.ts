import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isolatedGitEnv } from "../scripts/lib/git-env.mjs";

// The commit that concludes a conflicted merge, and a `git commit` at a
// rebase stop, carry a resolution no hook has seen. `lefthook.yml` therefore
// skips merge and rebase per job, on the style and speed jobs only, and never
// on the whole hook: a hook-level `skip` would let a credential into history
// through exactly the commits an agent makes while rebasing onto `main`.
//
// The end-to-end cases install this repository's own `lefthook.yml` into a
// throwaway repository, with only the `check:staged` command rewritten to call
// a copy of `scripts/check-staged.mjs` there — that script judges the
// repository it sits in, so the real one would inspect this checkout instead.
// `agents:check` keeps its `pnpm run` command: its glob matches nothing the
// fixture stages, so it never runs. The jobs that skip merge and rebase never
// run either, which is what lets the fixture have no `node_modules` of its own.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const lefthookConfigPath = path.join(repoRoot, "lefthook.yml");
const lefthookScript = path.join(repoRoot, "node_modules/lefthook/bin/index.js");
const checkStagedCommand = "run: pnpm run check:staged";

// Assembled at runtime so this file is not itself a staged credential.
const credentialLine = ["export LLM_API_KEY=", "sk-ant-", "a".repeat(25)].join("");

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeDirectory(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

/**
 * An environment that reaches neither the outer repository nor the
 * developer's git or lefthook configuration.
 *
 * `HOME`/`XDG_CONFIG_HOME` keep a global `core.hooksPath` (or signing setup)
 * out of the fixture — see tests/verify-hooks.test.ts. `LEFTHOOK` and
 * `LEFTHOOK_EXCLUDE` are cleared so a value exported in the shell running the
 * suite cannot switch off the very job these cases assert on.
 */
function isolatedEnv(): NodeJS.ProcessEnv {
  const home = makeDirectory("lefthook-merge-guard-home-");
  return isolatedGitEnv({
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    LEFTHOOK: "",
    LEFTHOOK_EXCLUDE: "",
  });
}

function git(dir: string, env: NodeJS.ProcessEnv, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env, stdio: "pipe" });
}

/**
 * A throwaway repository whose `main` and `side` branches both rewrite
 * `README.md`, so merging or rebasing one onto the other stops on a conflict,
 * with this repository's `lefthook.yml` installed as its real pre-commit hook.
 */
function initDivergedRepo(): { dir: string; env: NodeJS.ProcessEnv } {
  const env = isolatedEnv();
  const dir = makeDirectory("lefthook-merge-guard-");

  git(dir, env, ["init", "-q", "--initial-branch=main"]);
  git(dir, env, ["config", "user.email", "test@example.com"]);
  git(dir, env, ["config", "user.name", "Test"]);
  writeFileSync(path.join(dir, "README.md"), "seed\n");
  git(dir, env, ["add", "README.md"]);
  git(dir, env, ["commit", "-q", "-m", "seed"]);

  git(dir, env, ["checkout", "-q", "-b", "side"]);
  writeFileSync(path.join(dir, "README.md"), "side\n");
  git(dir, env, ["commit", "-q", "-a", "-m", "side"]);
  git(dir, env, ["checkout", "-q", "main"]);
  writeFileSync(path.join(dir, "README.md"), "main\n");
  git(dir, env, ["commit", "-q", "-a", "-m", "main"]);

  // Left untracked: nothing below stages them, so the guard never judges them.
  cpSync(path.join(repoRoot, "scripts"), path.join(dir, "scripts"), {
    recursive: true,
  });
  const config = readFileSync(lefthookConfigPath, "utf8");
  expect(config).toContain(checkStagedCommand);
  writeFileSync(
    path.join(dir, "lefthook.yml"),
    config.replace(
      checkStagedCommand,
      `run: '"${process.execPath}" scripts/check-staged.mjs'`,
    ),
  );
  execFileSync(process.execPath, [lefthookScript, "install", "-f"], {
    cwd: dir,
    env,
    stdio: "pipe",
  });

  return { dir, env };
}

/** Run `git` and keep its exit status and combined output rather than throwing. */
function tryGit(dir: string, env: NodeJS.ProcessEnv, args: readonly string[]) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Resolve the README conflict and stage the resolution plus `extra` files. */
function stageResolution(
  dir: string,
  env: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> = {},
): void {
  writeFileSync(path.join(dir, "README.md"), "resolved\n");
  for (const [name, content] of Object.entries(extra)) {
    writeFileSync(path.join(dir, name), content);
  }
  git(dir, env, ["add", "README.md", ...Object.keys(extra)]);
}

function headCommit(dir: string, env: NodeJS.ProcessEnv): string {
  return git(dir, env, ["rev-parse", "HEAD"]).trim();
}

function gitPath(dir: string, env: NodeJS.ProcessEnv, name: string): string {
  return path.resolve(dir, git(dir, env, ["rev-parse", "--git-path", name]).trim());
}

describe("lefthook's pre-commit hook during a conflicted merge", () => {
  it("refuses to conclude the merge when a credential is staged with the resolution", () => {
    const { dir, env } = initDivergedRepo();
    expect(tryGit(dir, env, ["merge", "side"]).status).not.toBe(0);
    expect(existsSync(gitPath(dir, env, "MERGE_HEAD"))).toBe(true);
    const before = headCommit(dir, env);
    stageResolution(dir, env, { "deploy.sh": `${credentialLine}\n` });

    const commit = tryGit(dir, env, ["commit", "--no-edit"]);

    expect(commit.status).not.toBe(0);
    expect(commit.output).toContain("Blocked:");
    expect(headCommit(dir, env)).toBe(before);
    expect(existsSync(gitPath(dir, env, "MERGE_HEAD"))).toBe(true);
  });

  it("concludes the merge when the resolution holds no secret", () => {
    const { dir, env } = initDivergedRepo();
    expect(tryGit(dir, env, ["merge", "side"]).status).not.toBe(0);
    stageResolution(dir, env);

    const commit = tryGit(dir, env, ["commit", "--no-edit"]);

    expect(commit.output).not.toContain("Blocked:");
    expect(commit.status).toBe(0);
    expect(
      git(dir, env, ["show", "--no-patch", "--format=%P", "HEAD"]).trim().split(" "),
    ).toHaveLength(2);
  });
});

describe("lefthook's pre-commit hook at a rebase stop", () => {
  it("refuses a commit of the resolution when a credential is staged with it", () => {
    const { dir, env } = initDivergedRepo();
    git(dir, env, ["checkout", "-q", "side"]);
    expect(tryGit(dir, env, ["rebase", "main"]).status).not.toBe(0);
    expect(existsSync(gitPath(dir, env, "rebase-merge"))).toBe(true);
    const before = headCommit(dir, env);
    stageResolution(dir, env, { "deploy.sh": `${credentialLine}\n` });

    const commit = tryGit(dir, env, ["commit", "--no-edit"]);

    expect(commit.status).not.toBe(0);
    expect(commit.output).toContain("Blocked:");
    expect(headCommit(dir, env)).toBe(before);
  });
});

/** The lines of the job named `name`, from its `- name:` line to the next sibling. */
function jobBlock(lines: readonly string[], name: string): string[] {
  const start = lines.findIndex((line) => line.trimStart() === `- name: ${name}`);
  expect(start, `lefthook.yml has no job named ${name}`).toBeGreaterThanOrEqual(0);
  const indent = (lines[start] ?? "").search(/\S/);
  const block = [lines[start] ?? ""];
  for (const line of lines.slice(start + 1)) {
    const lineIndent = line.search(/\S/);
    if (
      lineIndent !== -1 &&
      lineIndent <= indent &&
      !line.trimStart().startsWith("#")
    ) {
      break;
    }
    block.push(line);
  }
  return block;
}

describe("lefthook.yml's pre-commit shape", () => {
  const lines = readFileSync(lefthookConfigPath, "utf8").split("\n");

  it("declares no skip on the pre-commit hook itself", () => {
    const start = lines.indexOf("pre-commit:");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
    const hookKeys = lines
      .slice(start + 1, end === -1 ? undefined : end)
      .flatMap((line) => /^ {2}([\w-]+):/.exec(line)?.slice(1, 2) ?? []);

    expect(hookKeys).toContain("jobs");
    expect(hookKeys).not.toContain("skip");
  });

  it.each(["check:staged", "agents:check"])(
    "declares no skip on the %s job",
    (name) => {
      const skips = jobBlock(lines, name).filter((line) => /^\s*skip:/.test(line));

      expect(skips).toEqual([]);
    },
  );
});
