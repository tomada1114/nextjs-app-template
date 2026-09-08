import type * as z from "zod";

import type { Result } from "../core/result";
import type { LlmError } from "./errors";

/**
 * One structured-output request to a language model.
 *
 * @remarks
 * `schema` is what makes the call structured: the adapter asks the model for
 * data shaped like it and validates the answer against it, so a caller never
 * parses prose. `outputLanguage` is a BCP 47 tag naming the language the model
 * should write its *content* in — it does not change the shape `schema`
 * describes.
 *
 * Nothing here names a provider, a model id, or a token budget. Those are an
 * adapter's own construction-time configuration, not part of a request, which
 * is what lets the same request run against a fake, a recording, and a live
 * provider unchanged.
 */
export interface LlmRequest<TSchema extends z.ZodType> {
  /** The shape the model's answer must match. */
  readonly schema: TSchema;

  /** The instruction sent to the model. */
  readonly prompt: string;

  /** BCP 47 tag for the language the model writes its content in. */
  readonly outputLanguage: string;

  /**
   * Cancels the request.
   *
   * @remarks
   * This is one half of the deadline; the other is the timeout an adapter
   * configures on its own client. An adapter reports an abort as
   * `ERR_LLM_TIMEOUT` and keeps the signal's `reason` on the error's `cause`.
   */
  readonly signal?: AbortSignal;
}

/**
 * The vendor-neutral seam every language-model call goes through.
 *
 * @remarks
 * An implementation never throws for an expected failure — it resolves to a
 * {@link Result} whose error branch is an {@link LlmError}. That is what makes
 * the contract testable against a fake and a real provider with the same
 * assertions.
 */
export interface LlmPort {
  /**
   * Asks the model for a value matching `request.schema`.
   *
   * @returns The parsed value, or the {@link LlmError} describing why there is
   * none. The success type is inferred from the schema, so a caller never
   * restates it.
   */
  generate<TSchema extends z.ZodType>(
    request: LlmRequest<TSchema>,
  ): Promise<Result<z.infer<TSchema>, LlmError>>;
}
