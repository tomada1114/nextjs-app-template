import type {
  ContentBlock,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type * as z from "zod";

import type { LlmRequest } from "../../port";

/** Construction-time configuration a request needs but does not carry. */
export interface RequestShape {
  /** The provider's model id. */
  readonly model: string;

  /** Ceiling on the answer's length, in tokens. */
  readonly maxTokens: number;
}

/**
 * Builds the provider call for one {@link LlmRequest}.
 *
 * @remarks
 * `output_config.format` is where `schema` becomes a wire-level constraint
 * rather than a hopeful instruction: {@link zodOutputFormat} converts it to the
 * JSON Schema the API validates the model's answer against. A refinement has no
 * JSON Schema equivalent and is dropped in that conversion — which is precisely
 * why the answer is still validated against the caller's real schema after it
 * arrives, in `index.ts`, rather than being trusted because the API accepted it.
 *
 * `outputLanguage` is a system instruction, not part of the schema: it decides
 * the language the model writes its *content* in and must not change the shape
 * `format` describes.
 */
export function buildCreateParams<TSchema extends z.ZodType>(
  request: LlmRequest<TSchema>,
  shape: RequestShape,
): MessageCreateParamsNonStreaming {
  return {
    model: shape.model,
    max_tokens: shape.maxTokens,
    system: `Write every value of your answer in the language identified by the BCP 47 tag ${request.outputLanguage}.`,
    messages: [{ role: "user", content: request.prompt }],
    output_config: { format: zodOutputFormat(request.schema) },
  };
}

/**
 * The JSON the model produced, or `undefined` when the answer carried none.
 *
 * @remarks
 * A structured-output response puts the JSON in a text block, but the block
 * list is not guaranteed to hold one — a refusal or a `max_tokens` stop can end
 * a turn with no text at all. Returning `undefined` rather than throwing keeps
 * that case on the port's error branch, where every other expected failure is.
 */
export function firstTextBlock(content: readonly ContentBlock[]): string | undefined {
  for (const block of content) {
    if (block.type === "text") {
      return block.text;
    }
  }
  return undefined;
}
