import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { repoRoot, runNode } from "../scripts/lib/node-tools.mjs";

// `runNode` is the one spawn helper every remaining repository script goes
// through, so its result shapes — success, a non-zero exit, and a spawn that
// never started — are exercised directly here rather than only incidentally
// through the scripts that call it. Real throwaway scripts written into a
// `mkdtempSync` directory stand in for fixtures instead of mocking
// node:child_process: the `writing-tests` skill's conventions prefer a real
// fake to a mock beyond a one-shot call.
const workspaces: string[] = [];

function makeWorkspace(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  workspaces.push(dir);
  return dir;
}

function writeScript(workspace: string, name: string, source: string): string {
  const file = path.join(workspace, name);
  writeFileSync(file, source);
  return file;
}

afterEach(() => {
  while (workspaces.length > 0) {
    const dir = workspaces.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("repoRoot", () => {
  it("points at the repository root", () => {
    expect(existsSync(path.join(repoRoot, "package.json"))).toBe(true);
  });
});

describe("runNode", () => {
  it("captures stdout and exit code 0 on success", () => {
    const workspace = makeWorkspace("run-node-ok-");
    const script = writeScript(
      workspace,
      "ok.mjs",
      'console.log("hello from child");\n',
    );

    const result = runNode(script, []);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("hello from child");
    expect(result.stderr).toBe("");
  });

  it("passes arguments through to the child", () => {
    const workspace = makeWorkspace("run-node-args-");
    const script = writeScript(
      workspace,
      "echo-args.mjs",
      "console.log(process.argv.slice(2).join(','));\n",
    );

    const result = runNode(script, ["a", "b c"]);

    expect(result.stdout.trim()).toBe("a,b c");
  });

  it("captures a non-zero exit code and stderr", () => {
    const workspace = makeWorkspace("run-node-fail-");
    const script = writeScript(
      workspace,
      "fail.mjs",
      'console.error("boom");\nprocess.exitCode = 7;\n',
    );

    const result = runNode(script, []);

    expect(result.status).toBe(7);
    expect(result.stderr).toContain("boom");
  });

  it("reports a spawn failure instead of throwing, on an unusable cwd", () => {
    const workspace = makeWorkspace("run-node-cwd-");
    const script = writeScript(workspace, "ok.mjs", "console.log(1);\n");
    const missingCwd = path.join(workspace, "does-not-exist");

    const result = runNode(script, [], { cwd: missingCwd });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ENOENT");
  });

  it("runs with an explicitly given environment", () => {
    const workspace = makeWorkspace("run-node-env-");
    const script = writeScript(
      workspace,
      "env.mjs",
      'console.log(process.env.NODE_TOOLS_TEST_MARKER ?? "<unset>");\n',
    );

    const result = runNode(script, [], {
      env: { ...process.env, NODE_TOOLS_TEST_MARKER: "present" },
    });

    expect(result.stdout.trim()).toBe("present");
  });

  it("defaults cwd to the repository root", () => {
    const workspace = makeWorkspace("run-node-defcwd-");
    const script = writeScript(workspace, "cwd.mjs", "console.log(process.cwd());\n");

    const result = runNode(script, []);

    expect(result.stdout.trim()).toBe(repoRoot);
  });
});
