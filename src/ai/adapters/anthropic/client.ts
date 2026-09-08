import Anthropic from "@anthropic-ai/sdk";

/** The provider model this adapter calls when its caller names none. */
export const DEFAULT_MODEL = "claude-sonnet-5";

/** Ceiling on one answer's length, in tokens, when its caller names none. */
export const DEFAULT_MAX_TOKENS = 1024;

/**
 * How long one call may take before the SDK abandons it, in milliseconds.
 *
 * @remarks
 * The SDK's own default is ten minutes, which is a batch job's deadline rather
 * than a web request's: a route handler holding a connection open that long has
 * already failed its caller. This is the half of the deadline an adapter owns —
 * the other half is the `AbortSignal` on the request.
 */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Everything {@link createAnthropicClient} needs that is not a request. */
export interface AnthropicClientOptions {
  /** The credential, already known to be present and non-blank. */
  readonly apiKey: string;

  /** @see DEFAULT_TIMEOUT_MS */
  readonly timeoutMs?: number;

  /** How many times the SDK retries a retryable failure. Defaults to the SDK's own. */
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
  const { apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries, fetch } = options;

  return new Anthropic({
    apiKey,
    timeout: timeoutMs,
    ...(maxRetries === undefined ? {} : { maxRetries }),
    ...(fetch === undefined ? {} : { fetch }),
  });
}
