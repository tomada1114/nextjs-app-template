import { execFileSync } from "node:child_process";
import consoleModule from "node:console";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanHolding } from "../scripts/clean-holding.mjs";
import { isolatedGitEnv } from "../scripts/lib/git-env.mjs";

const workspaces: string[] = [];
const script = fileURLToPath(new URL("../scripts/clean-holding.mjs", import.meta.url));

function fixture(remote = "git@github.com:owner/repo.git") {
  const workspace = realpathSync(
    mkdtempSync(path.join(tmpdir(), "clean-holding-test-")),
  );
  workspaces.push(workspace);
  const root = path.join(workspace, "repo");
  const state = path.join(workspace, "state");
  const holding = path.join(state, "shipping-issues", "owner__repo", "holding");
  mkdirSync(root);
  execFileSync("git", ["init", "-q"], { cwd: root, env: isolatedGitEnv() });
  execFileSync("git", ["remote", "add", "origin", remote], {
    cwd: root,
    env: isolatedGitEnv(),
  });
  vi.stubEnv("AGENT_SKILL_STATE_DIR", state);
  vi.spyOn(consoleModule, "error").mockImplementation(() => undefined);
  vi.spyOn(consoleModule, "log").mockImplementation(() => undefined);
  return { root, state, holding, workspace };
}

function fill(directory: string) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "kept.txt"), "evidence");
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

