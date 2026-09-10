import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCALES } from "../src/i18n/locales";
import { MESSAGES } from "../src/i18n/messages";

// The only suite that asks the application a question over HTTP. Every other
// test here drives one layer through its own surface — a handler with
// `new Request()`, `src/proxy.ts` as a bare function, a page under jsdom — so
// nothing else notices when the seams between them come apart: a proxy at a
// path Next.js does not load, a Route Handler the App Router never mounts, a
// layout that renders under jsdom and throws in a real render. This starts the
// built application the way a deployment does — the production build, served by
// `next start` under `NODE_ENV=production` — and asserts only what a client
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

/**
 * Everything `pnpm build` reads that changes what the served application does.
 *
 * @remarks
 * Compared against `.next/BUILD_ID`'s timestamp, which is why this list is
 * paths rather than a glob: it is walked, not matched. `pnpm build` writes
 * nothing under any of them — it writes `.next/` and `next-env.d.ts` — so a
 * source newer than the build means the build is not of that source.
 */
const BUILD_INPUTS = ["src", "messages", "next.config.ts"];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The most recent modification time anywhere under a repository-relative path. */
function newestMtimeMs(target: string): number {
  const absolute = path.join(repoRoot, target);
  const root = statSync(absolute);
  if (!root.isDirectory()) {
    return root.mtimeMs;
  }
  // Directories count too: adding or removing a file changes only the
  // directory's own timestamp, and a build missing a whole new page is exactly
  // the staleness this guard is for.
  let newest = root.mtimeMs;
  for (const entry of readdirSync(absolute, {
    recursive: true,
    withFileTypes: true,
  })) {
    const { mtimeMs } = statSync(path.join(entry.parentPath, entry.name));
    if (mtimeMs > newest) {
      newest = mtimeMs;
    }
  }
  return newest;
}

/**
 * Fail unless `.next` holds a build of the source that is on disk right now.
 *
 * @remarks
 * The suite runs after `pnpm build`, never instead of it — see `package.json`'s
 * `check:source` and ci.yml's `static` job, which each build exactly once and
 * then call `pnpm run test:smoke`. Both halves are checked because the missing
 * build and the stale one fail differently: the first turns Next.js's "Could
 * not find a production build" into an instruction, and the second is the one
 * that would otherwise pass. A `.next/` from an earlier commit answers every
 * assertion below happily, about code that is no longer here — the false
 * confidence this guard exists to prevent.
 */
function assertFreshBuild(): void {
  const buildId = path.join(repoRoot, ".next", "BUILD_ID");
  if (!existsSync(buildId)) {
    throw new Error(
      "This suite serves the output of `pnpm build`, which is missing. Run `pnpm build` first, or run `pnpm run test:smoke`, which check:source and ci.yml both call after the build.",
    );
  }

  const builtAtMs = statSync(buildId).mtimeMs;
  const changed = BUILD_INPUTS.filter((input) => newestMtimeMs(input) > builtAtMs);
  if (changed.length > 0) {
    throw new Error(
      `This suite serves the output of \`pnpm build\`, and ${changed.join(", ")} changed after that build was written. Run \`pnpm build\` again: a build of code that is no longer here would pass these assertions without asserting anything about the change.`,
    );
  }
}

/**
 * A TCP port nothing is listening on.
 *
 * @remarks
 * The port is asked of the operating system rather than written down, so two
 * checkouts of this repository — or a developer's own `pnpm dev` — can run at
 * the same time without one failing on `EADDRINUSE`. `next start` is given the
 * number after the probe releases it; the window in between is why the probe
 * binds the same loopback address the server will, and why readiness is not
 * decided by an HTTP response alone — see {@link waitUntilServing}.
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

/** The signals a run is interrupted with, rather than finished by. */
const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Kill the server group if this process is interrupted, and return the undo.
 *
 * @remarks
 * `detached: true` is what makes the group killable at all, but it is also what
 * takes the child out of the terminal's foreground process group: a Ctrl-C
 * during a run never reaches `next start` on its own, and Vitest does not
 * promise `afterAll` runs on the way out. So the leak `detached` closes on the
 * normal path is one it would open on the interrupted path, and this closes it
 * back. `SIGKILL` rather than `SIGTERM` because a signal handler has no way to
 * wait for a graceful exit.
 *
 * Re-raising is conditional on this being the only listener for that signal:
 * adding one suppresses Node's default termination, so with no other listener
 * the run would hang on Ctrl-C, and with one — Vitest's own — re-raising would
 * drive it twice.
 */
