import type { Middleware } from "@anthropic-ai/sdk";

/**
 * The longest `retry-after` this client is willing to sit out, in milliseconds.
 *
 * @remarks
 * Equal to the SDK's own ceiling on a *computed* backoff sleep — `maxRetryDelay
 * = 8.0` seconds in `calculateDefaultRetryTimeoutMillis`
 * (`node_modules/@anthropic-ai/sdk/src/client.ts:1495`, `@anthropic-ai/sdk@^0.122.0`)
 * — and that equality is the whole point of the number rather than a
 * coincidence. Once no honoured `retry-after` can exceed it and no computed
 * backoff can either, *every* sleep in a call is at most 8 s whatever its
 * source, so the worst case a caller has to reason about becomes a figure this
 * repository states: `deadlineMs + MAX_RETRY_AFTER_MS`. Before, the second term
 * was whatever the provider asked for, and 300 s is a perfectly ordinary thing
 * for a rate limiter to ask for.
 *
 * Stated separately from `BACKOFF_CEILING_MS` in `./client` even though the two
 * are the same number today, because they are not the same kind of fact. That
 * one reports what the SDK does and has to follow the SDK if it ever changes;
 * this one is a policy this repository chose and would keep its value across
 * such a change. Deliberately not an {@link AnthropicAdapterOptions} field: a
 * template earns more from one fewer knob than from a tunable nobody has asked
 * to tune, and every behaviour it governs is reachable in a test through
 * `maxRetries` and a fixture header.
 */
export const MAX_RETRY_AFTER_MS = 8_000;

/**
 * The delay the SDK would take from these response headers, in milliseconds.
 *
 * @remarks
 * A mirror of `retryRequest`'s header reading
 * (`node_modules/@anthropic-ai/sdk/src/client.ts:1462-1481`), reproduced here
 * *including its quirks*, because a cap that computed a different number from
 * the one actually slept on would cap nothing:
 *
 * - `retry-after-ms` wins only when **truthy**. The SDK writes
 *   `if (retryAfterHeader && !timeoutMillis)`, not `!== undefined`, so a
 *   `retry-after-ms: 0` still lets a `retry-after` through and is read as
 *   seconds.
 * - A malformed `retry-after` yields `NaN`, not `undefined`. `Date.parse` of
 *   `"later"` is `NaN`, and `NaN` is what the SDK hands to `setTimeout` — which
 *   sleeps ~0. That is a different outcome from "no header at all", where the
 *   SDK computes its own backoff instead, so the two must not collapse into one
 *   return value here.
 *
 * `undefined` therefore means exactly one thing: the SDK would fall through to
 * `calculateDefaultRetryTimeoutMillis`, whose result is already bounded.
 */
export function honoredRetryAfterMs(headers: Headers): number | undefined {
  let timeoutMillis: number | undefined;

  const retryAfterMillisHeader = headers.get("retry-after-ms");
  if (retryAfterMillisHeader) {
    const parsed = Number.parseFloat(retryAfterMillisHeader);
    if (!Number.isNaN(parsed)) {
      timeoutMillis = parsed;
    }
  }

  const retryAfterHeader = headers.get("retry-after");
  if (retryAfterHeader && !timeoutMillis) {
    const seconds = Number.parseFloat(retryAfterHeader);
    timeoutMillis = Number.isNaN(seconds)
      ? Date.parse(retryAfterHeader) - Date.now()
      : seconds * 1000;
  }

  return timeoutMillis;
}

/**
 * Declines to retry when the provider asked for a wait this client cannot afford.
 *
 * @remarks
 * **The `x-should-retry: false` this returns is written by the client, not sent
 * by the server.** Nothing the provider said is being reported here: the header
 * is the SDK's own control channel — `shouldRetry` consults it ahead of the
 * `408`/`409`/`429`/`5xx` status rules
 * (`node_modules/@anthropic-ai/sdk/src/client.ts:1433-1437`) — and this
 * middleware writes it on the way past to end the retry chain. A reader who
 * takes it for something Anthropic sent will misread every log line downstream
 * of it. `ClientOptions.middleware` is the public seam that makes this
 * legitimate rather than a reach around the package: replacing a response is
 * what its contract documents (`src/core/middleware.ts`, "to transform it,
 * return a replacement, e.g. `new Response(body, response)`").
 *
 * Why refuse rather than shorten the wait. `retryRequest` awaits its backoff
 * with a bare `await sleep(timeoutMillis)` — no signal, though `sleep` itself
 * accepts one (`src/internal/utils/sleep.ts:9`) — so the adapter's composed
 * deadline cannot interrupt it, and the length comes verbatim from the header
 * with no clamp anywhere. A `429` carrying `retry-after: 300` therefore parks a
 * web request for five minutes past a deadline it was given. Clamping the
 * header to the cap would still sleep, and would still spend a second request
 * arguing with an explicit refusal; declining removes the overshoot on this
 * path outright, and `ERR_LLM_RATE_LIMIT` at t ≈ 1 s is an answer a route
 * handler can act on where the same code at t ≈ 301 s is one it has already
 * failed its own caller waiting for.
 *
 * An `x-should-retry: true` the provider *did* send is overridden, on purpose.
 * The provider decides whether a failure is retryable; how long this client is
 * willing to wait is this client's to decide, and 300 s is not it.
 *
 * Two constraints in the body are traps rather than style:
 *
 * - **Construct, never mutate.** A `Response` from a real `fetch` carries an
 *   immutable header guard, so `response.headers.set(...)` would work against
 *   the locally built `Response` every test uses and throw in production — the
 *   one divergence that must not ship.
 * - **The `>= 400` gate** keeps the replacement off the statuses that forbid a
 *   body (`204`, `205`, `304`), where `new Response(body, …)` throws. It is a
 *   deliberate superset of `shouldRetry`'s status list rather than a copy of
 *   it: the header is simply never read on a response the SDK would not have
 *   retried, so the looser test is the cheaper one to keep correct.
 *
 * A delay at or under {@link MAX_RETRY_AFTER_MS} is left alone and the SDK
 * retries exactly as it does today, as is a `NaN` or negative delay — both of
 * which the SDK sleeps ~0 on, so there is nothing to decline.
 */
export const declineLongRetryAfter: Middleware = async (request, next) => {
  const response = await next(request);

  if (response.status >= 400) {
    const delayMs = honoredRetryAfterMs(response.headers);

    if (delayMs !== undefined && delayMs > MAX_RETRY_AFTER_MS) {
      const headers = new Headers(response.headers);
      headers.set("x-should-retry", "false");

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
  }

  return response;
};