describe("cleanHolding", () => {
  it("removes only the named issue and run holdings", () => {
    const { root, holding, state } = fixture();
    const otherRepo = path.join(
      state,
      "shipping-issues",
      "other__repo",
      "holding",
      "42",
    );
    for (const name of ["42", "run", "57"]) fill(path.join(holding, name));
    fill(otherRepo);

    expect(cleanHolding(["42", "run"], root)).toBe(0);
    expect(existsSync(path.join(holding, "42"))).toBe(false);
    expect(existsSync(path.join(holding, "run"))).toBe(false);
    expect(existsSync(path.join(holding, "57"))).toBe(true);
    expect(existsSync(otherRepo)).toBe(true);
    expect(existsSync(holding)).toBe(true);
    expect(consoleModule.log).toHaveBeenCalledWith(
      `Removed: ${path.join(holding, "42")}`,
    );
  });

  it("reports a holding that is already absent", () => {
    const { root, holding } = fixture();
    expect(cleanHolding(["42"], root)).toBe(0);
    expect(consoleModule.log).toHaveBeenCalledWith(
      `Already absent: ${path.join(holding, "42")}`,
    );
    expect(existsSync(holding)).toBe(false);
  });

  it.each(["../", "/tmp/42", "foo", "holding", ".", "", "-1", "1.5", "42/nested"])(
    "refuses invalid target %j before removing any holding",
    (target) => {
      const { root, holding } = fixture();
      fill(path.join(holding, "42"));
      expect(cleanHolding(["42", target], root)).toBe(2);
      expect(existsSync(path.join(holding, "42"))).toBe(true);
      expect(consoleModule.error).toHaveBeenCalledWith(
        expect.stringMatching(/^ERR_CLEAN_INVALID_TARGET:/),
      );
    },
  );

  it("refuses an empty target list", () => {
    const { root } = fixture();
    expect(cleanHolding([], root)).toBe(2);
    expect(consoleModule.error).toHaveBeenCalledWith(
      expect.stringMatching(/^ERR_CLEAN_NO_TARGETS:/),
    );
  });

  it("refuses a final symlink pointing outside the holding root", () => {
    const { root, holding, workspace } = fixture();
    const outside = path.join(workspace, "outside");
    fill(outside);
    mkdirSync(holding, { recursive: true });
    symlinkSync(outside, path.join(holding, "42"), "dir");
    expect(cleanHolding(["42"], root)).toBe(2);
    expect(existsSync(path.join(outside, "kept.txt"))).toBe(true);
    expect(consoleModule.error).toHaveBeenCalledWith(
      expect.stringMatching(/^ERR_CLEAN_SYMLINK_ESCAPE:/),
    );
  });

  it("refuses a holding root redirected into another repository", () => {
    const { root, holding, state } = fixture();
    const other = path.join(state, "shipping-issues", "other__repo", "holding");
    fill(path.join(other, "42"));
    mkdirSync(path.dirname(holding), { recursive: true });
    symlinkSync(other, holding, "dir");
    expect(cleanHolding(["42"], root)).toBe(2);
    expect(existsSync(path.join(other, "42", "kept.txt"))).toBe(true);
  });

  it("refuses a dangling symlink pointing outside the holding area", () => {
    const { root, holding, workspace } = fixture();
    mkdirSync(holding, { recursive: true });
    symlinkSync(path.join(workspace, "missing"), path.join(holding, "42"), "dir");
    expect(cleanHolding(["42"], root)).toBe(2);
    expect(consoleModule.error).toHaveBeenCalledWith(
      expect.stringMatching(/^ERR_CLEAN_SYMLINK_ESCAPE:/),
    );
  });

  it("refuses a dangling holding-root symlink pointing outside its repository", () => {
    const { root, holding, workspace } = fixture();
    mkdirSync(path.dirname(holding), { recursive: true });
    symlinkSync(path.join(workspace, "missing"), holding, "dir");
    expect(cleanHolding(["42"], root)).toBe(2);
  });

  it("reports unlinking a dangling symlink inside the holding area as a removal", () => {
    const { root, holding } = fixture();
    mkdirSync(holding, { recursive: true });
    symlinkSync("57", path.join(holding, "42"), "dir");
    expect(cleanHolding(["42"], root)).toBe(0);
    expect(
      lstatSync(path.join(holding, "42"), { throwIfNoEntry: false }),
    ).toBeUndefined();
    expect(consoleModule.log).toHaveBeenCalledWith(
      `Removed: ${path.join(holding, "42")}`,
    );
  });

  it("refuses an ancestor redirected outside the state root", () => {
    const { root, holding, state, workspace } = fixture();
    const outside = path.join(workspace, "outside");
    fill(path.join(outside, "owner__repo", "holding", "42"));
    mkdirSync(state);
    symlinkSync(outside, path.join(state, "shipping-issues"), "dir");
    expect(cleanHolding(["42"], root)).toBe(2);
    expect(existsSync(path.join(outside, "owner__repo", "holding", "42"))).toBe(true);
    expect(existsSync(path.join(holding, "42"))).toBe(true);
  });

  it("accepts a symlinked state directory chosen by the caller", () => {
    const { root, state, holding, workspace } = fixture();
    fill(path.join(holding, "42"));
    const link = path.join(workspace, "state-link");
    symlinkSync(state, link, "dir");
    vi.stubEnv("AGENT_SKILL_STATE_DIR", link);
    expect(cleanHolding(["42"], root)).toBe(0);
    expect(existsSync(path.join(holding, "42"))).toBe(false);
  });

  it("refuses an unresolvable target without deleting any earlier target", () => {
    const { root, holding } = fixture();
    fill(path.join(holding, "42"));
    symlinkSync("57", path.join(holding, "57"), "dir");
    expect(cleanHolding(["42", "57"], root)).toBe(2);
    expect(existsSync(path.join(holding, "42"))).toBe(true);
    expect(consoleModule.error).toHaveBeenCalledWith(
      expect.stringMatching(/^ERR_CLEAN_UNRESOLVABLE:/),
    );
  });

  it.each([
    "https://github.com/owner/repo.git",
    "http://github.com/owner/repo",
    "ssh://git@github.com/owner/repo.git",
    "owner/repo",
  ])("resolves the repository slug from %s", (remote) => {
    const { root, holding } = fixture(remote);
    fill(path.join(holding, "42"));
    expect(cleanHolding(["42"], root)).toBe(0);
    expect(existsSync(path.join(holding, "42"))).toBe(false);
  });

  it.each([
    "../repo",
    "owner/..",
    "owner/.",
    "https://github.com/owner/repo/extra",
    "unrecognised",
  ])("refuses an unsafe or unrecognised repository slug %s", (remote) => {
    const { root, holding } = fixture(remote);
    fill(path.join(holding, "42"));
    expect(cleanHolding(["42"], root)).toBe(2);
    expect(existsSync(path.join(holding, "42"))).toBe(true);
    expect(consoleModule.error).toHaveBeenCalledWith(
      expect.stringMatching(/^ERR_CLEAN_REPOSITORY:/),
    );
  });

  it("refuses a repository without an origin", () => {
    const { root } = fixture();
    execFileSync("git", ["remote", "remove", "origin"], {
      cwd: root,
      env: isolatedGitEnv(),
    });
    expect(cleanHolding(["42"], root)).toBe(2);
    expect(consoleModule.error).toHaveBeenCalledWith(
      expect.stringMatching(/^ERR_CLEAN_REPOSITORY:/),
    );
  });

  it("refuses outside a git repository", () => {
    const { workspace } = fixture();
    const outside = path.join(workspace, "plain");
    mkdirSync(outside);
    expect(cleanHolding(["42"], outside)).toBe(2);
  });

  it("uses the fixture repository even inside a git hook", () => {
    const { root, holding } = fixture();
    fill(path.join(holding, "42"));
    vi.stubEnv("GIT_DIR", "/no-such-git-dir");
    vi.stubEnv("GIT_INDEX_FILE", "/no-such-index");
    expect(cleanHolding(["42"], root)).toBe(0);
    expect(existsSync(path.join(holding, "42"))).toBe(false);
  });

  it("reports a filesystem removal failure and retains the remaining holding", () => {
    const { root, holding } = fixture();
    fill(path.join(holding, "42"));
    chmodSync(holding, 0o500);
    try {
      expect(cleanHolding(["42"], root)).toBe(1);
      expect(existsSync(path.join(holding, "42"))).toBe(true);
      expect(consoleModule.error).toHaveBeenCalledWith(
        expect.stringMatching(/^ERR_CLEAN_REMOVE_FAILED:/),
      );
    } finally {
      chmodSync(holding, 0o700);
    }
  });

  it("runs the CLI against the current repository", () => {
    const { root, holding } = fixture();
    fill(path.join(holding, "42"));
    const output = execFileSync("node", [script, "42"], {
      cwd: root,
      env: isolatedGitEnv(),
      encoding: "utf8",
    });
    expect(output).toContain(`Removed: ${path.join(holding, "42")}`);
    expect(existsSync(path.join(holding, "42"))).toBe(false);
  });
});
