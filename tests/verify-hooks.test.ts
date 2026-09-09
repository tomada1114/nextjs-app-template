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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { isolatedGitEnv } from "../scripts/lib/git-env.mjs";
import { runNode } from "../scripts/lib/node-tools.mjs";
import { verifyHooks } from "../scripts/verify-hooks.mjs";

// lefthook installs the pre-commit hook itself, from its own `postinstall`, on
// every non-CI `pnpm install` — `pnpm-workspace.yaml` allowlists that build
// script. What it cannot do is fail: its `spawnSync` never throws on a non-zero
// status and the status is never read, so a `lefthook install -f` that could
// not write leaves `pnpm install` green with no hook and nothing on screen.
// That silent absence is what issue #81 is really about, and what
// `scripts/verify-hooks.mjs` closes.
//
// So these tests drive the real lefthook against throwaway `git init`
// repositories wherever the point is what actually lands on disk, and pin the
// two halves the verifier checks: a `lefthook.yml` that declares `pre-commit`
// (lefthook writes a blank config and calls it success), and a hook at the path
// git will really use (`core.hooksPath` legitimately redirects it).

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const workspaces: string[] = [];

/** A throwaway directory, removed after the test that made it. */
function makeDirectory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-hooks-test-"));
  workspaces.push(dir);
  return dir;
}

/**
 * An environment that reaches neither the developer's git config nor a CI flag.
 *
 * `isolatedGitEnv` strips every `GIT_*` variable, `GIT_CONFIG_GLOBAL` included,
 * so it cannot be used to *point* git at a throwaway config — the isolation has
 * to come from `HOME`/`XDG_CONFIG_HOME` instead. Without it, a machine with a
 * global `core.hooksPath` redirects every fixture repository's hooks at the
 * developer's own directory and these assertions stop meaning anything.
 * `CI` is cleared because this suite itself runs under CI, where the verifier
 * skips by design.
 */
function isolatedEnv(): NodeJS.ProcessEnv {
  const home = makeDirectory();
  return isolatedGitEnv({
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    CI: "",
    ALLOW_MISSING_GIT_HOOKS: "",
  });
}

/** A throwaway Git repository, initialised under an isolated environment. */
function makeRepository(env: NodeJS.ProcessEnv): string {
  const dir = makeDirectory();
  execFileSync("git", ["init", "-q"], { cwd: dir, env });
  return dir;
}

/** Give a throwaway repository the lefthook package, and optionally the config. */
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

