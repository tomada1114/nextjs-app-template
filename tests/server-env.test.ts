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

/**
 * Stubs every variable `src/server/env.ts` declares, plus `NEXT_PHASE`.
 *
 * @remarks
 * Each name not given is stubbed to `undefined` rather than left alone, so a
 * developer's shell that exports `OPENROUTER_API_KEY` or `LLM_ADAPTER` for
 * another reason cannot decide what a case below observes.
 */
function stubEnvironment(env: Readonly<Record<string, string | undefined>>): void {
  for (const name of [...SERVER_ENV_NAMES, "NEXT_PHASE"]) {
    vi.stubEnv(name, env[name]);
  }
}

describe("readServerEnv", () => {
  it("returns the value of a variable that is set", () => {
    stubEnvironment({
      OPENROUTER_API_KEY: "an-example-value",
      LLM_MODEL: "vendor/an-example-model",
      API_ACCESS_KEY: "an-example-access-key",
    });

    expect(readServerEnv({ billsAProvider: false })).toStrictEqual({
      OPENROUTER_API_KEY: "an-example-value",
      LLM_MODEL: "vendor/an-example-model",
      API_ACCESS_KEY: "an-example-access-key",
    });
  });

  it("treats an unset variable as absent", () => {
    stubEnvironment({});

    expect(readServerEnv({ billsAProvider: false }).OPENROUTER_API_KEY).toBeUndefined();
  });

  it("treats a blank variable as absent, so a copied .env.example still parses", () => {
    stubEnvironment({
      OPENROUTER_API_KEY: "   ",
      LLM_MODEL: "",
      LLM_ADAPTER: " ",
      API_ACCESS_KEY: "   ",
    });

    expect(readServerEnv({ billsAProvider: false })).toStrictEqual({
      OPENROUTER_API_KEY: undefined,
      LLM_MODEL: undefined,
      LLM_ADAPTER: undefined,
      API_ACCESS_KEY: undefined,
    });
  });

  // The handler compares against a bearer token, which cannot carry leading or
  // trailing whitespace, so a key kept as pasted -- out of a secret manager,
  // with the newline -- would answer 401 to every request including one sending
  // the exact configured value.
  it("trims a configured value, so a pasted newline is not part of the credential", () => {
    stubEnvironment({
      OPENROUTER_API_KEY: "  an-example-value\n",
      API_ACCESS_KEY: " an-example-access-key ",
    });

    expect(readServerEnv({ billsAProvider: true })).toStrictEqual({
      OPENROUTER_API_KEY: "an-example-value",
      API_ACCESS_KEY: "an-example-access-key",
    });
  });

  it("ignores environment variables it does not declare", () => {
    stubEnvironment({});
    vi.stubEnv("SOME_UNDECLARED_VARIABLE", "present");

    expect(readServerEnv({ billsAProvider: false })).toStrictEqual({});
  });
});

