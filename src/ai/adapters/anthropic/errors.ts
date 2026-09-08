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
 * Whether a rejection is a cancelled request wearing no SDK class.
 *
 * @remarks
 * The SDK converts an abort into `APIUserAbortError` only while it owns the
 * request, and it stops owning it once the response headers arrive — the body
 * is then decoded outside those guards. An abort landing in that window escapes
 * as the raw `AbortError` the platform threw, which is an ordinary
 * `DOMException` and an instance of none of the SDK's error classes. Matching
 * on the name is what the SDK itself does internally, and it is the only thing
 * these rejections have in common.
 */
function isAbortError(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    "name" in reason &&
    reason.name === "AbortError"
  );
}

/**
 * Translates whatever the SDK threw into the one error vocabulary the port
 * publishes.
 *
 * @remarks
 * `signal` is the one the request was made under — the adapter's own deadline
 * composed with the caller's signal when there was one — and never the SDK's
 * internal controller, which aborts with no reason at all. The SDK reports an
 * abort as its `APIUserAbortError`, which carries a message of its own and not
 * the reason that ended the request; rebuilding the error from the signal is
 * what lets a caller compare `result.error.cause` against the reason it
 * supplied, by identity, and what carries a fired deadline's own
 * `TimeoutError` through unchanged. See {@link abortedLlmError}.
 *
 * Order matters twice. `APIConnectionTimeoutError` and `APIUserAbortError` are
 * both `APIError` subclasses, so the general HTTP case has to come last; and
 * the timeout check has to precede {@link isAbortError}, because the SDK builds
 * its deadline out of an abort and only it can tell that one apart from the
 * caller's.
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
  if (isAbortError(reason)) {
    // An abort the SDK no longer had a chance to label. Reported through the
    // signal, not through `reason`, so `cause` keeps the identity the port
    // promises whichever side of the headers the cancellation landed on.
    return abortedLlmError(signal?.reason);
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
