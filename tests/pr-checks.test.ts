import { describe, expect, it } from "vitest";

import {
  checkSummary,
  contestedFiles,
  ecosystemOf,
  parseVersions,
  semverLevel,
} from "../scripts/lib/pr-checks.mjs";

// Pure-function coverage for the classifiers behind
// `.agents/skills/merge-dependabot/scripts/survey-prs.mjs`. Nothing here does
// I/O — the script keeps the `gh` call and the printing — so this suite stays
// in the `unit` project, the same precedent as tests/guard-rules.test.ts.
//
// `checkSummary` is the one that guards a merge: the skill's Step 3 lets a PR
// through only on `PASSING`, so a state the classifier does not recognise must
// hold the PR, never wave it past that gate.

/**
 * One rollup entry as GitHub's `statusCheckRollup` reports a check run:
 * `status` while it runs, `conclusion` once it has finished.
 */
function checkRun(name: string, conclusion: string): unknown {
  return { __typename: "CheckRun", name, status: "COMPLETED", conclusion };
}

describe("checkSummary: states that must not be reported as passing", () => {
  it.each([
    ["a startup failure", "STARTUP_FAILURE"],
    ["a stale conclusion", "STALE"],
    // GitHub adds conclusions over time. One this repository has never seen
    // must hold the PR rather than pass by default, which is the whole defect
    // this module was extracted to fix.
    ["a conclusion nobody has heard of", "SOME_FUTURE_CONCLUSION"],
    ["an outright failure", "FAILURE"],
    ["a timeout", "TIMED_OUT"],
    ["a cancellation", "CANCELLED"],
    ["a check awaiting a manual action", "ACTION_REQUIRED"],
  ])("reports %s as FAILING and names the check", (_label, conclusion) => {
    expect(checkSummary([checkRun("build", conclusion)])).toStrictEqual({
      state: "FAILING",
      failing: [`build=${conclusion}`],
    });
  });

  it("reports an entry carrying neither a conclusion nor a state as FAILING", () => {
    // An empty object stands in for a rollup entry whose shape the script did
    // not anticipate. There is nothing here that says the check passed, so
    // there is nothing here that may be read as permission to merge.
    expect(checkSummary([{}])).toStrictEqual({
      state: "FAILING",
      failing: ["?=UNKNOWN"],
    });
  });

  it("surfaces the broken check in a rollup whose other checks passed", () => {
    // The mixed rollup: before this module existed the passing entry erased
    // the broken one, and the operator's survey table showed no trace of it.
    expect(
      checkSummary([checkRun("lint", "SUCCESS"), checkRun("build", "STARTUP_FAILURE")]),
    ).toStrictEqual({
      state: "FAILING",
      failing: ["build=STARTUP_FAILURE"],
    });
  });

  it("names every broken check in a rollup with more than one", () => {
    expect(
      checkSummary([
        checkRun("lint", "FAILURE"),
        checkRun("test", "SUCCESS"),
        checkRun("build", "STALE"),
      ]).failing,
    ).toStrictEqual(["lint=FAILURE", "build=STALE"]);
  });

  it("reports FAILING rather than PENDING when a rollup holds both", () => {
    // A pending check cannot redeem a broken one: the answer an operator needs
    // is "do not merge this", not "come back later".
    expect(
      checkSummary([
        { __typename: "CheckRun", name: "slow", status: "IN_PROGRESS" },
        checkRun("build", "STARTUP_FAILURE"),
      ]),
    ).toStrictEqual({ state: "FAILING", failing: ["build=STARTUP_FAILURE"] });
  });
});

describe("checkSummary: states that must stay passing", () => {
  it.each([
    ["a successful check", "SUCCESS"],
    // A skipped job is how a conditional workflow reports "not applicable",
    // and a neutral one is how a check reports an advisory result. Neither is
    // a failure, and folding them into the failing bucket would hold every PR
    // this repository opens.
    ["a skipped job", "SKIPPED"],
    ["a neutral conclusion", "NEUTRAL"],
  ])("reports %s as PASSING", (_label, conclusion) => {
    expect(checkSummary([checkRun("build", conclusion)])).toStrictEqual({
      state: "PASSING",
      failing: [],
    });
  });

  it("reports a rollup of a success and a skip as PASSING", () => {
    expect(
      checkSummary([checkRun("build", "SUCCESS"), checkRun("deploy", "SKIPPED")]),
    ).toStrictEqual({ state: "PASSING", failing: [] });
  });
});