/** What `readServerEnv` reported, flattened; `[]` when it did not throw. */
function reportedIssues(billsAProvider: boolean): { path: string; message: string }[] {
  try {
    readServerEnv({ billsAProvider });
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
// money to answer must not also be left open (#82), and an adapter that cannot
// authenticate must not start at all. Refusing both at startup is what makes
// them impossible to forget.
describe("readServerEnv with the billed provider adapter wired", () => {
  const BOTH_KEYS = {
    OPENROUTER_API_KEY: "an-example-value",
    API_ACCESS_KEY: "an-example-access-key",
  };

  it("succeeds when both keys are set", () => {
    stubEnvironment(BOTH_KEYS);

    expect(reportedIssues(true)).toStrictEqual([]);
  });

  it.each([
    ["OPENROUTER_API_KEY", undefined],
    ["OPENROUTER_API_KEY", "   "],
    ["API_ACCESS_KEY", undefined],
    ["API_ACCESS_KEY", "   "],
  ])("refuses to boot when %s is %o, naming it alone", (name, value) => {
    stubEnvironment({ ...BOTH_KEYS, [name]: value });

    expect(() => readServerEnv({ billsAProvider: true })).toThrow(z.ZodError);
    expect(reportedIssues(true).map((issue) => issue.path)).toStrictEqual([name]);
  });

  it("names both variables at fault, and no credential value", () => {
    stubEnvironment({ LLM_MODEL: "vendor/an-example-model" });

    const reported = reportedIssues(true);

    expect(reported.map((issue) => issue.path).sort()).toStrictEqual([
      "API_ACCESS_KEY",
      "OPENROUTER_API_KEY",
    ]);
    // A ZodError reaches a log and a crash report, so it may name the variable
    // and never what was in it -- `designing-errors`.
    expect(reported.map((issue) => issue.message).join("\n")).not.toContain(
      "an-example-model",
    );
  });

  // `next build` evaluates the route module, and with it this read, on a
  // machine that holds no production credential -- CI among them. Only the
  // build phase waits; a server started from that build still refuses.
  it("defers both requirements while next build collects page data", () => {
    stubEnvironment({ NEXT_PHASE: "phase-production-build" });

    expect(reportedIssues(true)).toStrictEqual([]);
  });

  it("still refuses to boot in the phase that serves requests", () => {
    stubEnvironment({ NEXT_PHASE: "phase-production-server" });

    expect(
      reportedIssues(true)
        .map((issue) => issue.path)
        .sort(),
    ).toStrictEqual(["API_ACCESS_KEY", "OPENROUTER_API_KEY"]);
  });

  it("still validates LLM_ADAPTER's shape while next build runs", () => {
    stubEnvironment({
      NEXT_PHASE: "phase-production-build",
      LLM_ADAPTER: "openrouter",
    });

    expect(reportedIssues(true).map((issue) => issue.path)).toStrictEqual([
      "LLM_ADAPTER",
    ]);
  });
});

describe("LLM_ADAPTER", () => {
  it("boots with no key at all when it is fake", () => {
    stubEnvironment({ LLM_ADAPTER: "fake" });

    expect(readServerEnv({ billsAProvider: true })).toStrictEqual({
      LLM_ADAPTER: "fake",
    });
  });

  it("keeps an API_ACCESS_KEY given beside it", () => {
    stubEnvironment({ LLM_ADAPTER: "fake", API_ACCESS_KEY: "an-example-access-key" });

    expect(readServerEnv({ billsAProvider: true }).API_ACCESS_KEY).toBe(
      "an-example-access-key",
    );
  });

  // Never inferred: a missing key with LLM_ADAPTER unset is the deployment
  // mistake the billed rule exists to stop, not a request for the fake.
  it("is not implied by a missing key", () => {
    stubEnvironment({ API_ACCESS_KEY: "an-example-access-key" });

    expect(reportedIssues(true).map((issue) => issue.path)).toStrictEqual([
      "OPENROUTER_API_KEY",
    ]);
  });

  it.each(["openrouter", "Fake", "FAKE", "true", "1", "fake,openrouter"])(
    "rejects %o, so a typo never falls through to either adapter",
    (value) => {
      stubEnvironment({
        ...{ OPENROUTER_API_KEY: "k", API_ACCESS_KEY: "a" },
        LLM_ADAPTER: value,
      });

      expect(reportedIssues(true).map((issue) => issue.path)).toStrictEqual([
        "LLM_ADAPTER",
      ]);
      expect(reportedIssues(false).map((issue) => issue.path)).toStrictEqual([
        "LLM_ADAPTER",
      ]);
    },
  );
});

/** A `fetch` that answers every call with a chat completion, recording each body. */
function recordingCompletions(): { fetch: typeof globalThis.fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  return {
    bodies,
    fetch: (_input, init) => {
      bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: '{"answer":"42"}' },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    },
  };
}

/**
 * Loads `src/server/composition.ts` afresh against `env` -- the boot itself.
 *
 * @remarks
 * The composition root reads the environment once, at module load, so a
 * different environment needs a fresh module registry rather than the
 * instance an earlier case already built.
 */
async function bootWith(
  env: Readonly<Record<string, string | undefined>>,
): Promise<(request: Request) => Promise<Response>> {
  stubEnvironment(env);
  vi.resetModules();
  return (await import("../src/server/composition")).askHandler;
}

function askWithKey(accessKey: string): Request {
  return new Request("http://localhost/api/ask", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessKey}`,
    },
    body: JSON.stringify({ prompt: "What is the answer?" }),
  });
}

describe("the environment src/server/composition.ts boots with", () => {
  it.each(["OPENROUTER_API_KEY", "API_ACCESS_KEY"])(
    "refuses to boot without %s",
    async (name) => {
      const env = { OPENROUTER_API_KEY: "a-key", API_ACCESS_KEY: "an-access-key" };

      await expect(bootWith({ ...env, [name]: undefined })).rejects.toThrow(z.ZodError);
    },
  );

  it("boots with no key at all under LLM_ADAPTER=fake, and reaches no network", async () => {
    const network = vi.fn(() => Promise.reject(new Error("network reached")));
    vi.stubGlobal("fetch", network);

    const handler = await bootWith({ LLM_ADAPTER: "fake" });
    const response = await handler(askWithKey("ignored"));

    expect(response.status).toBe(200);
    expect(network).not.toHaveBeenCalled();
  });

  it("hands LLM_MODEL to the adapter as the model it asks", async () => {
    const { fetch, bodies } = recordingCompletions();
    vi.stubGlobal("fetch", fetch);

    const handler = await bootWith({
      OPENROUTER_API_KEY: "a-key",
      API_ACCESS_KEY: "an-access-key",
      LLM_MODEL: "vendor/an-example-model",
    });
    const response = await handler(askWithKey("an-access-key"));

    expect(response.status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: "vendor/an-example-model" });
  });

  it("asks the adapter's own default model when LLM_MODEL is unset", async () => {
    const { fetch, bodies } = recordingCompletions();
    vi.stubGlobal("fetch", fetch);

    const handler = await bootWith({
      OPENROUTER_API_KEY: "a-key",
      API_ACCESS_KEY: "an-access-key",
    });
    await handler(askWithKey("an-access-key"));

    expect(bodies[0]).toMatchObject({ model: "deepseek/deepseek-v4.1-flash" });
  });
});