function killServerGroupWhenInterrupted(server: ChildProcess): () => void {
  const registered: { signal: NodeJS.Signals; handler: () => void }[] = [];

  function remove(): void {
    for (const { signal, handler } of registered) {
      process.off(signal, handler);
    }
    registered.length = 0;
  }

  for (const signal of INTERRUPT_SIGNALS) {
    const wasAlreadyHandled = process.listenerCount(signal) > 0;
    const handler = (): void => {
      remove();
      signalServerGroup(server, "SIGKILL");
      if (!wasAlreadyHandled) {
        process.kill(process.pid, signal);
      }
    };
    registered.push({ signal, handler });
    process.on(signal, handler);
  }

  return remove;
}

/** Stop the server, whether the suite passed or failed. */
async function stopServer(server: ChildProcess): Promise<void> {
  if (
    server.pid === undefined ||
    server.exitCode !== null ||
    server.signalCode !== null
  ) {
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
let stopWatchingForInterrupts: (() => void) | undefined;
let baseUrl = "";

/**
 * Wait until the spawned server — and not merely something on that port — is
 * answering.
 *
 * @remarks
 * A poll with a deadline, not a fixed wait: how long `next start` takes to
 * listen is a property of the machine, so a sleep long enough to be reliable on
 * CI would be time every local run pays. Fake timers cannot stand in here —
 * what is being waited on is a real process binding a real socket.
 *
 * The child's own report of the address it bound gates the first `fetch`,
 * because the port was released by {@link reserveEphemeralPort} before this
 * child was told to take it: something else winning that race and answering
 * HTTP would otherwise satisfy a bare `fetch` and let every assertion below run
 * against a foreign server. Only one process can hold a TCP port, so a child
 * that printed this address is the one behind it. The cost is a dependence on
 * what the CLI prints; when that changes, the failure carries the output it did
 * print, which is the thing a reader needs.
 */
async function waitUntilServing(
  child: ChildProcess,
  port: number,
  readOutput: () => string,
  readSpawnFailure: () => Error | undefined,
): Promise<void> {
  const boundAddress = `127.0.0.1:${String(port)}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    // Read off the child rather than a flag of this suite's own: a server that
    // failed to start answers nothing, and waiting out the whole deadline for
    // it would hide the reason it is holding in the collected output.
    const spawnFailure = readSpawnFailure();
    if (spawnFailure !== undefined) {
      throw new Error(
        `\`next start\` could not be spawned (${spawnFailure.message}):\n${readOutput()}`,
      );
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `\`next start\` exited before it accepted a connection:\n${readOutput()}`,
      );
    }
    if (readOutput().includes(boundAddress)) {
      try {
        await fetch(baseUrl, { redirect: "manual" });
        return;
      } catch {
        // Announced, not yet accepting.
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `\`next start\` did not serve ${boundAddress} within ${String(READY_TIMEOUT_MS)}ms:\n${readOutput()}`,
      );
    }
    await delay(POLL_INTERVAL_MS);
  }
}

