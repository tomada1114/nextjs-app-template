import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { createAnthropicAdapter, LlmError } from "../src/ai/index";
import type { Result } from "../src/core/result";
import { LLM_FIXTURES_DIR, replayFetch } from "./llm-replay";

const SCHEMA = z.object({ answer: z.string() });

/** A `fetch` that answers once with `status` and `body`, recording what it got. */
function respondWith(
  status: number,
  body: unknown,
): { fetch: typeof globalThis.fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  return {
    calls,
    fetch: (_input, init) => {
      calls.push(init ?? {});
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  };
}

/** A 200 response whose single text block carries `text` verbatim. */
function messageWithText(text: string): unknown {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", citations: null, text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function ask(
  fetch: typeof globalThis.fetch,
  apiKey: string | undefined = "test-key",
): Promise<Result<z.infer<typeof SCHEMA>, LlmError>> {
  return createAnthropicAdapter({ apiKey, maxRetries: 0, fetch }).generate({
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

describe("createAnthropicAdapter without a credential", () => {
  it.each([undefined, "", "   "])(
    "reports ERR_LLM_AUTH rather than throwing when the key is %o",
    async (apiKey: string | undefined) => {
      const { fetch, calls } = respondWith(200, messageWithText('{"answer":"x"}'));

      // Constructed here rather than through `ask`, whose default parameter
      // would quietly substitute a key for the `undefined` case.
      const result = await createAnthropicAdapter({
        apiKey,
        maxRetries: 0,
        fetch,
      }).generate({ schema: SCHEMA, prompt: "?", outputLanguage: "en" });
      const error = failureOf(result);

      expect(error).toBeInstanceOf(LlmError);
      expect(error.code).toBe("ERR_LLM_AUTH");
      // A missing key must not cost a round trip to find out.
      expect(calls).toHaveLength(0);
    },
  );
});

describe("createAnthropicAdapter maps a provider failure onto the port vocabulary", () => {
  it.each([
    [401, "ERR_LLM_AUTH"],
    [403, "ERR_LLM_AUTH"],
    [429, "ERR_LLM_RATE_LIMIT"],
    [400, "ERR_LLM_INVALID_OUTPUT"],
    [422, "ERR_LLM_INVALID_OUTPUT"],
    [500, "ERR_LLM_UNAVAILABLE"],
    [529, "ERR_LLM_UNAVAILABLE"],
    // No documented meaning in this API; the conservative default applies.
    [404, "ERR_LLM_UNAVAILABLE"],
  ])("reports HTTP %i as %s", async (status, code) => {
    const { fetch } = respondWith(status, {
      type: "error",
      error: { type: "invalid_request_error", message: "no" },
    });

    expect(failureOf(await ask(fetch)).code).toBe(code);
  });

  it("reports a transport failure that is not an APIError as ERR_LLM_UNAVAILABLE", async () => {
    const boom = new Error("socket hang up");
    const error = failureOf(await ask(() => Promise.reject(boom)));

    expect(error.code).toBe("ERR_LLM_UNAVAILABLE");
  });
});

describe("createAnthropicAdapter validates the answer itself", () => {
  it("reports ERR_LLM_INVALID_OUTPUT when the answer carries no text block", async () => {
    const { fetch } = respondWith(200, {
      ...(messageWithText("") as Record<string, unknown>),
      content: [],
    });

    expect(failureOf(await ask(fetch)).code).toBe("ERR_LLM_INVALID_OUTPUT");
  });

  it("reports ERR_LLM_INVALID_OUTPUT when the text block is not JSON", async () => {
    const { fetch } = respondWith(200, messageWithText("I would rather not."));

    expect(failureOf(await ask(fetch)).code).toBe("ERR_LLM_INVALID_OUTPUT");
  });

  it("re-validates against the caller's schema, not only against the JSON Schema", async () => {
    // A refinement has no JSON Schema equivalent, so the API cannot enforce it
    // and a response that satisfies the derived schema still has to fail here.
    const refined = SCHEMA.refine((value) => value.answer.length > 3, "too short");
    const { fetch } = respondWith(200, messageWithText('{"answer":"no"}'));

    const result = await createAnthropicAdapter({
      apiKey: "test-key",
      maxRetries: 0,
      fetch,
    }).generate({ schema: refined, prompt: "?", outputLanguage: "en" });

    expect(failureOf(result).code).toBe("ERR_LLM_INVALID_OUTPUT");
  });
});

describe("createAnthropicAdapter builds the provider request", () => {
  it("sends the schema as a json_schema output format and the language as a system instruction", async () => {
    const { fetch, calls } = respondWith(200, messageWithText('{"answer":"x"}'));

    await ask(fetch);

    const raw = calls[0]?.body;
    if (typeof raw !== "string") {
      throw new Error("the SDK sent a request body that was not a JSON string");
    }

    expect(JSON.parse(raw)).toMatchObject({
      model: "claude-sonnet-5",
      output_config: { format: { type: "json_schema" } },
      messages: [{ role: "user", content: "What is the answer?" }],
      system: expect.stringContaining("ja") as unknown,
    });
  });
});

describe("the committed LLM fixtures", () => {
  const names = readdirSync(LLM_FIXTURES_DIR).filter((name) => name.endsWith(".json"));

  it("are a non-empty set", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)("replays %s without reaching the network", async (name) => {
    const networkFetch = vi.fn(() => Promise.reject(new Error("network reached")));
    vi.stubGlobal("fetch", networkFetch);

    // The result is whatever the fixture encodes — success for one, a failure
    // for another. What this asserts is that producing it opened no socket.
    await ask(replayFetch(name.replace(/\.json$/, "")));

    expect(networkFetch).not.toHaveBeenCalled();
  });

  it.each(names)("carries no credential in %s", (name) => {
    const text = readFileSync(path.join(LLM_FIXTURES_DIR, name), "utf8");

    expect(text).not.toMatch(/sk-ant-/i);
    expect(text).not.toMatch(/"(?:authorization|x-api-key)"/i);
  });
});
