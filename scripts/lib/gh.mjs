// The one `gh` runner the GitHub-writing scripts share. Each script still
// takes a GhRunner injection point, so its tests pass an in-memory fake and
// never reach this module's spawn.
import { spawnSync } from "node:child_process";

/**
 * Result of running one `gh` invocation.
 *
 * @typedef {object} GhResult
 * @property {number | null} status - Exit code, or null when the process never started.
 * @property {string} stdout - Captured standard output.
 * @property {string} stderr - Captured standard error.
 * @property {Error} [error] - Set when the process could not be spawned at all.
 */

/**
 * A function able to run `gh`. Tests pass an in-memory fake instead of
 * mocking `node:child_process`, following the `writing-tests` skill
 * ("prefer a real in-memory fake to a mock").
 *
 * @typedef {(args: readonly string[]) => GhResult} GhRunner
 */

/**
 * Run `gh` with the real CLI.
 *
 * @remarks
 * The limits differ per caller on purpose: a label listing or a ruleset body
 * can be far larger than one pull request's labels, so each script states its
 * own rather than inheriting one shared ceiling.
 *
 * @param {readonly string[]} args - Arguments passed to `gh`.
 * @param {{ timeout?: number, maxBuffer?: number }} [limits] - Spawn limits in
 *   milliseconds and bytes.
 * @returns {GhResult} The raw result; a spawn failure is reported, never thrown.
 */
export function spawnGh(args, { timeout = 120_000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  const result = spawnSync("gh", [...args], { encoding: "utf8", timeout, maxBuffer });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}
