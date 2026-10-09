// Shared containment checks for build and shipping holding cleanup.
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Raised by {@link canonicalize} when a path component fails to resolve for a
 * reason other than not existing, so containment cannot be judged safely.
 */
export class UnresolvablePathError extends Error {
  /**
   * @param {string} at - The path component `realpathSync` failed on.
   * @param {unknown} cause - The underlying `realpathSync` failure.
   */
  constructor(at, cause) {
    super(`could not resolve ${at}`, { cause });
    this.name = "UnresolvablePathError";
    /** @readonly @type {"ERR_CLEAN_UNRESOLVABLE"} */
    this.code = "ERR_CLEAN_UNRESOLVABLE";
    /** The path component that could not be resolved. */
    this.at = at;
  }
}

/**
 * Read a Node.js errno `code` off an unknown failure, if it has one.
 *
 * @param {unknown} error - A value caught from a filesystem call.
 * @returns {string | undefined} The `code`, when `error` carries a string one.
 */
export function errnoCode(error) {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/**
 * Canonicalize a path that need not exist yet.
 *
 * @remarks
 * `realpathSync` fails on a path that is not there, and `clean` is routinely
 * pointed at targets that are already gone — that is what `force: true` is
 * for — so a plain `realpathSync` would refuse the ordinary case. This walks
 * up to the nearest ancestor that does resolve and rejoins the rest by name.
 * A component that genuinely does not exist (`ENOENT`) or that turned out
 * not to be a directory partway through resolving a longer path (`ENOTDIR`)
 * is one the filesystem has nothing behind, so rejoining it lexically cannot
 * hide a symlink: every component that exists is already canonical in the
 * result. Any other failure — most importantly `EACCES`/`EPERM` from an
 * ancestor directory the process cannot search — means the walk cannot tell
 * whether that component is a symlink or not, so it fails closed instead of
 * rejoining lexically and risking exactly the escape this check exists to
 * catch.
 *
 * @param {string} target - Path to canonicalize; may be absent.
 * @returns {string} The canonical path, with any unresolvable suffix appended.
 * @throws {UnresolvablePathError} When a component fails to resolve for a
 * reason other than not existing.
 */
export function canonicalize(target) {
  /** @type {string[]} */
  const suffix = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(realpathSync(current), ...suffix);
    } catch (error) {
      const code = errnoCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new UnresolvablePathError(current, error);
      }
      // A dangling symlink exists even though realpath reports ENOENT.
      // Follow its destination before rejoining any missing suffix, or an
      // escaping link would be mistaken for an absent path inside the root.
      try {
        if (lstatSync(current).isSymbolicLink()) {
          const destination = path.resolve(
            path.dirname(current),
            readlinkSync(current),
          );
          return path.join(canonicalize(destination), ...suffix);
        }
      } catch (linkError) {
        const linkCode = errnoCode(linkError);
        if (linkCode !== "ENOENT" && linkCode !== "ENOTDIR") {
          throw new UnresolvablePathError(current, linkError);
        }
      }
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without resolving anything.
        return path.resolve(target);
      }
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Report whether a path lies outside a directory, or is that directory.
 *
 * @param {string} directory - Absolute path the target must sit inside.
 * @param {string} target - Absolute path to judge.
 * @returns {boolean} True when `target` escapes `directory`.
 */
export function escapes(directory, target) {
  const relative = path.relative(directory, target);
  return relative === "" || relative.startsWith("..") || path.isAbsolute(relative);
}
