import * as z from "zod";

import type { LlmRequest } from "../../port";

/** OpenRouter's OpenAI-compatible chat completions endpoint. Not configurable. */
export const CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Construction-time configuration a request needs but does not carry. */
export interface RequestShape {
  /** The OpenRouter model id, `vendor/model`. */
  readonly model: string;

  /** Ceiling on the answer's length, in tokens. */
  readonly maxTokens: number;
}

/**
 * The JSON body of one chat completions call for `request`.
 *
 * @remarks
 * `response_format` is where `schema` becomes a wire-level constraint: the
 * caller's Zod schema is converted with `z.toJSONSchema` and sent with
 * `strict: true`. A refinement has no JSON Schema equivalent and is dropped by
 * that conversion, which is why the answer is validated against the real
 * schema again once it arrives; a construct with no equivalent at all
 * (`transform`, `z.date`) makes the conversion throw instead, so the caller
 * builds this inside a guard of its own. The top-level `$schema` keyword is
 * removed because it describes the document rather than the answer, and a
 * strict-mode provider is not obliged to accept keywords outside its subset.
 *
 * `provider.require_parameters` makes OpenRouter route only to a provider that
 * honours every parameter sent — `response_format` above all — rather than to
 * one that would silently ignore the schema and answer in prose.
 *
 * `outputLanguage` is a system message, not part of the schema: it decides the
 * language the content is written in and must not change its shape.
 */
export function buildRequestBody<TSchema extends z.ZodType>(
  request: LlmRequest<TSchema>,
  shape: RequestShape,
): Record<string, unknown> {
  const schema = Object.fromEntries(
    Object.entries(z.toJSONSchema(request.schema)).filter(
      ([keyword]) => keyword !== "$schema",
    ),
  );
  return {
    model: shape.model,
    max_tokens: shape.maxTokens,
    messages: [
      {
        role: "system",
        content: `Write every value of your answer in the language identified by the BCP 47 tag ${request.outputLanguage}.`,
      },
      { role: "user", content: request.prompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "answer", strict: true, schema },
    },
    provider: { require_parameters: true },
  };
}

/** What a decoded `200` body turned out to hold. */
export type Completion =
  | { readonly kind: "text"; readonly text: string; readonly finishReason: string }
  | { readonly kind: "empty"; readonly finishReason: string }
  | { readonly kind: "error"; readonly status: number | undefined }
  | { readonly kind: "malformed" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FINISH_REASONS: ReadonlySet<unknown> = new Set([
  "stop",
  "length",
  "content_filter",
  "tool_calls",
  "function_call",
  "error",
]);

/**
 * Reads the answer out of a chat completions body.
 *
 * @remarks
 * Narrowed field by field rather than asserted, because a `200` is not a
 * promise of the documented shape. OpenRouter can answer `200` with an
 * `error` object instead of a completion once a request has been accepted
 * upstream, and a provider can end a turn with no content at all — a refusal,
 * or a `length` stop — which is why `finish_reason` travels with every
 * outcome that has one. A body that is none of these is `malformed`.
 */
export function readCompletion(body: unknown): Completion {
  if (!isRecord(body)) {
    return { kind: "malformed" };
  }
  const error = body["error"];
  if (isRecord(error)) {
    const code = error["code"];
    return { kind: "error", status: typeof code === "number" ? code : undefined };
  }
  const choices = body["choices"];
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  if (!isRecord(choice)) {
    return { kind: "malformed" };
  }
  const finish = choice["finish_reason"];
  const finishReason =
    typeof finish === "string" && FINISH_REASONS.has(finish) ? finish : "unknown";
  if (finishReason === "error") {
    return { kind: "error", status: undefined };
  }
  const message = choice["message"];
  const content = isRecord(message) ? message["content"] : undefined;
  return typeof content === "string" && content !== ""
    ? { kind: "text", text: content, finishReason }
    : { kind: "empty", finishReason };
}
