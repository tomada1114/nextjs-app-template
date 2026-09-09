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
 * How many of {@link CREDENTIAL_CHARACTER_CLASSES} a value has to mix before it
 * reads as generated rather than chosen by a person.
 *
 * @remarks
 * Three is what separates a generator's output from the strings people write
 * next to a password key on purpose: a kebab-case identifier, a placeholder, a
 * masked display value and a URL each mix two, while a value carrying upper
 * case, lower case and a digit — or any of those plus punctuation — is a shape
 * nobody types as a label.
 */
const MIN_CREDENTIAL_CHARACTER_CLASSES = 3;

/**
 * Every assignment site whose key ends in `password`, with the assigned value
 * captured as a double-quoted body, a single-quoted body, or a bare token.
 *
 * @remarks
 * The key half accepts one optional surrounding quote, so the JSON and YAML
 * forms are candidates as well as the env-style and source-code ones. It is
 * only a candidate: nothing about the key decides the outcome.
 *
 * The bare alternative runs to the next whitespace or quote rather than
 * stopping at a comma or a semicolon, so a value that carries one is judged
 * whole instead of being truncated below the length floor. What a statement
 * terminator left behind is trimmed by {@link TRAILING_STATEMENT_PUNCTUATION}.
 *
 * The `g` flag is here because `String.prototype.matchAll` requires it. Never
 * call `.test()` or `.exec()` on this instance — both advance `lastIndex` on a
 * module-level regex, so the following call would start mid-string. `matchAll`
 * clones the regex, which leaves the shared instance at `lastIndex === 0`.
 */
const PASSWORD_ASSIGNMENT =
  /password["']?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'\r\n]+))/gi;

/**
 * A statement terminator a bare capture swept up from the code around it. It
 * belongs to the statement, not to the value, and counting it as punctuation
 * would make an ordinary trailing-comma object property look credential-shaped.
 */
const TRAILING_STATEMENT_PUNCTUATION = /[,;]+$/;

/** Whitespace, or anything outside printable ASCII. */
const NON_ASCII_OR_WHITESPACE = /[^\x21-\x7e]/;

/**
 * A character that opens an expression, a template interpolation, a generic or
 * an object literal.
 *
 * @remarks
 * Applied to a bare, unquoted value only: there it is the strongest available
 * signal that the right-hand side is code rather than a literal. Inside quotes
 * the same characters are ordinary content — a generator emits them freely —
 * so a quoted body is held to {@link INTERPOLATION_MARKER} instead.
 */
const EXPRESSION_MARKER = /[$`(){}<>]/;

/**
 * The interpolation openers, which mean the same thing inside quotes as
 * outside: a shell or template expansion, or a command substitution. A lone
 * `$` is not one of them, which is what keeps a hash-shaped literal in scope.
 */
const INTERPOLATION_MARKER = /\$[{(]|`/;

/**
 * The four classes a credential-shaped value mixes: lower case, upper case,
 * digits, and punctuation.
 *
 * @remarks
 * `.` and `_` count as neither punctuation nor a letter: they are what an
 * identifier, a member expression and a file name are made of, so counting
 * them would make `form.password` and `user_password` look mixed.
 */
const CREDENTIAL_CHARACTER_CLASSES = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9._]/];

/**
 * The service-credential form: an upper snake case key ending in the env-style
 * password name, assigned a bare alphanumeric word that runs to the end of its
 * line.
 *
 * @remarks
 * This is the one shape the character-class test cannot reach — a single
 * lower-case word is one class, and no shape test tells a database's default
 * from a placeholder. What stands in for it is context: an upper snake case
 * key, and a value ending the line rather than a `,` or `;` continuing a
 * JavaScript object or type. Both are true of a compose file, a CI service
 * block and an env file, and false of ordinary source.
 *
 * No `g` flag, deliberately: this instance is used with `.test()`, which
 * advances `lastIndex` only on a global or sticky regex.
 */
const ENV_STYLE_PASSWORD_ASSIGNMENT =
  /\b[A-Z0-9_]*PASSWORD["']?[ \t]*[:=][ \t]*["']?[A-Za-z0-9]{8,}["']?[ \t]*(?:\r?\n|$)/;

/**
 * Whether an assigned value looks like a credential literal.
 *
 * @remarks
 * The judgement is the value's shape alone, never the key's: a key ending in
 * `password` sits above a schema, a type, a member expression or a translated
 * UI message at least as often as above a secret. A value qualifies when it is
 * at least {@link MIN_PASSWORD_VALUE_LENGTH} characters, is an unbroken run of
 * printable ASCII, carries no interpolation (and, unquoted, no expression
 * marker at all), and mixes at least
 * {@link MIN_CREDENTIAL_CHARACTER_CLASSES} of
 * {@link CREDENTIAL_CHARACTER_CLASSES}.
 *
 * The class count is what keeps the rule off intended work. A hyphenated
 * identifier, a masked display value, a documented placeholder and a URL each
 * mix two classes and pass; so, deliberately, does a lower-case word with a
 * digit stuck on the end, because no shape test separates that from the
 * placeholder people write in a README. What that costs, and the one context
 * where it is bought back, is stated where a reader meets it, in the
 * `changing-gates` skill.
 *
 * @param {string} value - The assigned value, with any surrounding quotes removed.
 * @param {boolean} quoted - Whether the value was written inside quotes.
 * @returns {boolean} True when the value is credential-shaped.
 */
export function isCredentialShapedValue(value, quoted) {
  if (value.length < MIN_PASSWORD_VALUE_LENGTH || NON_ASCII_OR_WHITESPACE.test(value)) {
    return false;
  }
  if ((quoted ? INTERPOLATION_MARKER : EXPRESSION_MARKER).test(value)) {
    return false;
  }
  let mixed = 0;
  for (const characterClass of CREDENTIAL_CHARACTER_CLASSES) {
    if (characterClass.test(value)) {
      mixed += 1;
    }
  }
  return mixed >= MIN_CREDENTIAL_CHARACTER_CLASSES;
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
    const quotedBody = match[1] ?? match[2];
    if (quotedBody !== undefined) {
      if (isCredentialShapedValue(quotedBody, true)) {
        return true;
      }
    } else if (
      isCredentialShapedValue(
        (match[3] ?? "").replace(TRAILING_STATEMENT_PUNCTUATION, ""),
        false,
      )
    ) {
      return true;
    }
  }
  return ENV_STYLE_PASSWORD_ASSIGNMENT.test(text);
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
