import Anthropic from "@anthropic-ai/sdk";

/** The provider model this adapter calls when its caller names none. */
export const DEFAULT_MODEL = "claude-sonnet-5";

/** Ceiling on one answer's length, in tokens, when its caller names none. */
export const DEFAULT_MAX_TOKENS = 1024;

/**
 * How long one attempt may wait for the response *headers*, in milliseconds.
 *
 * @remarks
 * Headers, not the whole answer: the SDK arms this deadline around its inner
 * fetch and clears it as soon as the `Response` resolves, so a provider that
 * sends `200` and then stalls mid-body is not bounded by it.
 * {@link DEFAULT_DEADLINE_MS} is what covers that half, and it covers it
 * whether or not the caller passed an `AbortSignal` of its own.
 *
 * The SDK's own default is ten minutes — a batch job's deadline rather than a
 * web request's, where a route handler holding a connection open that long has
 * already failed its caller.
 */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * How many times a failed attempt is retried.
 *
 * @remarks
 * Stated here rather than inherited, because the SDK's default of `2` multiplies
 * against {@link DEFAULT_TIMEOUT_MS}: three attempts plus two backoff sleeps put
 * a single stalled request past three minutes, which is not a deadline anyone
 * chose. One retry still absorbs the transient failure a retry is for, and
 * bounds the worst case at roughly two timeouts plus one sleep.
 */
export const DEFAULT_MAX_RETRIES = 1;

/**
 * How long one whole `generate()` call may take, in milliseconds.
 *
 * @remarks
 * Wall clock over the entire call — every attempt and the body read — where
 * {@link DEFAULT_TIMEOUT_MS} is per attempt and reaches only as far as the
 * headers. A provider that answers `200` and then dribbles bytes is the case it
 * exists for: nothing else settles that request, because the caller's
 * `AbortSignal` is optional and the SDK's own timer has already been cleared.
 *
 * The number itself is not a new policy. {@link DEFAULT_MAX_RETRIES} already
 * describes the intended worst case as roughly two timeouts plus one sleep, and
 * this is that bound enforced rather than merely described — which is why it is
 * two timeouts *plus a margin* rather than exactly two: a deadline of `120_000`
 * would fire before the second attempt's own timeout could, and cut off a retry
 * that was still inside the budget `maxRetries` promised it.
 *
 * The margin is not the whole story, because the one stretch of the call the
 * signal cannot reach is the backoff sleep between attempts: the SDK's
 * `retryRequest` awaits it without consulting `options.signal`, so an abort
 * landing mid-sleep is only noticed when the next attempt starts. The chain
 * ends there rather than making another request, but the call overshoots this
 * bound by the remainder of that sleep — bounded by the SDK's 8 s backoff
 * ceiling, or by whatever `retry-after` a `429` asked for.
 *
 * Not an SDK option, unlike the two above: the SDK has nowhere to put a
 * total-request bound, so the adapter composes it into the request's own
 * `AbortSignal` instead.
 */
export const DEFAULT_DEADLINE_MS = 130_000;

/**
 * The largest value {@link AnthropicAdapterOptions.deadlineMs} may take.
 *
 * @remarks
 * `AbortSignal.timeout` takes an unsigned 32-bit delay and throws a
 * `RangeError` for anything else — a negative, a fraction, `Infinity`. Rejected
 * at construction rather than left to throw per request, because `LlmPort`
 * promises `generate()` resolves to a `Result` and never throws, and the signal
 * is armed outside every `try` there.
 */
export const MAX_DEADLINE_MS = 4_294_967_295;

/** Everything {@link createAnthropicClient} needs that is not a request. */
export interface AnthropicClientOptions {
  /** The credential, already known to be present and non-blank. */
  readonly apiKey: string;

  /** @see DEFAULT_TIMEOUT_MS */
  readonly timeoutMs?: number;

  /** @see DEFAULT_MAX_RETRIES */
  readonly maxRetries?: number;

  /**
   * Substitutes the SDK's HTTP layer.
   *
   * @remarks
   * This is the whole of the record/replay seam: the contract suite hands in a
   * `fetch` that answers from a committed fixture, so the same adapter code
   * under test in CI is the code that talks to the provider in production, and
   * no test dependency is needed to arrange it.
   */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Builds the vendor client.
 *
 * @remarks
 * `apiKey` is required rather than optional on purpose. The SDK falls back to
 * reading `process.env.ANTHROPIC_API_KEY` itself when handed `undefined`, and
 * that fallback would make this file a second place the process reads its
 * environment — `src/server/env.ts` is meant to be the only one. Taking a
 * definite string closes it.
 */
export function createAnthropicClient(options: AnthropicClientOptions): Anthropic {
  const {
    apiKey,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    fetch,
  } = options;

  return new Anthropic({
    apiKey,
    timeout: timeoutMs,
    maxRetries,
    ...(fetch === undefined ? {} : { fetch }),
  });
}
