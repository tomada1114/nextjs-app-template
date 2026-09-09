import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCALES } from "../src/i18n/locales";

// The only suite that asks the application a question over HTTP. Every other
// test here drives one layer through its own surface — a handler with
// `new Request()`, `src/proxy.ts` as a bare function, a page under jsdom — so
// nothing else notices when the seams between them come apart: a proxy at a
// path Next.js does not load, a Route Handler the App Router never mounts, a
// layout that renders under jsdom and throws in a real render. This starts the
// built application the way a deployment does and asserts only what a client
// outside the process can see.
//
// No browser and no E2E harness, deliberately: `next start` plus `fetch` needs
// neither, and issue #12's decision to take on neither still stands.

/** The repository root, whose `.next` build `next start` serves. */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** The `next` CLI, run through this process's own Node rather than a shell. */
const nextCli = createRequire(import.meta.url).resolve("next/dist/bin/next");

/**
 * The credential the spawned server is given, and the only one it accepts.
 *
 * @remarks
 * Set on the child's environment rather than read from the ambient one, which
 * decides whether `POST /api/ask` answers 401 or 200: a developer who exports
 * `API_ACCESS_KEY`, or a `.env` Next.js loads at start-up, would otherwise
 * flip this suite's expectation without touching a line of it. Next.js does
 * not overwrite a variable already present in the environment it is spawned
 * with, so this value wins over either.
 *
 * It is a throwaway string, not a secret: what stands behind the port is the
 * fake adapter `src/server/composition.ts` wires, so an answer here reaches no
 * provider and costs nobody anything.
 */
const ACCESS_KEY = "smoke-test-throwaway-access-key";

/** How long `next start` gets to accept its first connection. */
const READY_TIMEOUT_MS = 60_000;

/** How long between readiness attempts. */
const POLL_INTERVAL_MS = 100;

/** How long a `SIGTERM`ed server gets to exit before it is killed outright. */
const SHUTDOWN_GRACE_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * A TCP port nothing is listening on.
 *
 * @remarks
 * The port is asked of the operating system rather than written down, so two
 * checkouts of this repository — or a developer's own `pnpm dev` — can run at
 * the same time without one failing on `EADDRINUSE`. `next start` is given the
 * number after the probe releases it; the window in between is why the probe
 * binds the same loopback address the server will.
 */
async function reserveEphemeralPort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (address === null || typeof address === "string") {
    throw new TypeError("the probe server reported no TCP address to read a port from");
  }
  probe.close();
  await once(probe, "close");
  return address.port;
}

/**
 * Signal the whole process group the server was started in.
 *
 * @remarks
 * A negative pid addresses the group, which `detached: true` gave the child of
 * its own. `next start` is a CLI that goes on to run the server, and killing
 * only the pid Node knows about is what leaves a listening process behind on a
 * developer's machine after a failed run.
 */
function signalServerGroup(server: ChildProcess, signal: NodeJS.Signals): void {
  const { pid } = server;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone, or the platform refused the negative pid.
    server.kill(signal);
  }
}

/** Stop the server, whether the suite passed or failed. */
async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  const closed = once(server, "close");
  signalServerGroup(server, "SIGTERM");
  const outcome = await Promise.race([
    closed.then(() => "closed" as const),
    delay(SHUTDOWN_GRACE_MS).then(() => "still running" as const),
  ]);
  if (outcome === "still running") {
    signalServerGroup(server, "SIGKILL");
    await closed;
  }
}

let server: ChildProcess | undefined;
let baseUrl = "";

beforeAll(async () => {
  // The suite runs after `pnpm build`, never instead of it — see
  // `package.json`'s `check:source` and ci.yml's `static` job. Saying so here
  // is what turns "Could not find a production build" into an instruction.
  if (!existsSync(path.join(repoRoot, ".next", "BUILD_ID"))) {
    throw new Error(
      "This suite serves the output of `pnpm build`, which is missing. Run `pnpm build` first, or run `pnpm run test:smoke`, which check:source and ci.yml both call after the build.",
    );
  }

  const port = await reserveEphemeralPort();
  baseUrl = `http://127.0.0.1:${String(port)}`;

  const started = spawn(
    process.execPath,
    [nextCli, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: repoRoot,
      env: { ...process.env, API_ACCESS_KEY: ACCESS_KEY },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  server = started;

  // Kept so a server that dies on start-up reports why, instead of this suite
  // reporting only that nothing ever answered.
  let output = "";
  const collect = (chunk: Buffer): void => {
    output += chunk.toString("utf8");
  };
  started.stdout.on("data", collect);
  started.stderr.on("data", collect);

  // A poll with a deadline, not a fixed wait: how long `next start` takes to
  // listen is a property of the machine, so a sleep long enough to be reliable
  // on CI would be time every local run pays. Fake timers cannot stand in
  // here — what is being waited on is a real process binding a real socket.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    // Read off the child rather than a flag of this suite's own: a server
    // that failed to start answers nothing, and waiting out the whole
    // deadline for it would hide the reason it is holding in `output`.
    if (started.exitCode !== null || started.signalCode !== null) {
      throw new Error(
        `\`next start\` exited before it accepted a connection:\n${output}`,
      );
    }
    try {
      await fetch(baseUrl, { redirect: "manual" });
      return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `\`next start\` did not accept a connection within ${String(READY_TIMEOUT_MS)}ms:\n${output}`,
      );
    }
    await delay(POLL_INTERVAL_MS);
  }
});

afterAll(async () => {
  if (server !== undefined) {
    await stopServer(server);
  }
});

describe("the built application, served by `next start`", () => {
  it("redirects a path with no locale prefix to one that has it", async () => {
    const response = await fetch(baseUrl, {
      redirect: "manual",
      headers: { "accept-language": "en" },
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    expect(new URL(location ?? "", baseUrl).pathname).toBe("/en");
  });

  it.each(LOCALES)(
    "serves /%s as a document declaring that language",
    async (locale) => {
      const response = await fetch(`${baseUrl}/${locale}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      // `<html lang>` is rendered by `src/app/[locale]/layout.tsx`, an async
      // Server Component no other test in this repository renders.
      await expect(response.text()).resolves.toMatch(
        new RegExp(`<html[^>]*\\slang="${locale}"`),
      );
    },
  );

  it("answers an unknown route with 404", async () => {
    const response = await fetch(`${baseUrl}/no-such-page`);

    expect(response.status).toBe(404);
  });

  it("refuses POST /api/ask without the access key", async () => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Hello", locale: "en" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ERR_UNAUTHORIZED" },
    });
  });

  it("answers POST /api/ask with the access key", async () => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ACCESS_KEY}`,
      },
      body: JSON.stringify({ prompt: "Hello", locale: "en" }),
    });

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("answer" in body)) {
      throw new TypeError(
        `POST /api/ask must answer with an \`answer\` field; it answered ${JSON.stringify(body)}`,
      );
    }
    // The shape, never the wording: which adapter answers is
    // `src/server/composition.ts`'s to change without editing this suite.
    expect(Object.keys(body)).toStrictEqual(["answer"]);
    expect(typeof body.answer).toBe("string");
    expect(body.answer).not.toBe("");
  });
});
