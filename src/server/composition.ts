import "server-only";

import { createFakeLlmPort } from "../ai/index";
import { readServerEnv } from "./env";
import { createAskHandler } from "./handlers/ask";

/**
 * Whether the adapter this file wires bills a provider for every answer.
 *
 * @remarks
 * This, and never what the environment happens to contain, is what closes
 * `POST /api/ask`: `readServerEnv` requires `API_ACCESS_KEY` while it is
 * `true`, so a deployment that pays for its answers cannot boot with the
 * endpoint open. A machine that exports `ANTHROPIC_API_KEY` for an unrelated
 * reason still bills nothing while the fake adapter answers, which is why the
 * gate cannot be keyed off that variable's presence.
 *
 * It sits above the environment read because the read has to happen before an
 * adapter can be handed a credential. Flipping it is the other half of the
 * adapter swap below: an adapter changed without it is a paid model call left
 * open to whoever finds the URL.
 */
const ADAPTER_BILLS_A_PROVIDER = false;

// Read once, at module load, so a malformed environment stops the server as it
// starts rather than showing up as a puzzling failure on some later request.
// That is also what closes the endpoint: with a billed adapter the schema
// requires `API_ACCESS_KEY`, so the day this file is edited to a provider
// adapter, an unprotected deployment fails here instead of answering.
const env = readServerEnv({ requiresAccessKey: ADAPTER_BILLS_A_PROVIDER });

/**
 * The one line in this repository that decides which vendor answers.
 *
 * @remarks
 * The fake adapter is what makes `pnpm dev` and `POST /api/ask` work with
 * nothing configured. A provider adapter is swapped in here and nowhere else
 * — no environment variable selects between them at runtime, because that
 * would move the choice out of the file whose whole job is to hold it. Wiring
 * `createAnthropicAdapter({ apiKey: env.ANTHROPIC_API_KEY })` instead is the
 * same one-line edit in the other direction, with
 * {@link ADAPTER_BILLS_A_PROVIDER} set to `true` in the same commit.
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
 * alongside a billed adapter, because `readServerEnv` above refuses that
 * combination.
 */
export const askHandler = createAskHandler({ llm, accessKey: env.API_ACCESS_KEY });
