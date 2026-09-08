// Path-shaped rules: which files must never be read.
//
// These are the checks that "which path is this" alone decides, independent
// of what a tool call is or what it carries. Used by the pre-commit
// staged-content check (scripts/check-staged.mjs, which sees a git diff).
// Lockfile hand-editing is not a path-shaped rule here: a re-generated
// lockfile (`pnpm install`) is normal to commit, and a git diff cannot tell
// that apart from a hand edit. Only a layer that sees the tool call that
// produced the change could tell them apart, and this repository does not
// enforce one — see AGENTS.md's "Enforcement layers".

/** Suffixes that mark a committed, secret-free sample of a `.env` file. */
export const ENV_EXAMPLE_SUFFIXES = [".example", ".sample", ".template"];

/**
 * Normalize a path the way the rules below expect to see it.
 *
 * @param {string} filePath - Path as it appeared in the tool call.
 * @returns {{ posix: string, name: string, parts: string[] }} Slash-separated
 * path, its basename, and its segments.
 */
export function describePath(filePath) {
  const posix = filePath.replace(/\\/g, "/");
  const parts = posix.split("/").filter((part) => part !== "" && part !== ".");
  return { posix, name: parts.at(-1) ?? "", parts };
}

/**
 * Report whether a `.env` file is a committed example rather than a real one.
 *
 * @param {string} name - Basename of the file.
 * @returns {boolean} True when the file is a sample and holds no secrets.
 */
export function isEnvExample(name) {
  return ENV_EXAMPLE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Report whether a basename is an environment file that can hold real values.
 *
 * @remarks
 * `.envrc` is direnv's file rather than dotenv's, so neither the `.env` name
 * nor the `.env.` prefix reaches it — yet it holds the same kind of content,
 * and AGENTS.md writes the prohibition as `.env*`, which covers it. The
 * `.envrc.` prefix carries more risk than the bare name: direnv convention
 * keeps boilerplate in `.envrc` and the real values in `.envrc.local` or
 * `.envrc.private`.
 *
 * `checkRead` is not only the agent-read rule — scripts/check-staged.mjs
 * reuses it as a hard pre-commit block, with no per-path exemption. A bare
 * `.envrc` is therefore uncommittable here, and a direnv project built from
 * this template is expected to keep its `.envrc` untracked.
 *
 * @param {string} name - Basename of the file.
 * @returns {boolean} True when the file is an environment file, example or not.
 */
export function isDotenvName(name) {
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === ".envrc" ||
    name.startsWith(".envrc.")
  );
}

/**
 * Trailing segments that identify the one personal Claude Code file
 * `.gitignore` names by exact path: `.claude/settings.local.json`.
 *
 * @remarks
 * Matched by trailing segments rather than requiring these to be the whole
 * path, the same way {@link isDotenvName} matches a basename and the
 * `secrets/` rule matches any ancestor segment — because `checkRead` guards
 * an agent's Read call, which arrives as an absolute path, not the
 * repository-root-relative spelling `.gitignore` itself uses. A
 * `.claude/settings.local.json` nested under some other directory, or
 * reached through a `../` spelling, is the same personal, token-bearing file
 * AGENTS.md and CLAUDE.md describe, so blocking it there too is intended, not
 * a false positive. `.claude/worktrees/` is the file's gitignored sibling for
 * full checkouts left behind by an agent session; those are already kept out
 * of a whole-tree walk by `SKIPPED_DIRECTORIES` naming `worktrees`, so no
 * matching rule for it belongs here.
 */
const CLAUDE_LOCAL_SETTINGS_PARTS = [".claude", "settings.local.json"];

/**
 * Report whether a path's final segments are the personal Claude settings file.
 *
 * @param {string[]} parts - Segments from {@link describePath}.
 * @returns {boolean} True when the path ends in `.claude/settings.local.json`,
 * at the repository root, nested deeper, or reached by an absolute path.
 */
function isClaudeLocalSettingsPath(parts) {
  const tail = parts.slice(-CLAUDE_LOCAL_SETTINGS_PARTS.length);
  return (
    tail.length === CLAUDE_LOCAL_SETTINGS_PARTS.length &&
    tail.every((part, index) => part === CLAUDE_LOCAL_SETTINGS_PARTS[index])
  );
}

/**
 * Return a block reason when a file must not be read.
 *
 * @param {string} filePath - Path the call targets.
 * @returns {string | null} The reason, or null when the read is fine.
 */
export function checkRead(filePath) {
  if (filePath === "") {
    return null;
  }
  const { name, parts } = describePath(filePath);
  if (isDotenvName(name) && !isEnvExample(name)) {
    return "Files named .env* may hold secrets and must not be read by the agent — read the matching .env.example instead.";
  }
  if (parts.slice(0, -1).includes("secrets")) {
    return "Files under secrets/ hold credentials and must not be read by the agent.";
  }
  if (isClaudeLocalSettingsPath(parts)) {
    return "`.claude/settings.local.json` is a developer's personal, gitignored settings file, which can hold real tokens, and must not be read by the agent.";
  }
  return null;
}
