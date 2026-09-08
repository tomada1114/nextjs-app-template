import "server-only";

import { createFakeLlmPort } from "../ai/index";
import { readServerEnv } from "./env";
import { createAskHandler } from "./handlers/ask";

// Read once, at module load, so a malformed environment stops the server as it
// starts rather than showing up as a puzzling failure on some later request.
// Nothing below reads a value out of it: the fake adapter needs no credential,
// and `ANTHROPIC_API_KEY` stays validated for the day this file is edited back
// to a provider adapter.
readServerEnv();

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

/** The handler `src/app/api/ask/route.ts` publishes as its `POST` export. */
export const askHandler = createAskHandler({ llm });
