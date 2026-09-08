import Anthropic from "@anthropic-ai/sdk";

import { declineLongRetryAfter } from "./retry-after";

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
 * {@link defaultDeadlineMs} is what covers that half, and it covers it
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
 * The SDK's own ceiling on a computed backoff sleep, per retry.
 *
 * @remarks
 * A report of what the SDK does, not a policy this repository sets. See
 * `MAX_RETRY_AFTER_MS` in `./retry-after`: the same number for a stated reason,
 * and the one that would keep its value if the SDK ever moved this one.
 */
const BACKOFF_CEILING_MS = 8_000;

/** The one stretch `timeoutMs` does not reach: reading the body behind the headers. */
const BODY_READ_MARGIN_MS = 2_000;

/**
 * How long one whole `generate()` call may take, in milliseconds, when the
 * caller does not pass `deadlineMs` explicitly.
 *
 * @remarks
 * Wall clock over the entire call — every attempt and the body read — where
 * `timeoutMs` is per attempt and reaches only as far as the headers. A
 * provider that answers `200` and then dribbles bytes is the case it exists
 * for: nothing else settles that request, because the caller's `AbortSignal`
 * is optional and the SDK's own timer has already been cleared.
 *
 * Derived rather than fixed, because a fixed constant computed from the
 * *default* `timeoutMs` and `maxRetries` silently under-cuts a caller who
 * configures either: `createAnthropicAdapter({ apiKey, timeoutMs: 300_000 })`
 * implies a single attempt can take five minutes, but a fixed `130_000` total
 * bound would abort before even that first attempt's own header timeout could
 * fire. Deriving from the resolved values instead means the two options stay
 * true to what they say they bound.
 *
 * Three terms:
 *
 * - `(maxRetries + 1) * timeoutMs` — every attempt, each of which may spend
 *   its whole `timeoutMs` waiting for response *headers*.
 * - `maxRetries * BACKOFF_CEILING_MS` — the backoff sleep between attempts,
 *   each bounded by the SDK's own ceiling on its *computed* backoff
 *   (`@anthropic-ai/sdk@^0.122.0`). A provider-supplied `retry-after` is the
 *   other thing that sleep can be, and it fits the same term only because
 *   {@link declineLongRetryAfter} declines one longer than
 *   `MAX_RETRY_AFTER_MS`, which is that ceiling's own value. Every sleep
 *   here is therefore at most 8 s whatever chose its length.
 * - `BODY_READ_MARGIN_MS` — exactly one body read, which happens once, behind
 *   the headers that finally arrive, and is the stretch `timeoutMs` cannot
 *   reach.
 *
 * With the shipped defaults (`DEFAULT_TIMEOUT_MS`, `DEFAULT_MAX_RETRIES`) this
 * comes to `2 * 60_000 + 1 * 8_000 + 2_000 = 130_000` — the same number this
 * used to be a fixed constant, so an application that configures neither
 * option sees no change at all.
 *
 * An explicit `deadlineMs` skips this function entirely and is honoured even
 * when it is shorter than one attempt's `timeoutMs`, because shortest-wins is
 * what composing a deadline into an `AbortSignal` means: a caller asking for a
 * hard five-second total bound while leaving a sixty-second per-attempt
 * timeout is asking for exactly the right thing. What it does not buy is
 * punctuality: a deadline that fires while any backoff sleep is in flight is
 * noticed only when that sleep ends, because `retryRequest` awaits it without
 * consulting the signal. The worst case is therefore
 * `deadlineMs + MAX_RETRY_AFTER_MS` — 138 s at the shipped defaults — and the
 * addend is now a sleep this repository chose to afford rather than one the
 * provider chose for it. The derived budget above already allows for every
 * sleep, so it is a short *explicit* `deadlineMs` that actually spends the
 * overshoot.
 */
export function defaultDeadlineMs(timeoutMs: number, maxRetries: number): number {
  return (
    (maxRetries + 1) * timeoutMs + maxRetries * BACKOFF_CEILING_MS + BODY_READ_MARGIN_MS
  );
}

/**
 * The largest value {@link AnthropicAdapterOptions.deadlineMs} may take —
 * and, since a per-attempt timeout longer than the largest total bound the
 * platform can ever arm could never be reached, {@link AnthropicClientOptions.timeoutMs}'s
 * ceiling too.
 *
 * @remarks
 * `AbortSignal.timeout` takes an unsigned 32-bit delay and throws a
 * `RangeError` for anything else — a negative, a fraction, `Infinity`. Rejected
 * at construction rather than left to throw per request, because `LlmPort`
 * promises `generate()` resolves to a `Result` and never throws, and the signal
 * is armed outside every `try` there.
 */
export const MAX_DEADLINE_MS = 4_294_967_295;

/**
 * The SDK's own hardcoded default host, a literal at `client.ts:627`/`:871` in
 * `@anthropic-ai/sdk@0.122.0` with no exported constant to import instead.
 */
const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/** Everything {@link createAnthropicClient} needs that is not a request. */
export interface AnthropicClientOptions {
  /** The credential, already known to be present and non-blank. */
  readonly apiKey: string;

  /**
   * @see DEFAULT_TIMEOUT_MS
   * @remarks Must be an integer in `1..MAX_DEADLINE_MS`; rejected otherwise.
   */
  readonly timeoutMs?: number;

  /**
   * @see DEFAULT_MAX_RETRIES
   * @remarks Must be a non-negative integer; rejected otherwise.
   */
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
 * `apiKey` is required rather than optional so the SDK's own
 * `process.env.ANTHROPIC_API_KEY` fallback never fires — `src/server/env.ts`
 * is the only place under `src/` meant to read `process.env`. Four more
 * options close the same fallback, all read at `client.ts:604-669`
 * (`@anthropic-ai/sdk@0.122.0`): `authToken: null`, else a Bearer header joins
 * `X-Api-Key` on every request; `baseURL`; `logLevel: "warn"`, the SDK's own
 * default; and `webhookKey: null`, which changes no request this adapter makes
 * — nothing here verifies a webhook — but is the same ambient read.
 * `ANTHROPIC_CUSTOM_HEADERS` alone has no closing option and is read
 * unconditionally: an acknowledged residual limitation.
 *
 * {@link declineLongRetryAfter} is installed on every client rather than per
 * request: what it enforces is a property of this adapter, not of one call, and
 * the SDK's own computed backoff is invisible to middleware anyway, so sizing a
 * per-request copy to the deadline still remaining would buy nothing.
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
    authToken: null,
    baseURL: ANTHROPIC_DEFAULT_BASE_URL,
    logLevel: "warn",
    webhookKey: null,
    timeout: timeoutMs,
    maxRetries,
    middleware: [declineLongRetryAfter],
    ...(fetch === undefined ? {} : { fetch }),
  });
}
