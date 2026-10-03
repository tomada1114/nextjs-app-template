import type * as z from "zod";

import { err, ok, type Result } from "../core/result";
import { abortedLlmError, LlmError } from "./errors";

/** Validates output without making cancellation wait for an async refinement. */
export async function validateOutput<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  signal: AbortSignal | undefined,
): Promise<Result<z.infer<TSchema>, LlmError>> {
  if (signal?.aborted === true) {
    return err(abortedLlmError(signal.reason));
  }

  async function parse(): Promise<Result<z.infer<TSchema>, LlmError>> {
    const parsed = await schema.safeParseAsync(value);
    if (signal?.aborted === true) {
      return err(abortedLlmError(signal.reason));
    }
    return parsed.success
      ? ok(parsed.data)
      : err(
          new LlmError(
            "ERR_LLM_INVALID_OUTPUT",
            "The model output did not match the requested schema.",
            { cause: parsed.error },
          ),
        );
  }

  if (signal === undefined) {
    return parse();
  }

  let onAbort: () => void = () => undefined;
  const cancelled = new Promise<Result<never, LlmError>>((resolve) => {
    onAbort = () => {
      resolve(err(abortedLlmError(signal.reason)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // The transport already receives this signal. Zod cannot cancel a refinement;
    // racing its promise also consumes any rejection that arrives after the abort.
    return await Promise.race([parse(), cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
