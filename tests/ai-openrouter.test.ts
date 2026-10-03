import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { createOpenRouterAdapter, LlmError } from "../src/ai/index";
import type { Result } from "../src/core/result";
import { headersThenStallFetch, LLM_FIXTURES_DIR, replayFetch } from "./llm-replay";

const SCHEMA = z.object({ answer: z.string() });

/** Where this adapter's fixtures live: one subdirectory per adapter. */
const FIXTURES_DIR = path.join(LLM_FIXTURES_DIR, "openrouter");

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A `fetch` that answers every call with `status` and `body`, recording what it got. */
function respondWith(
  status: number,
  body: unknown,
): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (input, init) => {
      calls.push({
        url: input instanceof Request ? input.url : String(input),
        init: init ?? {},
      });
      return Promise.resolve(
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  };
}

/** A `200` chat completion whose single choice carries `content` verbatim. */
function completion(content: string | null, finishReason: unknown = "stop"): unknown {
  return {
    id: "gen-test",
    object: "chat.completion",
    model: "deepseek/deepseek-v4.1-flash",
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message: { role: "assistant", content },
      },
    ],
  };
}

function ask(
  fetch: typeof globalThis.fetch,
  apiKey: string | undefined = "test-key",
): Promise<Result<z.infer<typeof SCHEMA>, LlmError>> {
  return createOpenRouterAdapter({ apiKey, fetch }).generate({
    schema: SCHEMA,
    prompt: "What is the answer?",
    outputLanguage: "ja",
  });
}

function failureOf<T>(result: Result<T, LlmError>): LlmError {
  if (result.ok) {
    throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
  }
  return result.error;
}

/** The JSON body of the one request `calls` recorded. */
function sentBody(calls: readonly Call[]): unknown {
  const raw = calls[0]?.init.body;
  if (typeof raw !== "string") {
    throw new Error("the adapter sent a request body that was not a JSON string");
  }
  return JSON.parse(raw);
}

describe("createOpenRouterAdapter configuration", () => {
  it.each([1, Number.MAX_SAFE_INTEGER])(
    "accepts a token ceiling of %i",
    (maxTokens) => {
      expect(() =>
        createOpenRouterAdapter({ apiKey: "test-key", maxTokens }),
      ).not.toThrow();
    },
  );
  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects an invalid token ceiling at construction: %o", (maxTokens) => {
    expect(() => createOpenRouterAdapter({ apiKey: "test-key", maxTokens })).toThrow(
      RangeError,
    );
  });

  it.each(["", "   "])("rejects a blank model at construction: %o", (model) => {
    expect(() => createOpenRouterAdapter({ apiKey: "test-key", model })).toThrow(
      TypeError,
    );
  });

  it("normalizes surrounding whitespace in the key and model", async () => {
    const { fetch, calls } = respondWith(200, completion('{"answer":"x"}'));
    const result = await createOpenRouterAdapter({
      apiKey: " test-key ",
      model: " vendor/model ",
      fetch,
    }).generate({ schema: SCHEMA, prompt: "?", outputLanguage: "en" });

    expect(result.ok).toBe(true);
    expect(calls[0]?.init.headers).toMatchObject({ authorization: "Bearer test-key" });
    expect(sentBody(calls)).toMatchObject({ model: "vendor/model" });
  });
});

describe("createOpenRouterAdapter without a credential", () => {
  it.each([undefined, "", "   "])(
    "reports ERR_LLM_AUTH without a round trip when the key is %o",
    async (apiKey: string | undefined) => {
      const { fetch, calls } = respondWith(200, completion('{"answer":"x"}'));

      // Constructed here rather than through `ask`, whose default parameter
      // would substitute a key for the `undefined` case.
      const result = await createOpenRouterAdapter({ apiKey, fetch }).generate({
        schema: SCHEMA,
        prompt: "?",
        outputLanguage: "en",
      });
      const error = failureOf(result);

      expect(error).toBeInstanceOf(LlmError);
      expect(error.code).toBe("ERR_LLM_AUTH");
      expect(calls).toHaveLength(0);
    },
  );
});

