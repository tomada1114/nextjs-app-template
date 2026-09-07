// Run a JavaScript file on the current Node, without going through a shell.
//
// Every command is spawned as `process.execPath <script.js> …` rather than as a
// bare name. That skips PATH lookup, skips the `.cmd` shims that make bare
// names unspawnable on Windows without `shell: true`, and guarantees the child
// runs on the same Node this script is running on.
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository root. */
export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * Result of a spawned command.
 *
 * @typedef {object} RunResult
 * @property {number} status - Exit code; 1 when the process was killed by a signal.
 * @property {string} stdout - Captured standard output.
 * @property {string} stderr - Captured standard error.
 */

/**
 * Run a JavaScript file on the current Node.
 *
 * @param {string} script - Absolute path of the script to run.
 * @param {readonly string[]} args - Arguments passed to the script.
 * @param {object} [options] - Spawn options.
 * @param {string} [options.cwd] - Working directory.
 * @param {NodeJS.ProcessEnv} [options.env] - Environment; defaults to this one.
 * @returns {RunResult} The captured result.
 */
export function runNode(script, args, options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    // A hung child must not hang CI. The slowest callers here spawn git or
    // node in a temporary directory and finish well inside this.
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    // The process never ran, or was killed for exceeding the timeout above.
    // Reporting the reason beats returning an empty stderr and a bare exit 1.
    return {
      status: 1,
      stdout: "",
      stderr: `${result.error.name}: ${result.error.message}`,
    };
  }
  // `status` is null only when a signal ended the process, which the branch
  // above has already covered for every case this helper can produce.
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}
