import { abortedLlmError, asError, LlmError, type LlmErrorCode } from "../../errors";

/**
 * The port code an OpenRouter status maps to.
 *
 * @remarks
 * Split by what a caller can *do*, using the meaning OpenRouter documents for
 * each status rather than the generic HTTP one:
 *
 * - `401` (bad key) and `402` (no credits left) are fixed in the account, not
 *   by asking again — `ERR_LLM_AUTH`.
 * - `400`, `422` and `403` reject the request's own content. `403` is
 *   OpenRouter's moderation refusal of the input, not a permission error, and
 *   the only request this adapter builds is the caller's schema and prompt, so
 *   all three are re-prompted — `ERR_LLM_INVALID_OUTPUT`.
 * - `408` is the upstream giving up on this request — `ERR_LLM_TIMEOUT`.
 * - `429` — `ERR_LLM_RATE_LIMIT`.
 *
 * Everything else, `502`/`503` and an absent status among them, is
 * `ERR_LLM_UNAVAILABLE`: try again later is the safe remedy for a failure
 * nobody has classified.
 */
export function codeForStatus(status: number | undefined): LlmErrorCode {
  switch (status) {
    case 401:
    case 402:
      return "ERR_LLM_AUTH";
    case 400:
    case 403:
    case 422:
      return "ERR_LLM_INVALID_OUTPUT";
    case 408:
      return "ERR_LLM_TIMEOUT";
    case 429:
      return "ERR_LLM_RATE_LIMIT";
    default:
      return "ERR_LLM_UNAVAILABLE";
  }
}

/**
 * The failure a non-`2xx` response, or a `200` carrying an `error` object,
 * reports.
 *
 * @remarks
 * The message names the status and nothing else: OpenRouter's own error text
 * can quote the prompt or the model's output straight back. That text is kept
 * on `cause` instead, for a server-side log.
 */
export function providerError(status: number | undefined, body: string): LlmError {
  const message =
    status === undefined
      ? "The LLM provider reported an error without a status."
      : `The LLM provider returned status ${String(status)}.`;
  return new LlmError(codeForStatus(status), message, {
    cause: new Error(`OpenRouter error response: ${body}`),
  });
}

/**
 * Translates a rejected `fetch` or body read into the port's vocabulary.
 *
 * @remarks
 * `signal` is the one the request was made under — the adapter's deadline
 * composed with the caller's signal. Whether *it* aborted decides the code,
 * not the rejection's name: a real `fetch` rejects with the signal's `reason`
 * itself, which may be any value at all, and rebuilding the error from
 * `signal.reason` is what keeps the caller's reason on `cause` by identity.
 */
export function transportError(reason: unknown, signal: AbortSignal): LlmError {
  if (signal.aborted) {
    return abortedLlmError(signal.reason);
  }
  return new LlmError(
    "ERR_LLM_UNAVAILABLE",
    "The LLM request could not reach the provider.",
    { cause: asError(reason, "The LLM request failed with no error object at all.") },
  );
}
