/**
 * The outcome of an operation that fails in ways its caller is expected to
 * handle.
 *
 * @remarks
 * A `Result` is returned, not thrown: the failure is part of the signature, so
 * a caller cannot forget it the way an undocumented `throw` lets them. Narrow
 * it by branching on `ok` — `if (!result.ok) return handle(result.error);` —
 * which discriminates the union and gives the other member's field back typed.
 *
 * Reserve it for expected failures. A bug (a broken invariant, a programming
 * error) still throws, because there is nothing useful for a caller to do with
 * it.
 */
export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/**
 * Wraps a value as the success branch of a {@link Result}.
 *
 * @remarks
 * The error type is `never`, so the returned value is assignable to a
 * `Result<T, E>` for any `E` without the caller restating it.
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Wraps an error as the failure branch of a {@link Result}. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
