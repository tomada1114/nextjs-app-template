import type * as z from "zod";

import { err, ok, type Result } from "../../../core/result";
import { abortedLlmError, asError, LlmError } from "../../errors";
import type { LlmPort, LlmRequest } from "../../port";
import {
  type AnthropicClientOptions,
  createAnthropicClient,
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  MAX_DEADLINE_MS,
} from "./client";
import { requestSignal } from "./deadline";
import { toLlmError } from "./errors";
import { buildCreateParams, firstTextBlock } from "./request";

/** Everything {@link createAnthropicAdapter} is configured with. */
export interface AnthropicAdapterOptions extends Omit<
  AnthropicClientOptions,
  "apiKey"
> {
  /**
   * The credential, as `src/server/env.ts` validated it.
   *
   * @remarks
   * Deliberately allowed to be absent. The template's promise is that the
   * application starts with nothing configured, so a missing key is reported as
   * `ERR_LLM_AUTH` on the request that needed one — a failure a caller can see
   * and act on — rather than as a server that refuses to boot.
   */
  readonly apiKey: string | undefined;

  /** @see DEFAULT_MODEL */
  readonly model?: string;

  /** @see DEFAULT_MAX_TOKENS */
  readonly maxTokens?: number;

  /** @see DEFAULT_DEADLINE_MS */
  readonly deadlineMs?: number;
}

/** The failure every request reports when no credential was configured. */
function missingKeyError(): LlmError {
  return new LlmError(
    "ERR_LLM_AUTH",
    "No Anthropic API key is configured. Set ANTHROPIC_API_KEY in the environment.",
  );
}

/**
 * Builds an {@link LlmPort} backed by the Anthropic Messages API.
 *
 * @remarks
 * The answer is validated twice, against two different things, and both are
 * load-bearing. The API validates it against the JSON Schema derived from
 * `schema`; this function then validates it again against `schema` itself, with
 * `safeParseAsync`. The second pass is not redundant, because the conversion to
 * JSON Schema silently drops what JSON Schema cannot say — a `refine`, a
 * branded type — so a response the API accepted can still fail the contract the
 * caller actually wrote. What it does *not* do is drop everything: a construct
 * with no JSON Schema equivalent at all (`transform`, `pipe`, `z.date`) makes
 * the conversion throw instead, which is why building the request is its own
 * guarded step below.
 *
 * `messages.create` is what that second pass requires. `messages.parse` would
 * apply `zodOutputFormat`'s own parser, which is Zod's *synchronous* `safeParse`
 * and therefore throws outright on a schema carrying an async refinement — the
 * one thing `LlmPort` promises never to do for an expected failure. The SDK
 * documents `create` as the call that returns the answer unparsed for exactly
 * this purpose.
 */
export function createAnthropicAdapter(options: AnthropicAdapterOptions): LlmPort {
  const {
    apiKey,
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    deadlineMs = DEFAULT_DEADLINE_MS,
    ...clientOptions
  } = options;

  // Thrown here, at wiring time, rather than left for `AbortSignal.timeout` to
  // throw per request: the signal is armed outside every `try` in `generate`,
  // and `LlmPort` promises that call resolves to a `Result` instead of
  // rejecting. A deadline outside the platform's range is a mistake in the
  // composition root, which is where a start-up failure points.
  if (
    !Number.isInteger(deadlineMs) ||
    deadlineMs <= 0 ||
    deadlineMs > MAX_DEADLINE_MS
  ) {
    throw new RangeError(
      `deadlineMs must be an integer between 1 and ${String(MAX_DEADLINE_MS)}; received ${String(deadlineMs)}.`,
    );
  }

  // Built once, at construction, so a missing key costs nothing per request and
  // the credential is read from this scope rather than kept on the port.
  const client =
    apiKey === undefined || apiKey.trim() === ""
      ? undefined
      : createAnthropicClient({ apiKey, ...clientOptions });

  return {
    async generate<TSchema extends z.ZodType>(
      request: LlmRequest<TSchema>,
    ): Promise<Result<z.infer<TSchema>, LlmError>> {
      if (request.signal?.aborted === true) {
        return err(abortedLlmError(request.signal.reason));
      }
      if (client === undefined) {
        return err(missingKeyError());
      }

      // Built outside the request's own `try`: deriving the JSON Schema throws
      // for a schema JSON Schema cannot express, and that is the caller's
      // schema being unusable — nothing was sent, so it is not a transport
      // failure and must not be reported as one worth retrying.
      let params;
      try {
        params = buildCreateParams(request, { model, maxTokens });
      } catch (reason) {
        return err(
          new LlmError(
            "ERR_LLM_INVALID_OUTPUT",
            "The request schema cannot be expressed as JSON Schema, so the model cannot be asked for it.",
            { cause: asError(reason, "The request schema is not convertible.") },
          ),
        );
      }

      // Armed here rather than at the top: every branch above returns without
      // sending anything, so a request that never reaches the provider arms no
      // timer at all.
      const signal = requestSignal(deadlineMs, request.signal);

      let text: string | undefined;
      let stopReason: string | null;
      try {
        const message = await client.messages.create(params, { signal });
        text = firstTextBlock(message.content);
        stopReason = message.stop_reason;
      } catch (reason) {
        return err(toLlmError(reason, signal));
      }

      if (text === undefined) {
        return err(
          new LlmError(
            "ERR_LLM_INVALID_OUTPUT",
            `The model's answer carried no text block to parse (stop_reason: ${String(stopReason)}).`,
          ),
        );
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (reason) {
        // `stop_reason` is named because it is what tells a truncated answer
        // from a malformed one. Both arrive here as unparsable JSON, but only
        // one of them is fixed by re-prompting: `max_tokens` needs a larger
        // ceiling, and re-asking the same question truncates identically.
        return err(
          new LlmError(
            "ERR_LLM_INVALID_OUTPUT",
            `The model's answer was not valid JSON (stop_reason: ${String(stopReason)}).`,
            { cause: asError(reason, "The model's answer was not valid JSON.") },
          ),
        );
      }

      // `safeParseAsync`, not `safeParse`: the synchronous form throws rather
      // than returning a failed result for a schema carrying an async
      // refinement. src/ai/adapters/fake/index.ts carries the same note.
      const parsed = await request.schema.safeParseAsync(json);
      if (!parsed.success) {
        return err(
          new LlmError(
            "ERR_LLM_INVALID_OUTPUT",
            "The model output did not match the requested schema.",
            { cause: parsed.error },
          ),
        );
      }

      return ok(parsed.data);
    },
  };
}
