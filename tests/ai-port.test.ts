import { describe, expect, expectTypeOf, it, vi } from "vitest";
import * as z from "zod";

import {
  createAnthropicAdapter,
  createFakeLlmPort,
  LlmError,
  type LlmErrorCode,
  type LlmPort,
} from "../src/ai/index";
import type { Result } from "../src/core/result";
import {
  isRecording,
  neverResolvingFetch,
  recordingFetch,
  replayFetch,
} from "./llm-replay";

/**
 * The shape every contract case asks a port to fill.
 *
 * @remarks
 * Exported because an adapter's harness has to produce data matching it — a
 * recorded fixture, in the Anthropic adapter's case — and a second copy of the
 * shape would drift from this one.
 */
export const CONTRACT_SCHEMA = z.object({
  answer: z.string(),
  confidence: z.number(),
});

/** The value {@link LlmPortContractHarness.succeeds} must resolve to. */
export const CONTRACT_ANSWER = {
  answer:
    "The Answer to the Ultimate Question of Life, the Universe, and Everything is 42.",
  confidence: 0.42,
};

/**
 * The four ports an adapter must be able to produce to be measured against the
 * contract.
 *
 * @remarks
 * This is the whole plug point. The fake builds each one from its constructor
 * options; a live adapter builds them from recorded fixtures, or from a stubbed
 * client. Neither the suite below nor an adapter's harness knows how the other
 * does it.
 */
export interface LlmPortContractHarness {
  /** A port that answers with exactly {@link CONTRACT_ANSWER}. */
  readonly succeeds: () => LlmPort;

  /** A port whose raw answer does not match {@link CONTRACT_SCHEMA}. */
  readonly returnsInvalidOutput: () => LlmPort;

  /** A port that fails every request with `code`. */
  readonly failsWith: (code: LlmErrorCode) => LlmPort;

  /**
   * A port that does not answer within a test's budget, so an abort of a
   * request already in flight is observable.
   */
  readonly neverAnswers: () => LlmPort;
}

/**
 * Every `LlmErrorCode`.
 *
 * @remarks
 * Annotating this `readonly LlmErrorCode[]` would let a new member be added to
 * the union with no case here. `as const satisfies` keeps the literal tuple
 * type instead, which the type assertion in "covers every LlmErrorCode" below
 * compares against the union — so a new code fails the type check until it is
 * listed here too.
 */
const ALL_CODES = [
  "ERR_LLM_AUTH",
  "ERR_LLM_RATE_LIMIT",
  "ERR_LLM_TIMEOUT",
  "ERR_LLM_INVALID_OUTPUT",
  "ERR_LLM_UNAVAILABLE",
] as const satisfies readonly LlmErrorCode[];

describe("the LlmPort contract suite", () => {
  it("covers every LlmErrorCode", () => {
    expectTypeOf<(typeof ALL_CODES)[number]>().toEqualTypeOf<LlmErrorCode>();

    expect(new Set(ALL_CODES).size).toBe(ALL_CODES.length);
  });
});

function valueOf<T>(result: Result<T, LlmError>): T {
  if (!result.ok) {
    throw new Error(`expected a value, got ${result.error.code}`);
  }
  return result.value;
}

function failureOf<T>(result: Result<T, LlmError>): LlmError {
  if (result.ok) {
    throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
  }
  return result.error;
}

