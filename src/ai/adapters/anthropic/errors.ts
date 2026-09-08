import {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";

import { abortedLlmError, asError, LlmError, type LlmErrorCode } from "../../errors";

/**
 * The port code an HTTP status maps to.
 *
 * @remarks
 * The vocabulary is about what a caller can *do*, so the split is by remedy
 * rather than by status class. `400`/`422` join `ERR_LLM_INVALID_OUTPUT`
 * because the only request this adapter ever builds is the caller's schema and
 * prompt: a rejected one is re-prompted, not retried and not reconfigured.
 * Everything unrecognised falls to `ERR_LLM_UNAVAILABLE`, which is the code
 * whose remedy — try again later — is safe to suggest for a failure nobody has
 * classified yet.
 */
function codeForStatus(status: number | undefined): LlmErrorCode {
  if (status === undefined) {
    return "ERR_LLM_UNAVAILABLE";
  }
  if (status === 401 || status === 403) {
    return "ERR_LLM_AUTH";
  }
  if (status === 429) {
    return "ERR_LLM_RATE_LIMIT";
  }
  if (status === 400 || status === 422) {
    return "ERR_LLM_INVALID_OUTPUT";
  }
  return "ERR_LLM_UNAVAILABLE";
}

/**
 * Translates whatever the SDK threw into the one error vocabulary the port
 * publishes.
 *
 * @remarks
 * `signal` is the caller's own, not the SDK's. The SDK reports an abort as its
 * `APIUserAbortError`, which carries a message of its own and not the reason
 * the caller passed to `abort()`; rebuilding the error from the signal is what
 * lets a caller compare `result.error.cause` against the reason it supplied,
 * by identity. See {@link abortedLlmError}.
 *
 * Order matters: `APIConnectionTimeoutError` and `APIUserAbortError` are both
 * `APIError` subclasses, so the general case has to come last.
 */
export function toLlmError(reason: unknown, signal: AbortSignal | undefined): LlmError {
  if (reason instanceof APIUserAbortError) {
    return abortedLlmError(signal?.reason);
  }
  if (reason instanceof APIConnectionTimeoutError) {
    return new LlmError("ERR_LLM_TIMEOUT", `LLM request timed out: ${reason.message}`, {
      cause: reason,
    });
  }
  if (reason instanceof APIError) {
    // `APIError`'s status is generic, so an unparameterised `instanceof` narrows
    // it no further than `any`. Re-narrowing here keeps the mapping honest
    // rather than trusting a type the check did not actually establish.
    const status: unknown = reason.status;
    return new LlmError(
      codeForStatus(typeof status === "number" ? status : undefined),
      reason.message,
      { cause: reason },
    );
  }

  const cause = asError(reason, "The LLM request failed for an unknown reason.");
  return new LlmError("ERR_LLM_UNAVAILABLE", `LLM request failed: ${cause.message}`, {
    cause,
  });
}
