import { execFileSync } from "node:child_process";
import consoleModule from "node:console";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { isolatedGitEnv } from "../scripts/lib/git-env.mjs";
import { runNode } from "../scripts/lib/node-tools.mjs";
import { installHooks } from "../scripts/install-hooks.mjs";

// `package.json`'s `prepare` script is what makes AGENTS.md's "Enforcement
// layers" row — the pre-commit hook applies to every author, any tool — true
// of a fresh clone rather than of one whose owner also ran `pnpm hooks:install`
// (#81). Two things have to hold for that: the installer really writes a hook
// into a repository that has none, and it never breaks `pnpm install` where a
// hook is meaningless. Both are asserted below, the first against a throwaway
// repository and the real lefthook rather than a stub.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const workspaces: string[] = [];

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

// `undefined` is spelled out on both members because `exactOptionalPropertyTypes`
// makes `cwd?: string` and `cwd?: string | undefined` different types, and the
// runner this stands in for (`runNode`) declares the latter.
interface RunOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

interface RunCall {
  script: string;
  args: readonly string[];
  options: RunOptions;
}

/** An in-memory fake lefthook runner: a real fake, not a mock of `node:child_process`. */
function makeFakeRunner(result: RunResult) {
  const calls: RunCall[] = [];
  const run = (
    script: string,
    args: readonly string[],
    options: RunOptions = {},
  ): RunResult => {
    calls.push({ script, args: [...args], options });
    return result;
  };
  return { run, calls };
}

/** A throwaway directory, removed after the test that made it. */
function makeDirectory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "install-hooks-test-"));
  workspaces.push(dir);
  return dir;
}

/**
 * A throwaway Git repository. `isolatedGitEnv` is what keeps `git init` off the
 * real index when this suite runs from the pre-commit hook, which exports
 * `GIT_DIR` to everything it spawns.
 */
function makeRepository(): string {
  const dir = makeDirectory();
  execFileSync("git", ["init", "-q"], { cwd: dir, env: isolatedGitEnv() });
  return dir;
}

