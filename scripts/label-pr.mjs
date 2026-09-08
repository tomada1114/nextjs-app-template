#!/usr/bin/env node
// Apply the label matching a pull request's Conventional Commit title type,
// and remove any other label from this workflow's own managed set that no
// longer matches after a retitle. Called by .github/workflows/pr-label.yml.
//
// Usage:
//   PR_NUMBER=123 PR_TITLE="feat: x" node scripts/label-pr.mjs
//
// Requires the `gh` CLI, authenticated (GH_TOKEN/GH_REPO in the
// environment). Best effort: a `gh` failure — a fork PR's read-only token, or
// a label `pnpm repo:labels` has not created yet — is reported as a GitHub
// Actions notice, never a non-zero exit.
import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";

import { isMain } from "./lib/is-main.mjs";
import { parseJson, readKey, readString } from "./lib/json.mjs";

/**
 * Conventional Commit type -> the label `.github/labels.yml` declares for
 * it. The values of this map are also the *only* labels this workflow is
 * ever allowed to add or remove; a human-added label is never touched.
 */
const TYPE_LABELS = new Map([
  ["feat", "enhancement"],
  ["fix", "bug"],
  ["docs", "documentation"],
  ["chore", "chore"],
  ["ci", "ci"],
  ["deps", "dependencies"],
]);

/** The full set of labels this workflow is ever allowed to add or remove. */
export const MANAGED_LABELS = new Set(TYPE_LABELS.values());

// A scope and a breaking-change `!` may each be present or absent, in either
// order: `feat:`, `feat(scope):`, `feat!:`, `feat(scope)!:`. This workflow
// does not carry a distinct "breaking change" label — none exists in
// .github/labels.yml today — so a breaking title still gets its ordinary
// type label rather than none at all (see the PR that introduced this file).
const TITLE_PATTERN = /^([a-z]+)(?:\([^)]*\))?!?:/;

/**
 * @param {string} title - A pull request title.
 * @returns {string | null} the lowercase Conventional Commit type, or null
 *   when the title carries no recognizable prefix at all.
 */
export function extractType(title) {
  const match = TITLE_PATTERN.exec(title);
  return match === null ? null : (match[1] ?? null);
}

/**
 * @param {string} title - A pull request title.
 * @returns {string | null} the label this title's type maps to, or null when
 *   the type is not one this workflow manages.
 */
export function resolveLabel(title) {
  const type = extractType(title);
  return type === null ? null : (TYPE_LABELS.get(type) ?? null);
}

/**
 * Decide the label update for a pull request: which label to add, if any,
 * and which of this workflow's *other* managed labels are stale and should
 * be removed. A label outside {@link MANAGED_LABELS} is never proposed for
 * removal, whatever the title says.
 *
 * @param {string} title - The pull request's current title.
 * @param {readonly string[]} currentLabels - Labels currently on the pull request.
 * @returns {{ addLabel: string | null, removeLabels: string[] }}
 */
export function computeLabelUpdate(title, currentLabels) {
  const addLabel = resolveLabel(title);
  const removeLabels = currentLabels.filter(
    (label) => label !== addLabel && MANAGED_LABELS.has(label),
  );
  return { addLabel, removeLabels };
}

/**
 * Result of one `gh` invocation.
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
 * Run `gh` with the real CLI. The default {@link GhRunner} used by {@link applyLabelUpdate}.
 *
 * @param {readonly string[]} args - Arguments passed to `gh`.
 * @returns {GhResult} The raw result.
 */
export function spawnGh(args) {
  const result = spawnSync("gh", [...args], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

/**
 * The pull request's current label names, read with `gh pr view --json labels`.
 *
 * @param {string} prNumber - The pull request number.
 * @param {GhRunner} run - The runner to use.
 * @returns {string[]} Label names currently on the pull request.
 * @throws Error when `gh` cannot be spawned or the call fails.
 */
export function fetchCurrentLabels(prNumber, run) {
  const result = run(["pr", "view", prNumber, "--json", "labels"]);
  if (result.error !== undefined) {
    throw new Error(`could not run \`gh\`: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`\`gh pr view\` failed: ${result.stderr.trim()}`);
  }
  const payload = parseJson(result.stdout === "" ? "null" : result.stdout);
  const rawLabels = readKey(payload, "labels");
  if (!Array.isArray(rawLabels)) {
    return [];
  }
  return rawLabels
    .map((label) => readString(label, "name"))
    .filter((name) => name !== undefined);
}

/**
 * Apply the label update for one pull request.
 *
 * @param {object} options
 * @param {string} options.prNumber - The pull request number.
 * @param {string} options.title - The pull request's current title.
 * @param {GhRunner} [options.run] - The `gh` runner to use; defaults to the real CLI.
 * @returns {void}
 */
export function applyLabelUpdate({ prNumber, title, run = spawnGh }) {
  /** @type {string[]} */
  let currentLabels;
  try {
    currentLabels = fetchCurrentLabels(prNumber, run);
  } catch (error) {
    console.log(
      `::notice::Could not read the pull request's current labels: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    currentLabels = [];
  }

  const { addLabel, removeLabels } = computeLabelUpdate(title, currentLabels);

  if (addLabel === null && removeLabels.length === 0) {
    console.log(
      `label-pr: no label mapping for title "${title}", and nothing stale to remove.`,
    );
    return;
  }

  const args = ["pr", "edit", prNumber];
  if (addLabel !== null) {
    args.push("--add-label", addLabel);
  }
  for (const label of removeLabels) {
    args.push("--remove-label", label);
  }

  const result = run(args);
  if (result.error !== undefined || result.status !== 0) {
    const reason =
      result.error !== undefined ? result.error.message : result.stderr.trim();
    console.log(
      `::notice::Could not update labels (add ${addLabel ?? "none"}, remove ${
        removeLabels.length > 0 ? removeLabels.join(", ") : "none"
      }): ${reason} (missing on the repository, or a fork PR's read-only token).`,
    );
  }
}

if (isMain(import.meta.url)) {
  applyLabelUpdate({
    prNumber: process.env["PR_NUMBER"] ?? "",
    title: process.env["PR_TITLE"] ?? "",
  });
}
