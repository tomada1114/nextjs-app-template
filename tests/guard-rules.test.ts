import { describe, expect, it } from "vitest";

import {
  checkCredentials,
  isCredentialShapedValue,
} from "../scripts/lib/guard/credentials.mjs";
import { checkRead } from "../scripts/lib/guard/paths.mjs";

// Pure-function coverage for the secret-detection rules under
// scripts/lib/guard/, used by scripts/check-staged.mjs. Nothing here spawns a
// process — tests/check-staged.test.ts covers that caller's own contract
// (staged content, exit codes).
//
// Secret-shaped fixtures are assembled from fragments rather than written
// out. A literal token or key header in this file would be a real finding
// for every secret scanner pointed at the repository.
function secretShaped(...parts: string[]): string {
  return parts.join("");
}

describe("paths: checkRead", () => {
  it("blocks reading a dotenv file", () => {
    expect(checkRead(".env")).toMatch(/\.env\*/);
  });

  it("blocks reading a direnv .envrc", () => {
    // direnv's file is neither `.env` nor `.env.`-prefixed, so it is named
    // rather than derived; its content is the same kind as a dotenv file's.
    expect(checkRead(".envrc")).toMatch(/\.env\*/);
  });

  it.each([".envrc.local", ".envrc.private"])(
    "blocks reading a direnv override such as %s",
    (name) => {
      // These, not the bare `.envrc`, are where direnv convention keeps real
      // values; the bare name is usually secret-free boilerplate.
      expect(checkRead(name)).toMatch(/\.env\*/);
    },
  );

  it("allows reading the env example", () => {
    expect(checkRead(".env.example")).toBeNull();
  });

  it("allows reading a direnv example", () => {
    expect(checkRead(".envrc.example")).toBeNull();
  });

  it("blocks a path under secrets/", () => {
    expect(checkRead("secrets/token.txt")).toMatch(/secrets\//);
  });

  it("blocks the personal .claude/settings.local.json", () => {
    expect(checkRead(".claude/settings.local.json")).toMatch(/settings\.local\.json/);
  });

  it.each([
    ["an absolute path", "/Users/dev/repo/.claude/settings.local.json"],
    ["a nested path", "packages/app/.claude/settings.local.json"],
  ])("blocks the personal .claude/settings.local.json via %s", (_label, path) => {
    // An agent's Read call arrives as an absolute path, and a checkout can
    // sit under any directory — the rule matches by trailing segments, the
    // same way its `.env*` and `secrets/` siblings do, so it still fires.
    expect(checkRead(path)).toMatch(/settings\.local\.json/);
  });

  it("allows the shared, committed .claude/settings.json", () => {
    expect(checkRead(".claude/settings.json")).toBeNull();
  });

  it("allows a skill file under .claude/skills/", () => {
    expect(checkRead(".claude/skills/writing-tests/SKILL.md")).toBeNull();
  });

  it("does not block a settings.local.json outside .claude/", () => {
    // The rule matches by trailing segments, not by basename alone — a
    // `settings.local.json` whose immediate parent is not `.claude/` is not
    // this rule's concern.
    expect(checkRead("some/other/settings.local.json")).toBeNull();
  });
});

describe("credentials: checkCredentials", () => {
  const privateKey = secretShaped("-----BEGIN RSA ", "PRIVATE ", "KEY-----");

  it("blocks a private key", () => {
    expect(checkCredentials(`${privateKey}\nMIIE…\n`)).toMatch(/private key/);
  });

  it("does not flag ordinary prose", () => {
    expect(
      checkCredentials("Store the token in the environment, never in a file."),
    ).toBeNull();
  });

  it.each([
    [
      "a lowercase password assignment",
      secretShaped("password ", "= ", '"s3cr3t-value"'),
      /password/,
    ],
    [
      "an upper-snake-case env-style password assignment",
      secretShaped("PASSWORD", "=", "s3cr3t-value"),
      /password/,
    ],
    [
      "an underscore-prefixed password assignment",
      secretShaped("db_password", "=", "s3cr3t-value"),
      /password/,
    ],
    [
      "a colon-delimited password assignment",
      secretShaped("password", ": ", '"s3cr3t-value"'),
      /password/,
    ],
    [
      // The shape this rule exists to catch and used to walk past: JSON quotes
      // the key, so the separator no longer follows the word directly.
      "a quoted JSON password assignment",
      secretShaped('{ "password', '": ', '"synthetic-example" }'),
      /password/,
    ],
    [
      "a single-quoted password assignment",
      secretShaped("password", ": ", "'s3cr3t-value'"),
      /password/,
    ],
    [
      "a camelCase password assignment",
      secretShaped("dbPassword", ": ", '"s3cr3t-value"'),
      /password/,
    ],
    [
      // Every candidate site is judged, not merely the first: an
      // implementation that stopped at the schema field above would let the
      // assignment below through.
      "a real assignment below a password schema field",
      secretShaped("password: z.string()\n", "password", "=", '"s3cr3t-value"'),
      /password/,
    ],
    [
      "a GitHub fine-grained personal access token",
      secretShaped("github_pat_", "11AAAAAAA0AAAAAAAAAAA", "AAAAAAAAAAAAAAAAAAAAAA"),
      /fine-grained/,
    ],
    [
      "a GitHub App installation JWT",
      secretShaped(
        "eyJhbGciOiJIUzI1NiJ9.",
        "eyJzdWIiOiIxMjM0NTY3ODkwIn0.",
        "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      ),
      /JSON Web Token/,
    ],
    [
      "an AWS secret access key assignment (underscore form)",
      secretShaped(
        "aws_secret_access_key = ",
        '"wJalrXUtnFEMI/K7MDENG',
        '/bPxRfiCYEXAMPLEKEY"',
      ),
      /AWS secret access key/,
    ],
    [
      "an AWS secret access key assignment (hyphenated form)",
      secretShaped(
        "aws-secret-access-key: ",
        '"wJalrXUtnFEMI/K7MDENG',
        '/bPxRfiCYEXAMPLEKEY"',
      ),
      /AWS secret access key/,
    ],
    ["an Anthropic API key", secretShaped("sk-ant-", "a".repeat(25)), /Anthropic/],
    [
      "a realistic hyphen-segmented Anthropic API key",
      secretShaped("sk-ant-api03-", "a".repeat(30), "-", "b".repeat(10), "-AA"),
      /Anthropic/,
    ],
    ["an OpenAI project API key", secretShaped("sk-proj-", "a".repeat(25)), /OpenAI/],
    ["a classic OpenAI API key", secretShaped("sk-", "a".repeat(25)), /OpenAI/],
    ["a Slack token", secretShaped("xoxb-", "1".repeat(15)), /Slack/],
    ["a Google API key", secretShaped("AIza", "a".repeat(35)), /Google/],
    ["a Stripe live API key", secretShaped("sk_live_", "a".repeat(20)), /Stripe/],
  ])("blocks %s", (_label, text, matcher) => {
    expect(checkCredentials(text)).toMatch(matcher);
  });

  it.each([
    [
      "prose that merely mentions a password",
      "Store the password in a secret manager, never in a file.",
    ],
    ["a plain github_pat-shaped word that is too short", "github_pat_expired"],
    ["a dotted string that is not JWT-shaped", "release.eyJust.a.version-like.string"],
    [
      "a bare 40-character string with no AWS context",
      secretShaped("wJalrXUtnFEMI/K7MDENG", "/bPxRfiCYEXAMPLEKEY"),
    ],
    [
      "a lowercase-only 40-character hex string (e.g. a git SHA)",
      "447392e1a2b3c4d5e6f7890123456789abcdef01",
    ],
    ["a short sk-ant-shaped string", "sk-ant-expired"],
    ["a short sk- prefixed string", "sk-expired"],
    ["a short xoxb-shaped string", "xoxb-revoked"],
    ["a short AIza-prefixed string", "AIzaExpired"],
    ["a Stripe test key", secretShaped("sk_test_", "a".repeat(20))],
    // Ordinary code that a sign-in form, a credential schema or a user model
    // brings into a project. Each of the six rows below was blocked before the
    // rule began judging the assigned value instead of the key.
    ["a zod password schema", "password: z.string()"],
    ["a TypeScript password field", "password: string;"],
    ["a Prisma or GraphQL password field", "password: String"],
    ["an optional TypeScript password property", "password?: string"],
    ["a destructured password read", "const password = form.password;"],
    ["a snake_case password identifier read", "password = user_password"],
    [
      // Eight characters, but a bare word carries neither a digit nor
      // credential-shaped punctuation, so it is a label rather than a value.
      // This row and the Japanese message below it pass on HEAD too: they
      // pin shapes the rule must never start firing on.
      "an English UI label under a password key",
      secretShaped('"password', '": ', '"Password"'),
    ],
    [
      // Why the printable-ASCII condition exists: `messages/ja.json` is a
      // Japanese catalog by definition, and its values sit under English keys.
      "a Japanese UI message under a password key",
      secretShaped('"password', '": ', '"パスワードを入力してください"'),
    ],
    [
      // Blocked before this change, since any non-space character after the
      // separator was enough.
      "a shell interpolation of a password variable",
      secretShaped("PASSWORD", "=", "${DB_PASS}"),
    ],
    [
      "a GitHub Actions expression reading a password secret",
      secretShaped("password", ": ", "${{ secrets.DB_PASSWORD }}"),
    ],
    [
      // The `.env.example` shape: every name shipped with an empty value.
      "an empty password value in an example file",
      secretShaped("DB_PASSWORD", "=", "\n"),
    ],
  ])("does not flag %s", (_label, text) => {
    expect(checkCredentials(text)).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(checkCredentials("")).toBeNull();
  });

  it("does not flag a whitespace-separated schema field", () => {
    // Deliberately out of scope, and the reason is the same one that keeps
    // `password: String` out: a value that is a type name is never a
    // credential, whichever separator precedes it. The rule therefore keeps
    // requiring a `:` or `=` separator.
    expect(checkCredentials("password  String")).toBeNull();
  });
});

describe("credentials: isCredentialShapedValue", () => {
  it.each([
    ["a hyphenated twelve-character value", "s3cr3t-value"],
    ["an eight-character value qualified by a digit", "abc12345"],
    ["a value qualified by punctuation alone", "value@shape"],
  ])("judges %s credential-shaped", (_label, value) => {
    expect(isCredentialShapedValue(value)).toBe(true);
  });

  it.each([
    ["a value one character under the length floor", "abc123-"],
    ["a word with neither a digit nor punctuation", "plainletters"],
    ["a value containing a space", "plain value-1"],
    ["a value containing non-ASCII characters", "パスワード-1"],
    ["a value opening a template interpolation", "abc1234$"],
    ["a value carrying a backtick", "abc1234`"],
    ["a value opening a call", "abc1234("],
    ["a value opening an object literal", "abc1234{"],
    ["a value opening a generic", "abc1234<"],
    ["a member expression", "form.password"],
    ["a snake_case identifier", "user_password"],
    ["the empty string", ""],
  ])("judges %s not credential-shaped", (_label, value) => {
    expect(isCredentialShapedValue(value)).toBe(false);
  });
});
