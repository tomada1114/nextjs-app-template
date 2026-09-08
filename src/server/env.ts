import "server-only";

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
 * The value is trimmed rather than kept as written, because every name here is
 * a credential and surrounding whitespace is never part of one. A secret pasted
 * out of a manager with a trailing newline would otherwise be a key no caller
 * can present in a matching form: `src/server/handlers/ask.ts` compares against
 * a bearer token that cannot carry leading or trailing whitespace, so an
 * untrimmed `API_ACCESS_KEY` would answer 401 to every request, including one
 * sending the exact configured value.
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
   * Credential for the Anthropic adapter.
   *
   * @remarks
   * Optional because `src/server/composition.ts` wires the fake adapter by
   * default, which needs no credential at all — that is what keeps the
   * template's promise that `pnpm dev` answers a request with nothing
   * configured. The key stays in this schema because the Anthropic adapter is
   * still shipped and still one line away in `src/server/composition.ts`: a
   * deployment that switches to it supplies this variable, and the adapter
   * reports a missing or rejected key as the port's `ERR_LLM_AUTH` on the
   * request that needed it — a failure a caller can see and act on, which a
   * server that refuses to boot is not.
   *
   * Its mere presence obliges nothing. A machine can have this exported for
   * something else entirely — the fixture recording flow in
   * `tests/ai-port.test.ts` needs it — while this application still answers
   * from the fake adapter and bills no one. What obliges
   * {@link serverEnvShape.API_ACCESS_KEY} is which adapter is wired, not which
   * variables happen to be set; see {@link ServerEnvRequirements}.
   */
  ANTHROPIC_API_KEY: optionalSetting,

  /**
   * The shared secret a caller of `POST /api/ask` must present.
   *
   * @remarks
   * Optional on its own — the zero-credential quick start answers from the
   * fake adapter and has nothing to protect — but required as soon as
   * `src/server/composition.ts` wires an adapter that bills a provider, which
   * it says by passing {@link ServerEnvRequirements.requiresAccessKey}.
   *
   * `src/server/composition.ts` hands the value to the handler, which
   * compares it against the caller's `Authorization: Bearer` credential. It
   * is authentication and nothing more: this template ships no rate limit and
   * no concurrency limit, so a holder of this key can still spend without
   * bound.
   */
  API_ACCESS_KEY: optionalSetting,
});

/** The validated environment, as the rest of `src/server/` sees it. */
export type ServerEnv = z.infer<typeof serverEnvShape>;

/** What the composition root has to tell {@link readServerEnv} about itself. */
export interface ServerEnvRequirements {
  /**
   * Whether the adapter the composition root wires bills a provider per answer.
   *
   * @remarks
   * `POST /api/ask` reaches the model call with nothing in front of it: no
   * middleware (`src/proxy.ts`'s matcher excludes `api` outright) and no check
   * in the handler beyond body validation. So an endpoint that costs money to
   * answer must not also be open, and `true` here is what makes that
   * impossible to forget — `readServerEnv` throws, and the server stops as it
   * starts rather than serving one request unprotected.
   *
   * It is the adapter that decides this, never the environment. Keying the
   * rule off whether a provider credential is *present* would refuse to start
   * on any machine that exports one for an unrelated reason, while the fake
   * adapter — which bills nothing — is what actually answers.
   */
  readonly requiresAccessKey: boolean;
}

/** The shape, plus the one rule that spans two of its fields. */
const billedServerEnvSchema = serverEnvShape.superRefine((env, ctx) => {
  if (env.API_ACCESS_KEY !== undefined) {
    return;
  }
  ctx.addIssue({
    code: "custom",
    path: ["API_ACCESS_KEY"],
    // Names, never values: this message reaches a log and a crash report.
    message:
      "API_ACCESS_KEY is required because src/server/composition.ts wires an adapter that bills a provider for every answer. POST /api/ask reaches that model call with no authentication of its own, so it must not be left open.",
  });
});

/** Every name {@link serverEnvShape} declares, for the `.env.example` check. */
export const SERVER_ENV_NAMES: readonly string[] = Object.keys(serverEnvShape.shape);

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
 * the missing `API_ACCESS_KEY` a billed adapter obliges.
 */
export function readServerEnv(requirements: ServerEnvRequirements): ServerEnv {
  const schema = requirements.requiresAccessKey
    ? billedServerEnvSchema
    : serverEnvShape;
  return schema.parse(process.env);
}
