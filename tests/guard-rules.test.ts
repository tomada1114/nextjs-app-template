import { describe, expect, it } from "vitest";

import {
  checkCredentials,
  isCredentialShapedValue,
} from "../scripts/lib/guard/credentials.mjs";
import { checkCommit, checkRead } from "../scripts/lib/guard/paths.mjs";

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
    // This is the one path on which the two layers deliberately diverge:
    // `checkCommit` lets a bare `.envrc` through to the content scan, because
    // a direnv project tracks it on purpose. Reading it is still refused — a
    // `.envrc` in a checkout may hold values whether or not it is tracked.
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

describe("paths: checkCommit", () => {
  it("allows committing direnv's bare .envrc", () => {
    // The decision this suite exists to pin. In direnv's convention `.envrc`
    // is the shared, secret-free script — `use flake`,
    // `source_env_if_exists .envrc.local` — and refusing it would fire on work
    // someone meant to do, teaching its author to reach for `--no-verify`,
    // which turns off the credential scan for every other staged file too.
    expect(checkCommit(".envrc")).toBeNull();
  });

  it("allows committing a nested .envrc", () => {
    // The rule reads the basename, not the repository root, so a workspace
    // package's own direnv script is treated the same way.
    expect(checkCommit("apps/web/.envrc")).toBeNull();
  });

  it.each([".envrc.local", ".envrc.private"])(
    "blocks committing a direnv override such as %s",
    (name) => {
      // Only the bare name diverges: these are where direnv convention keeps
      // the real values, so they stay refused on their path alone.
      expect(checkCommit(name)).toMatch(/\.env\*/);
    },
  );

  it.each([".env", ".env.local"])("blocks committing %s", (name) => {
    // dotenv's polarity is the opposite of direnv's — `.env` holds the values
    // and `.env.example` is the tracked one — so the carve-out never reaches
    // it.
    expect(checkCommit(name)).toMatch(/\.env\*/);
  });

  it.each([".env.example", ".envrc.example"])("allows committing %s", (name) => {
    expect(checkCommit(name)).toBeNull();
  });

  it("blocks committing a path under secrets/", () => {
    expect(checkCommit("secrets/token.txt")).toMatch(/secrets\//);
  });

  it("blocks committing a .envrc under secrets/", () => {
    // The carve-out is scoped to the dotenv branch, so it must not reach into
    // the `secrets/` rule — the one non-obvious interaction in the split.
    expect(checkCommit("secrets/.envrc")).toMatch(/secrets\//);
  });

  it.each([
    ["at the repository root", ".claude/settings.local.json"],
    ["nested under a package", "packages/app/.claude/settings.local.json"],
  ])("blocks committing the personal settings file %s", (_label, path) => {
    // The regression guard for the two-layer split: the shared body carries
    // three rules, and a version that dropped this one would still pass every
    // other row here.
    expect(checkCommit(path)).toMatch(/settings\.local\.json/);
  });

  it("allows committing the shared .claude/settings.json", () => {
    expect(checkCommit(".claude/settings.json")).toBeNull();
  });

  it.each([
    ["an empty path", ""],
    ["an ordinary source file", "src/example.ts"],
  ])("allows committing %s", (_label, path) => {
    expect(checkCommit(path)).toBeNull();
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
      // the key, so the separator no longer follows the word directly. The
      // value mixes upper case, lower case, digits and punctuation, which is
      // what the rule now reads rather than the key above it.
      "a quoted JSON password assignment",
      secretShaped('{ "password', '": ', '"S3cr3t-Example" }'),
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
      // A generated password carries `$`, `(`, `{` or `<` as freely as any
      // other punctuation. Inside quotes none of them can open an expression,
      // so the marker test that keeps `z.string()` out is applied to a bare
      // value only — these five rows were exempted while it was applied to
      // both.
      "a quoted generated password carrying a dollar sign",
      secretShaped("password", ": ", '"aB3$xQ9!zP"'),
      /password/,
    ],
    [
      "a quoted generated password carrying parentheses",
      secretShaped("password", ": ", '"P@ssw0rd(2024)"'),
      /password/,
    ],
    [
      "a quoted generated password carrying braces",
      secretShaped("const password", " = ", '"x9{Kq2}Lm4"'),
      /password/,
    ],
    [
      "a quoted generated password carrying an angle bracket",
      secretShaped("password", " = ", '"a<b1234xyz"'),
      /password/,
    ],
    [
      // A bcrypt hash begins with a cost-prefixed run of dollar signs and no
      // brace or parenthesis after them, so it is a literal rather than an
      // interpolation.
      "a quoted bcrypt hash",
      secretShaped("password", ": ", '"$2b$10$N9qo8uLOickgx2ZMRZoMy"'),
      /password/,
    ],
    [
      // The bare capture runs to the next whitespace rather than stopping at
      // the comma, so the value is judged whole. Truncated at the comma it
      // was six characters and fell under the length floor.
      "a bare password value carrying a comma",
      secretShaped("password", "=", "Str0ng,Pass"),
      /password/,
    ],
    [
      // The service-credential shape, which the character-class test cannot
      // reach on its own: one lower-case word is one class. An upper snake
      // case key and a value that ends the line are what stand in for it.
      "an upper snake case service credential in a compose file",
      secretShaped("POSTGRES_", "PASSWORD", ": ", "postgres"),
      /password/,
    ],
    [
      "an upper snake case service credential in an env-style assignment",
      secretShaped("MYSQL_ROOT_", "PASSWORD", "=", "rootpassword"),
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
    [
      // The content layer is what now stands between a committable `.envrc`
      // and a real key in it, so pin that it covers the recognizable shape.
      // The variable is named generically on purpose: the suite that keeps the
      // AI layer removable tracks the provider's own env name, so writing it
      // here would enlist this file in that removal.
      "a provider API key exported from a direnv script",
      secretShaped("export LLM_API_KEY=", "sk-ant-", "a".repeat(25)),
      /Anthropic/,
    ],
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
    // Written out rather than assembled, because none of the six is
    // secret-shaped — that is the whole claim each row makes. Every one of
    // them blocked the commit while the rule counted a hyphen or a slash as
    // enough on its own.
    [
      // The React `autoComplete` value, written by every sign-in form there
      // is, and the single likeliest string to sit under a password key.
      "the standard new-password autocomplete value",
      'password: "new-password"',
    ],
    ["a kebab-case identifier under a password key", 'password: "sign-in-form"'],
    ["a documented placeholder value", 'password: "your-password-here"'],
    ["a placeholder carrying a trailing digit", 'password: "changeme123"'],
    ["a masked display value", 'password: "********"'],
    ["a reset URL under a password key", 'password: "https://example.com/reset"'],
    [
      // The named residual risk of letting a bare `.envrc` through on its
      // path: an opaque, prefix-less value matches no pattern here, and no
      // entropy test is applied — the AWS entry was anchored precisely because
      // an unanchored one hits `pnpm-lock.yaml`'s integrity hashes. Accepted
      // rather than overlooked, and no worse than any other tracked file.
      "an opaque, prefix-less secret exported from a direnv script",
      secretShaped("export SESSION_SECRET=", "a".repeat(32)),
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
  // The second argument is whether the value was written inside quotes. It
  // decides one thing only: a bare value is rejected on any expression marker,
  // a quoted one only on a real interpolation opener.
  it.each<[string, string, boolean]>([
    ["a hyphenated value mixing letters and digits", "s3cr3t-value", false],
    ["a quoted generated password carrying punctuation", "aB3$xQ9!zP", true],
    [
      "a quoted hash-shaped literal that opens no interpolation",
      "$2b$10$N9qo8uLO",
      true,
    ],
    ["a bare value mixing upper case, lower case and a digit", "Str0ngPass", false],
  ])("judges %s credential-shaped", (_label, value, quoted) => {
    expect(isCredentialShapedValue(value, quoted)).toBe(true);
  });

  it.each<[string, string, boolean]>([
    ["a value one character under the length floor", "aB3-xY9", false],
    ["a word with neither a digit nor punctuation", "plainletters", false],
    ["a kebab-case identifier mixing only two classes", "new-password", true],
    ["a lower-case word with a digit stuck on the end", "changeme123", true],
    ["a value containing a space", "Str0ng value", true],
    [
      "a value containing non-ASCII characters",
      "\u30d1\u30b9\u30ef\u30fc\u30c9-1",
      true,
    ],
    ["a bare value opening a template interpolation", "aB3${xY9z}", false],
    ["a bare value carrying a backtick", "aB3`xY9z`", false],
    ["a bare value opening a call", "aB3(xY9z)", false],
    ["a bare value opening an object literal", "aB3{xY9z}", false],
    ["a bare value opening a generic", "aB3<xY9z>", false],
    ["a quoted value interpolating a variable", "aB3${xY9z}", true],
    ["a quoted value carrying a backtick", "aB3`xY9z`", true],
    ["a quoted value substituting a command", "aB3$(xY9z)", true],
    ["a member expression", "form.password", false],
    ["a snake_case identifier", "user_password", false],
    ["the empty string", "", false],
  ])("judges %s not credential-shaped", (_label, value, quoted) => {
    expect(isCredentialShapedValue(value, quoted)).toBe(false);
  });
});
