import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// A required status check names a check run by its job's display name, and
// GitHub matches the two as plain strings. Rename a job, or gate it so it no
// longer runs on a pull request, and the ruleset waits forever for a check
// that never reports: every pull request is unmergeable and nothing local
// says why. So every context `.github/rulesets/main.json` requires must equal
// the name of a job that reports on every pull request.
//
// Like tests/workflows.test.ts, this reads the workflows with a line scanner
// rather than a YAML parser, which would be a new dependency. Every shape it
// cannot read is treated as "does not report on every pull request", so the
// failure is a context reported as unmatched — never a context passed on a
// guess.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = path.join(repoRoot, ".github", "workflows");
const rulesetPath = path.join(repoRoot, ".github", "rulesets", "main.json");

/** GitHub Actions' app id, which every required check here is pinned to. */
const GITHUB_ACTIONS_INTEGRATION_ID = 15368;

/** The activity types GitHub defaults `pull_request` to. */
const DEFAULT_PULL_REQUEST_TYPES = ["opened", "synchronize", "reopened"];

// --- scanning ----------------------------------------------------------------

interface Line {
  indent: number;
  /** Trimmed content with any trailing comment removed. */
  text: string;
}

/** Structural lines only: blanks, comments and block-scalar bodies are dropped. */
function scan(source: string): Line[] {
  const lines: Line[] = [];
  let scalarIndent: number | null = null;
  for (const raw of source.split("\n")) {
    const text = raw.trim().replace(/\s+#.*$/, "");
    const indent = raw.length - raw.trimStart().length;
    if (scalarIndent !== null) {
      if (text === "" || indent > scalarIndent) {
        continue;
      }
      scalarIndent = null;
    }
    if (text === "" || text.startsWith("#")) {
      continue;
    }
    lines.push({ indent, text });
    if (/:\s*[|>][+-]?\d*$/.test(text)) {
      scalarIndent = indent;
    }
  }
  return lines;
}

/** The lines nested under `lines[index]`, including a same-column `- ` sequence. */
function blockOf(lines: readonly Line[], index: number): Line[] {
  const header = lines[index];
  if (header === undefined) {
    return [];
  }
  const ownsSameColumnSequence =
    header.text.endsWith(":") && !header.text.startsWith("- ");
  const body: Line[] = [];
  for (const line of lines.slice(index + 1)) {
    const nested =
      line.indent > header.indent ||
      (ownsSameColumnSequence &&
        line.indent === header.indent &&
        line.text.startsWith("- "));
    if (!nested) {
      break;
    }
    body.push(line);
  }
  return body;
}

/** The direct children of a block: the lines at its first line's indent. */
function children(body: readonly Line[]): { line: Line; index: number }[] {
  const first = body[0];
  if (first === undefined) {
    return [];
  }
  return body
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.indent === first.indent);
}

