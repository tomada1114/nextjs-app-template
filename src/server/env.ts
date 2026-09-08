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
const serverEnvSchema = z.object({
  /**
   * Credential for the Anthropic adapter.
   *
   * @remarks
   * Optional on purpose, and still optional now that
   * `src/server/composition.ts` wires the Anthropic adapter rather than the
   * fake. The template's promise is that `pnpm dev` answers a request with
   * nothing configured, and what keeps that true is the adapter itself: it
   * takes the credential as `string | undefined` and reports a missing or
   * rejected key as the port's `ERR_LLM_AUTH` on the request that needed it —
   * a failure a caller can see and act on, which a server that refuses to boot
   * is not.
   */
  ANTHROPIC_API_KEY: optionalSetting,
});

/** The validated environment, as the rest of `src/server/` sees it. */
export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Every name {@link serverEnvSchema} declares, for the `.env.example` check. */
export const SERVER_ENV_NAMES: readonly string[] = Object.keys(serverEnvSchema.shape);

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
 * @throws A `ZodError` naming every variable that did not match its shape.
 */
export function readServerEnv(): ServerEnv {
  return serverEnvSchema.parse(process.env);
}
