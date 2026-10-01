import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// A sub-agent definition that does not parse, or names a tier the other host
// lacks, fails nowhere else: the host just skips it, and a step handed to that
// tier silently runs as some other agent — a same-named one from a developer's
// home directory, or a host's built-in. AGENTS.md's "Sub-agents" says both
// hosts define the same three tiers; this file is what holds it to that.
//
// Both formats are parsed here rather than by adding a YAML or TOML dependency:
// the files are this repository's own, and each parser accepts only the subset
// they are written in and rejects the rest, so a definition that drifts outside
// it fails loudly instead of being half-read.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const claudeAgentsDirectory = path.join(repoRoot, ".claude", "agents");
const codexAgentsDirectory = path.join(repoRoot, ".codex", "agents");

/**
 * The three tiers, as AGENTS.md's "Sub-agents" and issue #182 define them.
 * `model` is Claude Code's alias — never a dated model ID, which would go
 * stale — and Codex CLI carries no model at all, inheriting the session's.
 */
const TIERS = [
  { name: "architect", model: "opus", effort: "high" },
  { name: "executor", model: "opus", effort: "low" },
  { name: "worker", model: "sonnet", effort: "medium" },
] as const;

/**
 * Every key a Codex definition here declares: the three Codex CLI requires,
 * plus the effort. No `model`, and no `sandbox_mode` or other permission
 * setting — what a sub-agent may run is not this file's to widen.
 */
const CODEX_KEYS = [
  "description",
  "developer_instructions",
  "model_reasoning_effort",
  "name",
] as const;

/** Every key a Claude Code definition here declares. */
const CLAUDE_KEYS = ["description", "effort", "model", "name"] as const;

const KEY_LINE = /^([A-Za-z_][\w-]*)[ \t]*=[ \t]*(.*)$/u;
const MULTILINE_DELIMITER = '"""';

/**
 * Parse the subset of TOML this repository writes a Codex agent in: top-level
 * `key = "basic string"` pairs and `key = """` multi-line basic strings, with
 * `#` comment lines and blank lines between them.
 *
 * @param {string} source - The full contents of a `.codex/agents/*.toml` file.
 * @returns {Record<string, string>} Every key the file declares.
 * @throws {Error} On a table header, a non-string value, an escape sequence,
 *   a key declared twice, or a multi-line string that is never closed.
 */
function parseAgentToml(source: string): Record<string, string> {
  const lines = source.split("\n");
  const fields: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const keyed = KEY_LINE.exec(line);
    if (!keyed) {
      throw new Error(`TOML line is not a top-level key/value pair: ${line}`);
    }
    const [, key = "", rawValue = ""] = keyed;
    if (key in fields) {
      throw new Error(`TOML declares "${key}" more than once`);
    }
    let value: string;
    if (rawValue === MULTILINE_DELIMITER) {
      // TOML drops the newline right after the opening delimiter, which is
      // where this subset always puts it.
      const close = lines.indexOf(MULTILINE_DELIMITER, index + 1);
      if (close === -1) {
        throw new Error(`TOML multi-line string for "${key}" is never closed`);
      }
      value = lines.slice(index + 1, close).join("\n") + "\n";
      index = close;
    } else {
      const single = /^"([^"\\]*)"$/u.exec(rawValue);
      if (!single) {
        throw new Error(`TOML value for "${key}" is not a plain basic string: ${line}`);
      }
      value = single[1] ?? "";
    }
    if (value.includes("\\")) {
      throw new Error(
        `TOML value for "${key}" uses an escape this parser does not read`,
      );
    }
    fields[key] = value;
  }
  return fields;
}

/**
 * Split a Claude Code agent file into its frontmatter keys and its body.
 *
 * Supports a plain `key: value` scalar and a folded block scalar (`key: >`)
 * whose continuation lines are indented — the two forms the files here use.
 *
 * @param {string} source - The full contents of a `.claude/agents/*.md` file.
 * @returns {{ fields: Record<string, string>; body: string }} The declared
 *   keys and everything after the closing delimiter.
 * @throws {Error} When the frontmatter is missing or never closed, a line in
 *   it is neither a key nor a continuation, or a key is declared twice.
 */
function parseAgentMarkdown(source: string): {
  fields: Record<string, string>;
  body: string;
} {
  const lines = source.split("\n");
  if (lines[0] !== "---") {
    throw new Error("agent file does not open with a `---` frontmatter delimiter");
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    throw new Error("agent frontmatter is never closed by a `---` delimiter");
  }

  const fields: Record<string, string> = {};
  let currentKey: string | undefined;
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const keyed = /^([A-Za-z][\w-]*):[ \t]*(.*)$/u.exec(line);
    if (keyed) {
      const [, key = "", rawValue = ""] = keyed;
      if (key in fields) {
        throw new Error(`frontmatter declares "${key}" more than once`);
      }
      currentKey = key;
      fields[key] = rawValue === ">" || rawValue === ">-" ? "" : rawValue.trim();
      continue;
    }
    if (currentKey === undefined || !line.startsWith(" ")) {
      throw new Error(`frontmatter line is neither a key nor a continuation: ${line}`);
    }
    const folded = fields[currentKey] ?? "";
    fields[currentKey] = folded === "" ? line.trim() : `${folded} ${line.trim()}`;
  }
  return { fields, body: lines.slice(end + 1).join("\n") };
}

