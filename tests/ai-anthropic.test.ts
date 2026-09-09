import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { createAnthropicAdapter, LlmError } from "../src/ai/index";
import type { Result } from "../src/core/result";
import { headersThenStallFetch, LLM_FIXTURES_DIR, replayFetch } from "./llm-replay";

const SCHEMA = z.object({ answer: z.string() });

/**
 * A `fetch` that answers every call with `status` and `body`, recording what it
 * got. `headers` is merged in after `content-type`, so a case can dictate the
 * `retry-after` the SDK reads.
 */
function respondWith(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): { fetch: typeof globalThis.fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  return {
    calls,
    fetch: (_input, init) => {
      calls.push(init ?? {});
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...headers },
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

describe("createAnthropicAdapter under its real retry configuration", () => {
  it("drives a second attempt under the real DEFAULT_MAX_RETRIES when a retryable failure fires", async () => {
    // `maxRetries` is deliberately not pinned to 0 here, unlike every other
    // test in this file: this is the one that exercises the value production
    // actually runs with, `DEFAULT_MAX_RETRIES`, so the SDK's retry path is
    // not left entirely untested. `429` is one of the statuses `shouldRetry`
    // in node_modules/@anthropic-ai/sdk/client.mjs treats as retryable
    // (alongside 408, 409 and >=500) — confirmed by reading it rather than
    // assumed. Fake timers stand in for the real backoff sleep the SDK awaits
    // between attempts (a plain, signal-blind `setTimeout`, per
    // node_modules/@anthropic-ai/sdk/internal/utils/sleep.mjs), which would
    // otherwise cost this test a real ~0.4s.
    const { fetch, calls } = respondWith(429, {
      type: "error",
      error: { type: "rate_limit_error", message: "slow down" },
    });

    vi.useFakeTimers();
    try {
      const pending = createAnthropicAdapter({ apiKey: "test-key", fetch }).generate({
        schema: SCHEMA,
        prompt: "?",
        outputLanguage: "en",
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const error = failureOf(await pending);

      expect(error.code).toBe("ERR_LLM_RATE_LIMIT");
    } finally {
      vi.useRealTimers();
    }

    // The evidence the issue asks for: a second request actually went out.
    expect(calls).toHaveLength(2);
  });

  it("ends the retry chain rather than starting a second attempt once the deadline fires mid-backoff", async () => {
    // The interaction #62 introduced. `AbortSignal.timeout` runs on the real
    // clock regardless of `vi.useFakeTimers` (it is not a `setTimeout` a fake
    // timer install can see), so unlike the test above this one cannot fake
    // the backoff sleep away — both timers have to run for real, so
    // `deadlineMs` has to sit inside a window rather than merely be small.
    // The SDK's first backoff is `0.5s * (1 - random()*0.25)`, so 375 ms is
    // its floor, and dispatching the first attempt costs roughly 10 ms here.
    // 200 ms is the midpoint of that window: far enough above the dispatch
    // cost that a loaded CI worker cannot fire the deadline before the first
    // request goes out (which would leave `calls` empty), and far enough
    // below 375 ms that the deadline still lands inside the sleep.
    const { fetch, calls } = respondWith(429, {
      type: "error",
      error: { type: "rate_limit_error", message: "slow down" },
    });

    const result = await createAnthropicAdapter({
      apiKey: "test-key",
      deadlineMs: 200,
      fetch,
    }).generate({ schema: SCHEMA, prompt: "?", outputLanguage: "en" });

    const error = failureOf(result);
    const cause = error.cause;

    expect(error.code).toBe("ERR_LLM_TIMEOUT");
    // The deadline's own TimeoutError, not the 429 the first attempt got —
    // the chain ended because the signal fired, not because the retry budget
    // ran out.
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).name).toBe("TimeoutError");
    // The fetch call count is the evidence: the SDK's backoff sleep ignores
    // the signal and runs to completion, but by the time it wakes up and is
    // about to start a second attempt, the deadline has already fired — so no
    // second request ever goes out.
    expect(calls).toHaveLength(1);
  });
});

/** The body every rate-limit case below answers with. */
const RATE_LIMITED = {
  type: "error",
  error: { type: "rate_limit_error", message: "slow down" },
};

/** One rate-limited `generate()` call under the real retry configuration. */
function askUnderRetries(
  fetch: typeof globalThis.fetch,
): Promise<Result<z.infer<typeof SCHEMA>, LlmError>> {
  return createAnthropicAdapter({ apiKey: "test-key", maxRetries: 1, fetch }).generate({
    schema: SCHEMA,
    prompt: "?",
    outputLanguage: "en",
  });
}

describe("createAnthropicAdapter declines a retry-after it cannot afford (#66)", () => {
  // The SDK sleeps a `retry-after` verbatim — `retryRequest` awaits
  // `sleep(timeoutMillis)` with no signal — so a provider asking for five
  // minutes parks the call five minutes past a deadline it was given. The
  // adapter's middleware answers the SDK's own `x-should-retry` header
  // instead, and the chain ends on the first attempt.
  //
  // The table, in order: the seconds form; the millisecond form; a falsy
  // `retry-after-ms` that still lets `retry-after` through (the SDK writes
  // `!timeoutMillis`, not `!== undefined`); an unparsable `retry-after-ms`,
  // which the SDK also falls past; a provider that explicitly asked for a
  // retry, which is overridden because *whether* to retry is the provider's
  // call and *how long to wait* is this client's; the HTTP-date form, five
  // minutes past the fixed clock set below; and one millisecond past
  // MAX_RETRY_AFTER_MS, which pins the comparison as `>` — a `>=` would decline
  // the boundary case the sibling suite below asserts is still honored.
  it.each([
    [{ "retry-after": "300" }],
    [{ "retry-after-ms": "600000" }],
    [{ "retry-after-ms": "0", "retry-after": "300" }],
    [{ "retry-after-ms": "later", "retry-after": "300" }],
    [{ "x-should-retry": "true", "retry-after": "300" }],
    [{ "retry-after": "Wed, 01 Jan 2025 00:05:00 GMT" }],
    [{ "retry-after-ms": "8001" }],
  ])("answers at once rather than retrying, given %o", async (headers) => {
    const { fetch, calls } = respondWith(429, RATE_LIMITED, headers);

    vi.useFakeTimers();
    try {
      // Fixed so the HTTP-date case is five minutes out rather than long past.
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

      const error = failureOf(await askUnderRetries(fetch));

      expect(error.code).toBe("ERR_LLM_RATE_LIMIT");
      // Settled with no timer advanced at all: nothing was ever scheduled to
      // sleep on, so the answer cannot have cost wall-clock time.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    // The assertion that fails loudly on a regression. A reintroduced sleep
    // would also hang until Vitest's own timeout, which is red either way but
    // far less legible than a count.
    expect(calls).toHaveLength(1);
  });
});

describe("createAnthropicAdapter still honors a retry-after it can afford (#66)", () => {
  // The half that stops the fix from degenerating into "never retry". In
  // order: one second; five hundred milliseconds; a malformed header, which
  // `Date.parse` turns into `NaN` and the SDK sleeps ~0 on rather than
  // computing a backoff; exactly MAX_RETRY_AFTER_MS, the longest wait this
  // client will still sit out; and no header at all, where the SDK's own
  // backoff applies and is already bounded by its 8 s ceiling.
  it.each([
    [{ "retry-after": "1" }],
    [{ "retry-after-ms": "500" }],
    [{ "retry-after": "later" }],
    [{ "retry-after": "8" }],
    [{}],
  ])("sleeps and makes a second attempt, given %o", async (headers) => {
    const { fetch, calls } = respondWith(429, RATE_LIMITED, headers);

    vi.useFakeTimers();
    try {
      const pending = askUnderRetries(fetch);

      // MAX_RETRY_AFTER_MS: the longest sleep any of these cases can ask for,
      // and the largest one honored at all.
      await vi.advanceTimersByTimeAsync(8_000);
      const error = failureOf(await pending);

      expect(error.code).toBe("ERR_LLM_RATE_LIMIT");
    } finally {
      vi.useRealTimers();
    }

    expect(calls).toHaveLength(2);
  });
});

describe("createAnthropicAdapter rejects a deadline the platform cannot arm", () => {
  it.each([
    0,
    -1,
    1.5,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    // One past the new ceiling (Node's signed 32-bit timer maximum,
    // INT32_MAX): the platform would not throw for this one either — it
    // silently clamps it and fires within a millisecond — so this is the
    // construction-time check's own job, not `AbortSignal.timeout`'s.
    2_147_483_648,
    // The *old* ceiling this issue lowers from. It used to construct cleanly
    // here and then fire immediately; it is rejected now.
    4_294_967_295,
  ])(
    "throws at construction rather than per request for deadlineMs %o",
    (deadlineMs: number) => {
      // `AbortSignal.timeout` throws a RangeError for anything outside an
      // unsigned 32-bit delay, and the adapter arms it outside every `try` in
      // `generate` — so left unchecked here it would surface as a *rejected*
      // `generate()`, which is the one thing `LlmPort` promises never happens.
      expect(() => createAnthropicAdapter({ apiKey: "test-key", deadlineMs })).toThrow(
        RangeError,
      );
    },
  );
});

describe("createAnthropicAdapter arms a near-ceiling deadline instead of firing it immediately (#99)", () => {
  // The bug this pins down: Node backs a timer's delay with a *signed* 32-bit
  // integer and silently clamps any delay from 2**31 upward to a token value
  // instead of rejecting it — `AbortSignal.timeout(2_147_483_648)` does not
  // throw, it fires within a millisecond rather than after the ~24.9 days
  // requested. Construction not throwing was the whole of the original
  // boundary test, and that assertion cannot tell a correctly-armed ~24.9-day
  // timer apart from one that already fired. `headersThenStallFetch` answers
  // 200 at once and then never closes the body, so nothing but the deadline
  // itself can settle this call, and racing it against a short real-clock
  // delay is what makes "still armed, not fired" observable.
  const STILL_PENDING = Symbol("still pending");

  it.each([
    // Just under the signed 32-bit ceiling.
    2_147_483_646,
    // Exactly INT32_MAX, the new MAX_DEADLINE_MS.
    2_147_483_647,
  ] as const)(
    "does not fire within 50ms of real time for deadlineMs %i",
    async (deadlineMs) => {
      const pending = createAnthropicAdapter({
        apiKey: "test-key",
        maxRetries: 0,
        deadlineMs,
        fetch: headersThenStallFetch(),
      }).generate({ schema: SCHEMA, prompt: "?", outputLanguage: "en" });

      const winner = await Promise.race([
        pending,
        new Promise<typeof STILL_PENDING>((resolve) => {
          setTimeout(() => {
            resolve(STILL_PENDING);
          }, 50);
        }),
      ]);

      expect(winner).toBe(STILL_PENDING);
    },
  );
});

describe("createAnthropicAdapter derives its default deadline from timeoutMs and maxRetries (#65)", () => {
  // The derived deadline is not directly observable — the adapter arms it
  // inside `generate` and `LlmPort` has nowhere to report it — so this pins
  // the arithmetic at the one place it *is* observable: the `MAX_DEADLINE_MS`
  // boundary the constructor already checks. Each pair of rows fixes one term
  // of `defaultDeadlineMs`'s three: the body-read margin (rows 1-2), and the
  // per-attempt/per-retry terms together (rows 3-4). Expected numbers are
  // worked out by hand below, not by re-running the derivation:
  //
  //   row 1: (0 + 1) * 2_147_481_646 + 0 * 8_000 + 2_000 = 2_147_483_646
  //   row 2: (0 + 1) * 2_147_481_648 + 0 * 8_000 + 2_000 = 2_147_483_648
  //   row 3: (1 + 1) * 1_073_736_823 + 1 * 8_000 + 2_000 = 2_147_483_646
  //   row 4: (1 + 1) * 1_073_736_824 + 1 * 8_000 + 2_000 = 2_147_483_648
  it.each([
    [2_147_481_646, 0, "constructs"],
    [2_147_481_648, 0, "RangeError"],
    [1_073_736_823, 1, "constructs"],
    [1_073_736_824, 1, "RangeError"],
  ] as const)(
    "timeoutMs %i with maxRetries %i %s",
    (timeoutMs, maxRetries, outcome) => {
      const build = () =>
        createAnthropicAdapter({ apiKey: "test-key", timeoutMs, maxRetries });

      if (outcome === "constructs") {
        expect(build).not.toThrow();
      } else {
        expect(build).toThrow(RangeError);
      }
    },
  );

  it("constructs for timeoutMs: 300_000 — the combination issue #65 was filed for", () => {
    // Under the fixed constant this used to be a fixed `130_000`, so the
    // total bound was cut well before this five-minute attempt's own header
    // timeout could even fire. Derived instead, with `maxRetries` left at its
    // default of `1`: 2 * 300_000 + 1 * 8_000 + 2_000 = 610_000, comfortably
    // under `MAX_DEADLINE_MS`.
    expect(() =>
      createAnthropicAdapter({ apiKey: "test-key", timeoutMs: 300_000 }),
    ).not.toThrow();
  });

  it("honours an explicit deadlineMs and skips the derivation entirely", () => {
    // The same `timeoutMs` refused in the boundary table above (it implies
    // `2_147_483_648`, one past `MAX_DEADLINE_MS`) constructs fine the moment
    // a total bound is given directly — precedence and the no-cross-check
    // rule pinned in one assertion.
    expect(() =>
      createAnthropicAdapter({
        apiKey: "test-key",
        timeoutMs: 1_073_736_824,
        deadlineMs: 60_000,
      }),
    ).not.toThrow();
  });
});

describe("createAnthropicAdapter rejects timeoutMs and maxRetries on their own terms (#72)", () => {
  it.each([0, -1, 100.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects timeoutMs %o naming the option, not the deadline it would derive",
    (timeoutMs: number) => {
      expect(() => createAnthropicAdapter({ apiKey: "test-key", timeoutMs })).toThrow(
        /timeoutMs/,
      );
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects maxRetries %o naming the option, not the deadline it would derive",
    (maxRetries: number) => {
      expect(() => createAnthropicAdapter({ apiKey: "test-key", maxRetries })).toThrow(
        /maxRetries/,
      );
    },
  );

  it("rejects maxRetries: 0 nowhere — it is the valid boundary the rest of this suite relies on", () => {
    expect(() =>
      createAnthropicAdapter({ apiKey: "test-key", maxRetries: 0 }),
    ).not.toThrow();
  });

  it("rejects an invalid maxRetries even behind an explicit deadlineMs that would otherwise skip the derivation entirely", () => {
    // Without this option-level check, this combination constructs cleanly:
    // an explicit deadlineMs skips `defaultDeadlineMs`, so nothing else ever
    // looks at maxRetries, and `-1` reaches `new Anthropic({ maxRetries: -1 })`
    // silently turning retries off.
    expect(() =>
      createAnthropicAdapter({
        apiKey: "test-key",
        maxRetries: -1,
        deadlineMs: 60_000,
      }),
    ).toThrow(/maxRetries/);
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

describe("createAnthropicClient closes the SDK's own environment reads (#88)", () => {
  it("targets the intended host, sends no bearer token, and logs at the intended level regardless of ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and ANTHROPIC_LOG", async () => {
    // Each of these three would, on today's HEAD, change client behaviour: the
    // constructor reads them itself whenever the matching option is left
    // unset (`node_modules/@anthropic-ai/sdk/src/client.ts:604-660`,
    // `@anthropic-ai/sdk@0.122.0`). None of them is `ANTHROPIC_API_KEY`, so
    // this is orthogonal to the `apiKey`-fallback case above.
    vi.stubEnv("ANTHROPIC_BASE_URL", "http://127.0.0.1:9");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "should-never-be-sent");
    vi.stubEnv("ANTHROPIC_LOG", "debug");

    const calls: { url: string; headers: Headers }[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      // Matches how the SDK itself normalizes its own `RequestInfo | URL`
      // parameter (`node_modules/@anthropic-ai/sdk/src/client.ts:1376-1379`):
      // `Request` has no useful `toString`, so a bare `String(input)` is not
      // safe here.
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push({ url, headers: new Headers(init?.headers ?? {}) });
      return Promise.resolve(
        new Response(JSON.stringify(messageWithText('{"answer":"x"}')), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    // `ANTHROPIC_LOG=debug` would raise the client's log level to `debug` had
    // the fallback fired, which turns on the `info`-level line the SDK logs
    // for every successful response (`client.ts:1280`) — console.info is the
    // observable half of "logLevel stays at its intended default".
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    let result: Result<z.infer<typeof SCHEMA>, LlmError>;
    try {
      result = await ask(fetch);
    } finally {
      info.mockRestore();
    }

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/^https:\/\/api\.anthropic\.com\//);
    expect(calls[0]?.headers.has("authorization")).toBe(false);
    expect(calls[0]?.headers.get("x-api-key")).toBe("test-key");
    expect(info).not.toHaveBeenCalled();
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
