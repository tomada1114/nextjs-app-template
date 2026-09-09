#!/usr/bin/env node
// Verify that this repository's pre-commit hook is really in force. This
// script installs nothing, and the name says so on purpose: `lefthook` already
// ships its own `postinstall` (`lefthook install -f`), and
// `pnpm-workspace.yaml` allowlists it, so every non-CI `pnpm install` writes
// the hook without anybody asking. What was missing is a check that the write
// succeeded.
//
// It cannot fail on its own. lefthook's postinstall calls `spawnSync`, which
// does not throw on a non-zero exit status, and never inspects the status it
// returns; its try/catch only reaches a spawn that could not start. So a
// `lefthook install -f` that prints `sync hooks: ❌` and exits 1 — a
// `core.hooksPath` pointing somewhere it cannot create — still leaves
// `pnpm install` green with no hook and nothing on screen. That silent absence
// makes AGENTS.md's "every author, any tool" row false exactly when nobody can
// tell, and closing it is this script's whole job.
//
// Both halves are checked, because either alone is satisfiable while the gate
// is absent. `lefthook install -f` run with no `lefthook.yml` *creates* a blank
// one, reports `sync hooks: ✔️` and exits 0 — a config with no `pre-commit`
// block is a gate that runs nothing. And the hook has to be looked for at the
// path git will really use: `core.hooksPath` legitimately redirects it, and a
// linked worktree's hooks live in the shared common directory, so
// `git rev-parse --git-path hooks` is asked rather than `.git/hooks` assumed.
//
// Four contexts get a skip instead of a failure, because verification is
// meaningless in each and breaking `pnpm install` there would cost more than
// the missing answer: the documented opt-out below, CI (which installs with
// `--frozen-lockfile` and commits nothing), a directory that is not the root of
// a Git work tree (a tarball extract, a Docker build context, a subtree copied
// inside somebody else's checkout), and an install that left no `lefthook` in
// `node_modules` (a `--prod` install). A `git` failure that is not a genuine
// "not a repository" — a `safe.directory` mismatch, a permission error, `git`
// missing from `PATH` — fails instead: those usually mean lefthook's own
// postinstall could not write the hook either, so asserting the work tree is
// absent would be the exact silent pass this script exists to close.
//
// Node globals are imported explicitly, as in every other .mjs here.
import { spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isolatedGitEnv } from "./lib/git-env.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** The lefthook package directory, relative to a project root. */
const LEFTHOOK_PACKAGE = path.join("node_modules", "lefthook");

/** The config lefthook reads; it writes a blank one when it finds none. */
const LEFTHOOK_CONFIG = "lefthook.yml";

/**
 * The environment variable that turns this check off deliberately.
 *
 * @remarks
 * Fail-closed is the house style here (`strictDepBuilds`, `devEngines`'
 * `onFail: error`), but a developer who genuinely cannot have a Git hook must
 * not be left unable to install dependencies at all. This is the difference
 * between an absence somebody chose and typed out, and the silent one this
 * script exists to remove — so every failure message names it.
 */
const OPT_OUT = "ALLOW_MISSING_GIT_HOOKS";

/**
 * A top-level `pre-commit:` key in `lefthook.yml`.
 *
 * @remarks
 * Matched with a regular expression rather than parsed: `scripts/**` may import
 * nothing outside `node:*`, so there is no YAML parser to reach for, and the
 * question here is only whether the file declares the hook at all. Anchored to
 * column zero so a `pre-commit` nested under something else does not count, and
 * both quoted spellings are accepted because YAML allows them.
 */
const PRE_COMMIT_BLOCK = /^(?:pre-commit|"pre-commit"|'pre-commit')[ \t]*:/m;

/**
 * Report whether an environment value reads as "on".
 *
 * @remarks
 * The truthiness lefthook's own `postinstall` uses for `CI` and `LEFTHOOK`:
 * unset, empty, `0` and `false` are all off. Matching it means `CI=0` means the
 * same thing to this script as it does to the tool it is checking up on.
 *
 * @param {string | undefined} value - The raw environment value.
 * @returns {boolean} True when the value is set to anything but an off spelling.
 */