describe("createOpenRouterAdapter maps an OpenRouter status onto the port vocabulary", () => {
  it.each([
    [400, "ERR_LLM_CONFIG"],
    [401, "ERR_LLM_AUTH"],
    // Out of credits: fixed in the account, not by asking again.
    [402, "ERR_LLM_AUTH"],
    // OpenRouter's moderation refusal of the input, not a permission error.
    [403, "ERR_LLM_INVALID_OUTPUT"],
    [408, "ERR_LLM_TIMEOUT"],
    [422, "ERR_LLM_INVALID_OUTPUT"],
    [429, "ERR_LLM_RATE_LIMIT"],
    [500, "ERR_LLM_UNAVAILABLE"],
    [502, "ERR_LLM_UNAVAILABLE"],
    [503, "ERR_LLM_UNAVAILABLE"],
    // No documented meaning for this endpoint; the conservative default applies.
    [404, "ERR_LLM_UNAVAILABLE"],
  ])("reports HTTP %i as %s", async (status, code) => {
    const { fetch } = respondWith(status, { error: { code: status, message: "no" } });

    expect(failureOf(await ask(fetch)).code).toBe(code);
  });

  it("keeps the provider's own error text off the message but on cause", async () => {
    const marker = "marker-5d0e7a-do-not-quote-this-provider-text";
    const { fetch } = respondWith(400, { error: { code: 400, message: marker } });

    const error = failureOf(await ask(fetch));

    expect(error.message).not.toContain(marker);
    expect(error.message).toContain("400");
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toContain(marker);
  });

  it("reports a refused connection as ERR_LLM_UNAVAILABLE, keeping the rejection on cause", async () => {
    const refusal = new TypeError("fetch failed: socket hang up");

    const error = failureOf(await ask(() => Promise.reject(refusal)));

    expect(error.code).toBe("ERR_LLM_UNAVAILABLE");
    expect(error.message).toContain("could not reach the provider");
    expect(error.message).not.toContain("socket hang up");
    expect(error.cause).toBe(refusal);
  });
});

describe("createOpenRouterAdapter reads a 200 that is not an answer", () => {
  it.each([
    "length",
    "content_filter",
    "tool_calls",
    "function_call",
    "future_reason",
    null,
    13,
  ])(
    "refuses unfinished or unrecognized answers even when their JSON is valid (%s)",
    async (finishReason) => {
      const { fetch } = respondWith(
        200,
        completion('{"answer":"partial"}', finishReason),
      );
      expect(failureOf(await ask(fetch)).code).toBe("ERR_LLM_INVALID_OUTPUT");
    },
  );

  it("refuses valid JSON when the provider omits its finish reason", async () => {
    const { fetch } = respondWith(200, {
      choices: [{ message: { content: '{"answer":"partial"}' } }],
    });
    expect(failureOf(await ask(fetch)).code).toBe("ERR_LLM_INVALID_OUTPUT");
  });

  it("keeps an unknown finish reason out of log messages", async () => {
    const privateText = "private request content in finish reason";
    const { fetch } = respondWith(200, completion(null, privateText));
    expect(failureOf(await ask(fetch)).message).not.toContain(privateText);
  });
  it.each([
    ["a body that is not JSON at all", "not json at all", "ERR_LLM_UNAVAILABLE"],
    ["a JSON array", [], "ERR_LLM_UNAVAILABLE"],
    ["an object with no choices", { id: "gen-test" }, "ERR_LLM_UNAVAILABLE"],
    ["an empty choices list", { choices: [] }, "ERR_LLM_UNAVAILABLE"],
    // OpenRouter can answer 200 with an error object once a request was
    // accepted upstream; its own code is mapped like a status.
    [
      "an error object carrying 429",
      { error: { code: 429, message: "x" } },
      "ERR_LLM_RATE_LIMIT",
    ],
    [
      "an error object carrying no code",
      { error: { message: "x" } },
      "ERR_LLM_UNAVAILABLE",
    ],
    [
      "a choice that finished with an error",
      completion(null, "error"),
      "ERR_LLM_UNAVAILABLE",
    ],
    ["a refusal with no content", completion(null), "ERR_LLM_INVALID_OUTPUT"],
    [
      "a truncated answer with empty content",
      completion("", "length"),
      "ERR_LLM_INVALID_OUTPUT",
    ],
    [
      "content that is not JSON",
      completion("I would rather not."),
      "ERR_LLM_INVALID_OUTPUT",
    ],
    [
      "JSON that does not match the schema",
      completion('{"answer":42}'),
      "ERR_LLM_INVALID_OUTPUT",
    ],
  ])("reports %s as %s", async (_label, body, code) => {
    const { fetch } = respondWith(200, body);

    expect(failureOf(await ask(fetch)).code).toBe(code);
  });

  it("names the finish_reason, which tells a truncated answer from a malformed one", async () => {
    const { fetch } = respondWith(200, completion('{"answer":"cut sho', "length"));

    expect(failureOf(await ask(fetch)).message).toContain("finish_reason: length");
  });

  it("re-validates against the caller's schema, not only against the JSON Schema", async () => {
    // A refinement has no JSON Schema equivalent, so the provider cannot
    // enforce it and an answer satisfying the derived schema still fails here.
    const refined = SCHEMA.refine((value) => value.answer.length > 3, "too short");
    const { fetch } = respondWith(200, completion('{"answer":"no"}'));

    const result = await createOpenRouterAdapter({
      apiKey: "test-key",
      fetch,
    }).generate({
      schema: refined,
      prompt: "?",
      outputLanguage: "en",
    });

    expect(failureOf(result).code).toBe("ERR_LLM_INVALID_OUTPUT");
  });

  it("reports a schema JSON Schema cannot express as ERR_LLM_INVALID_OUTPUT without sending it", async () => {
    const { fetch, calls } = respondWith(200, completion('{"when":"x"}'));

    const result = await createOpenRouterAdapter({
      apiKey: "test-key",
      fetch,
    }).generate({
      schema: z.object({ when: z.date() }),
      prompt: "?",
      outputLanguage: "en",
    });

    expect(failureOf(result).code).toBe("ERR_LLM_INVALID_OUTPUT");
    expect(calls).toHaveLength(0);
  });
});

