#!/usr/bin/env node
// Install this repository's Git hooks. `package.json`'s `prepare` script runs
// this on every `pnpm install`, which is what makes AGENTS.md's "Enforcement
// layers" row true of a fresh clone — the pre-commit hook applies to every
// author rather than to whoever remembered a second command afterwards.
//
// Three contexts get a skip instead of a failure, because a Git hook is
// meaningless in each and breaking `pnpm install` there would cost more than
// the missing hook: a directory that is not the root of a Git repository (a
// tarball extract, a Docker build context, a subtree copied inside somebody
// else's checkout), an install that left no `lefthook` in `node_modules` (a
// `--prod` install), and CI, which installs with `--frozen-lockfile` and never
// commits. Everything else fails the install and says why: a hook that is
// silently absent is the bug this script exists to close, so a hooks directory
// lefthook cannot write through has to be visible rather than shrugged off.
//
// Node globals are imported explicitly, as in every other .mjs here.
import { spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isolatedGitEnv } from "./lib/git-env.mjs";
import { isMain } from "./lib/is-main.mjs";
import { runNode } from "./lib/node-tools.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** The lefthook CLI entry point, relative to a project root. */
const LEFTHOOK_ENTRY = path.join("node_modules", "lefthook", "bin", "index.js");

/** The config `lefthook install` reads; it writes a blank one when it is gone. */
const LEFTHOOK_CONFIG = "lefthook.yml";

/**
 * Report whether an environment names a CI run.
 *
 * @remarks
 * GitHub Actions sets `CI=true`, and so does every other runner worth naming.
 * An empty, `0` or `false` value is a deliberate opt-out rather than a CI
 * marker, so it does not count.
 *
 * @param {Readonly<Record<string, string | undefined>>} env - Environment to read.
 * @returns {boolean} True when this looks like a CI run.
 */
function isContinuousIntegration(env) {
  const flag = env["CI"];
  return flag !== undefined && flag !== "" && flag !== "0" && flag !== "false";
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
 * Report whether `root` is itself the top level of a Git work tree.
 *
 * @remarks
 * `git rev-parse` is asked rather than `.git` being looked for, because a
 * linked worktree's `.git` is a gitlink file and its hooks live in the shared
 * common directory. The answer is compared with `root` so a copy of this
 * project unpacked *inside* somebody else's checkout skips instead of writing
 * hooks into the enclosing repository.
 *
 * @param {string} root - Project root to test.
 * @param {NodeJS.ProcessEnv} env - Environment for the spawned `git`.
 * @returns {boolean} True when `root` is a Git work tree's top level.
 */
function isGitWorkTreeRoot(root, env) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error !== undefined || result.status !== 0) {
    return false;
  }
  return canonical(result.stdout.trim()) === canonical(root);
}

/**
 * Install the Git hooks `lefthook.yml` declares.
 *
 * @remarks
 * Exported so `tests/install-hooks.test.ts` can drive every branch against a
 * throwaway repository and a stub runner, the same dependency-injection shape
 * `scripts/label-pr.mjs`'s `main` uses.
 *
 * The `git` and `lefthook` processes both run under {@link isolatedGitEnv}: an
 * inherited `GIT_DIR` outranks a `cwd`, and installing hooks into whichever
 * repository happened to spawn this one is the failure mode that costs the
 * most to notice.
 *
 * @param {object} [options] - Overrides for testing.
 * @param {string} [options.root] - Project root; defaults to this repository.
 * @param {Readonly<Record<string, string | undefined>>} [options.env] -
 * Environment to read; defaults to `process.env`.
 * @param {typeof runNode} [options.run] - Runner for the lefthook CLI.
 * @param {(message: string) => void} [options.log] - Reporter; defaults to
 * `console.error`, so a note never pollutes a caller's stdout.
 * @returns {number} Process exit code: 0 when installed or deliberately
 * skipped, 1 when the install was owed and failed.
 */
export function installHooks({
  root = repoRoot,
  env = process.env,
  run = runNode,
  log = (message) => {
    console.error(message);
  },
} = {}) {
  if (isContinuousIntegration(env)) {
    log("install-hooks: CI is set; skipping the Git hook install.");
    return 0;
  }

  const gitEnv = isolatedGitEnv(env);
  if (!isGitWorkTreeRoot(root, gitEnv)) {
    log("install-hooks: not a Git work tree root; skipping the Git hook install.");
    return 0;
  }

  const entry = path.join(root, LEFTHOOK_ENTRY);
  if (!existsSync(entry)) {
    log(
      `install-hooks: ${LEFTHOOK_ENTRY} is absent (a --prod install?); skipping the Git hook install.`,
    );
    return 0;
  }

  if (!existsSync(path.join(root, LEFTHOOK_CONFIG))) {
    log(
      `ERR_HOOKS_CONFIG_MISSING: ${LEFTHOOK_CONFIG} is not in ${root}.\n` +
        `Expected: the committed ${LEFTHOOK_CONFIG} that declares the pre-commit jobs.\n` +
        "Actual: no such file, and `lefthook install` would write a blank one over it.\n" +
        `Next: restore ${LEFTHOOK_CONFIG} with \`git checkout -- ${LEFTHOOK_CONFIG}\`, then run \`pnpm hooks:install\`.`,
    );
    return 1;
  }

  const result = run(entry, ["install"], { cwd: root, env: gitEnv });
  if (result.status !== 0) {
    log(
      `ERR_HOOKS_INSTALL_FAILED: \`lefthook install\` exited with ${String(result.status)}.\n` +
        "Expected: the hooks lefthook.yml declares, written into this repository's hooks directory.\n" +
        `Actual: ${`${result.stdout}${result.stderr}`.trim()}\n` +
        "Next: run `pnpm hooks:install` and fix what it reports; a set `core.hooksPath` (`git config --get core.hooksPath`) is the usual cause.",
    );
    return 1;
  }

  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = installHooks();
}