describe("checkSummary: pending and empty rollups", () => {
  it("reports an empty rollup as NONE", () => {
    expect(checkSummary([])).toStrictEqual({ state: "NONE", failing: [] });
  });

  it.each([
    ["queued", "QUEUED"],
    ["in progress", "IN_PROGRESS"],
    ["waiting", "WAITING"],
  ])("reports a check run that is %s as PENDING", (_label, status) => {
    // A check run in flight carries a status and no conclusion at all.
    expect(
      checkSummary([{ __typename: "CheckRun", name: "build", status }]),
    ).toStrictEqual({ state: "PENDING", failing: [] });
  });

  it.each([
    ["a pending commit status", "PENDING"],
    ["a commit status GitHub is still expecting", "EXPECTED"],
  ])("reports %s as PENDING", (_label, state) => {
    // A commit status reports `state`/`context` where a check run reports
    // `conclusion`/`name`.
    expect(
      checkSummary([{ __typename: "StatusContext", context: "ci/external", state }]),
    ).toStrictEqual({ state: "PENDING", failing: [] });
  });

  it("reports a failed commit status as FAILING under its context name", () => {
    expect(
      checkSummary([
        { __typename: "StatusContext", context: "ci/external", state: "ERROR" },
      ]),
    ).toStrictEqual({ state: "FAILING", failing: ["ci/external=ERROR"] });
  });

  it("reads a lower-case conclusion the same way as an upper-case one", () => {
    // The REST API spells conclusions in lower case where GraphQL uses upper.
    expect(checkSummary([{ name: "build", conclusion: "success" }])).toStrictEqual({
      state: "PASSING",
      failing: [],
    });
  });
});

describe("parseVersions", () => {
  it("reads a Dependabot bump title", () => {
    expect(
      parseVersions("chore(deps): bump vitest from 4.1.9 to 4.1.10"),
    ).toStrictEqual({
      pkg: "vitest",
      from: "4.1.9",
      to: "4.1.10",
    });
  });

  it("reads an `update … requirement` title with ranges", () => {
    expect(
      parseVersions("Update eslint requirement from ^10.6.0 to ^10.7.0"),
    ).toStrictEqual({ pkg: "eslint", from: "^10.6.0", to: "^10.7.0" });
  });

  it("returns nothing for a title that is not a bump", () => {
    expect(parseVersions("fix(server): bound the request body")).toStrictEqual({
      pkg: undefined,
      from: undefined,
      to: undefined,
    });
  });
});

describe("semverLevel", () => {
  it.each([
    ["1.2.3", "2.0.0", "major"],
    ["1.2.3", "1.3.0", "minor"],
    ["1.2.3", "1.2.4", "patch"],
    // A range with no patch component still classifies on the two it has.
    ["^10.6", "^10.7", "minor"],
    ["^10.6", "^11.0", "major"],
  ])("classifies %s → %s as %s", (from, to, expected) => {
    expect(semverLevel(from, to)).toBe(expected);
  });

  it.each([
    ["a missing `from`", undefined, "1.2.3"],
    ["a missing `to`", "1.2.3", undefined],
    ["an unparsable `from`", "next", "1.2.3"],
    ["an unparsable `to`", "1.2.3", "latest"],
  ])("reports %s as unknown", (_label, from, to) => {
    expect(semverLevel(from, to)).toBe("unknown");
  });
});

describe("ecosystemOf", () => {
  it.each([
    ["dependabot/github_actions/actions/checkout-5", "github_actions"],
    // Dependabot still names the npm updater `npm_and_yarn`, pnpm included.
    ["dependabot/npm_and_yarn/vitest-4.1.10", "npm"],
    ["renovate/docker-node-24", "other"],
  ])("classifies %s as %s", (branch, expected) => {
    expect(ecosystemOf(branch)).toBe(expected);
  });
});

describe("contestedFiles", () => {
  it("reports only the paths more than one pull request touches", () => {
    const contested = contestedFiles([
      { number: 3, files: ["package.json", "pnpm-lock.yaml"] },
      { number: 1, files: ["package.json", "pnpm-lock.yaml", "README.md"] },
      { number: 2, files: [".github/workflows/ci.yml"] },
    ]);
    expect([...contested]).toStrictEqual([
      ["package.json", [3, 1]],
      ["pnpm-lock.yaml", [3, 1]],
    ]);
  });

  it("reports nothing when no two pull requests overlap", () => {
    expect(
      contestedFiles([
        { number: 1, files: ["a.txt"] },
        { number: 2, files: ["b.txt"] },
      ]).size,
    ).toBe(0);
  });

  it("reports nothing for no pull requests at all", () => {
    expect(contestedFiles([]).size).toBe(0);
  });
});
