#!/usr/bin/env node
// Create or update every ruleset this repository commits under
// `.github/rulesets/` — today only `main.json`, the default branch's
// protection — from the JSON body `POST /repos/{owner}/{repo}/rulesets` and
// `PUT /repos/{owner}/{repo}/rulesets/{id}` accept.
//
// Usage:
//   node scripts/apply-ruleset.mjs
//
// A human-run, admin-only step: applying a ruleset needs repository admin
// rights, so it never runs from CI or a hook, and running it against the live
// repository needs sign-off like any other remote write. "Use this template"
// copies no rulesets, so every repository made from the template runs it once.
//
// Idempotent and additive: each file is matched by its own `name` and `target`
// against the repository's own rulesets — a match is updated in place with
// PUT, otherwise one is created with POST. It never deletes a ruleset,
// including one no file names. Every file is validated before the first `gh`
// call, so a malformed one applies nothing. `gh` comes from the caller's PATH
// and must already be authenticated. Rulesets on a private repository need a
// paid plan; that refusal is ERR_RULESET_PLAN_UNSUPPORTED rather than a raw 403.
import { spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseJson, readString } from "./lib/json.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const RULESET_DIRECTORY = ".github/rulesets";

/**
 * Every failure this script reports. The code is the contract; the rest of
 * the message is prose for whoever reads stderr.
 *
 * @typedef {"ERR_RULESET_ARGUMENT" | "ERR_RULESET_FILE_MISSING" | "ERR_RULESET_FILE_INVALID" | "ERR_RULESET_GH_MISSING" | "ERR_RULESET_NO_REPO" | "ERR_RULESET_PLAN_UNSUPPORTED" | "ERR_RULESET_FORBIDDEN"} RulesetErrorCode
 */

/** Error with a stable `ERR_RULESET_*` code and an actionable message. */
export class RulesetError extends Error {
  /**
   * @param {RulesetErrorCode} code - Stable identifier a caller branches on.
   * @param {object} detail - The parts of the report.
   * @param {string} detail.summary - What failed, in one sentence.
   * @param {string} detail.expected - What was expected.
   * @param {string} detail.actual - What was found instead.
   * @param {string} detail.next - The next safe command or edit.
   */
  constructor(code, { summary, expected, actual, next }) {
    super(
      `${code}: ${summary}\n` +
        `Expected: ${expected}\n` +
        `Actual: ${actual}\n` +
        `Next: ${next}`,
    );
    this.name = "RulesetError";
    /** @type {RulesetErrorCode} */
    this.code = code;
  }
}

/**
 * One validated ruleset file.
 *
 * @typedef {object} RulesetFile
 * @property {string} relative - Repository-relative path, for messages.
 * @property {string} file - Absolute path, handed to `gh api --input`.
 * @property {string} name - The ruleset's `name`.
 * @property {string} target - The ruleset's `target` (`branch`, `tag`, …).
 */

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
 * mocking `node:child_process`.
 *
 * @typedef {(args: readonly string[]) => GhResult} GhRunner
 */

/**
 * Run `gh` with the real CLI. The default {@link GhRunner} used by {@link main}.
 *
 * @param {readonly string[]} args - Arguments passed to `gh`.
 * @returns {GhResult} The raw result.
 */
