// Secret-shaped content: text that must never land in a tracked file.
//
// Read by the pre-commit staged-content check (`scripts/check-staged.mjs`),
// which scans a staged file's content before it can reach a commit.

/**
 * Secret shapes that must never be written into a tracked file.
 *
 * @remarks
 * Each pattern is written so that its own source text does not match it, which
 * is what lets this file be staged without the check refusing its own rules.
 * The generic password rule below the array is held to the same standard.
 *
 * The AWS secret access key entry is deliberately anchored to an
 * `aws_secret_access_key`-shaped assignment rather than matching a bare
 * 40-character base64 run: the unanchored shape alone matches dozens of
 * unrelated 40-character substrings inside this repository's own
 * `pnpm-lock.yaml` (base64 package integrity hashes happen to contain runs of
 * that length and character set), which would block an ordinary dependency
 * update. Anchoring to the assignment context is also what gitleaks' own
 * built-in AWS rule does, for the same reason. That entry accepts a hyphen or
 * an underscore between words and either a colon or an equals sign for the
 * assignment, and matches case-insensitively, since an env-style name is
 * conventionally upper snake case and YAML/JSON prefer a colon over an equals
 * sign.
 *
 * @type {{ pattern: RegExp, name: string }[]}
 */
export const CREDENTIAL_PATTERNS = [
  { pattern: /_authToken\s*=\s*\S/, name: "an npm registry auth token" },
  { pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, name: "a private key" },
  { pattern: /\bnpm_[A-Za-z0-9]{36,}\b/, name: "an npm access token" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, name: "a GitHub token" },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    name: "a GitHub fine-grained personal access token",
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    name: "a JSON Web Token, such as a GitHub App installation token",
  },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, name: "an AWS access key id" },
  {
    pattern: /\baws[-_]?secret[-_]?access[-_]?key\s*[:=]\s*['"]?[A-Za-z0-9/+]{40}\b/i,
    name: "an AWS secret access key",
  },
  // Real Anthropic keys (`sk-ant-api03-…-AA`) are hyphen-segmented, not a
  // single contiguous alphanumeric run, so the body must accept `-`/`_`.
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, name: "an Anthropic API key" },
  {
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9]{20,}\b/,
    name: "an OpenAI API key",
  },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, name: "a Slack token" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, name: "a Google API key" },
  { pattern: /\b[spr]k_live_[A-Za-z0-9]{16,}\b/, name: "a Stripe live API key" },
];

/**
 * Shortest value the generic password rule will judge to be a credential.
 * Below a password policy's usual floor, a literal is far likelier to be a
 * stub, a placeholder, or an abbreviation than a real secret.
 */
const MIN_PASSWORD_VALUE_LENGTH = 8;

/**
 * Every assignment site whose key ends in `password`, with the assigned value
 * captured as a double-quoted body, a single-quoted body, or a bare token.
 *
 * @remarks
 * The key half accepts one optional surrounding quote, so the JSON and YAML
 * forms are candidates as well as the env-style and source-code ones. It is
 * only a candidate: nothing about the key decides the outcome.
 *
 * The `g` flag is here because `String.prototype.matchAll` requires it. Never
 * call `.test()` or `.exec()` on this instance — both advance `lastIndex` on a
 * module-level regex, so the following call would start mid-string. `matchAll`
 * clones the regex, which leaves the shared instance at `lastIndex === 0`.
 */
const PASSWORD_ASSIGNMENT =
  /password["']?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'\r\n,;]+))/gi;

/**
 * Whitespace, anything outside printable ASCII, or a character that opens an
 * expression, a template interpolation, a generic or an object literal.
 */
const NON_LITERAL_VALUE = /[^\x21-\x7e]|[$`(){}<>]/;

/**
 * A digit or a punctuation character that a natural-language word, an
 * identifier, a member expression or a type name does not carry. `.` and `_`
 * are deliberately absent: they are what an identifier is made of.
 */
const CREDENTIAL_VALUE_QUALIFIER = /[0-9!#%&*+\-/=?@^~]/;

/**
 * Whether an assigned value looks like a credential literal.
 *
 * @remarks
 * The judgement is the value's shape alone, never the key's: a key ending in
 * `password` sits above a schema, a type, a member expression or a translated
 * UI message at least as often as above a secret. A value qualifies when it is
 * at least {@link MIN_PASSWORD_VALUE_LENGTH} characters, is an unbroken run of
 * printable ASCII, carries no expression or interpolation marker, and holds at
 * least one digit or credential-shaped punctuation character.
 *
 * What that deliberately misses is stated where a reader meets it, in the
 * `changing-gates` skill: a short secret, a purely alphabetic one, one holding
 * a space or a non-ASCII character, and one assembled at runtime all walk
 * through, as does the whitespace-separated schema form, which is a type
 * declaration rather than an assignment. The alternative — firing on any
 * non-space run after the key — rejected ordinary schema, type and variable
 * declarations, and AGENTS.md's "Enforcement layers" is explicit that a hook
 * firing on intended work teaches its author to reach for `--no-verify`, which
 * switches off every rule in this file at once.
 *
 * @param {string} value - The assigned value, with any surrounding quotes removed.
 * @returns {boolean} True when the value is credential-shaped.
 */
export function isCredentialShapedValue(value) {
  return (
    value.length >= MIN_PASSWORD_VALUE_LENGTH &&
    !NON_LITERAL_VALUE.test(value) &&
    CREDENTIAL_VALUE_QUALIFIER.test(value)
  );
}

/**
 * Whether text assigns a credential-shaped value to a password-shaped key.
 *
 * @param {string} text - Content about to be written, or a shell command.
 * @returns {boolean} True when at least one assignment site qualifies.
 */
function hasHardcodedPassword(text) {
  // Every site, not merely the first: a file routinely declares a password
  // field on one line and assigns a real value on another.
  for (const match of text.matchAll(PASSWORD_ASSIGNMENT)) {
    if (isCredentialShapedValue(match[1] ?? match[2] ?? match[3] ?? "")) {
      return true;
    }
  }
  return false;
}

/**
 * The single block message, so every rule here reports in one voice.
 *
 * @param {string} name - What the match looks like, as a noun phrase.
 * @returns {string} The reason to report.
 */
function blockReason(name) {
  return `This write looks like it embeds ${name}. Credentials belong in the environment or a secret store, never in a tracked file.`;
}

/**
 * Return a block reason when text carries a credential.
 *
 * @param {string} text - Content about to be written, or a shell command.
 * @returns {string | null} The reason, or null when nothing matched.
 */
export function checkCredentials(text) {
  if (text === "") {
    return null;
  }
  for (const { pattern, name } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      return blockReason(name);
    }
  }
  // Last, deliberately: a provider-specific match names the actual vendor,
  // which is a more useful report than the generic heuristic's.
  if (hasHardcodedPassword(text)) {
    return blockReason("a hardcoded password");
  }
  return null;
}
