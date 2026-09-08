import "server-only";

import { createFakeLlmPort } from "../ai/index";
import { readServerEnv } from "./env";
import { createAskHandler } from "./handlers/ask";

// Read once, at module load, so a malformed environment stops the server as it
// starts rather than showing up as a puzzling failure on some later request.
// That is also what closes the endpoint: the schema requires `API_ACCESS_KEY`
// as soon as a provider credential is configured, so the day this file is
// edited back to a provider adapter, an unprotected deployment fails here
// instead of answering.
const env = readServerEnv();

/**
 * The one line in this repository that decides which vendor answers.
 *
 * @remarks
 * The fake adapter is what makes `pnpm dev` and `POST /api/ask` work with
 * nothing configured. A provider adapter is swapped in here and nowhere else
 * — no environment variable selects between them at runtime, because that
 * would move the choice out of the file whose whole job is to hold it. Wiring
 * `createAnthropicAdapter({ apiKey: env.ANTHROPIC_API_KEY })` instead is the
 * same one-line edit in the other direction.
 */
const llm = createFakeLlmPort({
  response: {
    answer:
      "This answer comes from the fake LLM adapter, so the endpoint works with no API key. Swap the adapter in src/server/composition.ts to reach a real model.",
  },
});

/**
 * The handler `src/app/api/ask/route.ts` publishes as its `POST` export.
 *
 * @remarks
 * `accessKey` is `undefined` in the zero-credential quick start, which is what
 * lets `pnpm dev` answer with nothing configured; it cannot be `undefined`
 * alongside a provider credential, because `readServerEnv` above refuses that
 * combination.
 */
export const askHandler = createAskHandler({ llm, accessKey: env.API_ACCESS_KEY });