/** Give a throwaway repository the two files the installer looks for. */
function addLefthook(root: string, { config = true } = {}): void {
  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  symlinkSync(
    path.join(repoRoot, "node_modules", "lefthook"),
    path.join(root, "node_modules", "lefthook"),
    "dir",
  );
  if (config) {
    copyFileSync(path.join(repoRoot, "lefthook.yml"), path.join(root, "lefthook.yml"));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  while (workspaces.length > 0) {
    const dir = workspaces.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("installHooks", () => {
  it("writes a pre-commit hook into a repository that has none", () => {
    // The issue's own acceptance check, run against the real lefthook: a fresh
    // repository plus this script, and no `pnpm hooks:install` anywhere.
    const root = makeRepository();
    addLefthook(root);
    expect(existsSync(path.join(root, ".git", "hooks", "pre-commit"))).toBe(false);
    const messages: string[] = [];

    // The real environment, minus `CI` — this suite itself runs under CI, and
    // the skip that is right for `pnpm install` there would leave nothing to
    // assert. Everything else (PATH above all: lefthook spawns `git`) has to be
    // the real thing for the binary to run at all.
    const status = installHooks({
      root,
      env: { ...process.env, CI: "" },
      run: runNode,
      log: (message) => messages.push(message),
    });

    expect(messages).toEqual([]);
    expect(status).toBe(0);
    expect(existsSync(path.join(root, ".git", "hooks", "pre-commit"))).toBe(true);
  });

  it("skips, without running lefthook, when CI is set", () => {
    const root = makeRepository();
    addLefthook(root);
    const lefthook = makeFakeRunner({ status: 0, stdout: "", stderr: "" });
    const messages: string[] = [];

    expect(
      installHooks({
        root,
        env: { CI: "true" },
        run: lefthook.run,
        log: (message) => messages.push(message),
      }),
    ).toBe(0);

    expect(lefthook.calls).toEqual([]);
    expect(messages).toEqual([expect.stringContaining("CI is set")]);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["0", "0"],
    ["false", "false"],
  ])("still installs when CI is %s", (_label, value) => {
    // An opt-out spelling of `CI` must not be read as "this is CI": a developer
    // who exports `CI=0` would otherwise silently lose the hook.
    const root = makeRepository();
    addLefthook(root);
    const lefthook = makeFakeRunner({ status: 0, stdout: "", stderr: "" });

    expect(
      installHooks({
        root,
        env: value === undefined ? {} : { CI: value },
        run: lefthook.run,
        log: () => undefined,
      }),
    ).toBe(0);

    expect(lefthook.calls).toHaveLength(1);
    expect(lefthook.calls[0]?.args).toEqual(["install"]);
  });

  it("skips when the directory is not a Git repository at all", () => {
    // A tarball extract or a Docker build context: no `.git`, so `pnpm install`
    // must still succeed rather than failing on a hook nobody can use.
    const root = makeDirectory();
    const lefthook = makeFakeRunner({ status: 0, stdout: "", stderr: "" });
    const messages: string[] = [];

    expect(
      installHooks({
        root,
        env: {},
        run: lefthook.run,
        log: (message) => messages.push(message),
      }),
    ).toBe(0);

    expect(lefthook.calls).toEqual([]);
    expect(messages).toEqual([expect.stringContaining("not a Git work tree root")]);
  });

  it("skips when the root sits inside another repository rather than being one", () => {
    // Unpacked into somebody else's checkout, `git rev-parse` answers *their*
    // top level. Installing there would overwrite their hooks with ours.
    const outer = makeRepository();
    const root = path.join(outer, "vendor", "template");
    mkdirSync(root, { recursive: true });
    addLefthook(root);
    const lefthook = makeFakeRunner({ status: 0, stdout: "", stderr: "" });

    expect(
      installHooks({ root, env: {}, run: lefthook.run, log: () => undefined }),
    ).toBe(0);

    expect(lefthook.calls).toEqual([]);
    expect(existsSync(path.join(outer, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("skips when lefthook is not installed", () => {
    // A `--prod` install has no devDependencies, so there is no CLI to call.
    const root = makeRepository();
    const lefthook = makeFakeRunner({ status: 0, stdout: "", stderr: "" });
    const messages: string[] = [];

    expect(
      installHooks({
        root,
        env: {},
        run: lefthook.run,
        log: (message) => messages.push(message),
      }),
    ).toBe(0);

    expect(lefthook.calls).toEqual([]);
    expect(messages).toEqual([expect.stringContaining("node_modules/lefthook")]);
  });

  it("refuses to run lefthook when lefthook.yml is missing", () => {
    // `lefthook install` writes a blank config when it finds none, which would
    // put an empty gate in the tree and report success doing it.
    const root = makeRepository();
    addLefthook(root, { config: false });
    const lefthook = makeFakeRunner({ status: 0, stdout: "", stderr: "" });
    const messages: string[] = [];

    expect(
      installHooks({
        root,
        env: {},
        run: lefthook.run,
        log: (message) => messages.push(message),
      }),
    ).toBe(1);

    expect(lefthook.calls).toEqual([]);
    expect(messages).toEqual([expect.stringContaining("ERR_HOOKS_CONFIG_MISSING")]);
    expect(existsSync(path.join(root, "lefthook.yml"))).toBe(false);
  });

  it("fails, naming the repair command, when lefthook install exits non-zero", () => {
    // The `core.hooksPath` case. A silent skip here is the bug #81 is about:
    // the install has to be loud about the layer it could not put in place.
    const root = makeRepository();
    addLefthook(root);
    const lefthook = makeFakeRunner({
      status: 1,
      stdout: "core.hooksPath is set locally",
      stderr: "",
    });
    const messages: string[] = [];

    expect(
      installHooks({
        root,
        env: {},
        run: lefthook.run,
        log: (message) => messages.push(message),
      }),
    ).toBe(1);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("ERR_HOOKS_INSTALL_FAILED");
    expect(messages[0]).toContain("pnpm hooks:install");
    // lefthook's own diagnosis is passed through rather than swallowed.
    expect(messages[0]).toContain("core.hooksPath is set locally");
  });

  it("clears GIT_* before spawning lefthook", () => {
    // An inherited GIT_DIR outranks a cwd, so a `pnpm install` run from inside
    // a hook would otherwise install into whichever repository spawned it.
    const root = makeRepository();
    addLefthook(root);
    const lefthook = makeFakeRunner({ status: 0, stdout: "", stderr: "" });

    expect(
      installHooks({
        root,
        env: { GIT_DIR: "/somewhere/else/.git", PATH: process.env["PATH"] ?? "" },
        run: lefthook.run,
        log: () => undefined,
      }),
    ).toBe(0);

    const call = lefthook.calls[0];
    expect(call?.options.cwd).toBe(root);
    expect(call?.options.env).toBeDefined();
    expect(
      Object.keys(call?.options.env ?? {}).some((key) => key.startsWith("GIT_")),
    ).toBe(false);
  });

  it("reports through console.error by default", () => {
    // scripts/install-hooks.mjs imports `console` from "node:console", which is
    // a distinct object from the ambient global under Vitest — see
    // tests/clean.test.ts for the same spy target.
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);

    expect(installHooks({ root: makeDirectory(), env: {} })).toBe(0);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("not a Git work tree root"),
    );
  });
});

describe("package.json's prepare script", () => {
  /** One `scripts` entry from `package.json`. */
  function packageScript(name: string): string {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );
    const scripts =
      typeof manifest === "object" && manifest !== null && "scripts" in manifest
        ? manifest.scripts
        : undefined;
    const command =
      typeof scripts === "object" && scripts !== null && name in scripts
        ? (scripts as Record<string, unknown>)[name]
        : undefined;
    if (typeof command !== "string") {
      throw new Error(`package.json has no "${name}" script.`);
    }
    return command;
  }

  it("runs the installer, so `pnpm install` is the whole setup", () => {
    // Delete this and AGENTS.md's Enforcement layers table goes back to
    // claiming a layer a fresh clone does not have.
    expect(packageScript("prepare")).toBe("node scripts/install-hooks.mjs");
  });

  it("keeps hooks:install as the manual repair for the same thing", () => {
    expect(packageScript("hooks:install")).toBe("lefthook install");
  });
});