function ask(
  port: LlmPort,
  signal?: AbortSignal,
): Promise<Result<z.infer<typeof CONTRACT_SCHEMA>, LlmError>> {
  return port.generate({
    schema: CONTRACT_SCHEMA,
    prompt: "What is the answer?",
    outputLanguage: "en",
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * Every behaviour an `LlmPort` implementation must satisfy, whatever it talks
 * to.
 *
 * @remarks
 * Call it once per adapter. Issue #8's Anthropic adapter adds its own
 * `describeLlmPortContract("AnthropicLlmPort", ...)` call at the bottom of this
 * file, backed by recorded fixtures, so the identical assertions run against
 * both and the suite is still collected exactly once.
 */
export function describeLlmPortContract(
  name: string,
  harness: LlmPortContractHarness,
): void {
  describe(`${name} satisfies the LlmPort contract`, () => {
    it("resolves to the parsed value when the answer matches the schema", async () => {
      const result = await ask(harness.succeeds());

      expect(result).toStrictEqual({ ok: true, value: CONTRACT_ANSWER });
    });

    it("infers the value type from the request schema", async () => {
      const value = valueOf(await ask(harness.succeeds()));

      expectTypeOf(value).toEqualTypeOf<{ answer: string; confidence: number }>();
      expect(value.answer).toBe(CONTRACT_ANSWER.answer);
    });

    it("answers when the caller passes no signal at all", async () => {
      const result = await harness.succeeds().generate({
        schema: CONTRACT_SCHEMA,
        prompt: "What is the answer?",
        outputLanguage: "en",
      });

      expect(result).toStrictEqual({ ok: true, value: CONTRACT_ANSWER });
    });

    it("resolves rather than throws for a schema carrying an async refinement", async () => {
      // Zod's synchronous `safeParse` *throws* on a schema with an async
      // refine/transform instead of returning a failed result. An adapter that
      // reaches for it turns a caller's schema choice into a rejected promise,
      // which the port promises never to do for an expected failure. Both
      // directions are asserted, because only checking the accepting one would
      // pass against an adapter that swallowed the failure branch entirely.
      const accepts = CONTRACT_SCHEMA.refine(async (value) =>
        Promise.resolve(value.confidence <= 1),
      );
      const rejects = CONTRACT_SCHEMA.refine(async (value) =>
        Promise.resolve(value.confidence > 1),
      );
      const port = harness.succeeds();

      await expect(
        port.generate({
          schema: accepts,
          prompt: "What is the answer?",
          outputLanguage: "en",
        }),
      ).resolves.toStrictEqual({ ok: true, value: CONTRACT_ANSWER });

      const result = await port.generate({
        schema: rejects,
        prompt: "What is the answer?",
        outputLanguage: "en",
      });

      expect(failureOf(result).code).toBe("ERR_LLM_INVALID_OUTPUT");
    });

    it("reports ERR_LLM_TIMEOUT for an abort that lands during async schema validation", async () => {
      // The gap #90 closes: `safeParseAsync` keeps the call open after the raw
      // answer has already arrived, so a caller's abort can land while that
      // validation is still running. `notifyStarted`/`releaseRefinement` pin
      // the ordering — abort only after the refinement has actually started,
      // release it only after the abort — so this cannot pass by the parse
      // simply finishing before the signal is ever checked.
      let notifyStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      let releaseRefinement: (valid: boolean) => void = () => undefined;
      const refinement = new Promise<boolean>((resolve) => {
        releaseRefinement = resolve;
      });
      const schema = CONTRACT_SCHEMA.refine(() => {
        notifyStarted();
        return refinement;
      });
      const controller = new AbortController();

      const pending = harness.succeeds().generate({
        schema,
        prompt: "What is the answer?",
        outputLanguage: "en",
        signal: controller.signal,
      });
      await started;
      controller.abort();
      releaseRefinement(true);

      const error = failureOf(await pending);

      expect(error.code).toBe("ERR_LLM_TIMEOUT");
    });

    it("reports ERR_LLM_INVALID_OUTPUT when the answer does not match the schema", async () => {
      const error = failureOf(await ask(harness.returnsInvalidOutput()));

      expect(error).toBeInstanceOf(LlmError);
      expect(error.code).toBe("ERR_LLM_INVALID_OUTPUT");
    });

    it.each(ALL_CODES)(
      "reports %s as an error branch rather than throwing",
      async (code) => {
        const error = failureOf(await ask(harness.failsWith(code)));

        expect(error).toBeInstanceOf(LlmError);
        expect(error.code).toBe(code);
      },
    );

    it("reports ERR_LLM_TIMEOUT for a signal that was already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const error = failureOf(await ask(harness.neverAnswers(), controller.signal));

      expect(error.code).toBe("ERR_LLM_TIMEOUT");
    });

    it("reports ERR_LLM_TIMEOUT when the signal aborts mid-request", async () => {
      const controller = new AbortController();
      const pending = ask(harness.neverAnswers(), controller.signal);
      controller.abort();

      const error = failureOf(await pending);

      expect(error.code).toBe("ERR_LLM_TIMEOUT");
    });

    it("surfaces the caller's own abort reason on cause, by identity, keeping its text off message (#89)", async () => {
      // The reason's own message is a synthetic marker standing in for
      // whatever text a caller's abort reason carries. `abortedLlmError` must
      // never fold `cause.message` into its own `message` — see
      // designing-errors — so the marker must show up on `cause` and nowhere
      // in `message`, while `cause` itself still keeps the reason's identity.
      const marker = "marker-2f6c9d-do-not-quote-this-reason";
      const reason = new Error(marker);
      const controller = new AbortController();
      const pending = ask(harness.neverAnswers(), controller.signal);
      controller.abort(reason);

      const error = failureOf(await pending);

      expect(error.cause).toBe(reason);
      expect(error.message).not.toContain(marker);
    });

    it("normalises a non-Error abort reason into an Error keeping the reason on cause", async () => {
      const controller = new AbortController();
      const pending = ask(harness.neverAnswers(), controller.signal);
      controller.abort("cancelled by the operator");

      const error = failureOf(await pending);
      const cause = error.cause;

      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).cause).toBe("cancelled by the operator");
    });
  });
}

