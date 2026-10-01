import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../.agents/skills/shipping-issues/scripts/ci_watch.sh", import.meta.url),
);

// Only these tools reach the script, so neither `timeout` nor `gtimeout` can.
const TOOLS = [
  "bash",
  "awk",
  "grep",
  "sed",
  "cut",
  "tr",
  "mktemp",
  "rm",
  "sleep",
  "date",
];

// A `gh` whose checks never settle: the rollup reports one check and
// `gh pr checks --watch` blocks far past any timeout under test.
const GH_STUB = `#!/bin/sh
case "$*" in
  *statusCheckRollup*) echo 1 ;;
  "pr view"*) echo '{"state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","reviewDecision":""}' ;;
  *--watch*) exec sleep 60 ;;
  "pr checks"*) echo "ci	pending" ;;
esac
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stubPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-watch-test-"));
  dirs.push(dir);
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  for (const tool of TOOLS) {
    const found = ["/bin", "/usr/bin"]
      .map((d) => path.join(d, tool))
      .find((p) => existsSync(p));
    if (found === undefined) throw new Error(`${tool} not found in /bin or /usr/bin`);
    symlinkSync(found, path.join(bin, tool));
  }
  writeFileSync(path.join(bin, "gh"), GH_STUB);
  chmodSync(path.join(bin, "gh"), 0o755);
  return bin;
}

describe("ci_watch.sh without timeout or gtimeout", () => {
  it("reports TIMEOUT near the limit while checks stay pending", () => {
    const bin = stubPath();
    const started = Date.now();
    const result = spawnSync(path.join(bin, "bash"), [script, "7", "--timeout", "2"], {
      encoding: "utf8",
      // Next.js's types make NODE_ENV a required ProcessEnv key; the script ignores it.
      env: { PATH: bin, NODE_ENV: "test" },
      timeout: 20_000,
    });
    const elapsed = (Date.now() - started) / 1000;

    expect(result.stdout).toContain("verdict: TIMEOUT");
    expect(result.stdout).toContain("waited_seconds: 2");
    expect(result.stderr).toContain("timeout_enforced: shell");
    expect(result.status).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThan(10);
  });
});
