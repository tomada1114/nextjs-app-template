import consoleModule from "node:console";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import {
  RulesetError,
  applyRuleset,
  gh,
  loadRulesets,
  main,
  resolveRepo,
} from "../scripts/apply-ruleset.mjs";
import { spawnGh } from "../scripts/lib/gh.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

const ok = (stdout = ""): GhResult => ({ status: 0, stdout, stderr: "" });
const refused = (stderr: string): GhResult => ({ status: 1, stdout: "", stderr });
const REPO_VIEW = ok('{"nameWithOwner":"owner/repo"}\n');

/**
 * An in-memory fake `gh` answering each call, in order, from `answers` — a
 * real fake rather than a mock of `node:child_process`. A call with no answer
 * left fails the test, so an unexpected extra request (a DELETE, say) cannot
 * pass by being answered generically.
 */
function makeFakeGh(answers: GhResult[]) {
  const calls: string[][] = [];
  const run = (args: readonly string[]): GhResult => {
    calls.push([...args]);
    const answer = answers.shift();
    if (answer === undefined) {
      throw new Error(`unexpected gh call: gh ${args.join(" ")}`);
    }
    return answer;
  };
  return { run, calls };
}

function sentDelete(calls: readonly string[][]): boolean {
  return calls.some((call) => call.some((arg) => /^delete$/i.test(arg)));
}

const MAIN = JSON.stringify({ name: "main", target: "branch", enforcement: "active" });
const TAGS = JSON.stringify({ name: "release-tags", target: "tag" });
const listFilter = (name: string, target: string) =>
  `.[] | select(.name == "${name}" and .target == "${target}" and .source_type == "Repository") | .id`;

