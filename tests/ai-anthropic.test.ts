import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { createAnthropicAdapter, LlmError } from "../src/ai/index";
import type { Result } from "../src/core/result";
import { headersThenStallFetch, LLM_FIXTURES_DIR, replayFetch } from "./llm-replay";

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

  it("reports a refused connection as ERR_LLM_UNAVAILABLE", async () => {
    // The SDK wraps a rejected fetch in APIConnectionError, which *is* an
    // APIError carrying no status — so this exercises the status mapping's
    // `undefined` case, not the unrecognised-rejection fallback below.
    const error = failureOf(
      await ask(() => Promise.reject(new Error("socket hang up"))),
    );

    expect(error.code).toBe("ERR_LLM_UNAVAILABLE");
  });

  it("reports a rejection that is no SDK error at all as ERR_LLM_UNAVAILABLE", async () => {
    // A body that is not JSON makes the SDK's own decoding throw a SyntaxError,
    // which matches none of the mapped classes. Without a case here the
    // fallback is unreachable from the published surface and could be changed
    // to anything at all with the suite still green.
    const malformed: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response("not json at all", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const error = failureOf(await ask(malformed));

    expect(error.code).toBe("ERR_LLM_UNAVAILABLE");
    expect(error.cause).toBeInstanceOf(SyntaxError);
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

describe("createAnthropicAdapter when the abort lands after the response headers", () => {
  it("still reports ERR_LLM_TIMEOUT and keeps the caller's reason on cause", async () => {
    // The SDK labels an abort as APIUserAbortError only while it still owns the
    // request; once the headers have arrived the body is decoded outside those
    // guards and a cancellation escapes as a bare AbortError. Every abort case
    // in the contract suite lands on the near side of that boundary, so without
    // this the port's `cause`-by-identity promise is untested past it.
    const reason = new Error("the caller changed its mind");
    const controller = new AbortController();
    const pending = createAnthropicAdapter({
      apiKey: "test-key",
      maxRetries: 0,
      timeoutMs: 60_000,
      fetch: headersThenStallFetch(),
    }).generate({
      schema: SCHEMA,
      prompt: "?",
      outputLanguage: "en",
      signal: controller.signal,
    });

    // Long enough for the headers to have been handed over.
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort(reason);

    const error = failureOf(await pending);

    expect(error.code).toBe("ERR_LLM_TIMEOUT");
    expect(error.cause).toBe(reason);
  });
});

describe("createAnthropicAdapter when the provider stalls after the response headers", () => {
  it("ends the request on its own deadline with no caller signal at all", async () => {
    // The gap this closes. The SDK's `timeout` is armed around the inner fetch
    // and cleared the moment the `Response` resolves, so a provider that sends
    // 200 and then dribbles bytes is past it — `timeoutMs` here is deliberately
    // far longer than the deadline to prove it is not what ends this request.
    // With no signal supplied, nothing else could: before the adapter composed
    // a deadline of its own, this promise never settled.
    const result = await createAnthropicAdapter({
      apiKey: "test-key",
      maxRetries: 0,
      timeoutMs: 60_000,
      deadlineMs: 25,
      fetch: headersThenStallFetch(),
    }).generate({ schema: SCHEMA, prompt: "?", outputLanguage: "en" });

    const error = failureOf(result);
    const cause = error.cause;

    expect(error).toBeInstanceOf(LlmError);
    expect(error.code).toBe("ERR_LLM_TIMEOUT");
    // `AbortSignal.timeout`'s own reason, which is what names the adapter's
    // deadline rather than the caller's as the thing that fired.
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).name).toBe("TimeoutError");
  });

  it("leaves the deadline unfired for a request that answers", async () => {
    // The other half: the bound must not turn a working call into a failure,
    // and a deadline that never fires must not keep the run alive either —
    // `AbortSignal.timeout` is unref'd, which is why it is what composes it.
    const { fetch } = respondWith(200, messageWithText('{"answer":"x"}'));

    const result = await createAnthropicAdapter({
      apiKey: "test-key",
      maxRetries: 0,
      deadlineMs: 60_000,
      fetch,
    }).generate({ schema: SCHEMA, prompt: "?", outputLanguage: "en" });

    expect(result).toStrictEqual({ ok: true, value: { answer: "x" } });
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
  /**
   * What replaying each fixture must actually produce.
   *
   * @remarks
   * Written out rather than derived, and checked for completeness below. A
   * fixture whose outcome nothing asserts is a file that could decay into
   * anything — the earlier version of this suite discarded the result, so every
   * fixture failing would have passed it.
   */
  const OUTCOMES = {
    success: "ok",
    "invalid-output": "ERR_LLM_INVALID_OUTPUT",
    "auth-401": "ERR_LLM_AUTH",
    "rate-limit-429": "ERR_LLM_RATE_LIMIT",
    "overloaded-529": "ERR_LLM_UNAVAILABLE",
  } as const;

  const onDisk = readdirSync(LLM_FIXTURES_DIR)
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

      const result = await ask(replayFetch(name));

      if (expected === "ok") {
        expect(result.ok).toBe(true);
      } else {
        expect(failureOf(result).code).toBe(expected);
      }
      expect(networkFetch).not.toHaveBeenCalled();
    },
  );

  it("keeps the contract suite's own adapter off the network too", async () => {
    // The issue's requirement is about the contract suite, which builds its
    // ports in tests/ai-port.test.ts. This asserts the property the same way it
    // holds there: an adapter given a fixture `fetch` never falls back to the
    // global one, whatever the fixture turns out to contain.
    const networkFetch = vi.fn(() => Promise.reject(new Error("network reached")));
    vi.stubGlobal("fetch", networkFetch);

    await Promise.all(onDisk.map(async (name) => ask(replayFetch(name))));

    expect(networkFetch).not.toHaveBeenCalled();
  });

  it.each(onDisk)("carries no credential in %s", (name) => {
    const text = readFileSync(path.join(LLM_FIXTURES_DIR, `${name}.json`), "utf8");

    expect(text).not.toMatch(/sk-ant-/i);
    expect(text).not.toMatch(/"(?:authorization|x-api-key)"/i);
  });
});