describeLlmPortContract("createFakeLlmPort", {
  succeeds: () => createFakeLlmPort({ response: CONTRACT_ANSWER }),
  returnsInvalidOutput: () =>
    createFakeLlmPort({ response: { answer: 42, confidence: "high" } }),
  failsWith: (code) => createFakeLlmPort({ failWith: code }),
  // Far longer than the unit project's 5s budget, so only an abort ends it.
  neverAnswers: () => createFakeLlmPort({ response: CONTRACT_ANSWER, delayMs: 60_000 }),
});

/**
 * The fixture each `LlmErrorCode` is provoked by.
 *
 * @remarks
 * Only `success` and `auth-401` are recordings of real exchanges — a `429` or a
 * `529` cannot be provoked on demand, so those two are written by hand against
 * the documented error shape. `ERR_LLM_TIMEOUT` has no fixture at all: a
 * deadline is a property of the connection rather than of a response, so it is
 * arranged with a `fetch` that never answers and a timeout short enough for a
 * unit budget.
 */
const FIXTURE_FOR_CODE = {
  ERR_LLM_AUTH: "auth-401",
  ERR_LLM_RATE_LIMIT: "rate-limit-429",
  ERR_LLM_UNAVAILABLE: "overloaded-529",
  ERR_LLM_INVALID_OUTPUT: "invalid-output",
} as const satisfies Partial<Record<LlmErrorCode, string>>;

/**
 * The Anthropic adapter, wired to a fixture instead of to the network.
 *
 * @remarks
 * `apiKey` is a placeholder rather than a credential: `fetch` never reaches a
 * socket, so no key is authenticated, and the adapter needs a non-blank one
 * only to get past its own "nothing configured" branch.
 */
function replaying(fixture: string): LlmPort {
  return createAnthropicAdapter({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: replayFetch(fixture),
  });
}

describeLlmPortContract("createAnthropicAdapter", {
  succeeds: () => replaying("success"),
  returnsInvalidOutput: () => replaying("invalid-output"),
  failsWith: (code) =>
    code === "ERR_LLM_TIMEOUT"
      ? createAnthropicAdapter({
          apiKey: "test-key",
          maxRetries: 0,
          // Short enough that the SDK's own deadline, not the test runner's,
          // is what ends the request.
          timeoutMs: 5,
          fetch: neverResolvingFetch(),
        })
      : replaying(FIXTURE_FOR_CODE[code]),
  neverAnswers: () =>
    createAnthropicAdapter({
      apiKey: "test-key",
      maxRetries: 0,
      // Far longer than the suite's budget, so only the caller's abort ends it.
      timeoutMs: 60_000,
      fetch: neverResolvingFetch(),
    }),
});

