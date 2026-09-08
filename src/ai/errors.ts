/**
 * Every failure an `LlmPort` may report.
 *
 * @remarks
 * The vocabulary is deliberately about what a caller can *do*, not about which
 * provider produced it: retry later (`ERR_LLM_RATE_LIMIT`,
 * `ERR_LLM_UNAVAILABLE`), fix configuration (`ERR_LLM_AUTH`), give up on this
 * request (`ERR_LLM_TIMEOUT`), or re-prompt (`ERR_LLM_INVALID_OUTPUT`). A new
 * member is a change to what every adapter promises, so it is added here once
 * rather than per adapter.
 */
export type LlmErrorCode =
  | "ERR_LLM_AUTH"
  | "ERR_LLM_RATE_LIMIT"
  | "ERR_LLM_TIMEOUT"
  | "ERR_LLM_INVALID_OUTPUT"
  | "ERR_LLM_UNAVAILABLE";

/**
 * The single error type every LLM adapter reports through.
 *
 * @remarks
 * `code` is the contract a caller branches on; `message` is prose for a log and
 * may be reworded at any time. The provider's own error, when there was one, is
 * kept on `cause` so a log can still show it without any caller having to know
 * the provider's error classes.
 */
export class LlmError extends Error {
  /** Stable discriminator; a caller switches on this, never on `message`. */
  readonly code: LlmErrorCode;

  constructor(code: LlmErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LlmError";
    this.code = code;
  }
}

/**
 * Normalises an unknown rejection reason into an `Error`, returning the reason
 * itself when it already is one.
 *
 * @remarks
 * The identity half is the point. A caller that aborts with its own error
 * instance can compare what it observes against what it passed
 * (`result.error.cause === myReason`), which a freshly built error carrying the
 * same message would break. `fallback` only names the failure for the case
 * where the reason was not an `Error` at all — a string, `undefined`, anything
 * a `reject()` or `abort()` may carry — and that value is kept on `cause`.
 */
export function asError(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback, { cause: reason });
}

/**
 * Builds the {@link LlmError} an aborted request reports.
 *
 * @remarks
 * A deadline is not this layer's to invent: it belongs to the provider SDK's
 * own timeout option and to the `AbortSignal` the caller passes. What an
 * adapter owns is translating whatever that abort carried into the one error
 * vocabulary above, without losing the reason's identity — see
 * {@link asError}.
 */
export function abortedLlmError(reason: unknown): LlmError {
  const cause = asError(reason, "The LLM request was aborted.");
  return new LlmError("ERR_LLM_TIMEOUT", `LLM request aborted: ${cause.message}`, {
    cause,
  });
}
