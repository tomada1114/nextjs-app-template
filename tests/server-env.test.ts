import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

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
    vi.stubEnv("API_ACCESS_KEY", "an-example-access-key");

    expect(readServerEnv({ requiresAccessKey: false })).toStrictEqual({
      ANTHROPIC_API_KEY: "an-example-value",
      API_ACCESS_KEY: "an-example-access-key",
    });
  });

  it("treats an unset variable as absent", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);

    expect(
      readServerEnv({ requiresAccessKey: false }).ANTHROPIC_API_KEY,
    ).toBeUndefined();
  });

  it("treats a blank variable as absent, so a copied .env.example still boots", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "   ");
    vi.stubEnv("API_ACCESS_KEY", "   ");

    expect(readServerEnv({ requiresAccessKey: false })).toStrictEqual({
      ANTHROPIC_API_KEY: undefined,
      API_ACCESS_KEY: undefined,
    });
  });

  // The handler compares against a bearer token, which cannot carry leading or
  // trailing whitespace, so a key kept as pasted -- out of a secret manager,
  // with the newline -- would answer 401 to every request including one sending
  // the exact configured value.
  it("trims a configured value, so a pasted newline is not part of the credential", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "  an-example-value\n");
    vi.stubEnv("API_ACCESS_KEY", " an-example-access-key ");

    expect(readServerEnv({ requiresAccessKey: true })).toStrictEqual({
      ANTHROPIC_API_KEY: "an-example-value",
      API_ACCESS_KEY: "an-example-access-key",
    });
  });

  it("ignores environment variables it does not declare", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("API_ACCESS_KEY", undefined);
    vi.stubEnv("SOME_UNDECLARED_VARIABLE", "present");

    expect(readServerEnv({ requiresAccessKey: false })).toStrictEqual({});
  });
});

/** What `readServerEnv` reported, flattened; `[]` when it did not throw. */
function reportedIssues(
  requiresAccessKey: boolean,
): { path: string; message: string }[] {
  try {
    readServerEnv({ requiresAccessKey });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
    }
    throw error;
  }
  return [];
}

// `POST /api/ask` has no authentication of its own and no middleware in front
// of it (`src/proxy.ts`'s matcher excludes `api`), so an endpoint that costs
// money to answer must not also be left open. Refusing that combination at
// startup is what makes the protection impossible to forget: the server stops
// as it boots rather than serving one request unprotected (#82).
//
// What decides it is the adapter `src/server/composition.ts` wires, which is
// what it declares through `requiresAccessKey` -- never which variables happen
// to be exported on the machine.
describe("readServerEnv with a billed adapter wired", () => {
  it("throws when no API_ACCESS_KEY is set beside it", () => {
    vi.stubEnv("API_ACCESS_KEY", undefined);

    expect(() => readServerEnv({ requiresAccessKey: true })).toThrow(z.ZodError);
  });

  it("names API_ACCESS_KEY as the variable at fault, and no credential value", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "an-example-value");
    vi.stubEnv("API_ACCESS_KEY", undefined);

    const reported = reportedIssues(true);

    expect(reported.map((issue) => issue.path)).toStrictEqual(["API_ACCESS_KEY"]);
    // A ZodError reaches a log and a crash report, so it may name the variable
    // and never what was in it -- `designing-errors`.
    expect(reported.map((issue) => issue.message).join("\n")).not.toContain(
      "an-example-value",
    );
  });

  it("throws when API_ACCESS_KEY is blank, which reads as absent", () => {
    vi.stubEnv("API_ACCESS_KEY", "   ");

    expect(() => readServerEnv({ requiresAccessKey: true })).toThrow(z.ZodError);
  });

  it("succeeds when an API_ACCESS_KEY is set", () => {
    vi.stubEnv("API_ACCESS_KEY", "an-example-access-key");

    expect(readServerEnv({ requiresAccessKey: true }).API_ACCESS_KEY).toBe(
      "an-example-access-key",
    );
  });
});

describe("readServerEnv with the fake adapter wired", () => {
  it("requires nothing, so the zero-credential quick start boots", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("API_ACCESS_KEY", undefined);

    // `pnpm dev` answers from the fake adapter, which bills nothing, so there
    // is nothing to protect.
    expect(reportedIssues(false)).toStrictEqual([]);
  });

  // The regression the presence-based spelling of this rule caused: a machine
  // that exports ANTHROPIC_API_KEY for something else -- recording the LLM
  // fixtures under `LLM_RECORD=1` needs it -- would refuse to start, build, or
  // even load this suite, while the fake adapter was still what answered.
  it("requires nothing when a provider credential is exported for another purpose", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "an-example-value");
    vi.stubEnv("API_ACCESS_KEY", undefined);

    expect(reportedIssues(false)).toStrictEqual([]);
  });

  it("accepts an API_ACCESS_KEY on its own", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("API_ACCESS_KEY", "an-example-access-key");

    expect(readServerEnv({ requiresAccessKey: false })).toStrictEqual({
      API_ACCESS_KEY: "an-example-access-key",
    });
  });
});