export function spawnGh(args) {
  const result = spawnSync("gh", [...args], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

/**
 * The `*.json` file names under the rulesets directory, sorted.
 *
 * @param {string} root - Repository root.
 * @returns {string[]} File names, never empty.
 * @throws {RulesetError} ERR_RULESET_FILE_MISSING when there is none.
 */
export function listRulesetFiles(root) {
  const directory = path.join(root, RULESET_DIRECTORY);
  const present = existsSync(directory);
  const files = present
    ? readdirSync(directory)
        .filter((entry) => entry.endsWith(".json"))
        .sort()
    : [];
  if (files.length === 0) {
    throw new RulesetError("ERR_RULESET_FILE_MISSING", {
      summary: `${RULESET_DIRECTORY} holds no ruleset definition.`,
      expected: `at least one committed *.json ruleset under ${RULESET_DIRECTORY}.`,
      actual: present
        ? `no *.json file in ${RULESET_DIRECTORY}.`
        : `no ${RULESET_DIRECTORY} directory.`,
      next: `restore ${RULESET_DIRECTORY} from version control.`,
    });
  }
  return files;
}

/**
 * Read and validate one ruleset file.
 *
 * @param {string} root - Repository root.
 * @param {string} entry - File name under the rulesets directory.
 * @returns {RulesetFile} The validated file.
 * @throws {RulesetError} ERR_RULESET_FILE_INVALID when it is not usable.
 */
export function readRulesetFile(root, entry) {
  const relative = `${RULESET_DIRECTORY}/${entry}`;
  const file = path.join(root, RULESET_DIRECTORY, entry);
  /** @type {unknown} */
  let parsed;
  /** @type {string | undefined} */
  let problem;
  try {
    parsed = parseJson(readFileSync(file, "utf8"));
  } catch (error) {
    problem = `it is not JSON (${error instanceof Error ? error.message : String(error)}).`;
  }
  const isObject =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  const name = isObject ? readString(parsed, "name") : undefined;
  const target = isObject ? readString(parsed, "target") : undefined;
  if (problem === undefined && !isObject) {
    problem = "it is not a JSON object.";
  } else if (problem === undefined && (name === undefined || name === "")) {
    problem = 'it has no non-empty string "name".';
  } else if (problem === undefined && (target === undefined || target === "")) {
    problem = 'it has no non-empty string "target".';
  }
  if (problem !== undefined || name === undefined || target === undefined) {
    throw new RulesetError("ERR_RULESET_FILE_INVALID", {
      summary: `${relative} is not a usable ruleset definition.`,
      expected: 'a JSON object with a non-empty string "name" and "target".',
      actual: problem ?? "it is not a JSON object.",
      next: `fix ${relative}, or restore it from version control.`,
    });
  }
  return { relative, file, name, target };
}

/**
 * Validate every ruleset file before anything is sent.
 *
 * @param {string} root - Repository root.
 * @returns {RulesetFile[]} Every file, validated.
 * @throws {RulesetError} On the first missing or invalid file.
 */
export function loadRulesets(root) {
  return listRulesetFiles(root).map((entry) => readRulesetFile(root, entry));
}

/**
 * Run one `gh` call, turning a failure into the matching `ERR_RULESET_*` code.
 *
 * @param {GhRunner} run - The runner to use.
 * @param {string} action - What the call does, for the message.
 * @param {readonly string[]} args - Arguments passed to `gh`.
 * @returns {GhResult} The successful result.
 * @throws {RulesetError} When `gh` cannot start or the call is refused.
 */
export function gh(run, action, args) {
  const result = run(args);
  if (result.error !== undefined || result.status === null) {
    throw new RulesetError("ERR_RULESET_GH_MISSING", {
      summary: "the GitHub CLI could not be started.",
      expected: "`gh` on PATH, authenticated against this repository.",
      actual: result.error?.message ?? result.stderr.trim(),
      next: "install the GitHub CLI, then run `gh auth status`.",
    });
  }
  if (result.status === 0) {
    return result;
  }
  const message = result.stderr.trim();
  if (/upgrade/i.test(message)) {
    throw new RulesetError("ERR_RULESET_PLAN_UNSUPPORTED", {
      summary: `${action} was refused: rulesets on a private repository need a paid GitHub plan.`,
      expected:
        "a public repository, or a private one on a plan that supports rulesets.",
      actual: message,
      next: "make the repository public or move it to a paid plan, then run `pnpm repo:ruleset` again.",
    });
  }
  throw new RulesetError("ERR_RULESET_FORBIDDEN", {
    summary: `${action} was refused.`,
    expected: "the GitHub API to accept the request from a repository admin.",
    actual: message,
    next: "run `gh auth status` and confirm this account is an admin of the repository.",
  });
}

/**
 * Resolve the `owner/repo` slug `gh` is pointed at.
 *
 * @param {GhRunner} run - The runner to use.
 * @returns {string} The slug.
 * @throws {RulesetError} ERR_RULESET_NO_REPO when `gh` reports none.
 */
export function resolveRepo(run) {
  const result = gh(run, "resolving the repository (`gh repo view`)", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
  ]);
  /** @type {unknown} */
  let payload;
  try {
    payload = parseJson(result.stdout);
  } catch {
    payload = undefined;
  }
  const slug = readString(payload, "nameWithOwner");
  if (slug === undefined || slug === "") {
    throw new RulesetError("ERR_RULESET_NO_REPO", {
      summary: "`gh repo view` did not report a repository.",
      expected: "a `nameWithOwner` field in its JSON output.",
      actual: result.stdout.trim() === "" ? "no output." : result.stdout.trim(),
      next: "run this from a checkout with a GitHub remote, or `gh repo set-default`.",
    });
  }
  return slug;
}

/**
 * The `jq` filter selecting the id of this repository's own ruleset with a
 * given name and target. Organization rulesets are excluded twice — by
 * `includes_parents=false` on the request and by `source_type` here — because
 * the repository-scoped PUT cannot address them.
 *
 * @param {RulesetFile} ruleset - The file being applied.
 * @returns {string} The filter.
 */
export function matchFilter(ruleset) {
  return (
    `.[] | select(.name == ${JSON.stringify(ruleset.name)} and ` +
    `.target == ${JSON.stringify(ruleset.target)} and ` +
    '.source_type == "Repository") | .id'
  );
}

/**
 * Create or update one ruleset. Never deletes anything.
 *
 * @param {string} repo - `owner/repo` slug.
 * @param {RulesetFile} ruleset - The validated file.
 * @param {GhRunner} run - The runner to use.
 * @returns {"created" | "updated"} What was done.
 * @throws {RulesetError} When a `gh` call fails.
 */
export function applyRuleset(repo, ruleset, run) {
  const existing = gh(run, `listing the rulesets of ${repo}`, [
    "api",
    "--paginate",
    `repos/${repo}/rulesets?includes_parents=false`,
    "--jq",
    matchFilter(ruleset),
  ])
    .stdout.split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");

  if (existing === undefined) {
    gh(run, `creating the ruleset ${ruleset.name} from ${ruleset.relative}`, [
      "api",
      `repos/${repo}/rulesets`,
      "--method",
      "POST",
      "--input",
      ruleset.file,
    ]);
    console.log(`repo:ruleset: created ruleset ${ruleset.name} in ${repo}.`);
    return "created";
  }
  gh(
    run,
    `updating the ruleset ${ruleset.name} (id ${existing}) from ${ruleset.relative}`,
    [
      "api",
      `repos/${repo}/rulesets/${existing}`,
      "--method",
      "PUT",
      "--input",
      ruleset.file,
    ],
  );
  console.log(
    `repo:ruleset: updated ruleset ${ruleset.name} (id ${existing}) in ${repo}.`,
  );
  return "updated";
}

/**
 * Apply every committed ruleset to the repository `gh` is pointed at.
 *
 * @param {readonly string[]} argv - Arguments after the script name.
 * @param {object} [options] - Injection points for tests.
 * @param {string} [options.root] - Repository root; defaults to this checkout.
 * @param {GhRunner} [options.run] - `gh` runner; defaults to the real CLI.
 * @returns {number} Process exit code.
 */
export function main(argv, { root = ROOT, run = spawnGh } = {}) {
  if (argv.length > 0) {
    console.error(
      new RulesetError("ERR_RULESET_ARGUMENT", {
        summary: `unknown argument(s): ${argv.join(" ")}.`,
        expected: "no arguments.",
        actual: `${String(argv.length)} argument(s).`,
        next: "run `pnpm repo:ruleset` with no flags.",
      }).message,
    );
    return 2;
  }
  try {
    const rulesets = loadRulesets(root);
    const repo = resolveRepo(run);
    for (const ruleset of rulesets) {
      applyRuleset(repo, ruleset, run);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
