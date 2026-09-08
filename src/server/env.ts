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
 */
const optionalSetting = z
  .string()
  .transform((raw) => (raw.trim() === "" ? undefined : raw))
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
   * Supplying it does oblige {@link serverEnvShape.API_ACCESS_KEY}; see the
   * rule below for why.
   */
  ANTHROPIC_API_KEY: optionalSetting,

  /**
   * The shared secret a caller of `POST /api/ask` must present.
   *
   * @remarks
   * Optional on its own — the zero-credential quick start answers from the
   * fake adapter and has nothing to protect — but required as soon as any
   * name in {@link PROVIDER_CREDENTIAL_NAMES} is configured.
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

/**
 * Every variable that is a billed provider credential.
 *
 * @remarks
 * The rule below keys off this list rather than off one variable name, so a
 * second provider joins it by construction: adding the name here is what makes
 * the gate apply, and no other file has to be remembered. It is a list rather
 * than a predicate over the schema because "this name is billed" is not
 * something a `z.string()` can be asked.
 *
 * Removing the AI layer whole takes `ANTHROPIC_API_KEY` out of the schema and
 * out of this list, leaving it empty — at which point nothing is billed, so
 * nothing is required, which is the right answer rather than a rule left
 * pointing at a name that no longer exists.
 */
const PROVIDER_CREDENTIAL_NAMES = [
  "ANTHROPIC_API_KEY",
] as const satisfies readonly (keyof ServerEnv)[];

/**
 * The shape, plus the one rule that spans two of its fields.
 *
 * @remarks
 * `POST /api/ask` reaches a paid model call with nothing in front of it: no
 * middleware (`src/proxy.ts`'s matcher excludes `api` outright) and no check
 * in the handler beyond body validation. So the moment a real credential is
 * configured, an open endpoint spends money for anyone who finds it. Making
 * that combination fail validation is what turns "remember to protect it" into
 * something impossible to forget: `readServerEnv` throws, and the server stops
 * as it starts rather than serving one request unprotected.
 */
const serverEnvSchema = serverEnvShape.superRefine((env, ctx) => {
  const configured = PROVIDER_CREDENTIAL_NAMES.filter(
    (name) => env[name] !== undefined,
  );
  if (configured.length === 0 || env.API_ACCESS_KEY !== undefined) {
    return;
  }
  ctx.addIssue({
    code: "custom",
    path: ["API_ACCESS_KEY"],
    // Names, never values: this message reaches a log and a crash report.
    message: `API_ACCESS_KEY is required because a provider credential is configured (${configured.join(", ")}). POST /api/ask reaches a billed model call with no authentication of its own, so it must not be left open.`,
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
 * @returns The validated environment.
 * @throws A `ZodError` naming every variable that did not match its shape, or
 * the missing `API_ACCESS_KEY` a configured provider credential obliges.
 */
export function readServerEnv(): ServerEnv {
  return serverEnvSchema.parse(process.env);
}
