// The pure classifiers behind the Dependabot survey: a bot PR title, a semver
// level, an ecosystem, a status-check rollup, and the files two PRs contest.
//
// They live here rather than beside their only caller,
// `.agents/skills/merge-dependabot/scripts/survey-prs.mjs`, because a `.mjs`
// bundled inside a skill sits outside `coverage.include` and is therefore
// measured by no floor at all — so a skill script stays a thin dispatcher and
// anything with real branching moves under `scripts/`, where `scripts/**`'s
// floor applies. `authoring-skills` owns that rule.
//
// Nothing here does I/O: the caller keeps the `gh` invocation and the printing.

import { readString } from "./json.mjs";

// Matches Dependabot titles such as "bump vitest from 4.1.9 to 4.1.10" and
// "update eslint requirement from ^10.6.0 to ^10.7.0".
const BUMP =
  /(?:bump|update)\s+(?<pkg>\S+?)(?:\s+requirement)?\s+from\s+(?<old>\S+)\s+to\s+(?<next>\S+)/i;

// A range like `^10.7` has no patch component, so that group stays optional.
const VERSION = /(\d+)\.(\d+)(?:\.(\d+))?/;

// The only conclusions that let a pull request through the survey's merge
// gate. This is an allow-list on purpose, and it is the whole point of the
// module: `checkSummary` used to name the failures instead and accept
// everything it did not recognise, so a `STARTUP_FAILURE`, a `STALE`, or a
// rollup entry with no conclusion at all was reported as `PASSING` — a
// classifier whose default branch is *accept* turns a CI state nobody has
// heard of into a merge recommendation.
//
// `NEUTRAL` and `SKIPPED` belong here: a skipped job is how a conditional
// workflow reports "not applicable", not a failure.
const PASSING_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

// States that mean the check has not concluded yet, so the answer is "come
// back later" rather than either verdict. A check run reports these through
// `status` (handled separately below, since it carries no conclusion while it
// runs); a commit status reports `PENDING` or `EXPECTED` through `state`.
const PENDING_STATES = new Set([
  "PENDING",
  "IN_PROGRESS",
  "QUEUED",
  "WAITING",
  "EXPECTED",
]);

// What a rollup entry with neither a conclusion nor a state is called in the
// `failing` list, so the row an operator reads names something rather than
// trailing an empty `=`.
const UNKNOWN_STATE = "UNKNOWN";

/**
 * Pull the package and the two versions out of a bot pull request title.
 *
 * @param {string} title - Pull request title.
 * @returns {{ pkg: string | undefined, from: string | undefined, to: string | undefined }}
 * The parsed parts, each undefined when the title does not match.
 */
export function parseVersions(title) {
  const groups = BUMP.exec(title)?.groups;
  return { pkg: groups?.["pkg"], from: groups?.["old"], to: groups?.["next"] };
}

/**
 * Classify a bump as major, minor or patch.
 *
 * @param {string | undefined} from - Version before the bump.
 * @param {string | undefined} to - Version after the bump.
 * @returns {string} `major`, `minor`, `patch`, or `unknown` when unparsable.
 */
export function semverLevel(from, to) {
  if (from === undefined || to === undefined) {
    return "unknown";
  }
  const before = VERSION.exec(from);
  const after = VERSION.exec(to);
  if (before === null || after === null) {
    return "unknown";
  }
  const part = (/** @type {RegExpExecArray} */ match, /** @type {number} */ index) =>
    Number(match[index] ?? "0");
  if (part(before, 1) !== part(after, 1)) {
    return "major";
  }
  return part(before, 2) === part(after, 2) ? "patch" : "minor";
}

/**
 * Reduce a status check rollup to one overall state plus the failing checks.
 *
 * @remarks
 * Fails closed. Only the conclusions in `PASSING_STATES` pass and only the
 * states in `PENDING_STATES` hold; every other value — a known failure such as
 * `FAILURE` or `TIMED_OUT`, a conclusion this repository has never seen, a
 * conclusion GitHub adds after this was written, or an entry carrying none at
 * all — lands in `failing`. That matters most for a mixed rollup: a broken
 * check beside a passing one is now named in the row an operator reads,
 * instead of being erased by the passing entry beside it.
 *
 * The four-value vocabulary is unchanged: `NONE`, `PASSING`, `PENDING`,
 * `FAILING`.
 *
 * @param {readonly unknown[]} rollup - GitHub's `statusCheckRollup` array.
 * @returns {{ state: string, failing: string[] }} The summary.
 */
export function checkSummary(rollup) {
  if (rollup.length === 0) {
    return { state: "NONE", failing: [] };
  }
  /** @type {string[]} */
  const failing = [];
  let pending = false;
  for (const check of rollup) {
    // Check runs report conclusion/status; commit statuses report state.
    const state = (
      readString(check, "conclusion") ??
      readString(check, "state") ??
      ""
    ).toUpperCase();
    const status = (readString(check, "status") ?? "").toUpperCase();
    const name = readString(check, "name") ?? readString(check, "context") ?? "?";
    if (state === "" && status !== "" && status !== "COMPLETED") {
      // A check run still in flight carries a status but no conclusion yet.
      pending = true;
    } else if (PENDING_STATES.has(state)) {
      pending = true;
    } else if (!PASSING_STATES.has(state)) {
      failing.push(`${name}=${state === "" ? UNKNOWN_STATE : state}`);
    }
  }
  if (failing.length > 0) {
    return { state: "FAILING", failing };
  }
  return { state: pending ? "PENDING" : "PASSING", failing: [] };
}

/**
 * Classify a Dependabot branch name into an ecosystem.
 *
 * @param {string} branch - Head branch name.
 * @returns {string} `github_actions`, `npm`, or `other`.
 */
export function ecosystemOf(branch) {
  if (branch.includes("github_actions")) {
    return "github_actions";
  }
  // Dependabot still names the npm updater `npm_and_yarn`, pnpm included.
  return branch.includes("npm_and_yarn") ? "npm" : "other";
}

/**
 * Map each file touched by more than one pull request to those pull requests.
 *
 * @param {readonly { number: number, files: readonly string[] }[]} rows - Triage
 * rows, of which only the pull request number and its touched paths are read.
 * @returns {Map<string, number[]>} Contested paths, in insertion order.
 */
export function contestedFiles(rows) {
  /** @type {Map<string, number[]>} */
  const seen = new Map();
  for (const row of rows) {
    for (const path of row.files) {
      seen.set(path, [...(seen.get(path) ?? []), row.number]);
    }
  }
  return new Map([...seen].filter(([, numbers]) => numbers.length > 1));
}
