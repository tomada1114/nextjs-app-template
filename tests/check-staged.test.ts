import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkStagedChange, main, stagedChanges } from "../scripts/check-staged.mjs";

// scripts/check-staged.mjs is the pre-commit layer described in AGENTS.md's
// "Enforcement layers": it sees a staged git diff, not a tool call, so these
// tests drive it against a real throwaway repository rather than mocking git.
const repos: string[] = [];

// The suite itself runs from a git hook (`lefthook.yml` runs `test:related` on
// pre-commit), and git hands a hook GIT_DIR and, for a partial
// `git commit -- <path>`, GIT_INDEX_FILE. `scripts/check-staged.mjs`
// is meant to honor those — it is the pre-commit layer. Here they must go, or
// the fixture repositories below are built inside the checkout this suite is
// running in. See scripts/lib/git-env.mjs.
function clearGitEnvironment(): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("GIT_")) {
      vi.stubEnv(name, undefined);
    }
  }
}

beforeEach(clearGitEnvironment);

/** A fresh, empty git repository with a local identity, isolated from real user config. */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "check-staged-test-"));
  repos.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  // A fixture repository ships no .gitignore of its own, but git still reads
  // the developer's global excludes file, which on a machine that runs agents
  // lists `.claude/settings.local.json`. Left in place, `stage()` would fail
  // to add exactly the paths these tests exist to hand the guard, and only on
  // some machines. Point it at nothing so the fixture is the whole world.
  execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: dir });
  return dir;
}

