import console from "node:console";

import { describe, expect, it, vi } from "vitest";

import {
  applyLabelUpdate,
  computeLabelUpdate,
  extractType,
  fetchCurrentLabels,
  main,
  resolveLabel,
} from "../scripts/label-pr.mjs";

interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** An in-memory fake `gh` runner: a real fake, not a mock of `node:child_process`. */
function makeFakeGh(responder: (args: string[]) => GhResult) {
  const calls: string[][] = [];
  const run = (args: readonly string[]): GhResult => {
    const snapshot = [...args];
    calls.push(snapshot);
    return responder(snapshot);
  };
  return { run, calls };
}

function ok(stdout = ""): GhResult {
  return { status: 0, stdout, stderr: "" };
}

function failed(stderr: string): GhResult {
  return { status: 1, stdout: "", stderr };
}

function unavailable(): GhResult {
  return { status: null, stdout: "", stderr: "", error: new Error("spawn gh ENOENT") };
}

describe("extractType / resolveLabel", () => {
  // Traced by hand against `.github/workflows/pr-label.yml`'s pre-fix shell
  // (`type="${PR_TITLE%%:*}"; type="${type%%(*}"`) under bash: `feat: x` and
  // `feat(scope): x` both extracted `feat`, but `feat!: x` extracted the
  // unmatched `feat!` (no label at all) and `feat(scope)!: x` extracted
  // `feat` with the `!` silently discarded. Every row below fails that
  // extraction for at least one of the four spellings.
  it.each([
    ["feat: x", "feat", "enhancement"],
    ["feat(scope): x", "feat", "enhancement"],
    ["feat!: x", "feat", "enhancement"],
    ["feat(scope)!: x", "feat", "enhancement"],
    ["fix: x", "fix", "bug"],
    ["fix!: x", "fix", "bug"],
    ["docs(readme)!: x", "docs", "documentation"],
  ] as const)("maps %s to type %s and label %s", (title, type, label) => {
    expect(extractType(title)).toBe(type);
    expect(resolveLabel(title)).toBe(label);
  });

  it("returns null for a type this workflow does not manage", () => {
    expect(extractType("wip: x")).toBe("wip");
    expect(resolveLabel("wip: x")).toBeNull();
  });

  it("returns null for a title with no Conventional Commit prefix at all", () => {
    expect(extractType("does not start with a type")).toBeNull();
    expect(resolveLabel("does not start with a type")).toBeNull();
  });
});

describe("computeLabelUpdate", () => {
  it("proposes adding the mapped label when the PR carries none of this workflow's labels yet", () => {
    expect(computeLabelUpdate("feat: x", [])).toEqual({
      addLabel: "enhancement",
      removeLabels: [],
    });
  });

  // The pre-fix workflow never called `gh pr edit --remove-label` at all, so
  // retitling a PR left every previously applied type label in place. This
  // is the case that pins the fix: removing the stale label the new type no
  // longer matches — the PR carries exactly one managed label, so it can
  // only be this workflow's own earlier output.
  it("proposes removing the stale type label on a retitle when it is the only managed label present", () => {
    expect(computeLabelUpdate("fix: x", ["enhancement"])).toEqual({
      addLabel: "bug",
      removeLabels: ["enhancement"],
    });
  });

  it("never proposes removing a label outside this workflow's own managed set", () => {
    expect(computeLabelUpdate("fix: x", ["enhancement", "priority: P2"])).toEqual({
      addLabel: "bug",
      removeLabels: ["enhancement"],
    });
  });

  it("proposes nothing to remove when the current label already matches", () => {
    expect(computeLabelUpdate("feat: x", ["enhancement"])).toEqual({
      addLabel: "enhancement",
      removeLabels: [],
    });
  });

  // Two managed labels present means one of them was added by something
  // other than this workflow's own single-label output — a maintainer who
  // hand-adds `documentation` to a `feat:` PR that also touches docs, here.
  // Removing nothing is the only choice that never fights that maintainer.
  it("removes nothing when two or more managed labels are present, even though one is stale", () => {
    expect(computeLabelUpdate("feat: x", ["enhancement", "documentation"])).toEqual({
      addLabel: "enhancement",
      removeLabels: [],
    });
  });

  // Dependabot's github-actions updates title with `ci:` (.github/dependabot.yml)
  // while Dependabot itself applies its own default `dependencies` label,
  // never `ci`. That is one managed label differing from the resolved one --
  // structurally identical to the retitle case above, so no rule reading
  // labels alone can tell them apart. `dependencies` is exempt from removal
  // for exactly that reason: it is the only managed label another actor
  // applies on its own, so the workflow adds it and never takes it away.
  it("leaves Dependabot's own dependencies label alone on a ci:-titled update", () => {
    expect(computeLabelUpdate("ci: bump x", ["dependencies"])).toEqual({
      addLabel: "ci",
      removeLabels: [],
    });
  });

  it("still adds dependencies for a deps: title that does not carry it yet", () => {
    expect(computeLabelUpdate("deps: bump x", [])).toEqual({
      addLabel: "dependencies",
      removeLabels: [],
    });
  });

  it("never removes dependencies even when a retitle makes it stale", () => {
    expect(computeLabelUpdate("fix: x", ["dependencies"])).toEqual({
      addLabel: "bug",
      removeLabels: [],
    });
  });

  it("proposes only adding, never removing, when the new title maps to no label", () => {
    expect(computeLabelUpdate("wip: x", ["bug", "chore"])).toEqual({
      addLabel: null,
      removeLabels: [],
    });
  });
});

