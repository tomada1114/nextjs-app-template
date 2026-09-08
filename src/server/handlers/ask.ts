import * as z from "zod";

import type { LlmErrorCode, LlmPort } from "../../ai/index";

/**
 * What the handler needs from the outside world.
 *
 * @remarks
 * Everything crossing this boundary is an interface, never a concrete adapter:
 * that is what lets a test drive the handler with a fake and lets
 * `src/server/composition.ts` — and only it — decide which vendor is behind
 * the port.
 */
export interface AskHandlerDependencies {
  /** The model this endpoint asks. */
  readonly llm: LlmPort;
}

/** The JSON body `POST /api/ask` accepts. */
const askRequestSchema = z.object({
  /** The question put to the model. */
  prompt: z.string().min(1),

  /** BCP 47 tag for the language the answer is written in. */
  outputLanguage: z.string().min(1).default("en"),
});

/** The JSON body `POST /api/ask` answers with, and the shape asked of the model. */
const askAnswerSchema = z.object({
  answer: z.string(),
});

/**
 * The HTTP status each port failure is reported as.
 *
 * @remarks
 * `satisfies` rather than an annotation: it keeps the literal keys, so adding a
 * member to `LlmErrorCode` fails this object to compile instead of silently
 * falling through to a default status. `ERR_LLM_AUTH` maps to 500 on purpose —
 * the credential that failed is the server's, so the caller did nothing wrong
 * and has nothing to fix by retrying with different input.
 */
const STATUS_BY_LLM_CODE = {
  ERR_LLM_AUTH: 500,
  ERR_LLM_RATE_LIMIT: 429,
  ERR_LLM_TIMEOUT: 504,
  ERR_LLM_INVALID_OUTPUT: 502,
  ERR_LLM_UNAVAILABLE: 503,
} as const satisfies Record<LlmErrorCode, number>;

/**
 * The failure body every non-2xx answer carries.
 *
 * @remarks
 * `code` is the contract a client branches on; `message` is prose and may be
 * reworded. Nothing from the provider's own error text reaches the response —
 * it can carry request content back to whoever asked.
 */
function failure(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * Builds the `POST /api/ask` handler over the port it is given.
 *
 * @remarks
 * Web standards only: a `Request` in, a `Response` out, and no import from
 * `next`. That is what makes it testable with a plain `new Request(...)` — and
 * what keeps the Route Handler under `src/app/` a re-export with no logic of
 * its own to test separately.
 *
 * @returns The handler `src/app/api/ask/route.ts` exports as `POST`.
 */
export function createAskHandler(
  dependencies: AskHandlerDependencies,
): (request: Request) => Promise<Response> {
  const { llm } = dependencies;

  return async function handleAsk(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return failure(400, "ERR_BAD_REQUEST", "The request body is not valid JSON.");
    }

    const parsed = askRequestSchema.safeParse(body);
    if (!parsed.success) {
      return failure(
        400,
        "ERR_BAD_REQUEST",
        "The request body must be an object with a non-empty `prompt`.",
      );
    }

    const result = await llm.generate({
      schema: askAnswerSchema,
      prompt: parsed.data.prompt,
      outputLanguage: parsed.data.outputLanguage,
      // A client that hangs up aborts this signal, which the port forwards to
      // the provider instead of paying for an answer nobody will read.
      signal: request.signal,
    });

    if (!result.ok) {
      return failure(
        STATUS_BY_LLM_CODE[result.error.code],
        result.error.code,
        "The language model could not answer this request.",
      );
    }

    return Response.json(result.value, { status: 200 });
  };
}