/** Write a file, stage it, and return the repo-relative path for convenience. */
function stage(dir: string, relativePath: string, content: string): string {
  const absolute = path.join(dir, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  execFileSync("git", ["add", relativePath], { cwd: dir });
  return relativePath;
}

/** Commit whatever is currently staged, so a later change has a HEAD to diff against. */
function commit(dir: string, message = "initial"): void {
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (repos.length > 0) {
    const dir = repos.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("stagedChanges", () => {
  it("reports an added file as status A", () => {
    const dir = makeRepo();
    stage(dir, "notes.md", "hello\n");
    expect(stagedChanges(dir)).toEqual([{ status: "A", path: "notes.md" }]);
  });

  it("reports a deleted file as status D", () => {
    const dir = makeRepo();
    stage(dir, "notes.md", "hello\n");
    commit(dir);
    execFileSync("git", ["rm", "-q", "notes.md"], { cwd: dir });
    expect(stagedChanges(dir)).toEqual([{ status: "D", path: "notes.md" }]);
  });

  it("reports nothing when the index matches HEAD", () => {
    const dir = makeRepo();
    stage(dir, "notes.md", "hello\n");
    commit(dir);
    expect(stagedChanges(dir)).toEqual([]);
  });
});

describe("checkStagedChange", () => {
  it("blocks staging a real .env file", () => {
    const dir = makeRepo();
    const change = { status: "A", path: stage(dir, ".env", "API_TOKEN=live\n") };
    expect(checkStagedChange(change, dir)).toMatch(/must not be committed/);
  });

  it("allows staging a .env.example file", () => {
    const dir = makeRepo();
    const change = { status: "A", path: stage(dir, ".env.example", "API_TOKEN=\n") };
    expect(checkStagedChange(change, dir)).toBeNull();
  });

  it("allows staging direnv's bare .envrc", () => {
    // The file this issue is about: in direnv's convention `.envrc` is the
    // shared script, and the values live in the `.envrc.local` it sources.
    const dir = makeRepo();
    const change = {
      status: "A",
      path: stage(
        dir,
        ".envrc",
        "use flake\nlayout node\nsource_env_if_exists .envrc.local\n",
      ),
    };
    expect(checkStagedChange(change, dir)).toBeNull();
  });

  it("blocks a .envrc that exports a real key", () => {
    // Asserted on the credential message rather than the path one: if the
    // path rule silently came back it would short-circuit the content scan,
    // and this row is what notices. The variable is named generically because
    // the suite that keeps the AI layer removable tracks the provider's own
    // env name, and this file has no business joining that removal.
    const dir = makeRepo();
    const key = ["export LLM_API_KEY=", "sk-ant-", "a".repeat(25)].join("");
    const change = { status: "A", path: stage(dir, ".envrc", `${key}\n`) };
    expect(checkStagedChange(change, dir)).toMatch(/Anthropic/);
  });

  it("blocks staging a .envrc.local", () => {
    const dir = makeRepo();
    const change = {
      status: "A",
      path: stage(dir, ".envrc.local", "export API_TOKEN=live\n"),
    };
    expect(checkStagedChange(change, dir)).toMatch(/must not be committed/);
  });

  it("blocks staging a .envrc under secrets/", () => {
    // The carve-out is scoped to the dotenv branch, so the `secrets/` rule
    // still refuses this one.
    const dir = makeRepo();
    const change = {
      status: "A",
      path: stage(dir, "secrets/.envrc", "use flake\n"),
    };
    expect(checkStagedChange(change, dir)).toMatch(/must not be committed/);
  });

  it("blocks staging the personal .claude/settings.local.json", () => {
    const dir = makeRepo();
    const change = {
      status: "A",
      path: stage(dir, ".claude/settings.local.json", "{}\n"),
    };
    expect(checkStagedChange(change, dir)).toMatch(/must not be committed/);
  });

  it("blocks a staged file that embeds a credential", () => {
    const dir = makeRepo();
    const key = ["-----BEGIN RSA ", "PRIVATE ", "KEY-----"].join("");
    const change = { status: "A", path: stage(dir, "notes.txt", `${key}\n`) };
    expect(checkStagedChange(change, dir)).toMatch(/private key/);
  });

  it("allows weakening a config file", () => {
    // Deliberate: whether relaxing a gate is a good idea is a judgement call,
    // and a judgement call belongs in the pull request, where a reader can
    // disagree with it. A hook that blocked this would fire on legitimate work
    // and teach its author to reach for `--no-verify`, which would disable the
    // secret checks above along with it.
    const dir = makeRepo();
    stage(dir, "eslint.config.mjs", "reportUnusedDisableDirectives\n");
    commit(dir);
    const change = {
      status: "M",
      path: stage(dir, "eslint.config.mjs", "// removed\n"),
    };
    expect(checkStagedChange(change, dir)).toBeNull();
  });

  it("allows deleting a file, whatever it is", () => {
    const dir = makeRepo();
    stage(dir, "package.json", "{}\n");
    commit(dir);
    execFileSync("git", ["rm", "-q", "package.json"], { cwd: dir });
    const change = { status: "D", path: "package.json" };
    expect(checkStagedChange(change, dir)).toBeNull();
  });

  it("allows a re-generated lockfile", () => {
    // The pre-commit layer deliberately does not check lockfile content: a
    // regenerated lockfile is an ordinary, expected commit, and a git diff
    // cannot tell it apart from a hand edit. Only a layer that sees the tool
    // call that produced the change could, and this repository ships none — so
    // "generated, never hand-edited" holds as an instruction a reviewer checks,
    // not as a block. See AGENTS.md's "Enforcement layers", and
    // `managing-dependencies` for the reasoning.
    const dir = makeRepo();
    stage(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    commit(dir);
    const change = {
      status: "M",
      path: stage(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\npackages: {}\n"),
    };
    expect(checkStagedChange(change, dir)).toBeNull();
  });

  it("allows an ordinary source change", () => {
    const dir = makeRepo();
    const change = {
      status: "A",
      path: stage(dir, "src/example.ts", "export const value = 1;\n"),
    };
    expect(checkStagedChange(change, dir)).toBeNull();
  });

  it("allows staging a password schema field", () => {
    // The end-to-end statement of the false positive this layer used to have:
    // the moment a sign-in form enters a project, this line is written, and a
    // hook that blocks it teaches its author to reach for `--no-verify` —
    // which switches off every credential rule at once.
    const dir = makeRepo();
    const change = {
      status: "A",
      path: stage(dir, "src/sign-in.ts", "password: z.string()\n"),
    };
    expect(checkStagedChange(change, dir)).toBeNull();
  });

  it("blocks a staged file that assigns a quoted password", () => {
    // Assembled rather than written out, for the reason
    // tests/guard-rules.test.ts states: a literal secret-shaped string in a
    // test file is a real finding for any scanner pointed at the repository.
    const dir = makeRepo();
    const assignment = ['{ "password', '": ', '"S3cr3t-Example" }'].join("");
    const change = {
      status: "A",
      path: stage(dir, "config/app.json", `${assignment}\n`),
    };
    expect(checkStagedChange(change, dir)).toMatch(/password/);
  });

  it.each([
    ["id_rsa", "id_rsa"],
    ["id_dsa", "id_dsa"],
    ["id_ecdsa", "id_ecdsa"],
    ["id_ecdsa_sk", "id_ecdsa_sk"],
    ["id_ed25519", "id_ed25519"],
    ["id_ed25519_sk", "id_ed25519_sk"],
    [".pem file", "server.pem"],
    [".p12 file", "client.p12"],
    [".pfx file", "client.pfx"],
    [".key file", "server.key"],
    [".ppk file", "server.ppk"],
    ["a nested key file", ".ssh/id_rsa"],
    ["a mixed-case extension", "server.PEM"],
    ["a mixed-case basename", "ID_RSA"],
  ])("blocks staging a %s regardless of its content", (_label, relativePath) => {
    const dir = makeRepo();
    // The rule fires on the path alone, so content that would otherwise pass
    // every credential-content check still gets blocked here.
    const change = {
      status: "A",
      path: stage(dir, relativePath, "not secret-shaped\n"),
    };
    expect(checkStagedChange(change, dir)).toMatch(/private key file/);
  });

  it("allows a file that merely mentions id_rsa in its own name", () => {
    const dir = makeRepo();
    const change = {
      status: "A",
      path: stage(dir, "docs/id_rsa-rotation.md", "How to rotate an id_rsa key.\n"),
    };
    expect(checkStagedChange(change, dir)).toBeNull();
  });
});

describe("main", () => {
  it("returns 0 when nothing staged is unsafe", () => {
    const dir = makeRepo();
    stage(dir, "src/example.ts", "export const value = 1;\n");
    expect(main(dir)).toBe(0);
  });

  it("returns 0 when only a clean direnv .envrc is staged", () => {
    const dir = makeRepo();
    stage(dir, ".envrc", "use flake\nsource_env_if_exists .envrc.local\n");
    expect(main(dir)).toBe(0);
  });

  it("returns 1 when a staged change is blocked", () => {
    const dir = makeRepo();
    stage(dir, ".env", "API_TOKEN=live\n");
    expect(main(dir)).toBe(1);
  });
});