describe("fetchCurrentLabels", () => {
  it("returns the PR's current label names", () => {
    const { run } = makeFakeGh(() =>
      ok(JSON.stringify({ labels: [{ name: "bug" }, { name: "priority: P2" }] })),
    );
    expect(fetchCurrentLabels("42", run)).toEqual(["bug", "priority: P2"]);
  });

  it("tolerates a missing labels field", () => {
    const { run } = makeFakeGh(() => ok("{}"));
    expect(fetchCurrentLabels("42", run)).toEqual([]);
  });

  it("throws when gh cannot be spawned", () => {
    const { run } = makeFakeGh(() => unavailable());
    expect(() => fetchCurrentLabels("42", run)).toThrow(/could not run `gh`/);
  });

  it("throws when gh exits non-zero", () => {
    const { run } = makeFakeGh(() => failed("not authenticated"));
    expect(() => fetchCurrentLabels("42", run)).toThrow(/gh pr view.*failed/);
  });
});

describe("applyLabelUpdate", () => {
  it("adds the mapped label and removes the stale one in a single gh pr edit call", () => {
    const { run, calls } = makeFakeGh((args) =>
      args[0] === "pr" && args[1] === "view"
        ? ok(JSON.stringify({ labels: [{ name: "enhancement" }] }))
        : ok(),
    );

    applyLabelUpdate({ prNumber: "7", title: "fix: x", run });

    expect(calls).toEqual([
      ["pr", "view", "7", "--json", "labels"],
      ["pr", "edit", "7", "--add-label", "bug", "--remove-label", "enhancement"],
    ]);
  });

  it("makes no gh pr edit call when there is nothing to add or remove", () => {
    const { run, calls } = makeFakeGh(() => ok(JSON.stringify({ labels: [] })));

    applyLabelUpdate({ prNumber: "7", title: "wip: x", run });

    expect(calls).toEqual([["pr", "view", "7", "--json", "labels"]]);
  });

  it("logs a notice and continues (treating current labels as empty) when reading labels fails", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { run, calls } = makeFakeGh((args) =>
      args[1] === "view" ? failed("not authenticated") : ok(),
    );

    applyLabelUpdate({ prNumber: "7", title: "feat: x", run });

    expect(calls).toEqual([
      ["pr", "view", "7", "--json", "labels"],
      ["pr", "edit", "7", "--add-label", "enhancement"],
    ]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("::notice::"));
    logSpy.mockRestore();
  });

  it("logs a notice and does not throw when gh pr edit fails", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { run } = makeFakeGh((args) =>
      args[1] === "view"
        ? ok(JSON.stringify({ labels: [] }))
        : failed("read-only token"),
    );

    expect(() =>
      applyLabelUpdate({ prNumber: "7", title: "feat: x", run }),
    ).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("::notice::"));
    logSpy.mockRestore();
  });
});

describe("main", () => {
  it("fails hard with ERR_LABEL_PR_MISSING_PR_NUMBER and makes no gh call when PR_NUMBER is empty", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { run, calls } = makeFakeGh(() => ok());

    const exitCode = main({ env: { PR_TITLE: "feat: x" }, run });

    expect(exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ERR_LABEL_PR_MISSING_PR_NUMBER"),
    );
    errorSpy.mockRestore();
  });

  it("fails hard the same way when PR_NUMBER is present but empty", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { run, calls } = makeFakeGh(() => ok());

    const exitCode = main({ env: { PR_NUMBER: "", PR_TITLE: "feat: x" }, run });

    expect(exitCode).toBe(1);
    expect(calls).toEqual([]);
    errorSpy.mockRestore();
  });

  it("applies the label update and exits 0 when PR_NUMBER is set", () => {
    const { run, calls } = makeFakeGh((args) =>
      args[1] === "view" ? ok(JSON.stringify({ labels: [] })) : ok(),
    );

    const exitCode = main({ env: { PR_NUMBER: "7", PR_TITLE: "feat: x" }, run });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      ["pr", "view", "7", "--json", "labels"],
      ["pr", "edit", "7", "--add-label", "enhancement"],
    ]);
  });
});
