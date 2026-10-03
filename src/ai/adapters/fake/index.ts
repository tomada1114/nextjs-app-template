import type * as z from "zod";

import { err, type Result } from "../../../core/result";
import { abortedLlmError, LlmError, type LlmErrorCode } from "../../errors";
import type { LlmPort, LlmRequest } from "../../port";
import { validateOutput } from "../../validation";

/**
 * How a {@link createFakeLlmPort} instance answers every request it receives.
 *
 * @remarks
 * The whole configuration is fixed at construction: this adapter answers the
 * same way however it is prompted, which is what makes it usable both as the
 * "run the app with no API key" adapter and as the subject of the port's
 * contract suite. Replaying a recorded conversation is a different adapter.
 */
export interface FakeLlmPortOptions {
  /**
   * The raw value every request resolves to, before validation.
   *
   * @remarks
   * It is deliberately `unknown` and validated against each request's own
   * schema rather than typed against one, so a value that does *not* match is
   * expressible — that is how `ERR_LLM_INVALID_OUTPUT` is exercised. Leaving it
   * unset therefore fails every request with that code.
   */
  readonly response?: unknown;

  /** When set, every request fails with this code instead of answering. */
  readonly failWith?: LlmErrorCode;

  /**
   * How long to wait before answering, in milliseconds.
   *
   * @remarks
   * Only reason to set it is to leave a window in which a test can abort a
   * request that is already in flight. It defaults to `0`, which answers on the
   * next microtask. Must be an integer in `0..2_147_483_647`; rejected at
   * construction otherwise, before a timer can silently clamp it.
   */
  readonly delayMs?: number;
}

/**
 * Waits out the configured delay, or reports the abort that beat it.
 *
 * @returns `undefined` when the delay elapsed, or the {@link LlmError} the
 * abort produced.
 */
function settle(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<LlmError | undefined> {
  if (signal?.aborted === true) {
    return Promise.resolve(abortedLlmError(signal.reason));
  }
  if (ms <= 0) {
    return Promise.resolve(undefined);
  }

  return new Promise<LlmError | undefined>((resolve) => {
    const timer = setTimeout(() => {
      // Both paths drop the listener, so a signal that outlives this request
      // does not retain the closure.
      signal?.removeEventListener("abort", onAbort);
      resolve(undefined);
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      resolve(abortedLlmError(signal?.reason));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Builds an {@link LlmPort} that answers from a fixed configuration instead of
 * calling a provider.
 *
 * @remarks
 * It exists so the application runs, and its tests pass, with no API key and no
 * network. It satisfies the same contract suite a real adapter does.
 */
export function createFakeLlmPort(options: FakeLlmPortOptions = {}): LlmPort {
  const { response, failWith, delayMs = 0 } = options;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 2_147_483_647) {
    throw new RangeError("delayMs must be an integer in 0..2_147_483_647.");
  }

  return {
    async generate<TSchema extends z.ZodType>(
      request: LlmRequest<TSchema>,
    ): Promise<Result<z.infer<TSchema>, LlmError>> {
      const aborted = await settle(delayMs, request.signal);
      if (aborted !== undefined) {
        return err(aborted);
      }

      if (failWith !== undefined) {
        return err(
          new LlmError(
            failWith,
            `The fake LLM adapter is configured to fail with ${failWith}.`,
          ),
        );
      }

      return validateOutput(request.schema, response, request.signal);
    },
  };
}
