import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { readServerEnv, SERVER_ENV_NAMES } from "../src/server/env";

// `.env.example` is the one `.env*` file this repository tracks
// (`.gitignore`), and it is the only documentation of what the application
// needs configured. Nothing stops the two from drifting except this file: a
// variable added to src/server/env.ts and forgotten here would leave the next
// person to discover it from a stack trace.
//
// The scanner is deliberately not a dotenv parser. Adding a dependency to read
// six lines would cost more than it saves, and the shape asserted below --
// comments, blanks, and `NAME=value` -- is the whole grammar this file is
// allowed to use.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const envExamplePath = path.join(repoRoot, ".env.example");

/** One `NAME=value` assignment, or a line that is neither that nor a comment. */
interface ScannedEnvExample {
  /** Every assigned name, in the order the file lists them. */
  readonly names: string[];
  /** Every assigned value, keyed by name. */
  readonly values: Map<string, string>;
  /** `line N: <text>` for every line that is not blank, a comment, or an assignment. */
  readonly malformed: string[];
}

/** Reads `.env.example` into the three things the assertions below need. */
function scanEnvExample(): ScannedEnvExample {
  const names: string[] = [];
  const values = new Map<string, string>();
  const malformed: string[] = [];

  const lines = readFileSync(envExamplePath, "utf8").split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const assignment = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (assignment === null) {
      malformed.push(`line ${String(index + 1)}: ${line}`);
      continue;
    }
    names.push(assignment[1] ?? "");
    values.set(assignment[1] ?? "", assignment[2] ?? "");
  }

  return { names, values, malformed };
}

describe(".env.example", () => {
  it("uses only comments, blank lines and NAME=value assignments", () => {
    expect(scanEnvExample().malformed).toStrictEqual([]);
  });

  it("lists exactly the variables src/server/env.ts declares", () => {
    const listed = [...scanEnvExample().names].sort();

    expect(listed).toStrictEqual([...SERVER_ENV_NAMES].sort());
  });

  it("names each variable at most once", () => {
    const { names } = scanEnvExample();

    expect(names).toHaveLength(new Set(names).size);
  });

  it("ships no value, so a real credential can never be committed with it", () => {
    const withValues = [...scanEnvExample().values.entries()]
      .filter(([, value]) => value !== "")
      .map(([name]) => name);

    expect(withValues).toStrictEqual([]);
  });
});

describe("readServerEnv", () => {
  it("returns the value of a variable that is set", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "an-example-value");

    expect(readServerEnv()).toStrictEqual({ ANTHROPIC_API_KEY: "an-example-value" });
  });

  it("treats an unset variable as absent", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);

    expect(readServerEnv().ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("treats a blank variable as absent, so a copied .env.example still boots", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "   ");

    expect(readServerEnv().ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("ignores environment variables it does not declare", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("SOME_UNDECLARED_VARIABLE", "present");

    expect(readServerEnv()).toStrictEqual({});
  });
});
