import "server-only";

import { createAnthropicAdapter } from "../ai/index";
import { readServerEnv } from "./env";
import { createAskHandler } from "./handlers/ask";

// Read once, at module load, so a malformed environment stops the server as it
// starts rather than showing up as a puzzling failure on some later request.
const env = readServerEnv();

/**
 * The one line in this repository that decides which vendor answers.
 *
 * @remarks
 * A provider adapter is chosen here and nowhere else — no environment variable
 * selects between them at runtime, because that would move the choice out of
 * the file whose whole job is to hold it. Reverting to `createFakeLlmPort` is
 * the same one-line edit in the other direction.
 *
 * The credential is passed in rather than read here, and is allowed to be
 * absent: `src/server/env.ts` is the only module that touches `process.env`,
 * and a missing key surfaces as `ERR_LLM_AUTH` on the request that needed one,
 * so `pnpm dev` still starts with nothing configured.
 */
const llm = createAnthropicAdapter({ apiKey: env.ANTHROPIC_API_KEY });

/** The handler `src/app/api/ask/route.ts` publishes as its `POST` export. */
export const askHandler = createAskHandler({ llm });
