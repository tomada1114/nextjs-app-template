import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// GitHub Actions cannot be executed from here, so the properties spec 02 §5.1
// requires of every workflow are asserted against the files instead. This is
// the local evidence for DoD G.
//
// The scanner below is deliberately not a YAML parser. A parser would be a new
// dependency for a repository whose whole point is a small, reviewable
// dependency surface, and every rule here is about the *text* of a line — a
// pinned SHA, a trailing release-tag comment, a flag on a command — which
// survives round-tripping through a parser only by accident.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = path.join(repoRoot, ".github", "workflows");

// --- scanning ----------------------------------------------------------------

/** One structurally significant line: blanks, comments and block scalars are out. */
interface Line {
  /** Leading space count, which is what nesting is expressed with in YAML. */
  indent: number;
  /** Trimmed content with any trailing comment removed. */
  text: string;
  /** Original line including its trailing comment. */
  raw: string;
  /** 1-based line number, so a failure names a place a reader can open. */
  number: number;
}

/**
 * Split a workflow into structural lines.
 *
 * @remarks
 * Content of a block scalar (`run: |`) is skipped: a shell script contains
 * `#` comments, colons and `-` list markers that would otherwise read as YAML
 * structure. {@link runCommands} reads those bodies separately.
 */
function scan(source: string): Line[] {
  const lines: Line[] = [];
  let scalarIndent: number | null = null;

  source.split("\n").forEach((raw, index) => {
    // Trailing comments are dropped so that documenting a permission scope
    // does not change what a line means here. A `#` inside a quoted value
    // would be cut too, which is why shell bodies are read from the raw
    // source by `runCommands` instead.
    const text = raw.trim().replace(/\s+#.*$/, "");
    const indent = raw.length - raw.trimStart().length;

    if (scalarIndent !== null) {
      if (text === "" || indent > scalarIndent) {
        return;
      }
      scalarIndent = null;
    }
    if (text === "" || raw.trimStart().startsWith("#")) {
      return;
    }

    lines.push({ indent, text, raw, number: index + 1 });
    if (/:\s*[|>][+-]?\d*$/.test(text)) {
      scalarIndent = indent;
    }
  });

  return lines;
}

/**
 * The lines nested under `lines[headerIndex]`.
 *
 * @remarks
 * Indentation is not the whole story. A block sequence may be written at its
 * key's own column (`steps:` followed by `- uses:` in the same column), which
 * is legal YAML that reads as no body at all when only more deeply indented
 * lines count — and a rule handed an empty body passes without checking
 * anything. So a key awaiting a block value claims same-column `- ` entries
 * too. A header that is itself a sequence entry claims none: the next entry at
 * that column is its sibling, not its child, and swallowing it would merge
 * every step of a job into the first one.
 */
function blockOf(lines: Line[], headerIndex: number): Line[] {
  const header = lines[headerIndex];
  if (header === undefined) {
    return [];
  }
  const ownsSameColumnSequence =
    header.text.endsWith(":") && !header.text.startsWith("- ");

  const body: Line[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }
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

/** The value written after `key:` on the same line, or `""` when the value is a block. */
function inlineValue(line: Line): string {
  return line.text.slice(line.text.indexOf(":") + 1).trim();
}

function topLevel(lines: Line[], key: string): Line | undefined {
  return lines.find((line) => line.indent === 0 && line.text.startsWith(`${key}:`));
}

/**
 * The top-level `on:` line, however its key is spelled.
 *
 * @remarks
 * `on` is a YAML 1.1 boolean, so a workflow is free to quote the key to keep it
 * a string; GitHub reads `on:`, `"on":` and `'on':` alike. Every trigger rule
 * goes through here so that adding two quote characters cannot make a workflow
 * look as though it declares no triggers at all.
 */
function triggerLine(lines: Line[]): Line | undefined {
  return lines.find((line) => line.indent === 0 && /^["']?on["']?\s*:/.test(line.text));
}

interface Trigger {
  /** The event name alone: no `- ` marker, no quotes, no trailing `:`. */
  name: string;
  /** Where a report points: the entry's own line, or `on:` for an inline value. */
  line: Line;
}

/** The outermost entries of a flow collection, split on the commas at depth zero. */
function flowEntries(value: string): string[] {
  const body = value.slice(1, -1);
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body.charAt(index);
    if (character === "[" || character === "{") {
      depth += 1;
    } else if (character === "]" || character === "}") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      entries.push(body.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(body.slice(start));
  return entries;
}

/** The event an entry names, or `undefined` when it names none. */
function eventName(entry: string): string | undefined {
  return /^["']?([A-Za-z_][A-Za-z0-9_-]*)/.exec(entry.trim().replace(/^-\s+/, ""))?.[1];
}

/**
 * Every event `on:` declares, in whichever of its four shapes it is written:
 * an inline scalar, a flow collection, a block sequence, or a mapping.
 *
 * @remarks
 * Every trigger rule reads `on:` through here, so what it declares is decided
 * once rather than once per rule, each with its own blind spot. Only the
 * outermost entries count, so a nested `branches:` list that happens to hold an
 * event name is not one of them.
 */
function triggerNames(lines: Line[]): Trigger[] {
  const on = triggerLine(lines);
  if (on === undefined) {
    return [];
  }

  const named = (name: string | undefined, line: Line): Trigger[] =>
    name === undefined ? [] : [{ name, line }];

  const inline = inlineValue(on);
  if (inline !== "") {
    const entries = /^[[{]/.test(inline) ? flowEntries(inline) : [inline];
    return entries.flatMap((entry) => named(eventName(entry), on));
  }

  const events = blockOf(lines, lines.indexOf(on));
  const first = events[0];
  if (first === undefined) {
    return [];
  }
  const eventIndent = first.indent;

  // A block body is a sequence (every outermost entry is a trigger) or a
  // mapping (every outermost key is a trigger). YAML lets a mapping value be
  // written as a sequence at its key's own column, which puts a sequence item
  // at the same indent as the key it belongs to — so in a mapping body, an
  // outermost `- ` line is that key's value, never a sibling trigger.
  const isSequence = first.text.startsWith("- ");
  return events.flatMap((line) => {
    if (line.indent !== eventIndent) {
      return [];
    }
    if (!isSequence && line.text.startsWith("- ")) {
      return [];
    }
    return named(eventName(line.text), line);
  });
}

/** The line on which `on:` names `pull_request_target`, if any. */
function pullRequestTargetLine(lines: Line[]): Line | undefined {
  return triggerNames(lines).find(({ name }) => name === "pull_request_target")?.line;
}

/**
 * The top-level `on:` line, when its inline value opens a flow collection
 * (`[` or `{`) that never closes again on that same physical line.
 *
 * @remarks
 * A flow collection is legal YAML spread across several physical lines
 * (`on: [` … `]`), but {@link scan} reads one physical line at a time and
 * nothing rejoins them into a single value. Fed a lone `[`, {@link
 * flowEntries} slices it to `""`, {@link eventName} reports no event for
 * that, and {@link triggerNames} comes back empty — silently, with no
 * problem reported. That would let a workflow declare `pull_request_target`
 * past `ERR_WORKFLOW_PULL_REQUEST_TARGET` and skip
 * `ERR_WORKFLOW_CONCURRENCY_MISSING` too, so this is read for and reported on
 * directly rather than parsed: failing closed on an `on:` this lint cannot
 * finish reading is cheaper, and strictly safer, than teaching the scanner to
 * rejoin physical lines into one flow value.
 */
function unterminatedFlowOn(lines: Line[]): Line | undefined {
  const on = triggerLine(lines);
  if (on === undefined) {
    return undefined;
  }
  const inline = inlineValue(on);
  if (!/^[[{]/.test(inline)) {
    return undefined;
  }
  let depth = 0;
  for (const character of inline) {
    if (character === "[" || character === "{") {
      depth += 1;
    } else if (character === "]" || character === "}") {
      depth -= 1;
    }
  }
  return depth !== 0 ? on : undefined;
}

interface Job {
  name: string;
  header: Line;
  body: Line[];
}

function jobsOf(lines: Line[]): Job[] {
  const jobsIndex = lines.findIndex(
    (line) => line.indent === 0 && line.text === "jobs:",
  );
  if (jobsIndex === -1) {
    return [];
  }

  const body = blockOf(lines, jobsIndex);
  const jobs: Job[] = [];
  body.forEach((line, index) => {
    const name = /^([A-Za-z0-9_-]+):$/.exec(line.text)?.[1];
    if (line.indent === 2 && name !== undefined) {
      jobs.push({ name, header: line, body: blockOf(body, index) });
    }
  });
  return jobs;
}

/** Each step as its list-item line plus everything nested under it. */
function stepsOf(job: Job): Line[][] {
  const stepsIndex = job.body.findIndex(
    (line) => line.indent === job.header.indent + 2 && line.text === "steps:",
  );
  if (stepsIndex === -1) {
    return [];
  }

  const body = blockOf(job.body, stepsIndex);
  const first = body[0];
  if (first === undefined) {
    return [];
  }

  const steps: Line[][] = [];
  body.forEach((line, index) => {
    if (line.indent === first.indent && line.text.startsWith("- ")) {
      steps.push([line, ...blockOf(body, index)]);
    }
  });
  return steps;
}

/**
 * A key declared directly on the job, not somewhere inside one of its steps.
 *
 * @remarks
 * The depth matters: a `timeout-minutes` on a single step would otherwise read
 * as a timeout on the whole job, which is the opposite of what it means.
 */
function jobKey(job: Job, key: string): Line | undefined {
  return job.body.find(
    (line) => line.indent === job.header.indent + 2 && line.text.startsWith(`${key}:`),
  );
}

/** One `concurrency:` declaration, wherever GitHub Actions accepts it. */
interface ConcurrencyBlock {
  /** The job it is declared on, or `undefined` for the workflow-level block. */
  job: Job | undefined;
  /** The `concurrency:` line itself, which carries the flow-mapping spelling. */
  header: Line;
  /** The lines nested under `concurrency:`, where `cancel-in-progress` lives. */
  body: Line[];
  /** Whether the declaration names a group, which is what a run is queued against. */
  groups: boolean;
}

/** The key and value of one entry of a flow mapping, when it is written as a pair. */
const FLOW_PAIR = /^["']?([A-Za-z_][A-Za-z0-9_-]*)["']?\s*:\s*(.*)$/;

/** The value a flow-mapping entry gives `key`, or `undefined` when it names another. */
function flowValue(entry: string, key: string): string | undefined {
  const pair = FLOW_PAIR.exec(entry.trim());
  return pair?.[1] === key ? pair[2]?.trim() : undefined;
}

/**
 * Whether a `concurrency:` declaration groups anything at all.
 *
 * @remarks
 * `group` is what GitHub queues a run against, so a bare `concurrency:` key
 * with no body groups nothing and cancels nothing. Reading the key alone would
 * let a declaration that grants nothing satisfy the rule that asks for the
 * grouping — a gate silenced by the shape of a line rather than by its meaning.
 * The scalar shorthand (`concurrency: staging`) *is* the group, and the flow
 * mapping has to name one the same way the block form does.
 */
function namesGroup(header: Line, body: Line[]): boolean {
  const inline = inlineValue(header);
  if (inline.startsWith("{")) {
    return flowEntries(inline).some((entry) => {
      const group = flowValue(entry, "group");
      return group !== undefined && group !== "";
    });
  }
  if (inline !== "") {
    return true;
  }
  return body.some(
    (line) => line.text.startsWith("group:") && inlineValue(line) !== "",
  );
}

/**
 * Every `concurrency:` block the workflow declares, at either level.
 *
 * @remarks
 * GitHub Actions accepts `concurrency:` on the workflow **and** on a job, and
 * both rules below read the declaration through here so neither is anchored at
 * column zero. A rule that only looked at the top level reported a workflow
 * cancelling its own push runs as safe — the group is real either way, and so
 * is the CI record it destroys.
 */
function concurrencyBlocks(lines: Line[], jobs: Job[]): ConcurrencyBlock[] {
  const declared = (job: Job | undefined, scope: Line[], header: Line | undefined) => {
    if (header === undefined) {
      return [];
    }
    const body = blockOf(scope, scope.indexOf(header));
    return [{ job, header, body, groups: namesGroup(header, body) }];
  };

  return [
    ...declared(undefined, lines, topLevel(lines, "concurrency")),
    ...jobs.flatMap((job) => declared(job, job.body, jobKey(job, "concurrency"))),
  ];
}

/**
 * The line whose `cancel-in-progress: true` cancels a superseded run.
 *
 * @remarks
 * Both spellings count. A `concurrency:` with a body puts the key on its own
 * line; the flow mapping (`concurrency: { group: x, cancel-in-progress: true }`)
 * is the same declaration written on the header line, and a rule that read only
 * the body would find an empty one and pass — the same blind spot as reading
 * only column zero, in a different disguise.
 */
function unconditionalCancel(block: ConcurrencyBlock): Line | undefined {
  const cancel = block.body.find((line) => line.text.startsWith("cancel-in-progress:"));
  if (cancel !== undefined) {
    return inlineValue(cancel) === "true" ? cancel : undefined;
  }
  const inline = inlineValue(block.header);
  if (!inline.startsWith("{")) {
    return undefined;
  }
  const cancels = flowEntries(inline).some(
    (entry) => flowValue(entry, "cancel-in-progress") === "true",
  );
  return cancels ? block.header : undefined;
}

/**
 * Whether a job's own `if:` pins it to a pull-request event.
 *
 * @remarks
 * Such a job never runs on push, so the run its cancellation discards is never
 * a merged commit's only CI record and the rule below has nothing to report —
 * a message naming the job would assert what the `if:` denies. The reading is
 * deliberately narrow: a `||` makes the pull-request term one alternative among
 * several and a negation turns it inside out, so an expression this cannot be
 * certain of leaves the rule reporting rather than silently switching it off.
 */
function pinnedToPullRequest(job: Job): boolean {
  const condition = jobKey(job, "if");
  if (condition === undefined) {
    return false;
  }
  const expression = inlineValue(condition)
    .replace(/^\$\{\{/, "")
    .replace(/\}\}$/, "");
  if (expression.includes("||") || /!(?!=)/.test(expression)) {
    return false;
  }
  return /github\.event_name\s*==\s*(["'])pull_request\1/.test(expression);
}

interface UsesRef {
  line: Line;
  ref: string;
}

function usesOf(lines: Line[]): UsesRef[] {
  const refs: UsesRef[] = [];
  for (const line of lines) {
    const ref = /^(?:- )?uses:\s*(\S+)/.exec(line.text)?.[1];
    if (ref !== undefined) {
      refs.push({ line, ref });
    }
  }
  return refs;
}

interface RunCommand {
  line: number;
  command: string;
}

/** Every `run:` body, single line or block scalar, with its starting line number. */
function runCommands(source: string): RunCommand[] {
  const rawLines = source.split("\n");
  const commands: RunCommand[] = [];

  rawLines.forEach((raw, index) => {
    const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(raw);
    const indentText = match?.[1];
    const value = match?.[2];
    if (indentText === undefined || value === undefined) {
      return;
    }

    if (!/^[|>][+-]?\d*$/.test(value.trim())) {
      commands.push({ line: index + 1, command: value });
      return;
    }

    const indent = indentText.length;
    const body: string[] = [];
    for (let next = index + 1; next < rawLines.length; next += 1) {
      const bodyLine = rawLines[next];
      if (bodyLine === undefined) {
        break;
      }
      const bodyIndent = bodyLine.length - bodyLine.trimStart().length;
      if (bodyLine.trim() !== "" && bodyIndent <= indent) {
        break;
      }
      body.push(bodyLine);
    }
    commands.push({ line: index + 1, command: body.join("\n") });
  });

  return commands;
}

/**
 * The `run.shell` a `defaults:` block declares, or `undefined` when it declares
 * none — including when there is no `defaults:` block at all.
 *
 * @param scope - The line list `defaults` was found in: `lines` for the
 * workflow-level block, a job's own body for a job-level one.
 */
function defaultsRunShell(
  scope: Line[],
  defaults: Line | undefined,
): string | undefined {
  if (defaults === undefined) {
    return undefined;
  }
  return blockOf(scope, scope.indexOf(defaults))
    .filter((line) => line.text.startsWith("shell:"))
    .map((line) => inlineValue(line))[0];
}

/**
 * The `shell:` the step covering `lineNumber` declares for itself, if any.
 *
 * @remarks
 * A step's own `shell:` overrides both `defaults:` blocks, so it is the last
 * word on how a `run:` body is executed. Only the step's own keys count: the
 * depth check keeps a `shell` nested inside a `with:` — an action input that
 * happens to share the name — from reading as the step's shell.
 */
function stepShellAtLine(job: Job, lineNumber: number): string | undefined {
  const step = stepsOf(job).find((lines) =>
    lines.some((line) => line.number === lineNumber),
  );
  const header = step?.[0];
  if (step === undefined || header === undefined) {
    return undefined;
  }
  const inline = /^- shell:\s*(.*)$/.exec(header.text)?.[1];
  return (
    inline ??
    step
      .filter(
        (line) => line.indent === header.indent + 2 && line.text.startsWith("shell:"),
      )
      .map((line) => inlineValue(line))[0]
  );
}

/**
 * Whether a shell string makes a `run:` body fail closed on its own.
 *
 * @remarks
 * All three halves are required. `pipefail` alone still lets an unset variable
 * expand to the empty string, which is what `-u` is there to stop; and without
 * `errexit` a command that fails part-way through a script does not stop the
 * job, so the step reports success after the failure. `-e` and `-u` are each
 * matched as a letter anywhere in a cluster (`bash -euo pipefail {0}`), where
 * neither literal appears on its own, or under its long-option name
 * (`-o errexit`), which is the same shell spelled out.
 */
function isFailClosedShell(shell: string | undefined): boolean {
  if (shell?.includes("pipefail") !== true) {
    return false;
  }
  const errexit = /(?:^|\s)-[A-Za-z]*e/.test(shell) || /\berrexit\b/.test(shell);
  const nounset = /(?:^|\s)-[A-Za-z]*u/.test(shell) || /\bnounset\b/.test(shell);
  return errexit && nounset;
}

/** The job whose structural lines cover `lineNumber`, if any. */
function jobAtLine(jobs: Job[], lineNumber: number): Job | undefined {
  return jobs.find(
    (job) =>
      job.header.number === lineNumber ||
      job.body.some((line) => line.number === lineNumber),
  );
}

/** The index of the first step in `steps` that uses an action starting with `prefix`. */
function stepUsing(steps: Line[][], prefix: string): number {
  return steps.findIndex((step) =>
    usesOf(step).some(({ ref }) => ref.startsWith(prefix)),
  );
}

// --- rules -------------------------------------------------------------------

/** One workflow property that spec 02 §5.1 requires and this file does not have. */
interface Problem {
  /** Stable identifier, safe to match in a test. */
  code: string;
  /** Line the reader should open. */
  line: number;
  /** What is wrong and what it should be instead. */
  message: string;
}

/** A third-party or first-party action reference that must carry a full SHA. */
const PINNED_REF = /^[^@\s]+@[0-9a-f]{40}$/;
/** The release tag a pinned SHA must be annotated with, so the pin stays readable. */
const TAG_COMMENT = /#\s*v\d+\.\d+\.\d+/;

function lintWorkflow(source: string): Problem[] {
  const lines = scan(source);
  const problems: Problem[] = [];
  const report = (code: string, line: number, message: string): void => {
    problems.push({ code, line, message });
  };

  // An `on:` this lint cannot finish reading must not silently pass as "no
  // triggers": that is exactly the shape a pull_request_target could hide in.
  const unreadableOn = unterminatedFlowOn(lines);
  if (unreadableOn !== undefined) {
    report(
      "ERR_WORKFLOW_ON_UNREADABLE",
      unreadableOn.number,
      "on: opens a flow collection ([ or {) that continues onto later lines. This lint cannot read a flow collection split across physical lines — rewrite it as a block sequence/mapping, or keep it on one line.",
    );
  }

  const pullRequestTarget = pullRequestTargetLine(lines);
  if (pullRequestTarget !== undefined) {
    report(
      "ERR_WORKFLOW_PULL_REQUEST_TARGET",
      pullRequestTarget.number,
      "pull_request_target runs fork code with a writable token. Use pull_request.",
    );
  }

  // Actions are pinned to a full commit SHA and annotated with their release tag.
  for (const { line, ref } of usesOf(lines)) {
    if (ref.startsWith("./")) {
      continue;
    }
    if (!PINNED_REF.test(ref)) {
      report(
        "ERR_WORKFLOW_ACTION_NOT_PINNED",
        line.number,
        `${ref} is not pinned to a 40-character commit SHA.`,
      );
      continue;
    }
    if (!TAG_COMMENT.test(line.raw)) {
      report(
        "ERR_WORKFLOW_ACTION_TAG_COMMENT_MISSING",
        line.number,
        `${ref} has no trailing "# vX.Y.Z" comment, so the pin cannot be read.`,
      );
    }
  }

  // Top-level permissions are empty or read-only; jobs opt in to what they need.
  const permissions = topLevel(lines, "permissions");
  if (permissions === undefined) {
    report(
      "ERR_WORKFLOW_PERMISSIONS_MISSING",
      1,
      "No top-level permissions. Declare `permissions: {}` and grant per job.",
    );
  } else {
    const inline = inlineValue(permissions);
    const block = blockOf(lines, lines.indexOf(permissions)).map((line) => line.text);
    const readOnly =
      inline === "{}" ||
      (inline === "" && block.every((entry) => entry === "contents: read"));
    if (!readOnly) {
      report(
        "ERR_WORKFLOW_PERMISSIONS_TOO_BROAD",
        permissions.number,
        "Top-level permissions must be `{}` or `contents: read`.",
      );
    }
  }

  const jobs = jobsOf(lines);
  if (jobs.length === 0) {
    report("ERR_WORKFLOW_NO_JOBS", 1, "The workflow declares no jobs.");
  }

  for (const job of jobs) {
    if (jobKey(job, "timeout-minutes") === undefined) {
      report(
        "ERR_WORKFLOW_JOB_TIMEOUT_MISSING",
        job.header.number,
        `Job "${job.name}" has no timeout-minutes.`,
      );
    }

    const jobPermissions = jobKey(job, "permissions");
    if (jobPermissions === undefined) {
      report(
        "ERR_WORKFLOW_PERMISSIONS_MISSING",
        job.header.number,
        `Job "${job.name}" does not declare its own permissions.`,
      );
    } else {
      const scopes = [
        inlineValue(jobPermissions),
        ...blockOf(job.body, job.body.indexOf(jobPermissions)).map((line) => line.text),
      ];
      if (scopes.includes("write-all")) {
        report(
          "ERR_WORKFLOW_PERMISSIONS_TOO_BROAD",
          jobPermissions.number,
          `Job "${job.name}" grants write-all. List the scopes it actually needs.`,
        );
      }
    }

    // A rule that cannot see its input must not report the safety it never
    // checked. Every step rule below reads `stepsOf`, so a job whose steps the
    // scanner cannot reach is a hole in all of them at once, and is reported as
    // one rather than passing. A job that calls a reusable workflow declares
    // `uses:` on itself and has no steps to find.
    const jobSteps = stepsOf(job);
    if (jobSteps.length === 0 && jobKey(job, "uses") === undefined) {
      report(
        "ERR_WORKFLOW_JOB_STEPS_UNREADABLE",
        job.header.number,
        `Job "${job.name}" declares no steps this lint can read, so every step rule would pass without inspecting anything.`,
      );
    }

    // Checkout must not leave a usable credential behind for later steps.
    for (const step of jobSteps) {
      const checkout = usesOf(step).find(({ ref }) =>
        ref.startsWith("actions/checkout@"),
      );
      if (checkout === undefined) {
        continue;
      }
      const persists = step.some((line) => line.text === "persist-credentials: false");
      if (!persists) {
        report(
          "ERR_WORKFLOW_CHECKOUT_CREDENTIALS",
          checkout.line.number,
          "actions/checkout needs `persist-credentials: false`.",
        );
      }
    }
  }

  // setup-node's default package-manager cache resolves the pnpm store path by
  // invoking pnpm. A setup-node that runs first finds no pnpm on PATH, so it
  // silently caches nothing — the failure mode is a slow job, never an error.
  for (const job of jobs) {
    const steps = stepsOf(job);
    const pnpmIndex = stepUsing(steps, "pnpm/action-setup@");
    const nodeIndex = stepUsing(steps, "actions/setup-node@");
    if (pnpmIndex === -1 || nodeIndex === -1 || pnpmIndex < nodeIndex) {
      continue;
    }
    report(
      "ERR_WORKFLOW_SETUP_ORDER",
      steps[nodeIndex]?.[0]?.number ?? job.header.number,
      `Job "${job.name}" runs actions/setup-node before pnpm/action-setup, so the pnpm store cache never engages.`,
    );
  }

  // A pull request that is pushed to again must not keep the superseded run alive.
  const on = triggerLine(lines);
  const triggers = triggerNames(lines);
  const onPullRequest = triggers.some(({ name }) => name.startsWith("pull_request"));
  const onPush = triggers.some(({ name }) => name === "push");
  const concurrency = concurrencyBlocks(lines, jobs);
  // A workflow-level block covers every job; a job-level one covers its own job
  // and nothing else. So declaring it per job satisfies this rule only when
  // every job does — otherwise one block on a trivial job would switch the rule
  // off for the jobs that still leave a superseded run alive.
  // A block that names no group is not one of these: it queues nothing, so it
  // cannot cancel the superseded run this rule exists to ask for.
  const covered =
    concurrency.some(({ job, groups }) => job === undefined && groups) ||
    (jobs.length > 0 &&
      jobs.every((job) =>
        concurrency.some((block) => block.job === job && block.groups),
      ));
  if (onPullRequest && !covered) {
    report(
      "ERR_WORKFLOW_CONCURRENCY_MISSING",
      on?.number ?? 1,
      "A pull-request workflow needs `concurrency` so superseded runs are cancelled.",
    );
  }

  // Cancelling is right for a superseded pull request and wrong for a push: the
  // run being killed is the only CI or analysis record a merged commit gets.
  // That is as true of a job-level block as of the workflow-level one, so both
  // are read here rather than only the one at column zero.
  if (onPullRequest && onPush) {
    for (const block of concurrency) {
      // A job pinned to a pull request by its own `if:` does not run on push,
      // so cancelling its runs destroys no push record.
      if (block.job !== undefined && pinnedToPullRequest(block.job)) {
        continue;
      }
      const cancel = unconditionalCancel(block);
      if (cancel === undefined) {
        continue;
      }
      report(
        "ERR_WORKFLOW_CONCURRENCY_CANCELS_PUSH",
        cancel.number,
        block.job === undefined
          ? "This workflow also runs on push. Make cancel-in-progress conditional on the event being a pull request."
          : `Job "${block.job.name}" also runs on push. Make cancel-in-progress conditional on the event being a pull request.`,
      );
    }
  }

  // The runner's default shell is `bash -e`: an unset variable expands to the
  // empty string and a failure inside a pipeline is invisible. A script long
  // enough to need a second line is long enough for either to read as success.
  const topLevelShell = defaultsRunShell(lines, topLevel(lines, "defaults"));
  for (const { line, command } of runCommands(source)) {
    const body = command
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "" && !entry.startsWith("#"));
    if (body.length <= 1 || body[0] === "set -euo pipefail") {
      continue;
    }

    // Each level replaces the one above rather than adding to it: a job-level
    // `defaults:` discards the workflow-level one, and a step's own `shell:`
    // discards both. So the shell this body runs under is the innermost one
    // that names a shell at all.
    const job = jobAtLine(jobs, line);
    const jobShell =
      job === undefined
        ? undefined
        : defaultsRunShell(job.body, jobKey(job, "defaults"));
    const stepShell = job === undefined ? undefined : stepShellAtLine(job, line);
    if (isFailClosedShell(stepShell ?? jobShell ?? topLevelShell)) {
      continue;
    }

    report(
      "ERR_WORKFLOW_RUN_NOT_PIPEFAIL",
      line,
      'A multi-line run block must start with `set -euo pipefail`, or run under a defaults.run.shell that spells pipefail out — `shell: bash` is not enough, it leaves -u off. Expected: shell: "bash --noprofile --norc -eo pipefail -u {0}".',
    );
  }

  // An install that may resolve something other than the committed lockfile
  // would make every other gate advisory.
  for (const { line, command } of runCommands(source)) {
    for (const part of command.split("\n")) {
      if (
        /\bpnpm\b[^\n;&|]*\binstall\b/.test(part) &&
        !part.includes("--frozen-lockfile")
      ) {
        report(
          "ERR_WORKFLOW_INSTALL_NOT_FROZEN",
          line,
          `"${part.trim()}" installs without --frozen-lockfile.`,
        );
      }
    }
  }

  return problems;
}

// --- version agreement -------------------------------------------------------

/**
 * Every `version:` a pnpm/action-setup step states.
 *
 * @remarks
 * Expected to be empty: the action reads `packageManager` from package.json,
 * and that field is the only place the pnpm version is written.
 */
function pnpmSetupVersions(source: string): string[] {
  const lines = scan(source);
  const versions: string[] = [];

  for (const job of jobsOf(lines)) {
    for (const step of stepsOf(job)) {
      if (!usesOf(step).some(({ ref }) => ref.startsWith("pnpm/action-setup@"))) {
        continue;
      }
      const version = step
        .map((line) => /^version:\s*"?([\w.-]+)"?$/.exec(line.text)?.[1])
        .find((value) => value !== undefined);
      if (version !== undefined) {
        versions.push(version);
      }
    }
  }
  return versions;
}

// --- fixtures ----------------------------------------------------------------

/** A workflow that satisfies every rule; each test below breaks exactly one thing. */
const CLEAN_WORKFLOW = `name: Example

on:
  pull_request:

permissions: {}

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Install dependencies
        run: pnpm install --frozen-lockfile
`;

/** The same workflow with its one `run:` turned into a block scalar. */
const MULTI_LINE_RUN_WORKFLOW = CLEAN_WORKFLOW.replace(
  "        run: pnpm install --frozen-lockfile\n",
  [
    "        run: |",
    "          pnpm install --frozen-lockfile",
    "          node ./scripts/after.mjs",
    "",
  ].join("\n"),
);

/**
 * The same workflow with its `steps:` sequence written at the key's own column.
 *
 * @remarks
 * A block sequence may start in the same column as the key it belongs to, so
 * this is the same workflow GitHub runs. It is also the spelling a body read by
 * indentation alone sees as no steps at all, which would let every step rule
 * pass without looking at anything.
 */
const STEPS_AT_KEY_COLUMN_WORKFLOW = `name: Example

on:
  pull_request:

permissions: {}

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      with:
        persist-credentials: false

    - name: Install dependencies
      run: pnpm install --frozen-lockfile
`;

/**
 * The same workflow with a first step whose `- ` line is itself a block key.
 *
 * @remarks
 * `- env:` ends in a colon like any other key, so a body reader that decides
 * ownership on the colon alone lets this step claim every sibling step that
 * follows it. Nothing about the workflow is wrong: it is here to prove that a
 * sequence *entry* never claims its own siblings, whatever its first key is.
 */
const BLOCK_KEY_FIRST_STEP_WORKFLOW = CLEAN_WORKFLOW.replace(
  "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n",
  [
    "      - env:",
    "          FOO: bar",
    "        run: echo hi",
    "",
    "      - uses: pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda # v4.1.0",
    "",
    "      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0",
    "",
  ].join("\n"),
);

/**
 * The same workflow with its `concurrency:` declared on the job, not at the top.
 *
 * @remarks
 * GitHub Actions accepts `concurrency:` at either level, so the runs of this
 * workflow are grouped exactly as the clean one's are. It is the spelling a
 * rule anchored at column zero cannot see at all: the cancel-on-push rule then
 * reports a safety it never checked, and the missing-concurrency rule reports
 * absent a declaration that is one indent away.
 */
const JOB_LEVEL_CONCURRENCY_WORKFLOW = CLEAN_WORKFLOW.replace(
  "concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n\n",
  "",
).replace(
  "    timeout-minutes: 10\n",
  [
    "    timeout-minutes: 10",
    "    concurrency:",
    "      group: ${{ github.workflow }}-${{ github.ref }}",
    "      cancel-in-progress: true",
    "",
  ].join("\n"),
);

function codesOf(problems: Problem[]): string[] {
  return problems.map((problem) => problem.code);
}

function withoutLine(source: string, needle: string): string {
  return source
    .split("\n")
    .filter((line) => !line.includes(needle))
    .join("\n");
}

// --- the rules, against synthetic workflows ----------------------------------

describe("lintWorkflow", () => {
  it("accepts a workflow that satisfies every rule", () => {
    expect(lintWorkflow(CLEAN_WORKFLOW)).toEqual([]);
  });

  it("rejects an action referenced by tag instead of SHA", () => {
    const source = CLEAN_WORKFLOW.replace(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/checkout@v7",
    );

    expect(codesOf(lintWorkflow(source))).toContain("ERR_WORKFLOW_ACTION_NOT_PINNED");
  });

  it("rejects a short SHA", () => {
    const source = CLEAN_WORKFLOW.replace(
      "3d3c42e5aac5ba805825da76410c181273ba90b1",
      "3d3c42e",
    );

    expect(codesOf(lintWorkflow(source))).toContain("ERR_WORKFLOW_ACTION_NOT_PINNED");
  });

  it("rejects a pinned SHA with no release tag comment", () => {
    const source = CLEAN_WORKFLOW.replace(" # v7.0.1", "");

    expect(codesOf(lintWorkflow(source))).toEqual([
      "ERR_WORKFLOW_ACTION_TAG_COMMENT_MISSING",
    ]);
  });

  it("allows a local action, which has no SHA to pin", () => {
    const source = CLEAN_WORKFLOW.replace(
      "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n",
      "      - uses: ./.github/actions/setup\n",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects a job with no timeout", () => {
    const source = withoutLine(CLEAN_WORKFLOW, "timeout-minutes:");

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_JOB_TIMEOUT_MISSING"]);
  });

  it("does not accept a step timeout in place of the job's", () => {
    const source = withoutLine(CLEAN_WORKFLOW, "    timeout-minutes:").replace(
      "      - name: Install dependencies\n",
      "      - name: Install dependencies\n        timeout-minutes: 10\n",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_JOB_TIMEOUT_MISSING"]);
  });

  it("rejects a workflow with no top-level permissions", () => {
    const source = withoutLine(CLEAN_WORKFLOW, "permissions: {}");

    expect(codesOf(lintWorkflow(source))).toContain("ERR_WORKFLOW_PERMISSIONS_MISSING");
  });

  it("rejects top-level permissions wider than contents: read", () => {
    const source = CLEAN_WORKFLOW.replace(
      "permissions: {}",
      "permissions:\n  contents: write",
    );

    expect(codesOf(lintWorkflow(source))).toContain(
      "ERR_WORKFLOW_PERMISSIONS_TOO_BROAD",
    );
  });

  it("accepts contents: read as the top-level default", () => {
    const source = CLEAN_WORKFLOW.replace(
      "permissions: {}",
      "permissions:\n  contents: read",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects a job that does not declare its own permissions", () => {
    const source = withoutLine(
      withoutLine(CLEAN_WORKFLOW, "      contents: read"),
      "    permissions:",
    );

    expect(codesOf(lintWorkflow(source))).toContain("ERR_WORKFLOW_PERMISSIONS_MISSING");
  });

  it("rejects a job that grants write-all", () => {
    const source = CLEAN_WORKFLOW.replace(
      "    permissions:\n      contents: read",
      "    permissions: write-all",
    );

    expect(codesOf(lintWorkflow(source))).toContain(
      "ERR_WORKFLOW_PERMISSIONS_TOO_BROAD",
    );
  });

  it("rejects a checkout that keeps its credentials", () => {
    const source = withoutLine(CLEAN_WORKFLOW, "persist-credentials: false");

    expect(codesOf(lintWorkflow(source))).toEqual([
      "ERR_WORKFLOW_CHECKOUT_CREDENTIALS",
    ]);
  });

  it("accepts a workflow whose steps sequence sits at its key's own column", () => {
    expect(lintWorkflow(STEPS_AT_KEY_COLUMN_WORKFLOW)).toEqual([]);
  });

  it("rejects a checkout that keeps its credentials in a steps sequence at its key's own column", () => {
    const source = withoutLine(
      STEPS_AT_KEY_COLUMN_WORKFLOW,
      "persist-credentials: false",
    );

    expect(codesOf(lintWorkflow(source))).toEqual([
      "ERR_WORKFLOW_CHECKOUT_CREDENTIALS",
    ]);
  });

  it("does not let a step whose own line is a block key swallow its siblings", () => {
    // `- env:` ends in a colon, so a reader that decides ownership on the
    // colon alone merges every following step into this one -- which reads
    // setup-node's index as the merged step's own, and reports an ordering
    // failure this workflow does not have.
    expect(lintWorkflow(BLOCK_KEY_FIRST_STEP_WORKFLOW)).toEqual([]);
  });

  it("still reads a later step's own shell past a step whose line is a block key", () => {
    // The same merge cuts the other way: `stepShellAtLine` finds the merged
    // step first and answers with a sibling's `shell:`, so a multi-line `run:`
    // with no shell of its own stops being reported at all.
    const source = BLOCK_KEY_FIRST_STEP_WORKFLOW.replace(
      "        run: echo hi\n",
      ["        run: |", "          echo hi", "          echo there", ""].join("\n"),
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_RUN_NOT_PIPEFAIL"]);
  });

  it("rejects a job whose steps it cannot read", () => {
    // Reading nothing must not read as nothing being wrong: with no steps in
    // hand every step rule below passes without having looked at anything.
    const source = CLEAN_WORKFLOW.slice(0, CLEAN_WORKFLOW.indexOf("    steps:\n"));

    expect(codesOf(lintWorkflow(source))).toEqual([
      "ERR_WORKFLOW_JOB_STEPS_UNREADABLE",
    ]);
  });

  it("does not ask a job that calls a reusable workflow for steps it cannot have", () => {
    // `uses:` on the job itself is the whole job; the timeout the rule above
    // wants is a separate question and stays in the fixture to isolate this one.
    const source =
      CLEAN_WORKFLOW.slice(0, CLEAN_WORKFLOW.indexOf("    steps:\n")) +
      "    uses: ./.github/workflows/reusable.yml\n";

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects a pull-request workflow with no concurrency group", () => {
    const source = CLEAN_WORKFLOW.replace(
      "concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n\n",
      "",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_CONCURRENCY_MISSING"]);
  });

  it("does not require concurrency for a scheduled workflow", () => {
    const source = CLEAN_WORKFLOW.replace(
      "  pull_request:",
      '  schedule:\n    - cron: "0 6 * * 1"',
    ).replace(
      "concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n\n",
      "",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects pull_request_target as a mapping key", () => {
    const source = CLEAN_WORKFLOW.replace("  pull_request:", "  pull_request_target:");

    expect(codesOf(lintWorkflow(source))).toContain("ERR_WORKFLOW_PULL_REQUEST_TARGET");
  });

  it("rejects pull_request_target as an inline scalar", () => {
    const source = CLEAN_WORKFLOW.replace(
      "on:\n  pull_request:\n",
      "on: pull_request_target\n",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_PULL_REQUEST_TARGET"]);
  });

  it("rejects pull_request_target in a flow sequence", () => {
    const source = CLEAN_WORKFLOW.replace(
      "on:\n  pull_request:\n",
      "on: [pull_request_target]\n",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_PULL_REQUEST_TARGET"]);
  });

  it("rejects pull_request_target in a block sequence", () => {
    const source = CLEAN_WORKFLOW.replace(
      "on:\n  pull_request:\n",
      "on:\n  - pull_request_target\n",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_PULL_REQUEST_TARGET"]);
  });

  it("rejects pull_request_target in a block sequence at the key's own column", () => {
    // A sequence may start in the same column as the key it belongs to, which
    // is where a body read by indentation alone looks like no body at all.
    const source = CLEAN_WORKFLOW.replace(
      "on:\n  pull_request:\n",
      "on:\n- pull_request_target\n",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_PULL_REQUEST_TARGET"]);
  });

  it("rejects pull_request_target under a quoted on key", () => {
    // `on` is a YAML 1.1 boolean, so quoting the key is legal and changes
    // nothing about what the workflow runs.
    const source = CLEAN_WORKFLOW.replace(
      "on:\n  pull_request:\n",
      '"on":\n  pull_request_target:\n',
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_PULL_REQUEST_TARGET"]);
  });

  it("reports on: as unreadable for a flow sequence that spans multiple lines", () => {
    // #108 follow-up: `on: [` on its own line is a legal flow sequence that
    // continues onto later physical lines, but the scanner reads each
    // physical line on its own, so `inlineValue` sees only the bare `[` and
    // `triggerNames` silently reports zero triggers. That would let a
    // workflow declare `pull_request_target` past ERR_WORKFLOW_PULL_REQUEST_TARGET
    // and skip ERR_WORKFLOW_CONCURRENCY_MISSING as well, so an `on:` this
    // lint cannot finish reading is reported directly instead of silently
    // parsed as empty.
    const source = CLEAN_WORKFLOW.replace(
      "on:\n  pull_request:\n",
      "on: [\n  pull_request_target,\n  push,\n]\n",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_ON_UNREADABLE"]);
  });

  it("does not read a branch named after the trigger as the trigger itself", () => {
    const source = CLEAN_WORKFLOW.replace(
      "  pull_request:\n",
      "  pull_request:\n    branches: [pull_request_target]\n",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("does not read a branch named after the trigger as the trigger itself in a flow mapping", () => {
    const source = CLEAN_WORKFLOW.replace(
      "on:\n  pull_request:\n",
      "on: { pull_request: { branches: [pull_request_target] } }\n",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects an install that is not frozen", () => {
    const source = CLEAN_WORKFLOW.replace(
      "pnpm install --frozen-lockfile",
      "pnpm install",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_INSTALL_NOT_FROZEN"]);
  });

  it("finds an unfrozen install inside a multi-line run block", () => {
    const source = CLEAN_WORKFLOW.replace(
      "        run: pnpm install --frozen-lockfile\n",
      "        run: |\n          set -euo pipefail\n          pnpm install\n",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_INSTALL_NOT_FROZEN"]);
  });

  it("accepts an install carrying extra pnpm flags", () => {
    const source = CLEAN_WORKFLOW.replace(
      "pnpm install --frozen-lockfile",
      "pnpm $PNPM_RUNTIME_FLAG install --frozen-lockfile",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("ignores YAML-looking text inside a shell script", () => {
    const source = CLEAN_WORKFLOW.replace(
      "        run: pnpm install --frozen-lockfile\n",
      [
        "        run: |",
        "          set -euo pipefail",
        "          # uses: not-an-action@v1",
        '          echo "permissions: write-all"',
        "          - not a list item",
        "",
      ].join("\n"),
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects setup-node running before pnpm/action-setup", () => {
    const source = CLEAN_WORKFLOW.replace(
      "      - name: Install dependencies\n",
      [
        "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
        "        with:",
        "          node-version-file: .node-version",
        "",
        "      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10",
        "",
        "      - name: Install dependencies",
        "",
      ].join("\n"),
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_SETUP_ORDER"]);
  });

  it("accepts pnpm/action-setup running first", () => {
    const source = CLEAN_WORKFLOW.replace(
      "      - name: Install dependencies\n",
      [
        "      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10",
        "",
        "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
        "        with:",
        "          node-version-file: .node-version",
        "",
        "      - name: Install dependencies",
        "",
      ].join("\n"),
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects setup-node running first in a steps sequence at its key's own column", () => {
    const source = STEPS_AT_KEY_COLUMN_WORKFLOW.replace(
      "    - name: Install dependencies\n",
      [
        "    - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
        "      with:",
        "        node-version-file: .node-version",
        "",
        "    - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10",
        "",
        "    - name: Install dependencies",
        "",
      ].join("\n"),
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_SETUP_ORDER"]);
  });

  it("rejects a multi-line run block with nothing making it fail closed", () => {
    const source = CLEAN_WORKFLOW.replace(
      "        run: pnpm install --frozen-lockfile\n",
      [
        "        run: |",
        "          pnpm install --frozen-lockfile",
        "          node ./scripts/after.mjs",
        "",
      ].join("\n"),
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_RUN_NOT_PIPEFAIL"]);
  });

  it("accepts a multi-line run block covered by a workflow-level shell default", () => {
    const source = MULTI_LINE_RUN_WORKFLOW.replace(
      "permissions: {}\n",
      [
        "permissions: {}",
        "",
        "defaults:",
        "  run:",
        '    shell: "bash --noprofile --norc -eo pipefail -u {0}"',
        "",
      ].join("\n"),
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("does not let a job that names its own shell inherit that default", () => {
    // A job-level `defaults:` replaces the workflow-level one; `shell: bash`
    // there means this job really does run without -u.
    const source = MULTI_LINE_RUN_WORKFLOW.replace(
      "permissions: {}\n",
      [
        "permissions: {}",
        "",
        "defaults:",
        "  run:",
        '    shell: "bash --noprofile --norc -eo pipefail -u {0}"',
        "",
      ].join("\n"),
    ).replace(
      "    steps:\n",
      ["    defaults:", "      run:", "        shell: bash", "    steps:", ""].join(
        "\n",
      ),
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_RUN_NOT_PIPEFAIL"]);
  });

  it("does not let a step that names its own shell inherit a fail-closed default", () => {
    // A step's `shell:` is the last word, so `shell: bash` on the step is what
    // this body really runs under however careful the job's defaults are.
    const source = MULTI_LINE_RUN_WORKFLOW.replace(
      "    steps:\n",
      [
        "    defaults:",
        "      run:",
        '        shell: "bash --noprofile --norc -eo pipefail -u {0}"',
        "    steps:",
        "",
      ].join("\n"),
    ).replace("        run: |\n", "        shell: bash\n        run: |\n");

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_RUN_NOT_PIPEFAIL"]);
  });

  it("accepts a step whose own shell is fail closed, with no set line", () => {
    const source = MULTI_LINE_RUN_WORKFLOW.replace(
      "        run: |\n",
      '        shell: "bash --noprofile --norc -eo pipefail -u {0}"\n        run: |\n',
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("reads a step's own shell out of a steps sequence at its key's own column", () => {
    // The blindness cuts the other way here: a step the scanner never finds has
    // no shell either, so a workflow that is safe gets reported as unsafe.
    const source = STEPS_AT_KEY_COLUMN_WORKFLOW.replace(
      "      run: pnpm install --frozen-lockfile\n",
      [
        '      shell: "bash --noprofile --norc -eo pipefail -u {0}"',
        "      run: |",
        "        pnpm install --frozen-lockfile",
        "        node ./scripts/after.mjs",
        "",
      ].join("\n"),
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects a shell default that spells pipefail out but leaves -u off", () => {
    // `bash -eo pipefail {0}` is the trap the error message names: pipefail is
    // there, so a substring check passes it, while an unset variable still
    // expands to the empty string.
    const source = MULTI_LINE_RUN_WORKFLOW.replace(
      "permissions: {}\n",
      [
        "permissions: {}",
        "",
        "defaults:",
        "  run:",
        '    shell: "bash -eo pipefail {0}"',
        "",
      ].join("\n"),
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_RUN_NOT_PIPEFAIL"]);
  });

  it("rejects a shell default that leaves -e off", () => {
    // `bash -uo pipefail {0}` names two of the three flags, so a check that
    // stops at `-u` passes it while a command failing part-way through the
    // script still leaves the step green.
    const source = MULTI_LINE_RUN_WORKFLOW.replace(
      "permissions: {}\n",
      [
        "permissions: {}",
        "",
        "defaults:",
        "  run:",
        '    shell: "bash -uo pipefail {0}"',
        "",
      ].join("\n"),
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_RUN_NOT_PIPEFAIL"]);
  });

  it("accepts a shell default that spells the flags out as long options", () => {
    // `-o errexit -o nounset -o pipefail` is the same shell as `-euo pipefail`,
    // so a check that only reads short flags would reject a safe workflow.
    const source = MULTI_LINE_RUN_WORKFLOW.replace(
      "permissions: {}\n",
      [
        "permissions: {}",
        "",
        "defaults:",
        "  run:",
        '    shell: "bash -o errexit -o nounset -o pipefail {0}"',
        "",
      ].join("\n"),
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects cancelling unconditionally on a workflow that also runs on push", () => {
    const source = CLEAN_WORKFLOW.replace(
      "  pull_request:",
      "  push:\n    branches: [main]\n  pull_request:",
    );

    expect(codesOf(lintWorkflow(source))).toEqual([
      "ERR_WORKFLOW_CONCURRENCY_CANCELS_PUSH",
    ]);
  });

  it("accepts a cancellation conditional on the event being a pull request", () => {
    const source = CLEAN_WORKFLOW.replace(
      "  pull_request:",
      "  push:\n    branches: [main]\n  pull_request:",
    ).replace(
      "cancel-in-progress: true",
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("requires a concurrency group when the triggers are a flow sequence", () => {
    const source = CLEAN_WORKFLOW.replace(
      "on:\n  pull_request:\n",
      "on: [push, pull_request]\n",
    ).replace(
      "concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n\n",
      "",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_CONCURRENCY_MISSING"]);
  });

  it("rejects cancelling unconditionally when the triggers are a flow sequence", () => {
    const source = CLEAN_WORKFLOW.replace(
      "on:\n  pull_request:\n",
      "on: [push, pull_request]\n",
    );

    expect(codesOf(lintWorkflow(source))).toEqual([
      "ERR_WORKFLOW_CONCURRENCY_CANCELS_PUSH",
    ]);
  });

  it("still allows a pull-request-only workflow to cancel unconditionally", () => {
    expect(lintWorkflow(CLEAN_WORKFLOW)).toEqual([]);
  });

  it("accepts a pull-request workflow whose concurrency is declared per job", () => {
    // `concurrency:` on a job is a real declaration — GitHub groups that job's
    // runs and cancels the superseded ones. Reporting it missing was the rule
    // failing to look one indent down, not the workflow being wrong.
    expect(lintWorkflow(JOB_LEVEL_CONCURRENCY_WORKFLOW)).toEqual([]);
  });

  it("still reports missing concurrency when only one of two jobs declares its own", () => {
    // A job-level block governs its own job and nothing else, so one job's
    // block is not the whole-workflow guarantee this rule asks for. Letting it
    // stand in for one would hand a workflow a way to switch the rule off for
    // every other job by decorating a trivial one.
    const source =
      JOB_LEVEL_CONCURRENCY_WORKFLOW +
      [
        "  publish:",
        "    runs-on: ubuntu-latest",
        "    timeout-minutes: 10",
        "    permissions:",
        "      contents: read",
        "    steps:",
        "      - run: echo done",
        "",
      ].join("\n");

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_CONCURRENCY_MISSING"]);
  });

  it("rejects a job-level cancellation on a workflow that also runs on push", () => {
    const source = JOB_LEVEL_CONCURRENCY_WORKFLOW.replace(
      "  pull_request:",
      "  push:\n    branches: [main]\n  pull_request:",
    );

    expect(codesOf(lintWorkflow(source))).toEqual([
      "ERR_WORKFLOW_CONCURRENCY_CANCELS_PUSH",
    ]);
  });

  it("rejects a job-level cancellation the top-level block is careful to avoid", () => {
    // Column zero is spotless here: the workflow-level block cancels only a
    // pull request. The unconditional cancellation sits one indent down, where
    // it discards the push run's CI record just as effectively.
    const source = CLEAN_WORKFLOW.replace(
      "  pull_request:",
      "  push:\n    branches: [main]\n  pull_request:",
    )
      .replace(
        "cancel-in-progress: true",
        "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
      )
      .replace(
        "    timeout-minutes: 10\n",
        [
          "    timeout-minutes: 10",
          "    concurrency:",
          "      group: ${{ github.workflow }}-${{ github.ref }}-build",
          "      cancel-in-progress: true",
          "",
        ].join("\n"),
      );

    expect(codesOf(lintWorkflow(source))).toEqual([
      "ERR_WORKFLOW_CONCURRENCY_CANCELS_PUSH",
    ]);
  });

  it("accepts a job-level cancellation conditional on the event being a pull request", () => {
    const source = JOB_LEVEL_CONCURRENCY_WORKFLOW.replace(
      "  pull_request:",
      "  push:\n    branches: [main]\n  pull_request:",
    ).replace(
      "cancel-in-progress: true",
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("accepts a job-level cancellation on a job its own `if:` pins to a pull request", () => {
    // The job does not run on push at all, so the run its cancellation discards
    // is never a merged commit's only CI record. Reporting it would be the rule
    // firing on work the workflow got right, and contradicting the `if:` while
    // doing so.
    const source = JOB_LEVEL_CONCURRENCY_WORKFLOW.replace(
      "  pull_request:",
      "  push:\n    branches: [main]\n  pull_request:",
    ).replace(
      "    timeout-minutes: 10\n",
      "    timeout-minutes: 10\n    if: github.event_name == 'pull_request'\n",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("still reports a job-level cancellation whose `if:` also admits push", () => {
    // `||` makes the pull-request term one alternative among several, so this
    // job does run on push. An expression the rule cannot be certain of has to
    // leave it reporting rather than silently switching it off.
    const source = JOB_LEVEL_CONCURRENCY_WORKFLOW.replace(
      "  pull_request:",
      "  push:\n    branches: [main]\n  pull_request:",
    ).replace(
      "    timeout-minutes: 10\n",
      [
        "    timeout-minutes: 10",
        "    if: github.event_name == 'pull_request' || github.event_name == 'push'",
        "",
      ].join("\n"),
    );

    expect(codesOf(lintWorkflow(source))).toEqual([
      "ERR_WORKFLOW_CONCURRENCY_CANCELS_PUSH",
    ]);
  });

  it("reports missing concurrency when a job's block names no group", () => {
    // `group` is what GitHub queues runs against, so a bare `concurrency:` key
    // groups nothing and cancels nothing. Accepting it would let a declaration
    // that grants nothing satisfy the rule that exists to ask for the grouping.
    const source = JOB_LEVEL_CONCURRENCY_WORKFLOW.replace(
      [
        "    concurrency:",
        "      group: ${{ github.workflow }}-${{ github.ref }}",
        "      cancel-in-progress: true",
        "",
      ].join("\n"),
      "    concurrency:\n",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_CONCURRENCY_MISSING"]);
  });

  it("reports missing concurrency when the workflow-level block names no group", () => {
    const source = CLEAN_WORKFLOW.replace(
      [
        "concurrency:",
        "  group: ${{ github.workflow }}-${{ github.ref }}",
        "  cancel-in-progress: true",
        "",
      ].join("\n"),
      "concurrency:\n",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_CONCURRENCY_MISSING"]);
  });

  it("rejects a flow-mapping cancellation on a workflow that also runs on push", () => {
    // `concurrency: { … }` is the same declaration written on the header line.
    // A rule reading only the block body finds an empty one and passes, which is
    // the same blind spot as reading only column zero.
    const source = CLEAN_WORKFLOW.replace(
      "  pull_request:",
      "  push:\n    branches: [main]\n  pull_request:",
    ).replace(
      [
        "concurrency:",
        "  group: ${{ github.workflow }}-${{ github.ref }}",
        "  cancel-in-progress: true",
        "",
      ].join("\n"),
      "concurrency: { group: '${{ github.workflow }}', cancel-in-progress: true }\n",
    );

    expect(codesOf(lintWorkflow(source))).toEqual([
      "ERR_WORKFLOW_CONCURRENCY_CANCELS_PUSH",
    ]);
  });

  it("accepts a flow-mapping cancellation conditional on the event", () => {
    const source = CLEAN_WORKFLOW.replace(
      "  pull_request:",
      "  push:\n    branches: [main]\n  pull_request:",
    ).replace(
      [
        "concurrency:",
        "  group: ${{ github.workflow }}-${{ github.ref }}",
        "  cancel-in-progress: true",
        "",
      ].join("\n"),
      [
        "concurrency: { group: '${{ github.workflow }}',",
        " cancel-in-progress: \"${{ github.event_name == 'pull_request' }}\" }\n",
      ].join(""),
    );

    expect(lintWorkflow(source)).toEqual([]);
  });
});

// --- triggerNames, in isolation from lintWorkflow's other rules --------------

describe("triggerNames", () => {
  it("does not read a mapping value's own-column sequence item as a sibling trigger", () => {
    // #108: a mapping value written as a block sequence at its key's own
    // column (legal YAML, same shape `blockOf` already special-cases for
    // `steps:`) put the sequence item at the same indent as `schedule:`
    // itself, so it used to read as a second, bogus trigger named "cron".
    const source = CLEAN_WORKFLOW.replace(
      "on:\n  pull_request:\n",
      'on:\n  schedule:\n  - cron: "0 6 * * 1"\n',
    );

    expect(triggerNames(scan(source)).map(({ name }) => name)).toEqual(["schedule"]);
  });

  it.each([
    ["scalar", "on: push\n", ["push"]],
    ["flow sequence", "on: [push, pull_request]\n", ["push", "pull_request"]],
    ["block sequence", "on:\n  - push\n  - pull_request\n", ["push", "pull_request"]],
    [
      "block sequence at the key's own column",
      "on:\n- push\n- pull_request\n",
      ["push", "pull_request"],
    ],
    [
      "mapping with a nested sub-key",
      "on:\n  pull_request:\n    branches: [main]\n",
      ["pull_request"],
    ],
    [
      "mapping with a nested sub-mapping",
      "on:\n  workflow_dispatch:\n    inputs:\n      environment:\n        required: true\n",
      ["workflow_dispatch"],
    ],
  ])("reads the %s form of on: correctly", (_shape, onBlock, expected) => {
    const source = CLEAN_WORKFLOW.replace("on:\n  pull_request:\n", onBlock);

    expect(triggerNames(scan(source)).map(({ name }) => name)).toEqual(expected);
  });

  it("reports no triggers for a flow sequence that spans multiple lines", () => {
    // A flow collection may legally continue past its opening line, but scan()
    // reads one physical line at a time, so inlineValue(on) sees only the bare
    // "[" and every entry is lost. triggerNames stays silent about it on
    // purpose: lintWorkflow's ERR_WORKFLOW_ON_UNREADABLE is what turns this
    // shape into a reported problem instead of a silently empty trigger list.
    const source = CLEAN_WORKFLOW.replace(
      "on:\n  pull_request:\n",
      "on: [\n  pull_request_target,\n  push,\n]\n",
    );

    expect(triggerNames(scan(source))).toEqual([]);
  });
});

// --- the rules, against the workflows this repository ships -------------------

const workflowNames = readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

function workflowSource(name: string): string {
  return readFileSync(path.join(workflowsDir, name), "utf8");
}

describe("the workflows in .github/workflows", () => {
  it("includes every workflow spec 02 §5.2 makes mandatory", () => {
    expect(workflowNames).toEqual([
      "check-pr-title.yml",
      "ci.yml",
      "dependency-review.yml",
      "pr-label.yml",
      "security-audit.yml",
      "typos.yml",
    ]);
  });

  it.each(workflowNames)("%s satisfies every rule", (name) => {
    expect(lintWorkflow(workflowSource(name))).toEqual([]);
  });

  // The rules above are only worth anything if the scanner actually reaches
  // every job and every step. These two compare what it found against a plain
  // text count, so a silently skipped block fails here rather than passing as
  // "no problems found".
  it.each(workflowNames)("%s: the scanner sees every job", (name) => {
    const source = workflowSource(name);
    const declared = source
      .split("\n")
      // Job level only: four spaces of indent, which is where jobsOf looks.
      .filter((line) => /^ {4}timeout-minutes:/.test(line)).length;

    expect(jobsOf(scan(source))).toHaveLength(declared);
  });

  it.each(workflowNames)("%s: the scanner sees every action reference", (name) => {
    const source = workflowSource(name);
    const declared = source
      .split("\n")
      .filter((line) => /^\s*(?:- )?uses:/.test(line)).length;

    expect(usesOf(scan(source))).toHaveLength(declared);
  });

  it("pins every action, so nothing is fetched by a movable ref", () => {
    const refs = workflowNames.flatMap((name) =>
      usesOf(scan(workflowSource(name))).map(({ ref }) => ref),
    );

    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((ref) => !PINNED_REF.test(ref))).toEqual([]);
  });

  it("collects coverage exactly once", () => {
    // Spec 02 §5.2: the `test` job is the single source of truth, and a
    // second collector would make the threshold depend on which job finished.
    const collectors = runCommands(workflowSource("ci.yml")).filter(({ command }) =>
      command.includes("test:coverage"),
    );

    expect(collectors).toHaveLength(1);
  });

  it("grants a write scope only where the job cannot do its work without one", () => {
    // pr-label writes a label and tolerates the read-only token a fork PR
    // gets. Everything else, and in particular everything that runs
    // repository code, stays read-only. This repository publishes nothing, so
    // no workflow needs OIDC or a tag push any more.
    const writers = workflowNames.filter((name) =>
      scan(workflowSource(name)).some((line) => line.text.endsWith(": write")),
    );

    expect(writers.sort()).toEqual(["pr-label.yml"]);
  });
});

// --- the pull-request vocabulary shared by the bots and the labels ----------

const dependabotConfig = readFileSync(
  path.join(repoRoot, ".github", "dependabot.yml"),
  "utf8",
);
/** The entries of a `key: |` block scalar, trimmed, in file order. */
function blockScalarEntries(source: string, key: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${key}: |`);
  const header = lines[start];
  if (start === -1 || header === undefined) {
    return [];
  }

  const indent = header.length - header.trimStart().length;
  const entries: string[] = [];
  for (let next = start + 1; next < lines.length; next += 1) {
    const line = lines[next];
    if (line === undefined) {
      break;
    }
    if (line.trim() === "") {
      continue;
    }
    if (line.length - line.trimStart().length <= indent) {
      break;
    }
    entries.push(line.trim());
  }
  return entries;
}

/** The Conventional Commit types every `commit-message.prefix` in dependabot.yml asks for. */
function dependabotCommitTypes(source: string): string[] {
  return [...source.matchAll(/^\s*prefix:\s*"?([^"\s]+?):?"?\s*$/gm)].flatMap(
    (match) => match[1] ?? [],
  );
}

describe("the PR title vocabulary covers everything that can open a PR", () => {
  const allowedTypes = blockScalarEntries(
    workflowSource("check-pr-title.yml"),
    "types",
  );

  it("declares the allowed types instead of inheriting the action's default", () => {
    // The action's built-in default is not visible in this repository and does
    // not contain `deps`, so every Dependabot PR failed a check whose rule
    // nobody could read. What is enforced has to be written down here.
    expect(allowedTypes).toContain("feat");
    expect(allowedTypes).toContain("fix");
    expect(allowedTypes).toContain("chore");
  });

  it("accepts every prefix Dependabot commits with", () => {
    const prefixes = dependabotCommitTypes(dependabotConfig);

    expect(prefixes).not.toEqual([]);
    expect(prefixes.filter((prefix) => !allowedTypes.includes(prefix))).toEqual([]);
  });
});

describe("the Dependabot cooldown agrees with the pnpm install cooldown", () => {
  it("states the same window in days and in minutes", () => {
    // pnpm refuses to install a version younger than `minimumReleaseAge`, so a
    // Dependabot PR proposing one is a PR that cannot go green. A comment in
    // dependabot.yml claims the two match; this is what checks it.
    const days = [
      ...dependabotConfig.matchAll(/^\s*default-days:\s*(\d+)\s*$/gm),
    ].flatMap((match) => match[1] ?? []);
    const minutes = /^minimumReleaseAge:\s*(\d+)\s*$/m.exec(
      readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
    )?.[1];

    expect(days).not.toEqual([]);
    expect(minutes).toBeTypeOf("string");
    for (const value of days) {
      expect(Number(value) * 1440).toBe(Number(minutes));
    }
  });

  it("gives every update ecosystem a cooldown", () => {
    const ecosystems = dependabotConfig.match(/^\s*- package-ecosystem:/gm) ?? [];
    const cooldowns = dependabotConfig.match(/^\s*cooldown:/gm) ?? [];

    expect(ecosystems).not.toEqual([]);
    expect(cooldowns).toHaveLength(ecosystems.length);
  });
});

// --- agreement with package.json and .node-version ---------------------------

interface Manifest {
  private?: boolean;
  engines?: { node?: string };
  packageManager?: string;
  devEngines?: {
    runtime?: { onFail?: string; version?: string };
    packageManager?: { version?: string };
  };
}

const manifest = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
) as Manifest;

describe("workflow regression checks for repository automation", () => {
  it("runs the test job as a fail-fast-free OS matrix with one coverage leg", () => {
    const source = workflowSource("ci.yml");
    // Anchored on the next top-level job header rather than on one job's name:
    // `test` is currently the last job in the file, and `indexOf` of a name
    // that is not there returns -1, which `slice` would read as "one character
    // from the end" and silently widen the window to the whole file.
    const header = "  test:\n";
    const testStart = source.indexOf(header);
    expect(testStart).toBeGreaterThan(-1);
    const afterHeader = source.slice(testStart + header.length);
    const nextJob = /^ {2}[a-z][a-z-]*:$/m.exec(afterHeader);
    const testJob =
      nextJob === null ? afterHeader : afterHeader.slice(0, nextJob.index);

    expect(testJob).toContain("name: Test (${{ matrix.os }})");
    expect(testJob).toContain("strategy:");
    expect(testJob).toContain("fail-fast: false");
    expect(testJob).toContain("os: [ubuntu-latest]");
    expect(testJob).toContain("if: matrix.os == 'ubuntu-latest'");
    expect(testJob).toContain("if: matrix.os != 'ubuntu-latest'");
    expect(testJob).toContain("run: pnpm run test:coverage");
    expect(testJob).toContain("run: pnpm run test");
    expect((testJob.match(/run: pnpm run test:coverage/g) ?? []).length).toBe(1);
  });

  it("keeps the dependency-review severity gate", () => {
    // Without `fail-on-severity` the action reports advisories and passes, so
    // the workflow's presence in .github/workflows/ would prove nothing.
    expect(workflowSource("dependency-review.yml")).toMatch(
      /^\s*fail-on-severity:\s*\S+/m,
    );
  });

  it("fails closed after finite security-audit retries", () => {
    const source = workflowSource("security-audit.yml");
    expect(source).not.toContain("--ignore-registry-errors");
    expect(source).toContain("for attempt in 1 2 3");
    expect(source).toContain("exit 1");
  });

  it("publishes nothing, so it declares no Node floor and no job to verify one", () => {
    // This repository is private (`package.json`'s `"private": true`): nothing
    // is packed, published, or consumed as a tarball. `engines.node` was the
    // published floor, and the `package`/`package-floor` jobs were the only
    // things that verified it against a packed artifact — the three go
    // together, and re-adding any one of them alone leaves a floor nobody
    // checks or a job with nothing to check. The development runtime is
    // carried by `devEngines.runtime` and `.node-version` instead, asserted in
    // the block below.
    const source = workflowSource("ci.yml");

    expect(manifest.engines).toBeUndefined();
    expect(manifest.private).toBe(true);
    expect(source.indexOf("  package:")).toBe(-1);
    expect(source.indexOf("  package-floor:")).toBe(-1);
  });
});

describe("the development runtime contract fails closed", () => {
  it("treats the Node 24 requirement as an error", () => {
    expect(manifest.devEngines?.runtime?.onFail).toBe("error");
  });

  it("keeps devEngines and .node-version on the development Node major", () => {
    // `devEngines.runtime.version` is what pnpm enforces locally, and
    // `.node-version` is what the source-check jobs install. These two are now
    // the only Node versions this repository states: there is no published
    // `engines.node` floor to be independent of.
    const major = (value: string) => /(\d+)/.exec(value)?.[1];
    const nodeVersionFile = readFileSync(
      path.join(repoRoot, ".node-version"),
      "utf8",
    ).trim();

    expect(major(manifest.devEngines?.runtime?.version ?? "")).toBe(
      major(nodeVersionFile),
    );
  });
});

describe("package.json is the only place the pnpm version is written", () => {
  const declared = manifest.devEngines?.packageManager?.version;

  it("is declared in package.json", () => {
    expect(declared).toBeTypeOf("string");
  });

  // pnpm/action-setup reads the exact `packageManager` field, so a `version:`
  // input is a second copy of a number that has one home. This used to be
  // asserted the other way round — every copy had to agree with the manifest —
  // which kept nine copies correct instead of removing them. The inversion is
  // deliberate: the version cannot drift if no workflow states it.
  it.each(workflowNames)("%s states no pnpm version of its own", (name) => {
    expect(pnpmSetupVersions(workflowSource(name))).toEqual([]);
  });

  it("would notice a version that came back", () => {
    // A rule that asserts an empty list has to be shown capable of a non-empty
    // one, or it goes on passing after the scanner stops finding anything.
    const stated = CLEAN_WORKFLOW.replace(
      "      - name: Install dependencies\n",
      [
        "      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10",
        "        with:",
        "          version: 11.18.0",
        "",
        "      - name: Install dependencies",
        "",
      ].join("\n"),
    );

    expect(pnpmSetupVersions(stated)).toEqual(["11.18.0"]);
  });

  it("would notice a version stated in a steps sequence at its key's own column", () => {
    const stated = STEPS_AT_KEY_COLUMN_WORKFLOW.replace(
      "    - name: Install dependencies\n",
      [
        "    - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10",
        "      with:",
        "        version: 11.18.0",
        "",
        "    - name: Install dependencies",
        "",
      ].join("\n"),
    );

    expect(pnpmSetupVersions(stated)).toEqual(["11.18.0"]);
  });

  it("declares the same pnpm string in packageManager and devEngines", () => {
    // pnpm warns on every command when the two disagree, and says it will
    // ignore `packageManager` — the field corepack and Dependabot read. Keep
    // them byte-identical so neither the warning nor the drift can return.
    expect(manifest.packageManager).toBe(`pnpm@${declared ?? ""}`);
  });
});