/** `key` of a `key:` or `key: value` line, unquoted; undefined for anything else. */
function keyOf(line: Line): string | undefined {
  const match = /^(["']?)([^"':]+)\1\s*:(\s|$)/.exec(line.text);
  return match?.[2];
}

function valueOf(line: Line): string {
  return line.text.slice(line.text.indexOf(":") + 1).trim();
}

function unquote(value: string): string {
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

/**
 * The items of an inline flow sequence (`[a, b]`) or of a block sequence under
 * a key; undefined when the value is neither — an expression, a mapping, a
 * scalar.
 */
function sequenceItems(value: string, body: readonly Line[]): string[] | undefined {
  if (value !== "") {
    if (!/^\[[^[\]{}]*\]$/.test(value)) {
      return undefined;
    }
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => unquote(item.trim()))
      .filter((item) => item !== "");
  }
  const items = children(body).map(({ line }) => line.text);
  if (items.length === 0 || !items.every((item) => item.startsWith("- "))) {
    return undefined;
  }
  return items.map((item) => unquote(item.slice(2).trim()));
}

/** Find `key:` among a block's direct children and return its line and body. */
function child(
  body: readonly Line[],
  key: string,
): { line: Line; body: Line[] } | undefined {
  const found = children(body).find(({ line }) => keyOf(line) === key);
  return found === undefined
    ? undefined
    : { line: found.line, body: blockOf(body, found.index) };
}

// --- triggers ----------------------------------------------------------------

/**
 * Whether a `pull_request` trigger's body leaves it firing on every pull
 * request: no filter but `types`, and `types` keeps every default activity.
 * A `paths`, `paths-ignore`, `branches` or `branches-ignore` filter, or any
 * key this scanner does not know, counts as not every pull request.
 */
function pullRequestBodyFiresAlways(value: string, body: readonly Line[]): boolean {
  if (value !== "" && value !== "{}" && value !== "null" && value !== "~") {
    return false;
  }
  return children(body).every(({ line, index }) => {
    if (keyOf(line) !== "types") {
      return false;
    }
    const types = sequenceItems(valueOf(line), blockOf(body, index));
    return (
      types !== undefined &&
      DEFAULT_PULL_REQUEST_TYPES.every((type) => types.includes(type))
    );
  });
}

/** Whether a workflow runs on every pull request. */
function runsOnEveryPullRequest(lines: readonly Line[]): boolean {
  const index = lines.findIndex(
    (line) => line.indent === 0 && /^["']?on["']?\s*:/.test(line.text),
  );
  const header = lines[index];
  if (header === undefined) {
    return false;
  }
  const inline = valueOf(header);
  if (inline !== "") {
    const events = inline.startsWith("[")
      ? sequenceItems(inline, [])
      : [unquote(inline)];
    return events?.includes("pull_request") ?? false;
  }
  const body = blockOf(lines, index);
  return children(body).some(({ line, index: at }) => {
    if (line.text.startsWith("- ")) {
      return unquote(line.text.slice(2).trim()) === "pull_request";
    }
    if (keyOf(line) !== "pull_request") {
      return false;
    }
    return pullRequestBodyFiresAlways(valueOf(line), blockOf(body, at));
  });
}

// --- jobs ----------------------------------------------------------------------

/**
 * Expand `${{ matrix.<key> }}` in a job name over a literal matrix. Undefined
 * when the name holds any other expression, or the matrix is not a plain
 * literal one (`include`, `exclude`, or a computed value).
 */
function expandName(name: string, jobBody: readonly Line[]): string[] | undefined {
  const keys = [...name.matchAll(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g)].map(
    (match) => match[1] ?? "",
  );
  const withoutMatrix = name.replace(/\$\{\{\s*matrix\.[\w-]+\s*\}\}/g, "");
  if (withoutMatrix.includes("${{")) {
    return undefined;
  }
  if (keys.length === 0) {
    return [name];
  }
  const strategy = child(jobBody, "strategy");
  const matrix = strategy === undefined ? undefined : child(strategy.body, "matrix");
  if (
    matrix === undefined ||
    valueOf(matrix.line) !== "" ||
    child(matrix.body, "include") !== undefined ||
    child(matrix.body, "exclude") !== undefined
  ) {
    return undefined;
  }
  let names = [name];
  for (const key of new Set(keys)) {
    const entry = child(matrix.body, key);
    const values =
      entry === undefined ? undefined : sequenceItems(valueOf(entry.line), entry.body);
    if (values === undefined || values.length === 0) {
      return undefined;
    }
    const pattern = new RegExp(`\\$\\{\\{\\s*matrix\\.${key}\\s*\\}\\}`, "g");
    names = names.flatMap((partial) =>
      values.map((value) => partial.replace(pattern, value)),
    );
  }
  return names;
}

/**
 * The check-run names of the jobs in one workflow that report on every pull
 * request: the workflow runs on every pull request, and the job carries no
 * job-level `if:` and calls no reusable workflow.
 */
function reportingJobNames(source: string): string[] {
  const lines = scan(source);
  if (!runsOnEveryPullRequest(lines)) {
    return [];
  }
  const jobsIndex = lines.findIndex(
    (line) => line.indent === 0 && keyOf(line) === "jobs",
  );
  if (jobsIndex === -1) {
    return [];
  }
  const jobsBody = blockOf(lines, jobsIndex);
  return children(jobsBody).flatMap(({ line, index }) => {
    const id = keyOf(line);
    const body = blockOf(jobsBody, index);
    if (
      id === undefined ||
      child(body, "if") !== undefined ||
      child(body, "uses") !== undefined
    ) {
      return [];
    }
    const declared = child(body, "name");
    const name = declared === undefined ? id : unquote(valueOf(declared.line));
    return expandName(name, body) ?? [];
  });
}

// --- the committed files -------------------------------------------------------

interface RequiredCheck {
  context: string;
  integrationId: unknown;
}

function readRuleset(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(rulesetPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(".github/rulesets/main.json is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function rulesOf(ruleset: Record<string, unknown>): Record<string, unknown>[] {
  const rules = ruleset["rules"];
  return Array.isArray(rules)
    ? rules.filter(
        (rule): rule is Record<string, unknown> =>
          typeof rule === "object" && rule !== null,
      )
    : [];
}

function parametersOf(
  ruleset: Record<string, unknown>,
  type: string,
): Record<string, unknown> | undefined {
  const parameters = rulesOf(ruleset).find((rule) => rule["type"] === type)?.[
    "parameters"
  ];
  return typeof parameters === "object" && parameters !== null
    ? (parameters as Record<string, unknown>)
    : undefined;
}

function requiredChecks(ruleset: Record<string, unknown>): RequiredCheck[] {
  const checks = parametersOf(ruleset, "required_status_checks")?.[
    "required_status_checks"
  ];
  if (!Array.isArray(checks)) {
    return [];
  }
  return checks.map((check: unknown) => {
    const record =
      typeof check === "object" && check !== null
        ? (check as Record<string, unknown>)
        : {};
    return {
      context: typeof record["context"] === "string" ? record["context"] : "",
      integrationId: record["integration_id"],
    };
  });
}

function committedReportingNames(): Map<string, string> {
  const names = new Map<string, string>();
  for (const file of readdirSync(workflowsDir).sort()) {
    if (!/\.ya?ml$/.test(file)) {
      continue;
    }
    const source = readFileSync(path.join(workflowsDir, file), "utf8");
    for (const name of reportingJobNames(source)) {
      names.set(name, file);
    }
  }
  return names;
}

describe(".github/rulesets/main.json", () => {
  const ruleset = readRuleset();
  const checks = requiredChecks(ruleset);

  it("requires every context from a job that reports on every pull request", () => {
    const reporting = committedReportingNames();
    const unmatched = checks
      .map((check) => check.context)
      .filter((context) => !reporting.has(context));

    expect(unmatched).toEqual([]);
  });

  it("requires at least one check, each once, each from GitHub Actions", () => {
    const contexts = checks.map((check) => check.context);

    expect(contexts.length).toBeGreaterThan(0);
    expect(new Set(contexts).size).toBe(contexts.length);
    expect(contexts.filter((context) => context === "")).toEqual([]);
    expect(
      checks.filter((check) => check.integrationId !== GITHUB_ACTIONS_INTEGRATION_ID),
    ).toEqual([]);
  });

  it("protects the default branch with no bypass actor", () => {
    expect(ruleset["name"]).toBe("main");
    expect(ruleset["target"]).toBe("branch");
    expect(ruleset["enforcement"]).toBe("active");
    expect(ruleset["conditions"]).toEqual({
      ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
    });
    expect(ruleset["bypass_actors"]).toEqual([]);
  });

  it("blocks deletion and force-pushes and requires a pull request with no approval", () => {
    const types = rulesOf(ruleset).map((rule) => rule["type"]);

    expect(types).toEqual(
      expect.arrayContaining([
        "deletion",
        "non_fast_forward",
        "pull_request",
        "required_status_checks",
      ]),
    );
    expect(
      parametersOf(ruleset, "pull_request")?.["required_approving_review_count"],
    ).toBe(0);
  });
});

describe("reportingJobNames", () => {
  const job = (header: string) =>
    `jobs:\n  build:\n${header}    runs-on: ubuntu-latest\n    steps:\n      - run: true\n`;

  it.each([
    ["a block `pull_request:` with no filter", "on:\n  pull_request:\n", ["build"]],
    ["an inline scalar", "on: pull_request\n", ["build"]],
    ["an inline flow sequence", "on: [push, pull_request]\n", ["build"]],
    ["a block sequence", "on:\n  - push\n  - pull_request\n", ["build"]],
    ["a quoted `on` key", '"on":\n  pull_request:\n', ["build"]],
    [
      "a `types` filter that keeps every default type",
      "on:\n  pull_request:\n    types: [opened, reopened, edited, synchronize]\n",
      ["build"],
    ],
    [
      "a `types` filter that drops `synchronize`",
      "on:\n  pull_request:\n    types: [opened, reopened]\n",
      [],
    ],
    ["a `paths` filter", "on:\n  pull_request:\n    paths: [src/**]\n", []],
    [
      "a `paths-ignore` filter",
      "on:\n  pull_request:\n    paths-ignore:\n      - docs/**\n",
      [],
    ],
    ["a `branches` filter", "on:\n  pull_request:\n    branches: [main]\n", []],
    ["push alone", "on:\n  push:\n    branches: [main]\n", []],
    ["`pull_request_target` alone", "on:\n  pull_request_target:\n", []],
    ["a schedule alone", 'on:\n  schedule:\n    - cron: "0 6 * * 1"\n', []],
  ])("reads a workflow triggered by %s", (_label, on, expected) => {
    expect(reportingJobNames(on + job(""))).toEqual(expected);
  });

  it("uses the job's `name:` over its id, unquoted", () => {
    expect(
      reportingJobNames("on: pull_request\n" + job('    name: "Static checks"\n')),
    ).toEqual(["Static checks"]);
  });

  it("drops a job gated by a job-level `if:`", () => {
    expect(
      reportingJobNames(
        "on: pull_request\n" + job("    name: Gated\n    if: github.actor == 'x'\n"),
      ),
    ).toEqual([]);
  });

  it("keeps a job whose `if:` is on a step rather than on the job", () => {
    const source =
      "on: pull_request\njobs:\n  build:\n    name: Kept\n    runs-on: ubuntu-latest\n" +
      "    steps:\n      - if: always()\n        run: true\n";
    expect(reportingJobNames(source)).toEqual(["Kept"]);
  });

  it("drops a job that calls a reusable workflow", () => {
    expect(
      reportingJobNames(
        "on: pull_request\njobs:\n  call:\n    name: Called\n    uses: ./.github/workflows/x.yml\n",
      ),
    ).toEqual([]);
  });

  it.each([
    ["a flow sequence", "os: [ubuntu-latest, macos-latest]"],
    ["a block sequence", "os:\n          - ubuntu-latest\n          - macos-latest"],
  ])("expands a literal matrix written as %s", (_label, matrix) => {
    const source =
      "on: pull_request\njobs:\n  test:\n    name: Test (${{ matrix.os }})\n" +
      `    strategy:\n      matrix:\n        ${matrix}\n` +
      "    runs-on: ${{ matrix.os }}\n";
    expect(reportingJobNames(source)).toEqual([
      "Test (ubuntu-latest)",
      "Test (macos-latest)",
    ]);
  });

  it.each([
    ["an `include` list", "os: [ubuntu-latest]\n        include:\n          - os: x"],
    ["a computed matrix value", "os: ${{ fromJSON(inputs.os) }}"],
    ["a missing matrix key", "node: [24]"],
  ])("drops a matrix name it cannot expand: %s", (_label, matrix) => {
    const source =
      "on: pull_request\njobs:\n  test:\n    name: Test (${{ matrix.os }})\n" +
      `    strategy:\n      matrix:\n        ${matrix}\n`;
    expect(reportingJobNames(source)).toEqual([]);
  });

  it("drops a name built from an expression other than the matrix", () => {
    expect(
      reportingJobNames(
        "on: pull_request\n" + job("    name: Build ${{ github.event_name }}\n"),
      ),
    ).toEqual([]);
  });
});