describe("createOpenRouterAdapter builds the provider request", () => {
  it("posts to the chat completions endpoint with a bearer credential", async () => {
    const { fetch, calls } = respondWith(200, completion('{"answer":"x"}'));

    await ask(fetch);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("asks for a strict json_schema answer from a provider that honours it, in the requested language", async () => {
    const { fetch, calls } = respondWith(200, completion('{"answer":"x"}'));

    await ask(fetch);

    expect(sentBody(calls)).toStrictEqual({
      model: "deepseek/deepseek-v4.1-flash",
      max_tokens: 1024,
      messages: [
        {
          role: "system",
          content:
            "Write every value of your answer in the language identified by the BCP 47 tag ja.",
        },
        { role: "user", content: "What is the answer?" },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          strict: true,
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      },
      provider: { require_parameters: true },
    });
  });

  it("sends the model and token ceiling it was constructed with", async () => {
    const { fetch, calls } = respondWith(200, completion('{"answer":"x"}'));

    await createOpenRouterAdapter({
      apiKey: "test-key",
      model: "z-ai/glm-4.6",
      maxTokens: 256,
      fetch,
    }).generate({ schema: SCHEMA, prompt: "?", outputLanguage: "en" });

    expect(sentBody(calls)).toMatchObject({ model: "z-ai/glm-4.6", max_tokens: 256 });
  });

  it("uses the global fetch, looked up per request, when none is given", async () => {
    const { fetch, calls } = respondWith(200, completion('{"answer":"x"}'));
    const port = createOpenRouterAdapter({ apiKey: "test-key" });
    vi.stubGlobal("fetch", fetch);

    const result = await port.generate({
      schema: SCHEMA,
      prompt: "?",
      outputLanguage: "en",
    });

    expect(result).toStrictEqual({ ok: true, value: { answer: "x" } });
    expect(calls).toHaveLength(1);
  });
});

describe("createOpenRouterAdapter bounds the whole call", () => {
  it("reports ERR_LLM_TIMEOUT with the caller's reason on cause when the abort lands mid-body", async () => {
    const reason = new Error("the caller changed its mind");
    const controller = new AbortController();
    const { fetch, bodyRead } = headersThenStallFetch();
    const pending = createOpenRouterAdapter({ apiKey: "test-key", fetch }).generate({
      schema: SCHEMA,
      prompt: "?",
      outputLanguage: "en",
      signal: controller.signal,
    });

    await bodyRead;
    controller.abort(reason);
    const error = failureOf(await pending);

    expect(error.code).toBe("ERR_LLM_TIMEOUT");
    expect(error.cause).toBe(reason);
  });

  it("ends a stalled body on its own deadline with no caller signal at all", async () => {
    const result = await createOpenRouterAdapter({
      apiKey: "test-key",
      deadlineMs: 25,
      fetch: headersThenStallFetch().fetch,
    }).generate({ schema: SCHEMA, prompt: "?", outputLanguage: "en" });

    const error = failureOf(result);

    expect(error.code).toBe("ERR_LLM_TIMEOUT");
    // `AbortSignal.timeout`'s own reason names the adapter's deadline, not a
    // caller's, as the thing that fired.
    expect((error.cause as Error).name).toBe("TimeoutError");
  });

  it("enforces its deadline while an async schema refinement is unfinished", async () => {
    let release: (valid: boolean) => void = () => undefined;
    const refinement = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const schema = SCHEMA.refine(() => refinement);
    const { fetch } = respondWith(200, completion('{"answer":"x"}'));
    try {
      const error = failureOf(
        await createOpenRouterAdapter({
          apiKey: "test-key",
          deadlineMs: 25,
          fetch,
        }).generate({ schema, prompt: "?", outputLanguage: "en" }),
      );
      expect(error.code).toBe("ERR_LLM_TIMEOUT");
      expect((error.cause as Error).name).toBe("TimeoutError");
    } finally {
      release(true);
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "throws a RangeError at construction for deadlineMs %o",
    (deadlineMs: number) => {
      expect(() => createOpenRouterAdapter({ apiKey: "test-key", deadlineMs })).toThrow(
        RangeError,
      );
    },
  );

  it.each([1, 2_147_483_647])("constructs for deadlineMs %i", (deadlineMs) => {
    expect(() =>
      createOpenRouterAdapter({ apiKey: "test-key", deadlineMs }),
    ).not.toThrow();
  });
});

describe("the committed OpenRouter fixtures", () => {
  /**
   * What replaying each fixture must produce, written out and checked for
   * completeness below so no fixture can decay into anything unasserted.
   */
  const OUTCOMES = {
    success: "ok",
    "invalid-output": "ERR_LLM_INVALID_OUTPUT",
    "invalid-model-400": "ERR_LLM_CONFIG",
    "auth-401": "ERR_LLM_AUTH",
    "rate-limit-429": "ERR_LLM_RATE_LIMIT",
    "unavailable-502": "ERR_LLM_UNAVAILABLE",
  } as const;

  const onDisk = readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();

  it("are exactly the fixtures this suite has an expectation for", () => {
    expect(onDisk).toStrictEqual(Object.keys(OUTCOMES).sort());
  });

  it.each(Object.entries(OUTCOMES))(
    "replays %s as %s without reaching the network",
    async (name, expected) => {
      const networkFetch = vi.fn(() => Promise.reject(new Error("network reached")));
      vi.stubGlobal("fetch", networkFetch);

      const result = await ask(replayFetch(`openrouter/${name}`));

      if (expected === "ok") {
        expect(result.ok).toBe(true);
      } else {
        expect(failureOf(result).code).toBe(expected);
      }
      expect(networkFetch).not.toHaveBeenCalled();
    },
  );

  it.each(onDisk)("carries no credential in %s", (name) => {
    const text = readFileSync(path.join(FIXTURES_DIR, `${name}.json`), "utf8");

    expect(text).not.toMatch(/sk-or-/i);
    expect(text).not.toMatch(/"(?:authorization|x-api-key)"/i);
    expect(text).not.toMatch(/Bearer /);
  });
});

describe("the tests/fixtures/llm/ tree", () => {
  // The per-adapter suites list and scan only their own subdirectory, so a
  // fixture written straight into `tests/fixtures/llm/`, or into a directory no
  // suite owns, would otherwise be replayed by nothing and checked by nothing.

  /** Every adapter subdirectory a suite above owns; nothing else may sit here. */
  const ADAPTER_FIXTURE_DIRS = ["openrouter"];

  /** Every file under `dir`, as paths relative to `LLM_FIXTURES_DIR`. */
  function filesUnder(dir: string): string[] {
    return readdirSync(path.join(LLM_FIXTURES_DIR, dir), { withFileTypes: true })
      .flatMap((entry) => {
        const relative = path.posix.join(dir, entry.name);
        return entry.isDirectory() ? filesUnder(relative) : [relative];
      })
      .sort();
  }

  it("holds exactly the adapter subdirectories and no top-level fixture", () => {
    const top = readdirSync(LLM_FIXTURES_DIR, { withFileTypes: true });

    expect(
      top.filter((entry) => !entry.isDirectory()).map((e) => e.name),
    ).toStrictEqual([]);
    expect(
      top
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
    ).toStrictEqual(ADAPTER_FIXTURE_DIRS);
  });

  it("walked a tree that actually contains fixtures", () => {
    expect(filesUnder(".")).toContain("openrouter/success.json");
  });

  it.each(filesUnder("."))("carries no credential in %s", (relative) => {
    const text = readFileSync(path.join(LLM_FIXTURES_DIR, relative), "utf8");

    expect(text).not.toMatch(/sk-(?:or|ant)-/i);
    expect(text).not.toMatch(/"(?:authorization|x-api-key)"/i);
    expect(text).not.toMatch(/Bearer /);
  });
});
