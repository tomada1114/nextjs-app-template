import { defaultDeadlineMs, MAX_DEADLINE_MS } from "./client";

/**
 * Rejects `timeoutMs` and `maxRetries` on their own terms, before either feeds
 * the deadline derivation.
 *
 * @remarks
 * An explicit `deadlineMs` skips {@link defaultDeadlineMs} entirely — #65's
 * design, which {@link resolveDeadlineMs}'s own remarks describe — so that path
 * is the *only* place these two options are looked at on their own. Without
 * this check, `{ maxRetries: -1, deadlineMs: 60_000 }` constructs cleanly and
 * reaches `new Anthropic({ maxRetries: -1 })`, where the SDK's
 * `retriesRemaining > 0` is never true and retries are silently off.
 *
 * This is deliberately not a cross-check against `deadlineMs`: an individually
 * valid `timeoutMs`/`maxRetries` pair that derives to something unarmable is
 * still the derived-deadline check's job below, not this one's.
 *
 * `timeoutMs` shares {@link MAX_DEADLINE_MS} as its own ceiling: a per-attempt
 * timeout larger than the largest total bound the platform can ever arm could
 * never be reached anyway. `maxRetries` has no ceiling beyond being a
 * non-negative integer — `0` is valid and already relied on by this module's
 * own tests; this issue asks only that the option be checked, not that a retry
 * policy be invented.
 *
 * @throws A `RangeError` naming whichever option the caller passed.
 */
function validateAttemptOptions(timeoutMs: number, maxRetries: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_DEADLINE_MS) {
    throw new RangeError(
      `timeoutMs must be an integer between 1 and ${String(MAX_DEADLINE_MS)}; received ${String(timeoutMs)}.`,
    );
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError(
      `maxRetries must be a non-negative integer; received ${String(maxRetries)}.`,
    );
  }
}

/**
 * The total deadline one adapter runs its requests under.
 *
 * @remarks
 * Resolved once, at construction, and validated there rather than left for
 * {@link requestSignal} to throw per request. `AbortSignal.timeout` rejects a
 * delay outside an unsigned 32-bit range with a `RangeError`, and the signal is
 * armed outside every `try` in `generate` — so an unchecked value would surface
 * as a *rejected* `generate()`, the one thing `LlmPort` promises never happens.
 * A deadline out of range is a composition-root mistake, and a start-up failure
 * is where that points.
 *
 * `timeoutMs` and `maxRetries` are checked on their own terms first, via
 * {@link validateAttemptOptions} — see its remarks for why that cannot simply be
 * folded into the check below. What follows here catches the other case: a
 * `deadlineMs`, explicit or derived, that is itself out of range.
 *
 * `explicit` wins outright when it is given, even when it is shorter than one
 * attempt's `timeoutMs`: shortest-wins is what composing a deadline into an
 * `AbortSignal` means, and a caller asking for a hard bound below its
 * per-attempt timeout is asking for exactly the right thing. The two messages
 * differ for the same reason — only one of these is a value the caller typed.
 *
 * @throws A `RangeError` naming whichever option the caller can act on.
 */
export function resolveDeadlineMs(
  explicit: number | undefined,
  timeoutMs: number,
  maxRetries: number,
): number {
  validateAttemptOptions(timeoutMs, maxRetries);

  const deadlineMs = explicit ?? defaultDeadlineMs(timeoutMs, maxRetries);

  if (
    !Number.isInteger(deadlineMs) ||
    deadlineMs <= 0 ||
    deadlineMs > MAX_DEADLINE_MS
  ) {
    throw new RangeError(
      explicit === undefined
        ? `timeoutMs and maxRetries imply a total deadline of ${String(deadlineMs)} ms, which is not an integer between 1 and ${String(MAX_DEADLINE_MS)}. Correct timeoutMs and maxRetries: passing deadlineMs bounds the call but leaves those two as they are.`
        : `deadlineMs must be an integer between 1 and ${String(MAX_DEADLINE_MS)}; received ${String(deadlineMs)}.`,
    );
  }

  return deadlineMs;
}

/**
 * The signal one request is actually made under.
 *
 * @remarks
 * Composed, not raced. A `Promise.race` against a timer settles the promise the
 * adapter returns while leaving the socket open and the body still arriving,
 * which bounds the caller's wait and nothing else; aborting the transport is
 * what ends the request. Composing also makes the bound *total* rather than per
 * attempt — an abort landing between retries ends the chain instead of starting
 * another attempt, so `maxRetries` no longer multiplies it. Ends it, but not
 * necessarily on time: the SDK's backoff sleep does not consult the signal, so
 * an abort arriving mid-sleep is noticed only when the next attempt begins. The
 * overshoot that costs is bounded rather than open-ended — at most
 * `MAX_RETRY_AFTER_MS`, because no sleep the SDK starts can outlast it once
 * `declineLongRetryAfter` refuses a longer `retry-after`. See
 * {@link defaultDeadlineMs} for the arithmetic.
 *
 * `AbortSignal.any` propagates the *first* aborting source's `reason`, which is
 * what keeps the error identity the port promises: a caller that aborted with
 * its own error still finds that instance on `cause`, and a fired deadline
 * arrives as `AbortSignal.timeout`'s own `TimeoutError`. Both are
 * `ERR_LLM_TIMEOUT` — the code whose remedy, give up on this request, is right
 * either way.
 *
 * `AbortSignal.timeout`'s timer is unref'd, so an armed deadline never holds
 * the process — or a test run — open past the request it bounds. It is also not
 * cancellable, which is what a caller has to know before arming one: this is
 * called per request, once the call is certain to be sent.
 */
export function requestSignal(
  deadlineMs: number,
  callerSignal: AbortSignal | undefined,
): AbortSignal {
  const deadline = AbortSignal.timeout(deadlineMs);
  return callerSignal === undefined
    ? deadline
    : AbortSignal.any([deadline, callerSignal]);
}