/** Run the real `lefthook install -f`, the way lefthook's own postinstall does. */
function installLefthookHooks(root: string, env: NodeJS.ProcessEnv) {
  return runNode(
    path.join(root, "node_modules", "lefthook", "bin", "index.js"),
    ["install", "-f"],
    { cwd: root, env },
  );
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

describe("verifyHooks", () => {
  it("passes once lefthook has really installed the hook", () => {
    const env = isolatedEnv();
    const root = makeRepository(env);
    addLefthook(root);
    expect(installLefthookHooks(root, env).status).toBe(0);
    expect(existsSync(path.join(root, ".git", "hooks", "pre-commit"))).toBe(true);
    const messages: string[] = [];

    const status = verifyHooks({ root, env, log: (m) => messages.push(m) });

    expect(messages).toEqual([]);
    expect(status).toBe(0);
  });

  it("passes when core.hooksPath redirects the hook out of .git/hooks", () => {
    // A merely *set* `core.hooksPath` is not a defect: lefthook installs into
    // that directory and git runs hooks from it, so the gate is in force.
    // Asking `git rev-parse --git-path hooks` rather than assuming
    // `.git/hooks` is what keeps this from being a false failure.
    const env = isolatedEnv();
    const root = makeRepository(env);
    addLefthook(root);
    const hooksDirectory = path.join(makeDirectory(), "elsewhere");
    mkdirSync(hooksDirectory, { recursive: true });
    execFileSync("git", ["config", "core.hooksPath", hooksDirectory], {
      cwd: root,
      env,
    });
    expect(installLefthookHooks(root, env).status).toBe(0);
    expect(existsSync(path.join(hooksDirectory, "pre-commit"))).toBe(true);
    expect(existsSync(path.join(root, ".git", "hooks", "pre-commit"))).toBe(false);

    expect(verifyHooks({ root, env, log: () => undefined })).toBe(0);
  });

  it("fails, naming the opt-out, when lefthook's postinstall silently installed nothing", () => {
    // The measured silent absence, reproduced end to end: `core.hooksPath`
    // points below a regular file, so `mkdir` cannot succeed for any user.
    // `lefthook install -f` exits 1 and writes nothing, while lefthook's own
    // `postinstall.js` — the thing `pnpm install` actually runs — exits 0.
    const env = isolatedEnv();
    const root = makeRepository(env);
    addLefthook(root);
    const blocker = path.join(makeDirectory(), "a-file-not-a-directory");
    writeFileSync(blocker, "not a directory\n");
    execFileSync("git", ["config", "core.hooksPath", path.join(blocker, "hooks")], {
      cwd: root,
      env,
    });

    expect(installLefthookHooks(root, env).status).toBe(1);
    // lefthook's postinstall swallows that failure. This is the premise the
    // verifier exists for; if it ever stops holding, this line says so.
    const postinstall = runNode(
      path.join(root, "node_modules", "lefthook", "postinstall.js"),
      [],
      { cwd: root, env: { ...env, INIT_CWD: root } },
    );
    expect(postinstall.status).toBe(0);

    const messages: string[] = [];
    expect(verifyHooks({ root, env, log: (m) => messages.push(m) })).toBe(1);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("ERR_HOOKS_NOT_INSTALLED");
    expect(messages[0]).toContain("pnpm hooks:install");
    expect(messages[0]).toContain("ALLOW_MISSING_GIT_HOOKS");
  });

  it("fails when lefthook.yml is absent", () => {
    const env = isolatedEnv();
    const root = makeRepository(env);
    addLefthook(root, { config: false });
    const messages: string[] = [];

    expect(verifyHooks({ root, env, log: (m) => messages.push(m) })).toBe(1);

    expect(messages).toEqual([expect.stringContaining("ERR_HOOKS_CONFIG_MISSING")]);
  });

  it("fails on the blank config lefthook writes for itself and calls success", () => {
    // Measured: with no `lefthook.yml`, `lefthook install -f` creates one, says
    // `sync hooks: ✔️` and exits 0 — an empty gate reporting success. It
    // happens during lefthook's postinstall, before `prepare` ever runs, so the
    // verifier is the only thing that can see it.
    const env = isolatedEnv();
    const root = makeRepository(env);
    addLefthook(root, { config: false });

    expect(installLefthookHooks(root, env).status).toBe(0);
    expect(existsSync(path.join(root, "lefthook.yml"))).toBe(true);

    const messages: string[] = [];
    expect(verifyHooks({ root, env, log: (m) => messages.push(m) })).toBe(1);

    expect(messages).toEqual([expect.stringContaining("ERR_HOOKS_CONFIG_INCOMPLETE")]);
  });

  it("fails when the installed pre-commit hook is somebody else's", () => {
    const env = isolatedEnv();
    const root = makeRepository(env);
    addLefthook(root);
    writeFileSync(
      path.join(root, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\nexit 0\n",
    );
    const messages: string[] = [];

    expect(verifyHooks({ root, env, log: (m) => messages.push(m) })).toBe(1);

    expect(messages).toEqual([expect.stringContaining("ERR_HOOKS_NOT_LEFTHOOK")]);
  });

  it("fails when git cannot say where the hooks directory is", () => {
    const env = isolatedEnv();
    const root = makeRepository(env);
    addLefthook(root);
    const messages: string[] = [];

    const status = verifyHooks({
      root,
      env,
      // Only the `--git-path` question fails; the work-tree question still
      // answers, so the run reaches the half that cannot be resolved.
      git: (args, options) =>
        args[1] === "--git-path"
          ? undefined
          : execFileSync("git", [...args], { ...options, encoding: "utf8" }).trim(),
      log: (m) => messages.push(m),
    });

    expect(status).toBe(1);
    expect(messages).toEqual([expect.stringContaining("ERR_HOOKS_PATH_UNRESOLVED")]);
  });
});

describe("verifyHooks skips", () => {
  it("skips when CI is set", () => {
    const messages: string[] = [];

    expect(
      verifyHooks({
        root: makeDirectory(),
        env: { CI: "true" },
        log: (m) => messages.push(m),
      }),
    ).toBe(0);

    expect(messages).toEqual([expect.stringContaining("CI is set")]);
  });

  it("skips when the opt-out is set", () => {
    // A missing hook a developer chose and typed out, which is the whole
    // difference from the absence this script removes.
    const env = isolatedEnv();
    const root = makeRepository(env);
    addLefthook(root);
    const messages: string[] = [];

    expect(
      verifyHooks({
        root,
        env: { ...env, ALLOW_MISSING_GIT_HOOKS: "1" },
        log: (m) => messages.push(m),
      }),
    ).toBe(0);

    expect(messages).toEqual([
      expect.stringContaining("ALLOW_MISSING_GIT_HOOKS is set"),
    ]);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["0", "0"],
    ["false", "false"],
  ])("still verifies when CI and the opt-out are %s", (_label, value) => {
    // lefthook's own truthiness: an off spelling must not read as "on", or a
    // developer who exports `CI=0` silently loses both the hook and the check.
    const env = isolatedEnv();
    const root = makeRepository(env);
    addLefthook(root);
    const overrides =
      value === undefined ? {} : { CI: value, ALLOW_MISSING_GIT_HOOKS: value };
    const messages: string[] = [];

    expect(
      verifyHooks({
        root,
        env: {
          ...env,
          CI: undefined,
          ALLOW_MISSING_GIT_HOOKS: undefined,
          ...overrides,
        },
        log: (m) => messages.push(m),
      }),
    ).toBe(1);

    expect(messages).toEqual([expect.stringContaining("ERR_HOOKS_NOT_INSTALLED")]);
  });

  it("skips when the directory is not a Git work tree at all", () => {
    // A tarball extract or a Docker build context: `pnpm install` must still
    // succeed rather than failing on a hook nobody there can use.
    const messages: string[] = [];

    expect(
      verifyHooks({
        root: makeDirectory(),
        env: isolatedEnv(),
        log: (m) => messages.push(m),
      }),
    ).toBe(0);

    expect(messages).toEqual([expect.stringContaining("not a Git work tree")]);
  });

  it("skips when the root sits inside another repository rather than being one", () => {
    // Unpacked into somebody else's checkout, `git rev-parse` answers *their*
    // top level, and their hooks are none of this project's business.
    const env = isolatedEnv();
    const outer = makeRepository(env);
    const root = path.join(outer, "vendor", "template");
    mkdirSync(root, { recursive: true });
    addLefthook(root);
    const messages: string[] = [];

    expect(verifyHooks({ root, env, log: (m) => messages.push(m) })).toBe(0);

    expect(messages).toEqual([
      expect.stringContaining("sits inside another Git repository"),
    ]);
  });

  it("skips when lefthook is not installed", () => {
    // A `--prod` install has no devDependencies, so there is no gate to expect.
    const env = isolatedEnv();
    const root = makeRepository(env);
    const messages: string[] = [];

    expect(verifyHooks({ root, env, log: (m) => messages.push(m) })).toBe(0);

    expect(messages).toEqual([expect.stringContaining("node_modules/lefthook")]);
  });

  it("reports through console.error by default", () => {
    // scripts/verify-hooks.mjs imports `console` from "node:console", which is
    // a distinct object from the ambient global under Vitest — see
    // tests/clean.test.ts for the same spy target.
    const errorSpy = vi
      .spyOn(consoleModule, "error")
      .mockImplementation(() => undefined);

    expect(verifyHooks({ root: makeDirectory(), env: isolatedEnv() })).toBe(0);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("not a Git work tree"),
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

  it("verifies rather than installs", () => {
    // `prepare` runs after every dependency's own lifecycle script, so it sees
    // the result of lefthook's postinstall. Pointing it at an installer instead
    // would only repeat work lefthook already did — and repeat it just as
    // silently, since that is the defect.
    expect(packageScript("prepare")).toBe("node scripts/verify-hooks.mjs");
  });

  it("keeps hooks:install as the manual repair", () => {
    expect(packageScript("hooks:install")).toBe("lefthook install");
  });
});
