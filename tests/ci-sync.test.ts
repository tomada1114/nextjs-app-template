import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
 * Empty today; the mechanism stays ready, and an entry is a claim to argue in
 * the pull request that adds it.
 */
const CHECK_SOURCE_ONLY_EXCEPTIONS = new Map<string, string>();

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

/**
 * Extract the `pnpm run <name>` tokens out of `check:source`'s definition,
 * in order.
 */
function checkSourceSteps(): string[] {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const scripts =
    typeof manifest === "object" && manifest !== null && "scripts" in manifest
      ? manifest.scripts
      : undefined;
  const checkSource =
    typeof scripts === "object" && scripts !== null && "check:source" in scripts
      ? scripts["check:source"]
      : undefined;
  if (typeof checkSource !== "string") {
    throw new Error('package.json has no "check:source" script to check.');
  }
  return [...checkSource.matchAll(/pnpm run ([\w:-]+)/g)].map(
    (match) => match[1] ?? "",
  );
}

function ciWorkflow(): string {
  return readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
}

/**
 * Every job name `ci.yml` declares. Top-level keys (`name`, `on`,
 * `permissions`, `concurrency`, `jobs`) sit at column 0 and a job's own body at
 * four spaces or more, so the two-space keys between `jobs:` and the next
 * column-0 key are exactly the jobs — read from the file so a job added
 * tomorrow is covered the day it lands, not the day someone remembers this
 * test.
 */
function ciJobNames(): string[] {
  const text = ciWorkflow();
  const jobsKey = /^jobs:$/m.exec(text);
  if (jobsKey === null) {
    throw new Error("ci.yml declares no top-level `jobs:` key.");
  }
  const rest = text.slice(jobsKey.index + jobsKey[0].length);
  // A `#` at column 0 is a comment, not the next top-level key.
  const nextTopLevel = /^[^\s#]/m.exec(rest);
  const body = nextTopLevel === null ? rest : rest.slice(0, nextTopLevel.index);
  return [...body.matchAll(/^ {2}([\w-]+):$/gm)].map((match) => match[1] ?? "");
}

/**
 * Extract every `pnpm run <name>` step inside one named top-level job block
 * of `ci.yml`, from that job's header up to the next top-level job (or the
 * end of the file).
 */
function ciJobSteps(jobName: string): string[] {
  const text = ciWorkflow();
  const jobStart = new RegExp(`^  ${jobName}:$`, "m").exec(text);
  if (jobStart === null) {
    throw new Error(`ci.yml has no top-level job named "${jobName}".`);
  }
  const rest = text.slice(jobStart.index + jobStart[0].length);
  const nextJob = /^ {2}[\w-]+:$/m.exec(rest);
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