describe("createFakeLlmPort", () => {
  it("fails with ERR_LLM_INVALID_OUTPUT when no response was configured", async () => {
    const error = failureOf(await ask(createFakeLlmPort()));

    expect(error.code).toBe("ERR_LLM_INVALID_OUTPUT");
  });

  it("keeps the schema's own validation error on cause", async () => {
    const error = failureOf(
      await ask(createFakeLlmPort({ response: { answer: 1, confidence: 2 } })),
    );

    expect(error.cause).toBeInstanceOf(z.ZodError);
  });

  describe("with a configured delay", () => {
    it("answers once the delay has elapsed", async () => {
      vi.useFakeTimers();
      try {
        const pending = ask(
          createFakeLlmPort({ response: CONTRACT_ANSWER, delayMs: 5_000 }),
        );
        await vi.advanceTimersByTimeAsync(5_000);

        expect(await pending).toStrictEqual({ ok: true, value: CONTRACT_ANSWER });
      } finally {
        vi.useRealTimers();
      }
    });

    it("removes its abort listener once the delay has elapsed", async () => {
      vi.useFakeTimers();
      try {
        const controller = new AbortController();
        const removeListener = vi.spyOn(controller.signal, "removeEventListener");
        const pending = ask(
          createFakeLlmPort({ response: CONTRACT_ANSWER, delayMs: 5_000 }),
          controller.signal,
        );
        await vi.advanceTimersByTimeAsync(5_000);
        await pending;

        expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears its pending timer when the signal aborts first", async () => {
      vi.useFakeTimers();
      try {
        const controller = new AbortController();
        const pending = ask(
          createFakeLlmPort({ response: CONTRACT_ANSWER, delayMs: 5_000 }),
          controller.signal,
        );
        controller.abort();
        const error = failureOf(await pending);

        expect(error.code).toBe("ERR_LLM_TIMEOUT");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stays aborted even once the delay would have elapsed", async () => {
      vi.useFakeTimers();
      try {
        const controller = new AbortController();
        const pending = ask(
          createFakeLlmPort({ response: CONTRACT_ANSWER, delayMs: 5_000 }),
          controller.signal,
        );
        controller.abort();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(failureOf(await pending).code).toBe("ERR_LLM_TIMEOUT");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

/**
 * Re-captures the two fixtures that are recordings of real exchanges.
 *
 * @remarks
 * Skipped unless `LLM_RECORD=1`, which is a local operation: it spends money
 * and needs a real credential, so it is never what CI runs. It lives here, next
 * to {@link CONTRACT_ANSWER}, because the recorded answer has to *be* that
 * value for the contract suite above to assert on it — building the prompt from
 * the constant is what stops the fixture and the assertion drifting apart.
 *
 * `ERR_LLM_RATE_LIMIT` and `ERR_LLM_UNAVAILABLE` have no entry here: neither a
 * 429 nor a 529 can be provoked on demand, so their fixtures are written by
 * hand against the documented error shape.
 */
describe.runIf(isRecording())("recording the Anthropic fixtures", () => {
  it("has a credential to record with", () => {
    expect(process.env["ANTHROPIC_API_KEY"] ?? "").not.toBe("");
  });

  it("records a successful exchange", async () => {
    const result = await createAnthropicAdapter({
      apiKey: process.env["ANTHROPIC_API_KEY"],
      maxRetries: 0,
      fetch: recordingFetch("success", 200),
    }).generate({
      schema: CONTRACT_SCHEMA,
      prompt: `Reply with exactly this JSON object, copied verbatim: ${JSON.stringify(CONTRACT_ANSWER)}`,
      outputLanguage: "en",
    });

    // The recording is only usable if the real answer is the value the replayed
    // contract suite asserts on, so that is checked at record time rather than
    // discovered as a failure on the next run.
    expect(result).toStrictEqual({ ok: true, value: CONTRACT_ANSWER });
  });

  it("records an authentication failure", async () => {
    // Deliberately not the real credential: a rejected key is the whole point,
    // and it is short enough not to look like one to the staged-content guard.
    const error = failureOf(
      await ask(
        createAnthropicAdapter({
          apiKey: "sk-ant-invalid",
          maxRetries: 0,
          fetch: recordingFetch("auth-401", 401),
        }),
      ),
    );

    expect(error.code).toBe("ERR_LLM_AUTH");
  });
});
