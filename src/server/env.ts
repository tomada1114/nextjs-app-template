import "server-only";

import { PHASE_PRODUCTION_BUILD } from "next/constants";
import * as z from "zod";

/**
 * A variable that may be absent, where a blank value means the same as absent.
 *
 * @remarks
 * `.env.example` ships every name with an empty value, so copying it to `.env`
 * — the first thing anyone does with this template — leaves `KEY=` in the
 * environment. Node reports that as `""`, not as a missing key, and treating
 * the two differently would make a copied example file a configuration error.
 *
 * The value is trimmed rather than kept as written, because surrounding
 * whitespace is never part of any value here. A secret pasted out of a manager
 * with a trailing newline would otherwise be a key no caller can present in a
 * matching form: `src/server/handlers/ask.ts` compares against a bearer token
 * that cannot carry leading or trailing whitespace, so an untrimmed
 * `API_ACCESS_KEY` would answer 401 to every request, including one sending the
 * exact configured value.
 */
const optionalSetting = z
  .string()
  .transform((raw) => {
    const value = raw.trim();
    return value === "" ? undefined : value;
  })
  .optional();

/**
 * Every environment variable this application reads.
 *
 * @remarks
 * Adding a name here obliges a matching line in `.env.example`;
 * `tests/server-env.test.ts` asserts that correspondence rather than trusting
 * it.
 */
const serverEnvShape = z.object({
  /**
   * Credential for the OpenRouter adapter `src/server/composition.ts` wires.
   *
   * @remarks
   * Optional in the shape, required by the rule below: the composition root
   * refuses to load without it unless {@link serverEnvShape.LLM_ADAPTER}
   * replaces the provider with the fake. A missing key is a deployment mistake,
   * and failing the module that needs it names the variable, where a
   * constructed adapter would answer every request with `ERR_LLM_AUTH`.
   */
  OPENROUTER_API_KEY: optionalSetting,

  /**
   * The OpenRouter model id every answer is asked of, `vendor/model`.
   *
   * @remarks
   * Unset, the adapter's own default answers. Not validated beyond being
   * non-blank: OpenRouter's catalogue is the authority on which ids exist, and
   * an unknown one comes back from it as a failed request. Nothing else about
   * the model is configurable here, by decision.
   */
  LLM_MODEL: optionalSetting,

  /**
   * An explicit opt-in to the fake adapter, whose only accepted value is
   * `fake`.
   *
   * @remarks
   * With it set, the fake answers, no credential is required, and nothing is
   * billed — the path the smoke test and a keyless local run take. It is never
   * inferred from a missing {@link serverEnvShape.OPENROUTER_API_KEY}: a
   * deployment that lost its key must stop, not quietly start answering with
   * canned text. Any other value is rejected rather than ignored, so a typo
   * cannot fall through to the billed provider either.
   */
  LLM_ADAPTER: optionalSetting.pipe(
    z
      .literal("fake", {
        error:
          "LLM_ADAPTER accepts only `fake`. Leave it unset to answer through the provider adapter src/server/composition.ts wires.",
      })
      .optional(),
  ),

  /**
   * The shared secret a caller of `POST /api/ask` must present.
   *
   * @remarks
   * Required while `src/server/composition.ts` wires an adapter that bills a
   * provider, which it says through {@link ServerEnvRequirements.billsAProvider};
   * optional only when `LLM_ADAPTER=fake` takes that adapter's place and there
   * is nothing to protect.
   *
   * `src/server/composition.ts` hands the value to the handler, which
   * compares it against the caller's `Authorization: Bearer` credential.
   * `API_ACCESS_KEY` is authentication only. This template deliberately ships
   * neither a rate limit nor a concurrency limit; deployments using a billed
   * adapter must apply their deployment-wide caller-throughput policy at an edge
   * or gateway before `POST /api/ask` reaches the app. See
   * `building-app-routes` for that guidance.
   */
  API_ACCESS_KEY: optionalSetting,
});

