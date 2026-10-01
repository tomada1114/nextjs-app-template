/**
 * How long one whole `generate()` call may take, in milliseconds, when the
 * caller does not pass `deadlineMs`.
 *
 * @remarks
 * Wall clock over the entire call — the request, the response headers and the
 * body behind them. This adapter makes exactly one attempt, so there is no
 * per-attempt timeout or retry budget to derive it from: it is the only bound
 * there is, and it holds whether or not the caller passed a signal.
 */
export const DEFAULT_DEADLINE_MS = 60_000;

/**
 * The largest `deadlineMs` this adapter accepts: Node's signed 32-bit timer
 * ceiling.
 *
 * @remarks
 * Node silently clamps a larger delay instead of rejecting it, so
 * `AbortSignal.timeout(2 ** 31)` fires within a millisecond rather than after
 * the ~24.9 days requested. Anything above this is refused at construction,
 * because `LlmPort` never throws.
 */
export const MAX_DEADLINE_MS = 2_147_483_647;

/**
 * The total deadline one adapter runs its requests under.
 *
 * @remarks
 * Checked once, at construction. A delay outside `AbortSignal.timeout`'s own
 * range would otherwise throw from inside `generate()` — a rejected promise
 * `LlmPort` promises never happens — and one merely above
 * {@link MAX_DEADLINE_MS} would fire at once instead of when it was asked to.
 *
 * @throws A `RangeError` naming `deadlineMs` when it is not an integer in
 * `1..MAX_DEADLINE_MS`.
 */
export function resolveDeadlineMs(explicit: number | undefined): number {
  const deadlineMs = explicit ?? DEFAULT_DEADLINE_MS;
  if (
    !Number.isInteger(deadlineMs) ||
    deadlineMs <= 0 ||
    deadlineMs > MAX_DEADLINE_MS
  ) {
    throw new RangeError(
      `deadlineMs must be an integer between 1 and ${String(MAX_DEADLINE_MS)}; received ${String(deadlineMs)}.`,
    );
  }
  return deadlineMs;
}

/**
 * The signal one request is actually made under.
 *
 * @remarks
 * Composed, not raced: aborting the signal `fetch` was given is what closes
 * the socket and errors a body still arriving, where a `Promise.race` against
 * a timer would settle the returned promise and leave the transport running.
 * `AbortSignal.any` propagates the first aborting source's `reason`, so a
 * caller's own abort reason and a fired deadline's `TimeoutError` both reach
 * `cause` by identity.
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
