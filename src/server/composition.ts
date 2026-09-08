import "server-only";

import { createFakeLlmPort } from "../ai/index";
import { readServerEnv } from "./env";
import { createAskHandler } from "./handlers/ask";

// Validated for its own sake: nothing below reads a value out of it yet, but a
// malformed environment should stop the server as it starts rather than show
// up as a puzzling failure on some later request.
readServerEnv();

/**
 * The one line in this repository that decides which vendor answers.
 *
 * @remarks
 * The fake adapter is what makes `pnpm dev` work with nothing configured. It
 * is swapped for a provider adapter here and nowhere else — no environment
 * variable selects between them at runtime, because that would move the choice
 * out of the file whose whole job is to hold it.
 */
const llm = createFakeLlmPort({
  response: {
    answer:
      "This answer comes from the fake LLM adapter, so the endpoint works with no API key. Swap the adapter in src/server/composition.ts to reach a real model.",
  },
});

/** The handler `src/app/api/ask/route.ts` publishes as its `POST` export. */
export const askHandler = createAskHandler({ llm });