/** The validated environment, as the rest of `src/server/` sees it. */
export type ServerEnv = z.infer<typeof serverEnvShape>;

/** What the composition root has to tell {@link readServerEnv} about itself. */
export interface ServerEnvRequirements {
  /**
   * Whether the provider adapter the composition root wires bills per answer.
   *
   * @remarks
   * `POST /api/ask` reaches the model call with nothing in front of it: no
   * middleware (`src/proxy.ts`'s matcher excludes `api` outright) and no check
   * in the handler beyond body validation. So an endpoint that costs money to
   * answer must not also be open, and `true` here is what makes that
   * impossible to forget — `readServerEnv` throws without `API_ACCESS_KEY`, and
   * without the provider credential that adapter cannot answer with.
   *
   * It is the wiring that decides this, never which credentials the
   * environment happens to hold. The one environment value that lifts it is
   * `LLM_ADAPTER=fake`, because that one replaces the adapter itself.
   */
  readonly billsAProvider: boolean;
}

/** Names, never values: each message reaches a log and a crash report. */
const REQUIRED_WHILE_BILLED = {
  OPENROUTER_API_KEY:
    "OPENROUTER_API_KEY is required because src/server/composition.ts answers through the OpenRouter adapter. Set it, or set LLM_ADAPTER=fake to answer from the fake adapter with no credential and no bill.",
  API_ACCESS_KEY:
    "API_ACCESS_KEY is required because src/server/composition.ts wires an adapter that bills a provider for every answer. POST /api/ask reaches that model call with no authentication of its own, so it must not be left open.",
} as const;

/** The shape, plus the rule that spans its fields while a provider bills. */
const billedServerEnvSchema = serverEnvShape.superRefine((env, ctx) => {
  if (env.LLM_ADAPTER === "fake") {
    return;
  }
  for (const [name, message] of Object.entries(REQUIRED_WHILE_BILLED)) {
    if (env[name as keyof typeof REQUIRED_WHILE_BILLED] === undefined) {
      ctx.addIssue({ code: "custom", path: [name], message });
    }
  }
});

/** Every name {@link serverEnvShape} declares, for the `.env.example` check. */
export const SERVER_ENV_NAMES: readonly string[] = Object.keys(serverEnvShape.shape);

/**
 * Whether this process is `next build` evaluating route modules.
 *
 * @remarks
 * `next build` imports every route module to collect its segment config, and
 * `src/server/composition.ts` reads the environment at module load — so
 * without this, a build would demand the production credentials and CI, which
 * holds none, could not build at all. Next sets `NEXT_PHASE` for exactly this
 * phase before it spawns the workers that do it, and nothing is served during
 * it, so the shape is still validated there and only the billed rule waits for
 * the server that loads the module to answer a request.
 */
function isProductionBuild(): boolean {
  return process.env["NEXT_PHASE"] === PHASE_PRODUCTION_BUILD;
}

/**
 * Reads and validates `process.env`.
 *
 * @remarks
 * This is the only place in `src/` that touches `process.env`; every other
 * module receives what it needs as an argument. Keeping the read here is what
 * makes "where does this secret enter the process" a question a reader answers
 * by opening one file.
 *
 * It throws rather than returning a `Result`: a malformed environment is a
 * deployment mistake with no caller-side recovery, so failing where it is read
 * is more useful than threading an error through code that cannot act on it.
 *
 * @param requirements - What the composition root's own wiring demands of the
 * environment; see {@link ServerEnvRequirements}.
 * @returns The validated environment.
 * @throws A `ZodError` naming every variable that did not match its shape, or
 * the `OPENROUTER_API_KEY` and `API_ACCESS_KEY` a billed adapter obliges.
 */
export function readServerEnv(requirements: ServerEnvRequirements): ServerEnv {
  const schema =
    requirements.billsAProvider && !isProductionBuild()
      ? billedServerEnvSchema
      : serverEnvShape;
  return schema.parse(process.env);
}