beforeAll(async () => {
  assertFreshBuild();

  const port = await reserveEphemeralPort();
  baseUrl = `http://127.0.0.1:${String(port)}`;

  const started = spawn(
    process.execPath,
    [nextCli, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: repoRoot,
      // `NODE_ENV` is set rather than inherited: Vitest defaults it to `test`,
      // and Next.js's CLI only fills the variable in when it is absent, so the
      // production build would otherwise be served under `test` and every
      // `process.env.NODE_ENV === "production"` branch would take a path no
      // deployment takes.
      env: { ...process.env, NODE_ENV: "production", API_ACCESS_KEY: ACCESS_KEY },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  server = started;
  stopWatchingForInterrupts = killServerGroupWhenInterrupted(started);

  // Kept so a server that dies on start-up reports why, instead of this suite
  // reporting only that nothing ever answered.
  let output = "";
  const collect = (chunk: Buffer): void => {
    output += chunk.toString("utf8");
  };
  started.stdout.on("data", collect);
  started.stderr.on("data", collect);

  // An `error` on a `ChildProcess` nobody is listening to is thrown as an
  // uncaught exception, which on a loaded runner (`EAGAIN`, `EMFILE`) would
  // kill this worker with an opaque stack instead of the report above.
  let spawnFailure: Error | undefined;
  started.on("error", (error: Error) => {
    spawnFailure = error;
  });

  await waitUntilServing(
    started,
    port,
    () => output,
    () => spawnFailure,
  );
});

afterAll(async () => {
  stopWatchingForInterrupts?.();
  stopWatchingForInterrupts = undefined;
  if (server !== undefined) {
    await stopServer(server);
    server = undefined;
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
    "serves /%s as a document with localized metadata and language alternates",
    async (locale) => {
      const response = await fetch(`${baseUrl}/${locale}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      // `<html lang>` is rendered by `src/app/[locale]/layout.tsx`, an async
      // Server Component no other test in this repository renders.
      const document = await response.text();
      expect(document).toMatch(new RegExp(`<html[^>]*\\slang="${locale}"`));
      expect(document).toContain(`<title>${MESSAGES[locale].Metadata.title}</title>`);
      expect(document).toContain(
        `<meta name="description" content="${MESSAGES[locale].Metadata.description}"`,
      );
      expect(document).toMatch(
        new RegExp(
          `<link(?=[^>]*rel="canonical")(?=[^>]*href="[^"]*/${locale}")[^>]*>`,
        ),
      );
      for (const alternateLocale of LOCALES) {
        expect(document).toMatch(
          new RegExp(
            `<link(?=[^>]*rel="alternate")(?=[^>]*hrefLang="${alternateLocale}")(?=[^>]*href="[^"]*/${alternateLocale}")[^>]*>`,
          ),
        );
      }
    },
  );

  it("serves distinct metadata for English and Japanese", async () => {
    const documents = await Promise.all(
      LOCALES.map(async (locale) => (await fetch(`${baseUrl}/${locale}`)).text()),
    );

    expect(documents[0]).not.toContain(`<title>${MESSAGES.ja.Metadata.title}</title>`);
    expect(documents[0]).not.toContain(
      `<meta name="description" content="${MESSAGES.ja.Metadata.description}"`,
    );
  });

  // The two halves of "an unknown route 404s" are asserted apart, and both with
  // `redirect: "manual"`, because following the redirect merges them: a single
  // `fetch("/no-such-page")` reports the 404 of `/en/no-such-page` and passes
  // just as happily if the proxy stopped running and the unprefixed path 404d
  // on its own — one of the failures this suite exists to catch.
  it("redirects an unknown path with no locale prefix rather than 404ing it", async () => {
    const response = await fetch(`${baseUrl}/no-such-page`, {
      redirect: "manual",
      headers: { "accept-language": "en" },
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    expect(new URL(location ?? "", baseUrl).pathname).toBe("/en/no-such-page");
  });

  it.each(LOCALES)(
    "serves /%s/no-such-page as a localized 404 document",
    async (locale) => {
      const response = await fetch(`${baseUrl}/${locale}/no-such-page`, {
        redirect: "manual",
      });

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("text/html");

      const document = await response.text();
      expect(document.match(/<html\b/g)).toHaveLength(1);
      expect(document.match(/<body\b/g)).toHaveLength(1);
      expect(document).toMatch(new RegExp(`<html[^>]*\\slang="${locale}"`));
      expect(document).toContain(MESSAGES[locale].NotFound.title);
      expect(document).toContain(MESSAGES[locale].NotFound.description);
      expect(document).toContain(MESSAGES[locale].NotFound.homeLink);

      const otherLocale = locale === "en" ? "ja" : "en";
      expect(document).not.toContain(MESSAGES[otherLocale].NotFound.title);
    },
  );

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
