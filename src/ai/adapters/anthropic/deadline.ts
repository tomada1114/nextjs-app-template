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
 * an abort arriving mid-sleep is noticed only when the next attempt begins.
 * See {@link DEFAULT_DEADLINE_MS} for what that costs.
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
