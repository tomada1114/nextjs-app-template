import "server-only";

import { createFakeLlmPort, createOpenRouterAdapter } from "../ai/index";
import { readServerEnv } from "./env";
import { createAskHandler } from "./handlers/ask";
import { failure } from "./http";

/**
 * Whether the adapter this file wires bills a provider for every answer.
 *
 * @remarks
 * This, and never which credentials the environment happens to contain, is
 * what closes `POST /api/ask`: `readServerEnv` requires `API_ACCESS_KEY` and
 * `OPENROUTER_API_KEY` while it is `true`, so a deployment that pays for its
 * answers cannot serve the endpoint open, or without the key it pays with.
 * `LLM_ADAPTER=fake` is the one setting meant to lift both, because it replaces
 * the billed adapter rather than merely omitting its credential. `NEXT_PHASE`
 * lifts them too, during `next build` only — which is why {@link askHandler}
 * checks the access key again rather than trusting the read.
 *
 * It sits above the environment read because the read has to happen before an
 * adapter can be handed a credential. Wiring a different provider below is the
 * other half of any edit to it: an adapter changed without reconsidering it is
 * either a paid model call left open, or a free one locked for no reason.
 */
const ADAPTER_BILLS_A_PROVIDER = true;

// Read once, at module load, so a malformed or incomplete environment fails
// the module itself, naming the variable, rather than surfacing later as a
// puzzling model error. `next start` evaluates every route module as it starts
// (`experimental.preloadEntriesOnStart`, on by default) but swallows a failure
// there, so the server still comes up and every request to `POST /api/ask`
// rethrows the cached error: a 500, with the ZodError in the log. `next build`
// evaluates this module too, and `readServerEnv` defers the billed rule during
// that phase only.
const env = readServerEnv({ billsAProvider: ADAPTER_BILLS_A_PROVIDER });

/**
 * The one place in this repository that decides which vendor answers.
 *
 * @remarks
 * OpenRouter by default, with `LLM_MODEL` choosing the model when it is set.
 * `LLM_ADAPTER=fake` is the only alternative, and it has to be asked for by
 * name: the smoke test and a keyless local run need a path that cannot bill,
 * and an explicit value cannot bill by accident, where one inferred from a
 * missing key would turn a lost secret into a server quietly answering with
 * canned text. No other runtime choice exists, so this file still answers
 * "which vendor does this application call" on its own.
 */
const llm =
  env.LLM_ADAPTER === "fake"
    ? createFakeLlmPort({
        response: {
          answer:
            "This answer comes from the fake LLM adapter because LLM_ADAPTER=fake is set, so nothing was billed. Unset it and set OPENROUTER_API_KEY to reach a real model.",
        },
      })
    : createOpenRouterAdapter({
        apiKey: env.OPENROUTER_API_KEY,
        ...(env.LLM_MODEL === undefined ? {} : { model: env.LLM_MODEL }),
      });

/** Whether the billed adapter is what answers, with no access key to guard it. */
function servesABilledAdapterOpen(billsAProvider: boolean): boolean {
  return (
    billsAProvider && env.LLM_ADAPTER !== "fake" && env.API_ACCESS_KEY === undefined
  );
}

/**
 * The handler `src/app/api/ask/route.ts` publishes as its `POST` export.
 *
 * @remarks
 * `accessKey` may be `undefined` only under `LLM_ADAPTER=fake`, where nothing
 * is billed and so nothing needs protecting. `readServerEnv` refuses it beside
 * the billed adapter, except while `NEXT_PHASE` names the production build — a
 * variable a misbuilt image can carry into the server it runs. So a billed
 * adapter with no access key is checked here too, and answers every request
 * with a 500 before the body is read or the provider reached, rather than ever
 * falling through to an endpoint open to anyone. No request is served during a
 * real build, so this branch costs that phase nothing. `ERR_LLM_AUTH` is the
 * code because its remedy is the same: the operator fixes the configuration.
 */
export const askHandler: (request: Request) => Promise<Response> =
  servesABilledAdapterOpen(ADAPTER_BILLS_A_PROVIDER)
    ? () =>
        Promise.resolve(
          failure(
            500,
            "ERR_LLM_AUTH",
            "This endpoint is not configured to answer: it bills a provider and has no access key.",
          ),
        )
    : createAskHandler({ llm, accessKey: env.API_ACCESS_KEY });