function isEnabled(value) {
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

/**
 * Resolve a path through symlinks, falling back to the path as given.
 *
 * @param {string} target - Path to canonicalize.
 * @returns {string} The canonical path, or `target` when it cannot be resolved.
 */
function canonical(target) {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Git's own wording for "there is no repository here at all".
 *
 * @remarks
 * Matched against text, not the exit status alone: `git` also exits non-zero
 * for a `safe.directory` mismatch ("detected dubious ownership"), for a
 * permission error, and — via a spawn failure — for `git` missing from
 * `PATH`, and none of those mean the directory is not a repository. They mean
 * the check could not complete, and frequently mean lefthook's own
 * postinstall could not install the hook either, so they must fail rather
 * than read as the one case verification is genuinely meaningless for.
 */
const NOT_A_WORK_TREE = "not a git repository";

/**
 * Run `git` and report enough to tell "no repository here" from any other failure.
 *
 * @param {readonly string[]} args - Arguments after `git`.
 * @param {object} options - Spawn options.
 * @param {string} options.cwd - Directory to run in.
 * @param {NodeJS.ProcessEnv} options.env - Environment for the child.
 * @returns {{ stdout: string | undefined; stderr: string }} `stdout` is the
 * trimmed output on success, `undefined` on any failure. `stderr` is git's own
 * message on a non-zero exit, or a locally built one when `git` itself could
 * not be spawned, so a caller can distinguish a genuine "not a repository"
 * from `git` being absent or erroring for any other reason.
 */
function runGit(args, { cwd, env }) {
  const result = spawnSync("git", [...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error !== undefined) {
    return { stdout: undefined, stderr: result.error.message };
  }
  if (result.status !== 0) {
    return { stdout: undefined, stderr: result.stderr.trim() };
  }
  return { stdout: result.stdout.trim(), stderr: "" };
}

/**
 * Read a file, returning an empty string when it cannot be read as text.
 *
 * @param {string} target - Path to read.
 * @returns {string} The file's contents, or `""` when the read failed.
 */
function readOrEmpty(target) {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return "";
  }
}

/**
 * Render a path for a message: relative to `root` when it sits inside it.
 *
 * @remarks
 * A hooks directory reached through `core.hooksPath`, or through a linked
 * worktree's common directory, is outside the project and has to be printed in
 * full for the repair to be actionable. One inside the project does not, and
 * the stderr contract keeps an absolute home path out of a report it can.
 *
 * @param {string} root - Project root.
 * @param {string} target - Path to render.
 * @returns {string} A repository-relative path, or the absolute one.
 */
function display(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") ? relative : target;
}

/**
 * Verify that the pre-commit hook `lefthook.yml` declares is really installed.
 *
 * @remarks
 * Exported so `tests/verify-hooks.test.ts` can drive every branch against
 * throwaway `git init` repositories, the same dependency-injection shape
 * `scripts/label-pr.mjs`'s `main` uses. Nothing here writes: the worst a
 * misconfigured run can do is report.
 *
 * `git` runs under {@link isolatedGitEnv}. An inherited `GIT_DIR` outranks a
 * `cwd`, and a `pnpm install` started from inside a hook would otherwise ask
 * about whichever repository spawned it rather than the one being installed.
 *
 * @param {object} [options] - Overrides for testing.
 * @param {string} [options.root] - Project root; defaults to this repository.
 * @param {Readonly<Record<string, string | undefined>>} [options.env] -
 * Environment to read; defaults to `process.env`.
 * @param {typeof runGit} [options.git] - Runner for `git`.
 * @param {(message: string) => void} [options.log] - Reporter; defaults to
 * `console.error`, so a note never pollutes a caller's stdout.
 * @returns {number} Process exit code: 0 when the hook is in force or the check
 * was deliberately skipped, 1 when the gate is absent.
 */
export function verifyHooks({
  root = repoRoot,
  env = process.env,
  git = runGit,
  log = (message) => {
    console.error(message);
  },
} = {}) {
  if (isEnabled(env[OPT_OUT])) {
    log(`verify-hooks: ${OPT_OUT} is set; not checking the pre-commit hook.`);
    return 0;
  }
  if (isEnabled(env["CI"])) {
    log("verify-hooks: CI is set; not checking the pre-commit hook.");
    return 0;
  }

  const gitEnv = isolatedGitEnv(env);
  const topLevel = git(["rev-parse", "--show-toplevel"], { cwd: root, env: gitEnv });
  if (topLevel.stdout === undefined) {
    if (topLevel.stderr.includes(NOT_A_WORK_TREE)) {
      log("verify-hooks: not a Git work tree; not checking the pre-commit hook.");
      return 0;
    }
    log(
      "ERR_HOOKS_GIT_UNAVAILABLE: `git rev-parse --show-toplevel` failed.\n" +
        "Expected: git to answer whether this directory is a work tree, so the hook can be verified.\n" +
        `Actual: ${topLevel.stderr === "" ? "git could not be run at all" : topLevel.stderr}\n` +
        "Next: fix what git reports — a `git config --global --add safe.directory` line for " +
        "dubious ownership, or installing git — then try again. " +
        `Set ${OPT_OUT}=1 to install without the hook, deliberately.`,
    );
    return 1;
  }
  // Compared with `root` so a copy of this project unpacked *inside* somebody
  // else's checkout reports on their hooks instead of its own missing ones.
  if (canonical(topLevel.stdout) !== canonical(root)) {
    log(
      "verify-hooks: this directory sits inside another Git repository rather than being one; " +
        "not checking the pre-commit hook.",
    );
    return 0;
  }

  if (!existsSync(path.join(root, LEFTHOOK_PACKAGE))) {
    log(
      `verify-hooks: ${LEFTHOOK_PACKAGE} is absent (a --prod install?); not checking the pre-commit hook.`,
    );
    return 0;
  }

  const configPath = path.join(root, LEFTHOOK_CONFIG);
  if (!existsSync(configPath)) {
    log(
      `ERR_HOOKS_CONFIG_MISSING: no ${LEFTHOOK_CONFIG} at the project root.\n` +
        `Expected: the committed ${LEFTHOOK_CONFIG} that declares the pre-commit jobs.\n` +
        "Actual: no such file. `lefthook install` writes a blank one when it finds none, and reports success doing it.\n" +
        `Next: restore it with \`git checkout -- ${LEFTHOOK_CONFIG}\`, then run \`pnpm hooks:install\`. ` +
        `Set ${OPT_OUT}=1 to install without the hook, deliberately.`,
    );
    return 1;
  }
  if (!PRE_COMMIT_BLOCK.test(readOrEmpty(configPath))) {
    log(
      `ERR_HOOKS_CONFIG_INCOMPLETE: ${LEFTHOOK_CONFIG} declares no \`pre-commit\` block.\n` +
        "Expected: a top-level `pre-commit:` key, whose jobs are the gate every author goes through.\n" +
        "Actual: a config without one — which is what `lefthook install` leaves behind when it creates its own blank config, exit 0 and all.\n" +
        `Next: restore the committed ${LEFTHOOK_CONFIG} with \`git checkout -- ${LEFTHOOK_CONFIG}\`, then run \`pnpm hooks:install\`. ` +
        `Set ${OPT_OUT}=1 to install without the hook, deliberately.`,
    );
    return 1;
  }

  const hooksDirectory = git(["rev-parse", "--git-path", "hooks"], {
    cwd: root,
    env: gitEnv,
  });
  if (hooksDirectory.stdout === undefined) {
    log(
      "ERR_HOOKS_PATH_UNRESOLVED: `git rev-parse --git-path hooks` failed.\n" +
        "Expected: the directory git runs hooks from, which `core.hooksPath` may legitimately redirect.\n" +
        `Actual: ${hooksDirectory.stderr === "" ? "git could not answer" : hooksDirectory.stderr}\n` +
        "Next: run `git rev-parse --git-path hooks` here and fix what it reports. " +
        `Set ${OPT_OUT}=1 to install without the hook, deliberately.`,
    );
    return 1;
  }
  // `--git-path` answers relatively in an ordinary checkout (`.git/hooks`) and
  // absolutely from a linked worktree, where hooks live in the shared common
  // directory. Resolving against `root` covers both.
  const hookPath = path.resolve(root, hooksDirectory.stdout, "pre-commit");

  if (!existsSync(hookPath)) {
    log(
      `ERR_HOOKS_NOT_INSTALLED: no pre-commit hook at ${display(root, hookPath)}.\n` +
        "Expected: the hook lefthook's own postinstall writes on every non-CI `pnpm install`.\n" +
        "Actual: nothing there. lefthook's postinstall ignores `lefthook install`'s exit status, so a failed install leaves `pnpm install` green and the gate absent.\n" +
        "Next: run `pnpm hooks:install` and read what it reports; a `core.hooksPath` lefthook cannot write to (`git config --get core.hooksPath`) is the usual cause. " +
        `Set ${OPT_OUT}=1 to install without the hook, deliberately.`,
    );
    return 1;
  }
  const hookMode = statSync(hookPath).mode;
  if ((hookMode & 0o111) === 0) {
    log(
      `ERR_HOOKS_NOT_EXECUTABLE: the pre-commit hook at ${display(root, hookPath)} is not executable.\n` +
        "Expected: the executable bit lefthook sets when it writes the hook.\n" +
        "Actual: a file present but not executable — git silently skips a hook like that at commit time, with nothing on screen.\n" +
        `Next: run \`chmod +x ${display(root, hookPath)}\` or \`pnpm hooks:install\` to have lefthook rewrite it. ` +
        `Set ${OPT_OUT}=1 to install without the hook, deliberately.`,
    );
    return 1;
  }
  if (!readOrEmpty(hookPath).includes("lefthook")) {
    log(
      `ERR_HOOKS_NOT_LEFTHOOK: the pre-commit hook at ${display(root, hookPath)} does not call lefthook.\n` +
        `Expected: lefthook's generated hook, which is what runs the jobs ${LEFTHOOK_CONFIG} declares.\n` +
        "Actual: some other pre-commit hook, so this repository's gate does not run at commit time.\n" +
        "Next: run `pnpm hooks:install` to have lefthook take the hook over; it renames the existing one to `pre-commit.old` rather than discarding it. " +
        `Set ${OPT_OUT}=1 to install without the hook, deliberately.`,
    );
    return 1;
  }

  return 0;
}

if (import.meta.main) {
  process.exitCode = verifyHooks();
}
