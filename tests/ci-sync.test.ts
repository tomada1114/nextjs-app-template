import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import vitestConfig from "../vitest.config";

// `check:source` restates, as one composite script, ground that
// `.github/workflows/ci.yml`'s jobs also cover as separate `run:` steps (split
// for failure attribution — a reader should see which step failed, not just
// that the composite did). Nothing asserted the two lists stay in sync, so a
// step added to one silently stops being enforced by the other: a contributor
// running the composite locally would pass a gate CI never runs, or the
// reverse. Both directions are checked below, over every job `ci.yml` declares
// rather than a hard-coded pair of them.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * `check:source` steps that need not appear as a `ci.yml` step of their own.
 * Each entry is a reasoned exception, checked below for stale or empty claims.
 */
const CHECK_SOURCE_ONLY_EXCEPTIONS = new Map<string, string>([
  [
    "hooks:verify",
    "CI never installs Git hooks and verify-hooks skips under CI; this gate checks the developer checkout before its source tools run.",
  ],
]);

/**
 * `ci.yml` steps that need not appear in `check:source` — a check a local run
 * legitimately does not owe, as opposed to one nobody can run before pushing.
 */
const CI_ONLY_EXCEPTIONS = new Map<string, string>([
  [
    "test",
    "ci.yml's `Run tests without coverage` step is the `matrix.os != 'ubuntu-latest'` half of a pair that keeps coverage collected exactly once when a second OS joins the matrix; the `ubuntu-latest` half runs `test:coverage`. `check:source` runs `test:coverage` too, which is this suite plus the coverage floors, so a local run is not missing a gate.",
  ],
]);

/** Read a named package script, rejecting an absent or non-string command. */
function script(name: string): string {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const scripts =
    typeof manifest === "object" && manifest !== null && "scripts" in manifest
      ? manifest.scripts
      : undefined;
  const command =
    typeof scripts === "object" && scripts !== null && name in scripts
      ? scripts[name as keyof typeof scripts]
      : undefined;
  if (typeof command !== "string") {
    throw new Error(`package.json has no "${name}" script to check.`);
  }
  return command;
}

/** Extract check:source's ordered `pnpm run <name>` tokens. */
function checkSourceSteps(): string[] {
  return [...script("check:source").matchAll(/pnpm run ([\w:-]+)/g)].map(
    (match) => match[1] ?? "",
  );
}

const ciWorkflow = readFileSync(
  path.join(repoRoot, ".github", "workflows", "ci.yml"),
  "utf8",
);

/** A job header: the two-space key that opens one job inside `jobs:`. */
const JOB_HEADER = String.raw`^ {2}([\w-]+):$`;

/**
 * The body of `ci.yml`'s top-level `jobs:` block. Top-level keys (`name`, `on`,
 * `permissions`, `concurrency`, `jobs`) sit at column 0 and a job's own body at
 * four spaces or more, so everything from `jobs:` to the next column-0 key is
 * exactly the jobs and nothing else — which is what keeps a job's body from
 * running past the end of the block when `jobs:` is not the last key.
 */
function ciJobsBlock(): string {
  const jobsKey = /^jobs:$/m.exec(ciWorkflow);
  if (jobsKey === null) {
    throw new Error("ci.yml declares no top-level `jobs:` key.");
  }
  const rest = ciWorkflow.slice(jobsKey.index + jobsKey[0].length);
  // A `#` at column 0 is a comment, not the next top-level key.
  const nextTopLevel = /^[^\s#]/m.exec(rest);
  return nextTopLevel === null ? rest : rest.slice(0, nextTopLevel.index);
}

/**
 * Every job name `ci.yml` declares — read from the file so a job added
 * tomorrow is covered the day it lands, not the day someone remembers this
 * test.
 */
function ciJobNames(): string[] {
  return [...ciJobsBlock().matchAll(new RegExp(JOB_HEADER, "gm"))].map(
    (match) => match[1] ?? "",
  );
}

/**
 * Extract every `pnpm run <name>` step inside one named job of `ci.yml`, from
 * that job's header up to the next job (or the end of the `jobs:` block).
 */
function ciJobSteps(jobName: string): string[] {
  const block = ciJobsBlock();
  const jobStart = new RegExp(`^  ${jobName}:$`, "m").exec(block);
  if (jobStart === null) {
    throw new Error(`ci.yml has no top-level job named "${jobName}".`);
  }
  const rest = block.slice(jobStart.index + jobStart[0].length);
  const nextJob = new RegExp(JOB_HEADER, "m").exec(rest);
  const body = nextJob === null ? rest : rest.slice(0, nextJob.index);
  return [...body.matchAll(/run:\s*pnpm run ([\w:-]+)/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("check:source stays in sync with ci.yml", () => {
  const steps = checkSourceSteps();
  const jobNames = ciJobNames();
  const ciStepNames = [...new Set(jobNames.flatMap((jobName) => ciJobSteps(jobName)))];
  const checkSourceStepNames = new Set(steps);
  const ciSteps = new Set(ciStepNames);

  it("found at least one check:source step to check", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  // A parser that silently finds no jobs would make the assertions below pass
  // over an empty set, which is the bug this file exists to rule out.
  it("reads every job ci.yml declares, including static and test", () => {
    expect(jobNames).toContain("static");
    expect(jobNames).toContain("test");
  });

  it("found at least one ci.yml step to check", () => {
    expect(ciStepNames.length).toBeGreaterThan(0);
  });

  it.each(steps)(
    "check:source's %s runs as its own ci.yml step, or is a documented exception",
    (step) => {
      expect(ciSteps.has(step) || CHECK_SOURCE_ONLY_EXCEPTIONS.has(step)).toBe(true);
    },
  );

  it.each(ciStepNames)(
    "ci.yml's %s runs in check:source, or is a documented exception",
    (step) => {
      expect(checkSourceStepNames.has(step) || CI_ONLY_EXCEPTIONS.has(step)).toBe(true);
    },
  );

  it("every documented check:source exception still names a real check:source step", () => {
    for (const name of CHECK_SOURCE_ONLY_EXCEPTIONS.keys()) {
      expect(steps).toContain(name);
    }
  });

  it("every documented ci.yml exception still names a real ci.yml step", () => {
    for (const name of CI_ONLY_EXCEPTIONS.keys()) {
      expect(ciStepNames).toContain(name);
    }
  });

  it("every documented exception states a reason", () => {
    for (const reason of [
      ...CHECK_SOURCE_ONLY_EXCEPTIONS.values(),
      ...CI_ONLY_EXCEPTIONS.values(),
    ]) {
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("every vitest project runs in check:source", () => {
  const projects = vitestConfig.test?.projects ?? [];
  const names = projects.map((project) => {
    if (
      typeof project !== "object" ||
      !("test" in project) ||
      typeof project.test.name !== "string" ||
      project.test.name.length === 0
    ) {
      throw new Error("Each Vitest project must declare its test.name in the config.");
    }
    return project.test.name;
  });
  const reached = new Set(
    checkSourceSteps()
      .filter((name) => name.startsWith("test"))
      .flatMap((name) =>
        [...script(name).matchAll(/(?:^|\s)--project=([\w-]+)(?=\s|$)/g)].map(
          (match) => match[1],
        ),
      ),
  );

  it("finds declared projects to check", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)("runs %s through a positive project filter", (name) => {
    expect(reached, `No check:source test script selects ${name}`).toContain(name);
  });
});