function caught(action: () => unknown): RulesetError {
  try {
    action();
  } catch (error) {
    if (error instanceof RulesetError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a RulesetError");
}

describe("apply-ruleset", () => {
  const tempDirs: string[] = [];
  let errorSpy: MockInstance<typeof console.error>;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    // The script imports `console` from "node:console", a distinct object
    // from the ambient global under Vitest, so the spies target that module.
    errorSpy = vi.spyOn(consoleModule, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(consoleModule, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A temporary repository root holding the given `.github/rulesets/` files. */
  function makeRoot(files: Readonly<Record<string, string>> | undefined): string {
    const dir = mkdtempSync(path.join(tmpdir(), "apply-ruleset-test-"));
    tempDirs.push(dir);
    if (files !== undefined) {
      mkdirSync(path.join(dir, ".github", "rulesets"), { recursive: true });
      for (const [name, body] of Object.entries(files)) {
        writeFileSync(path.join(dir, ".github", "rulesets", name), body);
      }
    }
    return dir;
  }

  describe("main", () => {
    it("creates the ruleset with POST when none with its name and target exists", () => {
      const root = makeRoot({ "main.json": MAIN });
      const { run, calls } = makeFakeGh([REPO_VIEW, ok(""), ok("{}")]);

      expect(main([], { root, run })).toBe(0);
      expect(calls).toEqual([
        ["repo", "view", "--json", "nameWithOwner"],
        [
          "api",
          "--paginate",
          "repos/owner/repo/rulesets?includes_parents=false",
          "--jq",
          listFilter("main", "branch"),
        ],
        [
          "api",
          "repos/owner/repo/rulesets",
          "--method",
          "POST",
          "--input",
          path.join(root, ".github", "rulesets", "main.json"),
        ],
      ]);
      expect(sentDelete(calls)).toBe(false);
      expect(logSpy).toHaveBeenCalledWith(
        "repo:ruleset: created ruleset main in owner/repo.",
      );
    });

    it("updates the first matching ruleset in place with PUT", () => {
      const root = makeRoot({ "main.json": MAIN });
      const { run, calls } = makeFakeGh([REPO_VIEW, ok("42\n77\n"), ok("{}")]);

      expect(main([], { root, run })).toBe(0);
      expect(calls).toHaveLength(3);
      expect(calls[2]).toEqual([
        "api",
        "repos/owner/repo/rulesets/42",
        "--method",
        "PUT",
        "--input",
        path.join(root, ".github", "rulesets", "main.json"),
      ]);
      expect(sentDelete(calls)).toBe(false);
      expect(logSpy).toHaveBeenCalledWith(
        "repo:ruleset: updated ruleset main (id 42) in owner/repo.",
      );
    });

    it("applies every file by its own name and target, creating one and updating another", () => {
      const root = makeRoot({
        "main.json": MAIN,
        "release-tags.json": TAGS,
        "notes.txt": "not a ruleset",
      });
      const { run, calls } = makeFakeGh([
        REPO_VIEW,
        ok(""),
        ok("{}"),
        ok("9\n"),
        ok("{}"),
      ]);

      expect(main([], { root, run })).toBe(0);
      expect(calls.slice(1).map((call) => call.at(-1))).toEqual([
        listFilter("main", "branch"),
        path.join(root, ".github", "rulesets", "main.json"),
        listFilter("release-tags", "tag"),
        path.join(root, ".github", "rulesets", "release-tags.json"),
      ]);
      expect(calls[2]?.[3]).toBe("POST");
      expect(calls[4]?.slice(0, 4)).toEqual([
        "api",
        "repos/owner/repo/rulesets/9",
        "--method",
        "PUT",
      ]);
      expect(sentDelete(calls)).toBe(false);
    });

    it.each([
      ["not JSON", "{ nope"],
      ["a JSON array", "[]"],
      ["JSON null", "null"],
      ["nameless", JSON.stringify({ target: "branch" })],
      ["named with an empty string", JSON.stringify({ name: "", target: "branch" })],
      ["targetless", JSON.stringify({ name: "main" })],
      ["targeted at a number", JSON.stringify({ name: "main", target: 1 })],
    ])(
      "applies nothing and exits 1 with ERR_RULESET_FILE_INVALID when a file is %s",
      (_label, body) => {
        // The valid file sorts first, so this also proves validation of every
        // file happens before the first gh call rather than per file.
        const root = makeRoot({ "a-valid.json": MAIN, "b-broken.json": body });
        const { run, calls } = makeFakeGh([]);

        expect(main([], { root, run })).toBe(1);
        expect(calls).toEqual([]);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringMatching(
            /^ERR_RULESET_FILE_INVALID: \.github\/rulesets\/b-broken\.json /,
          ),
        );
      },
    );

    it.each([
      ["there is no rulesets directory", undefined],
      ["the directory holds no JSON file", { "README.txt": "x" }],
    ])("exits 1 with ERR_RULESET_FILE_MISSING when %s", (_label, files) => {
      const { run, calls } = makeFakeGh([]);

      expect(main([], { root: makeRoot(files), run })).toBe(1);
      expect(calls).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^ERR_RULESET_FILE_MISSING:/),
      );
    });

    it("rejects an argument with exit 2 before reading anything or calling gh", () => {
      const { run, calls } = makeFakeGh([]);

      expect(main(["--dry-run"], { root: makeRoot(undefined), run })).toBe(2);
      expect(calls).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^ERR_RULESET_ARGUMENT:/),
      );
    });

    it("exits 1 and stops after a failed create, sending nothing further", () => {
      const root = makeRoot({ "main.json": MAIN, "release-tags.json": TAGS });
      const { run, calls } = makeFakeGh([
        REPO_VIEW,
        ok(""),
        refused("HTTP 422: Validation Failed"),
      ]);

      expect(main([], { root, run })).toBe(1);
      expect(calls).toHaveLength(3);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^ERR_RULESET_FORBIDDEN:/),
      );
    });

    it("validates the ruleset this repository commits", () => {
      expect(loadRulesets(repoRoot)).toEqual([
        {
          relative: ".github/rulesets/main.json",
          file: path.join(repoRoot, ".github", "rulesets", "main.json"),
          name: "main",
          target: "branch",
        },
      ]);
    });
  });

  describe("gh", () => {
    it("reports ERR_RULESET_GH_MISSING when gh cannot be started", () => {
      const { run } = makeFakeGh([
        { status: null, stdout: "", stderr: "", error: new Error("spawn gh ENOENT") },
      ]);

      const error = caught(() => gh(run, "listing", ["api"]));
      expect(error.code).toBe("ERR_RULESET_GH_MISSING");
      expect(error.message).toContain("ENOENT");
    });

    it("reports ERR_RULESET_PLAN_UNSUPPORTED when GitHub asks for a plan upgrade", () => {
      const { run } = makeFakeGh([
        refused(
          "HTTP 403: Upgrade to GitHub Pro or make this repository public to enable this feature.",
        ),
      ]);

      expect(caught(() => gh(run, "creating", ["api"])).code).toBe(
        "ERR_RULESET_PLAN_UNSUPPORTED",
      );
    });

    it("reports ERR_RULESET_FORBIDDEN for any other refusal", () => {
      const { run } = makeFakeGh([refused("HTTP 401: Bad credentials")]);

      const error = caught(() => gh(run, "creating", ["api"]));
      expect(error.code).toBe("ERR_RULESET_FORBIDDEN");
      expect(error.name).toBe("RulesetError");
    });
  });

  describe("resolveRepo", () => {
    it.each([
      ["no output", ""],
      ["output that is not JSON", "owner/repo"],
      ["JSON without nameWithOwner", "{}"],
    ])("reports ERR_RULESET_NO_REPO for %s", (_label, stdout) => {
      const { run } = makeFakeGh([ok(stdout)]);

      expect(caught(() => resolveRepo(run)).code).toBe("ERR_RULESET_NO_REPO");
    });
  });

  describe("applyRuleset", () => {
    it("never sends a DELETE, even when several rulesets share the name", () => {
      const ruleset = {
        relative: ".github/rulesets/main.json",
        file: "/x/main.json",
        name: "main",
        target: "branch",
      };
      const { run, calls } = makeFakeGh([ok("1\n2\n3\n"), ok("{}")]);

      expect(applyRuleset("owner/repo", ruleset, run)).toBe("updated");
      expect(calls).toHaveLength(2);
      expect(sentDelete(calls)).toBe(false);
    });
  });

  describe("spawnGh", () => {
    it("reports a spawn failure rather than throwing when gh is not on PATH", () => {
      vi.stubEnv("PATH", makeRoot(undefined));

      const result = spawnGh(["--version"]);
      expect(result.status).toBeNull();
      expect(result.error).toBeInstanceOf(Error);
    });
  });
});
