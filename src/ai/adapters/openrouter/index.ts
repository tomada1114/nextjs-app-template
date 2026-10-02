import type * as z from "zod";

import { err, type Result } from "../../../core/result";
import { abortedLlmError, asError, LlmError } from "../../errors";
import type { LlmPort, LlmRequest } from "../../port";
import { validateOutput } from "../../validation";
import { requestSignal, resolveDeadlineMs } from "./deadline";
import { providerError, transportError } from "./errors";
import { buildRequestBody, CHAT_COMPLETIONS_URL, readCompletion } from "./request";

/** The model this adapter calls when its caller names none. */
export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";

/** Ceiling on one answer's length, in tokens, when its caller names none. */
export const DEFAULT_MAX_TOKENS = 1024;

/** Everything {@link createOpenRouterAdapter} is configured with. */
export interface OpenRouterAdapterOptions {
  /**
   * The credential.
   *
   * @remarks
   * A required property that may hold `undefined`, so a caller can pass an
   * optional setting straight through. A missing or blank key is reported as
   * `ERR_LLM_AUTH` on every request, with no round trip. In this application
   * that is a backstop rather than the expected path: `src/server/env.ts`
   * refuses to load the composition root without `OPENROUTER_API_KEY` unless
   * `LLM_ADAPTER=fake` replaces this adapter.
   */
  readonly apiKey: string | undefined;

  /** A nonblank model id, trimmed at construction. @see DEFAULT_MODEL */
  readonly model?: string;

  /** A positive safe integer, rejected at construction otherwise. @see DEFAULT_MAX_TOKENS */
  readonly maxTokens?: number;

  /**
   * The whole call's wall-clock bound, `DEFAULT_DEADLINE_MS` when omitted.
   *
   * @remarks Must be an integer in `1..MAX_DEADLINE_MS`; rejected at construction.
   */
  readonly deadlineMs?: number;

  /**
   * Substitutes the HTTP layer — the whole record/replay seam. The global
   * `fetch` is used when omitted, looked up per request.
   */
  readonly fetch?: typeof globalThis.fetch;
}

/** The failure every request reports when no credential was configured. */
function missingKeyError(): LlmError {
  return new LlmError(
    "ERR_LLM_AUTH",
    "No OpenRouter API key is configured. Set OPENROUTER_API_KEY in the environment.",
  );
}

/** `text` as JSON, or `undefined` when it is not JSON at all. */
function parseJson(text: string): { readonly value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * Builds an {@link LlmPort} backed by OpenRouter's chat completions endpoint.
 *
 * @remarks
 * Plain `fetch`, no SDK, one attempt per call. The answer is validated twice:
 * by the provider against the JSON Schema derived from `schema`, and then here
 * against `schema` itself with `safeParseAsync`, because the conversion drops
 * what JSON Schema cannot say — a `refine`, a brand — and the synchronous
 * `safeParse` would throw rather than fail on an async refinement.
 */
export function createOpenRouterAdapter(options: OpenRouterAdapterOptions): LlmPort {
  const model = (options.model ?? DEFAULT_MODEL).trim();
  if (model === "") {
    throw new TypeError("model must be a nonblank OpenRouter model id.");
  }
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new RangeError("maxTokens must be a positive safe integer.");
  }
  const deadlineMs = resolveDeadlineMs(options.deadlineMs);
  const send = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const trimmedKey = options.apiKey?.trim();
  const key = trimmedKey === "" ? undefined : trimmedKey;

  return {
    async generate<TSchema extends z.ZodType>(
      request: LlmRequest<TSchema>,
    ): Promise<Result<z.infer<TSchema>, LlmError>> {
      if (request.signal?.aborted === true) {
        return err(abortedLlmError(request.signal.reason));
      }
      if (key === undefined) {
        return err(missingKeyError());
      }

      // Outside the transport's `try`: a schema JSON Schema cannot express is
      // the caller's to fix, nothing was sent, and it is not worth a retry.
      let body;
      try {
        body = JSON.stringify(buildRequestBody(request, { model, maxTokens }));
      } catch (reason) {
        return err(
          new LlmError(
            "ERR_LLM_INVALID_OUTPUT",
            "The request schema cannot be expressed as JSON Schema, so the model cannot be asked for it.",
            { cause: asError(reason, "The request schema is not convertible.") },
          ),
        );
      }

      // Armed only once the call is certain to be sent.
      const signal = requestSignal(deadlineMs, request.signal);

      let status: number;
      let text: string;
      try {
        const response = await send(CHAT_COMPLETIONS_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
          },
          body,
          signal,
        });
        status = response.status;
        text = await response.text();
      } catch (reason) {
        return err(transportError(reason, signal));
      }

      if (status < 200 || status > 299) {
        return err(providerError(status, text));
      }

      const decoded = parseJson(text);
      const completion = readCompletion(decoded?.value);
      switch (completion.kind) {
        case "malformed":
          return err(
            new LlmError(
              "ERR_LLM_UNAVAILABLE",
              "The LLM provider answered with a body that is not a chat completion.",
            ),
          );
        case "error":
          return err(providerError(completion.status, text));
        case "empty":
          return err(
            new LlmError(
              "ERR_LLM_INVALID_OUTPUT",
              `The model's answer carried no content to parse (finish_reason: ${completion.finishReason}).`,
            ),
          );
        case "text":
          if (
            completion.finishReason === "length" ||
            completion.finishReason === "content_filter"
          ) {
            return err(
              new LlmError(
                "ERR_LLM_INVALID_OUTPUT",
                `The model did not complete its answer (finish_reason: ${completion.finishReason}).`,
              ),
            );
          }
          break;
      }

      // `finish_reason` is what tells a truncated answer (`length`, fixed by a
      // larger `maxTokens`) from a malformed one (fixed by re-prompting).
      const answer = parseJson(completion.text);
      if (answer === undefined) {
        return err(
          new LlmError(
            "ERR_LLM_INVALID_OUTPUT",
            `The model's answer was not valid JSON (finish_reason: ${completion.finishReason}).`,
          ),
        );
      }

      return validateOutput(request.schema, answer.value, signal);
    },
  };
}