/** Prose compared across hosts: line wrapping is a formatter's, not a difference. */
function normalizeWhitespace(text: string): string {
  return text.trim().split(/\s+/u).join(" ");
}

function readClaudeAgent(name: string): ReturnType<typeof parseAgentMarkdown> {
  return parseAgentMarkdown(
    readFileSync(path.join(claudeAgentsDirectory, `${name}.md`), "utf8"),
  );
}

function readCodexAgent(name: string): Record<string, string> {
  return parseAgentToml(
    readFileSync(path.join(codexAgentsDirectory, `${name}.toml`), "utf8"),
  );
}

const tierNames = TIERS.map((tier) => tier.name);

describe("the Claude Code tier definitions under .claude/agents/", () => {
  it("define exactly the three tiers", () => {
    expect(readdirSync(claudeAgentsDirectory).sort()).toEqual(
      tierNames.map((name) => `${name}.md`),
    );
  });

  it.each(TIERS)("declare only the expected keys in $name", ({ name }) => {
    expect(Object.keys(readClaudeAgent(name).fields).sort()).toEqual([...CLAUDE_KEYS]);
  });

  it.each(TIERS)("name $name's frontmatter after its file", ({ name }) => {
    expect(readClaudeAgent(name).fields["name"]).toBe(name);
  });

  it.each(TIERS)("pin $name to the $model alias", ({ name, model }) => {
    expect(readClaudeAgent(name).fields["model"]).toBe(model);
  });

  it.each(TIERS)("run $name at $effort effort", ({ name, effort }) => {
    expect(readClaudeAgent(name).fields["effort"]).toBe(effort);
  });

  it.each(TIERS)("give $name a description and a body", ({ name }) => {
    const { fields, body } = readClaudeAgent(name);
    expect(fields["description"]).not.toBe("");
    expect(body.trim()).not.toBe("");
  });
});

describe("the Codex CLI tier definitions under .codex/agents/", () => {
  it("define exactly the three tiers", () => {
    expect(readdirSync(codexAgentsDirectory).sort()).toEqual(
      tierNames.map((name) => `${name}.toml`),
    );
  });

  it.each(TIERS)(
    "declare the required keys and the effort, and nothing else, in $name",
    ({ name }) => {
      expect(Object.keys(readCodexAgent(name)).sort()).toEqual([...CODEX_KEYS]);
    },
  );

  it.each(TIERS)("name $name after its file", ({ name }) => {
    expect(readCodexAgent(name)["name"]).toBe(name);
  });

  it.each(TIERS)("run $name at $effort reasoning effort", ({ name, effort }) => {
    expect(readCodexAgent(name)["model_reasoning_effort"]).toBe(effort);
  });

  it.each(TIERS)("give $name a description", ({ name }) => {
    expect(readCodexAgent(name)["description"]).not.toBe("");
  });
});

describe("the two hosts' definitions of one tier", () => {
  it.each(TIERS)("give $name the same instructions on both hosts", ({ name }) => {
    expect(
      normalizeWhitespace(readCodexAgent(name)["developer_instructions"] ?? ""),
    ).toBe(normalizeWhitespace(readClaudeAgent(name).body));
  });
});

describe("parseAgentToml", () => {
  it("reads a basic string", () => {
    expect(parseAgentToml('name = "worker"\n')).toEqual({ name: "worker" });
  });

  it("skips comment and blank lines", () => {
    expect(parseAgentToml('# a comment\n\nname = "worker"\n')).toEqual({
      name: "worker",
    });
  });

  it("drops the newline after a multi-line string's opening delimiter", () => {
    const source = 'body = """\nFirst line.\nSecond line.\n"""\n';
    expect(parseAgentToml(source)).toEqual({ body: "First line.\nSecond line.\n" });
  });

  it.each([
    ["a table header", '[agent]\nname = "worker"\n', /not a top-level key/u],
    ["a non-string value", "count = 1\n", /not a plain basic string/u],
    ["an unterminated basic string", 'name = "worker\n', /not a plain basic string/u],
    ["an escape in a basic string", 'name = "a\\"b"\n', /not a plain basic string/u],
    ["an escape in a multi-line string", 'body = """\na\\nb\n"""\n', /escape/u],
    ["a multi-line string never closed", 'body = """\ntext\n', /never closed/u],
    ["a key declared twice", 'name = "a"\nname = "b"\n', /more than once/u],
  ])("rejects %s", (_label, source, message) => {
    expect(() => parseAgentToml(source)).toThrow(message);
  });
});

describe("parseAgentMarkdown", () => {
  it("folds a block scalar and returns the body after the frontmatter", () => {
    const source = "---\nname: a\ndescription: >\n  First\n  second.\n---\n\nBody.\n";
    expect(parseAgentMarkdown(source)).toEqual({
      fields: { name: "a", description: "First second." },
      body: "\nBody.\n",
    });
  });

  it.each([
    ["a file with no frontmatter", "# Title\n", /frontmatter delimiter/u],
    ["frontmatter that is never closed", "---\nname: a\n", /never closed/u],
    ["a stray line", "---\n- stray\n---\n", /neither a key/u],
    ["a key declared twice", "---\nname: a\nname: b\n---\n", /more than once/u],
  ])("rejects %s", (_label, source, message) => {
    expect(() => parseAgentMarkdown(source)).toThrow(message);
  });
});
