import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where a recorded provider exchange is kept.
 *
 * @remarks
 * `tests/fixtures/` is excluded from ESLint, Prettier, typos and tsconfig, and
 * from Vitest's own collection. That is deliberate for this directory: a
 * recording is captured data, and reformatting it would change the very bytes a
 * replay asserts on. It is *not* excluded from `scripts/check-staged.mjs`,
 * which inspects every staged blob whatever its extension, so the credential
 * guard still applies to anything written here.
 */
export const LLM_FIXTURES_DIR = fileURLToPath(
  new URL("fixtures/llm/", import.meta.url),
);

/**
 * One recorded HTTP exchange, as a fixture file holds it.
 *
 * @remarks
 * Deliberately not a whole `Response`. Only the status and the JSON body are
 * kept, because those are all a replay needs, and dropping the headers is what
 * makes a credential structurally unable to reach a committed file: the request
 * — where the SDK puts `x-api-key` — is never written down at all, and neither
 * is any response header a future API version might add.
 *
 * The body *is* verbatim, so what the provider puts inside it is committed:
 * `success.json` carries the real `id` of the recorded message, and an error
 * body carries its `request_id`. Those are opaque per-request identifiers, not
 * credentials, and keeping them is what makes the fixture a real recording.
 *
 * `headers` exists for the hand-written fixtures that need one (a
 * `retry-after`, say); the recorder never writes it.
 */
export interface LlmFixture {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Whether this run is allowed to reach the provider and overwrite fixtures. */
export function isRecording(): boolean {
  return process.env["LLM_RECORD"] === "1";
}

function fixturePath(name: string): string {
  return path.join(LLM_FIXTURES_DIR, `${name}.json`);
}

function isFixture(value: unknown): value is LlmFixture {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { status?: unknown }).status === "number" &&
    "body" in value
  );
}

/** Reads one fixture, failing loudly rather than replaying a malformed one. */
export function readFixture(name: string): LlmFixture {
  const parsed: unknown = JSON.parse(readFileSync(fixturePath(name), "utf8"));
  if (!isFixture(parsed)) {
    throw new Error(`${fixturePath(name)} is not a recorded LLM exchange.`);
  }
  return parsed;
}

/**
 * A `fetch` that answers from a committed fixture and never opens a socket.
 *
 * @remarks
 * This is the whole replay mechanism. Substituting the SDK's HTTP layer rather
 * than stubbing the adapter is what keeps the code under test identical to the
 * code that talks to the provider — the request is built, signed, sent and its
 * response decoded by the real SDK — and it needs no test dependency to do it.
 */
export function replayFetch(name: string): typeof globalThis.fetch {
  const fixture = readFixture(name);
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(fixture.body), {
        status: fixture.status,
        headers: { "content-type": "application/json", ...fixture.headers },
      }),
    );
}

/**
 * A `fetch` that never answers, and reports an abort the way a real one does.
 *
 * @remarks
 * Rejecting with the signal's own `reason` is what makes both deadline paths
 * observable: the SDK aborts its internal controller when its `timeout`
 * elapses, and forwards the caller's `AbortSignal` to that same controller, so
 * one implementation covers a timed-out request and a cancelled one.
 */
export function neverResolvingFetch(): typeof globalThis.fetch {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        return;
      }
      if (signal.aborted) {
        reject(abortRejection(signal.reason));
        return;
      }
      signal.addEventListener("abort", () => {
        reject(abortRejection(signal.reason));
      });
    });
}

/**
 * The rejection a real `fetch` produces for an aborted request.
 *
 * @remarks
 * The name is the load-bearing part: the SDK tells a deadline apart from any
 * other transport failure by `name === "AbortError"` alone, so a `reason` that
 * is not already an `Error` still has to arrive under that name rather than as
 * a bare value.
 */
function abortRejection(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error(String(reason));
  error.name = "AbortError";
  return error;
}

/**
 * A `fetch` that calls the provider for real and writes the answer to `name`.
 *
 * @remarks
 * Only ever reached under `LLM_RECORD=1`, which is a local operation needing a
 * real credential. The request is never written down — only the status and the
 * response body are — so no header this call sent can reach a committed file.
 */
export function recordingFetch(
  name: string,
  expectedStatus: number,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    const text = await response.text();

    // Written only for the status the recording set out to capture. A session
    // that met a 429 or a 500 instead would otherwise overwrite a good fixture
    // with that body: the assertion downstream still fails, but the damaged
    // file is already on disk by then and `git add` would stage it.
    if (response.status === expectedStatus) {
      const fixture: LlmFixture = {
        status: response.status,
        body: JSON.parse(text) as unknown,
      };
      mkdirSync(LLM_FIXTURES_DIR, { recursive: true });
      writeFileSync(fixturePath(name), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    }

    return new Response(text, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * A `fetch` that answers with headers and then never finishes the body.
 *
 * @remarks
 * The window {@link neverResolvingFetch} cannot reach. The SDK converts an
 * abort into `APIUserAbortError` only while it still owns the request, and it
 * hands ownership over once the `Response` resolves; a cancellation arriving
 * during the body decode therefore surfaces as a bare `AbortError` instead.
 * Reproducing that window is what keeps the port's `cause`-by-identity promise
 * under test on both sides of the headers rather than only the near side.
 *
 * `bodyRead` settles once the consumer has actually started reading the body —
 * the moment the SDK stops owning the request, and the boundary a caller can
 * wait on instead of estimating with a real sleep. It is created once, at
 * helper construction, with the `let resolve` pattern rather than
 * `Promise.withResolvers`, which is ES2024 and outside `tsconfig.json`'s
 * `lib: ["ES2023", "DOM", "DOM.Iterable"]`.
 *
 * The stream's `{ highWaterMark: 0 }` strategy is load-bearing: at the default
 * high-water mark of 1 the stream pre-fills and `pull` runs at construction,
 * before any consumer, which would resolve `bodyRead` on the near side of the
 * boundary it exists to mark. At HWM 0, `pull` runs only once something (here,
 * the SDK's own `Response` decoding) actually reads.
 */
export function headersThenStallFetch(): {
  fetch: typeof globalThis.fetch;
  /** Settles once the consumer has actually started reading the body. */
  bodyRead: Promise<void>;
} {
  let resolveBodyRead: () => void = () => undefined;
  const bodyRead = new Promise<void>((resolve) => {
    resolveBodyRead = resolve;
  });

  const fetch: typeof globalThis.fetch = (_input, init) => {
    const body = new ReadableStream(
      {
        start(controller) {
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () => {
              controller.error(abortRejection(signal.reason));
            },
            { once: true },
          );
        },
        pull() {
          resolveBodyRead();
        },
      },
      { highWaterMark: 0 },
    );

    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  return { fetch, bodyRead };
}
