import { describe, expect, it, vi } from "vitest";
import type * as z from "zod";

import {
  createFakeLlmPort,
  type LlmError,
  type LlmErrorCode,
  type LlmPort,
  type LlmRequest,
} from "../src/ai/index";
import type { Result } from "../src/core/result";
import { createAskHandler } from "../src/server/handlers/ask";

/**
 * The origin a `Request` needs to be constructible.
 *
 * @remarks
 * Nothing in the handler reads it — the route's path is Next.js's business, not
 * the handler's — but `new Request()` rejects a relative URL.
 */
const ENDPOINT = "http://localhost/api/ask";

/** What the port was asked, as the handler passed it on. */
interface CapturedRequest {
  readonly prompt: string;
  readonly outputLanguage: string;
  readonly signal: AbortSignal | undefined;
}

/**
 * Wraps a port so a test can assert on what the handler asked it.
 *
 * @remarks
 * A recording wrapper rather than a mock: the request still reaches a real
 * fake port and comes back through the same code path, so the assertions below
 * are about behavior rather than about how many times something was called.
 */
function capturing(inner: LlmPort, seen: CapturedRequest[]): LlmPort {
  return {
    generate<TSchema extends z.ZodType>(
      request: LlmRequest<TSchema>,
    ): Promise<Result<z.infer<TSchema>, LlmError>> {
      seen.push({
        prompt: request.prompt,
        outputLanguage: request.outputLanguage,
        signal: request.signal,
      });
      return inner.generate(request);
    },
  };
}

/** A `POST` carrying `body` verbatim, however malformed it is. */
function postRequest(body: string, init: RequestInit = {}): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    ...init,
  });
}

/**
 * `RequestInit` with the field Node requires alongside a streaming body.
 *
 * @remarks
 * `undici` refuses a `ReadableStream` body without `duplex: "half"`, and
 * TypeScript's DOM `RequestInit` does not declare the field, so an inline
 * object literal would not compile. Named here rather than cast at the call
 * site.
 */
type StreamingRequestInit = RequestInit & { readonly duplex: "half" };

/**
 * A `POST` whose body stream fails partway through, as a dropped upload does.
 *
 * @remarks
 * The one shape `new Request(url, { body: "..." })` cannot express: a body that
 * begins to arrive and then stops because the connection died. Everything below
 * the handler sees exactly what a client hanging up mid-upload produces.
 */
function postRequestThatFailsMidBody(): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"prompt":"Which cit'));
      controller.error(new Error("connection reset"));
    },
  });
  const init: StreamingRequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  };
  return new Request(ENDPOINT, init);
}

/** The answer the fake port is configured to give unless a test says otherwise. */
const ANSWER = { answer: "Kyoto is the old capital." };

/**
 * The two ceilings the handler enforces, written out rather than imported.
 *
 * @remarks
 * Importing `MAX_PROMPT_LENGTH` or `MAX_REQUEST_BODY_BYTES` would make every
 * boundary case below agree with the implementation by construction — a
 * ceiling raised by mistake would move the tests with it and nothing would
 * fail. These are the numbers a caller is promised, so they are typed here.
 * The body ceiling is stated in bytes and exercised with ASCII JSON, where a
 * character is one byte.
 */
const MAX_PROMPT_LENGTH = 8_000;
const MAX_REQUEST_BODY_BYTES = 65_536;

/**
 * A well-formed request body padded out to exactly `bytes` bytes.
 *
 * @remarks
 * The padding goes in a property the schema does not declare — `zod` strips an
 * unknown key rather than rejecting it — because the `prompt` has a ceiling of
 * its own far below the body's, so no legal prompt can fill a body on its own.
 */
function bodyOfBytes(bytes: number): string {
  const envelope = JSON.stringify({ prompt: "Which city?", padding: "" });
  return JSON.stringify({
    prompt: "Which city?",
    padding: "a".repeat(bytes - envelope.length),
  });
}

describe("the ask handler", () => {
  it("answers a well-formed request with the model's structured output", async () => {
    const handler = createAskHandler({ llm: createFakeLlmPort({ response: ANSWER }) });

    const response = await handler(
      postRequest(JSON.stringify({ prompt: "Which city was the old capital?" })),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toStrictEqual(ANSWER);
  });

  it.each([{ invalid: [0xff] }, { invalid: [0xc3, 0x28] }, { invalid: [0xe3, 0x81] }])(
    "rejects malformed UTF-8 bytes $invalid without asking the model",
    async ({ invalid }) => {
      const seen: CapturedRequest[] = [];
      const handler = createAskHandler({
        llm: capturing(createFakeLlmPort({ response: ANSWER }), seen),
      });
      const encoder = new TextEncoder();
      const body = Uint8Array.from([
        ...encoder.encode('{"prompt":"'),
        ...invalid,
        ...encoder.encode('"}'),
      ]);
      const response = await handler(new Request(ENDPOINT, { method: "POST", body }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "ERR_BAD_REQUEST" },
      });
      expect(seen).toEqual([]);
    },
  );

  it("decodes multi-byte text split across body chunks without changing it", async () => {
    const prompt = "\u65e5\u672c\u8a9e \u{1F600}";
    const bytes = new TextEncoder().encode(JSON.stringify({ prompt }));
    const seen: CapturedRequest[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) {
          controller.enqueue(Uint8Array.of(byte));
        }
        controller.close();
      },
    });
    const init: StreamingRequestInit = { method: "POST", body: stream, duplex: "half" };
    const handler = createAskHandler({
      llm: capturing(createFakeLlmPort({ response: ANSWER }), seen),
    });

    expect((await handler(new Request(ENDPOINT, init))).status).toBe(200);
    expect(seen[0]?.prompt).toBe(prompt);
  });

  it("prevents malformed-request failures from being cached", async () => {
    const handler = createAskHandler({ llm: createFakeLlmPort({ response: ANSWER }) });
    const response = await handler(postRequest("not JSON"));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("passes the prompt to the port with its surrounding whitespace trimmed", async () => {
    const seen: CapturedRequest[] = [];
    const handler = createAskHandler({
      llm: capturing(createFakeLlmPort({ response: ANSWER }), seen),
    });

    await handler(
      postRequest(JSON.stringify({ prompt: "  Which city? ", locale: "ja" })),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).toBe("Which city?");
  });

  // The mapping itself, not the port's field: the UI ships `en` and `ja`, and
  // the model is asked in the BCP 47 tag each one names. A locale added to
  // `src/i18n/locales.ts` without an entry in the handler's table fails to
  // compile, so this only has to pin the values the table produces today.
  it.each([
    ["ja", "ja"],
    ["en", "en"],
  ])("asks the model to answer the %s locale in %s", async (locale, expected) => {
    const seen: CapturedRequest[] = [];
    const handler = createAskHandler({
      llm: capturing(createFakeLlmPort({ response: ANSWER }), seen),
    });

    await handler(postRequest(JSON.stringify({ prompt: "Which city?", locale })));

    expect(seen[0]?.outputLanguage).toBe(expected);
  });

  it("defaults the output language to English when the body omits the locale", async () => {
    const seen: CapturedRequest[] = [];
    const handler = createAskHandler({
      llm: capturing(createFakeLlmPort({ response: ANSWER }), seen),
    });

    await handler(postRequest(JSON.stringify({ prompt: "Which city?" })));

    expect(seen[0]?.outputLanguage).toBe("en");
  });

  it("forwards the caller's cancellation to the port", async () => {
    const seen: CapturedRequest[] = [];
    const handler = createAskHandler({
      llm: capturing(createFakeLlmPort({ response: ANSWER }), seen),
    });
    const controller = new AbortController();

    const request = postRequest(JSON.stringify({ prompt: "Which city?" }), {
      signal: controller.signal,
    });
    await handler(request);
    const forwarded = seen[0]?.signal;
    expect(forwarded?.aborted).toBe(false);

    controller.abort();

    expect(forwarded?.aborted).toBe(true);
  });

  it("rejects a body that is not JSON", async () => {
    const handler = createAskHandler({ llm: createFakeLlmPort({ response: ANSWER }) });

    const response = await handler(postRequest("not json at all"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        code: "ERR_BAD_REQUEST",
        message: "The request body is not valid JSON.",
      },
    });
  });

  it.each([
    ["an object with no prompt", JSON.stringify({ locale: "en" })],
    ["an empty prompt", JSON.stringify({ prompt: "" })],
    ["a whitespace-only prompt", JSON.stringify({ prompt: "   " })],
    ["a prompt of tabs and newlines", JSON.stringify({ prompt: "\t\n \r\n" })],
    [
      "a prompt one character over the ceiling",
      JSON.stringify({ prompt: "a".repeat(MAX_PROMPT_LENGTH + 1) }),
    ],
    [
      "a prompt still over the ceiling once its whitespace is trimmed",
      JSON.stringify({ prompt: ` ${"a".repeat(MAX_PROMPT_LENGTH + 1)} ` }),
    ],
    ["a non-string prompt", JSON.stringify({ prompt: 42 })],
    ["a locale this app does not ship", JSON.stringify({ prompt: "Hi", locale: "fr" })],
    ["a blank locale", JSON.stringify({ prompt: "Hi", locale: "" })],
    ["a JSON array", JSON.stringify([{ prompt: "Hi" }])],
    ["a bare JSON string", JSON.stringify("Hi")],
  ])("rejects %s with ERR_BAD_REQUEST", async (_label, body) => {
    const handler = createAskHandler({ llm: createFakeLlmPort({ response: ANSWER }) });

    const response = await handler(postRequest(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ERR_BAD_REQUEST" },
    });
  });

  // A connection that dies mid-upload is an ordinary event, not a defect in
  // this process: the handler owes the caller a `Response`, the same 400 a body
  // read with `request.json()` produced, rather than a rejection that reaches
  // the route boundary as a 500 carrying no `error.code` at all.
  it("rejects a body whose stream fails mid-read without reaching the port", async () => {
    const seen: CapturedRequest[] = [];
    const handler = createAskHandler({
      llm: capturing(createFakeLlmPort({ response: ANSWER }), seen),
    });

    const response = await handler(postRequestThatFailsMidBody());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ERR_BAD_REQUEST" },
    });
    expect(seen).toStrictEqual([]);
  });

  it.each(["already", "in flight"] as const)(
    "stops reading an upload when its signal was aborted %s",
    async (when) => {
      vi.useFakeTimers();
      const seen: CapturedRequest[] = [];
      const abort = new AbortController();
      let finishBody: () => void = () => undefined;
      const cancellation = { done: false };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          finishBody = () => {
            controller.close();
          };
        },
        cancel() {
          cancellation.done = true;
        },
      });
      const init: StreamingRequestInit = {
        method: "POST",
        body: stream,
        duplex: "half",
        signal: abort.signal,
      };
      const request = new Request(ENDPOINT, init);
      if (when === "already") {
        abort.abort();
      }
      let outcome: Response | undefined;
      const pending = createAskHandler({
        llm: capturing(createFakeLlmPort({ response: ANSWER }), seen),
      })(request);
      void pending.then((response) => {
        outcome = response;
      });
      try {
        if (when === "in flight") {
          abort.abort();
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome?.status).toBe(400);
        expect(cancellation.done).toBe(true);
        expect(request.body?.locked).toBe(false);
        expect(seen).toEqual([]);
      } finally {
        if (!cancellation.done) {
          finishBody();
        }
        await pending;
        vi.useRealTimers();
      }
    },
  );

  it("answers an oversized upload without waiting for its cancellation hook", async () => {
    vi.useFakeTimers();
    let finishCancellation: () => void = () => undefined;
    const cancellation = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_REQUEST_BODY_BYTES + 1));
      },
      cancel: () => cancellation,
    });
    const init: StreamingRequestInit = { method: "POST", body: stream, duplex: "half" };
    const request = new Request(ENDPOINT, init);
    let outcome: Response | undefined;
    const pending = createAskHandler({ llm: createFakeLlmPort({ response: ANSWER }) })(
      request,
    );
    void pending.then((response) => {
      outcome = response;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome?.status).toBe(413);
      expect(request.body?.locked).toBe(false);
    } finally {
      finishCancellation();
      await pending;
      vi.useRealTimers();
    }
  });

  it("rejects a request that carries no body at all", async () => {
    const handler = createAskHandler({ llm: createFakeLlmPort({ response: ANSWER }) });

    const response = await handler(new Request(ENDPOINT, { method: "POST" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ERR_BAD_REQUEST" },
    });
  });

  it.each([
    ["at the ceiling", "a".repeat(MAX_PROMPT_LENGTH)],
    ["at the ceiling once trimmed", `  ${"a".repeat(MAX_PROMPT_LENGTH)}  `],
    ["at the floor", "a"],
  ])("answers a prompt %s", async (_label, prompt) => {
    const seen: CapturedRequest[] = [];
    const handler = createAskHandler({
      llm: capturing(createFakeLlmPort({ response: ANSWER }), seen),
    });

    const response = await handler(postRequest(JSON.stringify({ prompt })));

    expect(response.status).toBe(200);
    expect(seen[0]?.prompt).toBe(prompt.trim());
  });

  // The endpoint's own promise, and the one place message text is asserted on:
  // a caller learns which constraint it broke and never reads its own input
  // back out of the answer, which is what would copy a prompt into every log
  // that records a 400. See the `designing-errors` skill.
  it("names the prompt constraint without echoing the prompt that broke it", async () => {
    const handler = createAskHandler({ llm: createFakeLlmPort({ response: ANSWER }) });
    const rejected = "hunter2-".repeat(MAX_PROMPT_LENGTH);

    const response = await handler(postRequest(JSON.stringify({ prompt: rejected })));
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("ERR_BAD_REQUEST");
    expect(body).toContain(String(MAX_PROMPT_LENGTH));
    expect(body).not.toContain("hunter2");
  });

  it("answers a body of exactly the byte ceiling", async () => {
    const handler = createAskHandler({ llm: createFakeLlmPort({ response: ANSWER }) });

    const response = await handler(postRequest(bodyOfBytes(MAX_REQUEST_BODY_BYTES)));

    expect(response.status).toBe(200);
  });

  // The point is not only the status: a body this endpoint refuses must be
  // refused *before* the port is reached, or the request has already cost
  // money by the time it is rejected.
  it("rejects a body over the byte ceiling without reaching the port", async () => {
    const seen: CapturedRequest[] = [];
    const handler = createAskHandler({
      llm: capturing(createFakeLlmPort({ response: ANSWER }), seen),
    });

    const response = await handler(
      postRequest(bodyOfBytes(MAX_REQUEST_BODY_BYTES + 1)),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        code: "ERR_PAYLOAD_TOO_LARGE",
        message: `The request body must be at most ${String(MAX_REQUEST_BODY_BYTES)} bytes.`,
      },
    });
    expect(seen).toStrictEqual([]);
  });

  // A ceiling enforced by reading is a ceiling a lying client cannot move; one
  // read off `Content-Length` would be exactly as wrong as the header is.
  it("rejects an oversized body that declares a small Content-Length", async () => {
    const seen: CapturedRequest[] = [];
    const handler = createAskHandler({
      llm: capturing(createFakeLlmPort({ response: ANSWER }), seen),
    });

    const response = await handler(
      postRequest(bodyOfBytes(MAX_REQUEST_BODY_BYTES + 1), {
        headers: { "content-type": "application/json", "content-length": "12" },
      }),
    );

    expect(response.status).toBe(413);
    expect(seen).toStrictEqual([]);
  });

  it.each([
    ["ERR_LLM_AUTH", 500],
    ["ERR_LLM_RATE_LIMIT", 429],
    ["ERR_LLM_TIMEOUT", 504],
    ["ERR_LLM_INVALID_OUTPUT", 502],
    ["ERR_LLM_UNAVAILABLE", 503],
  ] as const satisfies readonly (readonly [LlmErrorCode, number])[])(
    "reports %s as HTTP %i",
    async (code, status) => {
      const handler = createAskHandler({ llm: createFakeLlmPort({ failWith: code }) });

      const response = await handler(postRequest(JSON.stringify({ prompt: "Hi" })));

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toStrictEqual({
        error: {
          code,
          message: "The language model could not answer this request.",
        },
      });
    },
  );

  it("reports an answer that does not match the schema as ERR_LLM_INVALID_OUTPUT", async () => {
    const handler = createAskHandler({
      llm: createFakeLlmPort({ response: { answer: 42 } }),
    });

    const response = await handler(postRequest(JSON.stringify({ prompt: "Hi" })));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ERR_LLM_INVALID_OUTPUT" },
    });
  });
});

// `src/server/env.ts` makes `API_ACCESS_KEY` mandatory as soon as a billed
// provider credential is configured, so this is what a deployed app that pays
// for its answers actually runs. What each case has to show is not only the
// status but that the port was never reached: an endpoint that rejects a
// request *after* spending money on it has protected nothing.
describe("the ask handler with an access key configured", () => {
  const ACCESS_KEY = "an-example-access-key";

  /** The handler and the record of everything the port was asked. */
  function guarded(): {
    handler: (request: Request) => Promise<Response>;
    seen: CapturedRequest[];
  } {
    const seen: CapturedRequest[] = [];
    return {
      handler: createAskHandler({
        llm: capturing(createFakeLlmPort({ response: ANSWER }), seen),
        accessKey: ACCESS_KEY,
      }),
      seen,
    };
  }

  /** A well-formed `POST` carrying `authorization` verbatim, or none at all. */
  function askWith(authorization?: string): Request {
    return postRequest(
      JSON.stringify({ prompt: "Which city was the old capital?" }),
      authorization === undefined ? {} : { headers: { authorization } },
    );
  }

  // RFC 9110 §11.1 makes the auth-scheme token case-insensitive, and a client,
  // a proxy or a gateway may normalise it, so the spelling a caller sends must
  // not decide whether the correct key is accepted.
  it.each([
    ["Bearer", `Bearer ${ACCESS_KEY}`],
    ["bearer", `bearer ${ACCESS_KEY}`],
    ["BEARER", `BEARER ${ACCESS_KEY}`],
  ])(
    "answers a request carrying the configured key under the %s scheme",
    async (_label, authorization) => {
      const { handler, seen } = guarded();

      const response = await handler(askWith(authorization));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual(ANSWER);
      expect(seen).toHaveLength(1);
    },
  );

  it.each([
    ["no Authorization header", undefined],
    ["an empty Authorization header", ""],
    ["a wrong key", "Bearer not-the-configured-key"],
    ["the right key under the wrong scheme", `Basic ${ACCESS_KEY}`],
    ["the key with no scheme", ACCESS_KEY],
    ["a bearer prefix and nothing after it", "Bearer "],
    ["a prefix of the key", `Bearer ${ACCESS_KEY.slice(0, -1)}`],
    ["the key with something appended", `Bearer ${ACCESS_KEY}x`],
  ])("rejects %s without reaching the port", async (_label, authorization) => {
    const { handler, seen } = guarded();

    const response = await handler(askWith(authorization));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        code: "ERR_UNAUTHORIZED",
        message: "This endpoint requires a valid access key.",
      },
    });
    expect(seen).toStrictEqual([]);
  });

  it("challenges with the scheme a caller has to use", async () => {
    const { handler } = guarded();

    const response = await handler(askWith());

    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("rejects before validating the body, so an anonymous caller learns nothing", async () => {
    const { handler, seen } = guarded();

    const response = await handler(postRequest("not json at all"));

    expect(response.status).toBe(401);
    expect(seen).toStrictEqual([]);
  });
});

describe("the composed /api/ask route", () => {
  /**
   * The composition root and the route rebuilt against `env`, registry and all.
   *
   * @remarks
   * `src/server/composition.ts` reads the environment once at module load and
   * refuses to load at all without the provider's credentials, so neither
   * module is imported statically here: a static import would assert on
   * whatever the developer's shell exports. Every declared name is stubbed,
   * absent unless `env` gives it, for the same reason.
   */
  async function composedWith(
    env: Readonly<Record<string, string | undefined>>,
  ): Promise<{
    askHandler: (request: Request) => Promise<Response>;
    POST: (request: Request) => Promise<Response>;
  }> {
    for (const name of [
      "OPENROUTER_API_KEY",
      "LLM_MODEL",
      "LLM_ADAPTER",
      "API_ACCESS_KEY",
    ]) {
      vi.stubEnv(name, env[name]);
    }
    vi.resetModules();
    const { askHandler } = await import("../src/server/composition");
    const { POST } = await import("../src/app/api/ask/route");
    return { askHandler, POST };
  }

  it("is the handler composition.ts builds, re-exported as POST", async () => {
    const { askHandler, POST } = await composedWith({ LLM_ADAPTER: "fake" });

    expect(POST).toBe(askHandler);
  });

  // Pins the answer envelope the route replies with, against the real
  // composition rather than against a handler this test builds itself. The
  // body is matched by shape, not by wording -- which adapter composition.ts
  // wires is its own decision to change, but that the reply is
  // `{answer: <string>}` and not an error envelope is not.
  it("answers a well-formed request with the answer envelope", async () => {
    const { askHandler } = await composedWith({ LLM_ADAPTER: "fake" });

    const response = await askHandler(
      postRequest(JSON.stringify({ prompt: "Which city was the old capital?" })),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body: unknown = await response.json();
    expect(body).toBeTypeOf("object");
    expect(body).not.toBeNull();
    if (typeof body !== "object" || body === null || !("answer" in body)) {
      throw new Error(`not an answer envelope: ${JSON.stringify(body)}`);
    }
    expect(Object.keys(body)).toStrictEqual(["answer"]);
    expect(body.answer).toBeTypeOf("string");
  });

  // The keyless path is explicit: under LLM_ADAPTER=fake nothing is billed,
  // so with no API_ACCESS_KEY the route answers an anonymous caller rather
  // than a 401 (#82), and with no provider key it still answers rather than
  // surfacing ERR_LLM_AUTH (#77).
  it("answers 200 under LLM_ADAPTER=fake with no credential of either kind", async () => {
    const { askHandler } = await composedWith({ LLM_ADAPTER: "fake" });

    const response = await askHandler(
      postRequest(JSON.stringify({ prompt: "Which city was the old capital?" })),
    );

    expect(response.status).toBe(200);
  });

  // The provider adapter bills, so the composition it builds is closed: a
  // caller without the access key is turned away before any model call.
  it("answers 401 to an anonymous caller while the provider adapter is wired", async () => {
    const network = vi.fn(() => Promise.reject(new Error("network reached")));
    vi.stubGlobal("fetch", network);
    const { askHandler } = await composedWith({
      OPENROUTER_API_KEY: "a-key",
      API_ACCESS_KEY: "an-access-key",
    });

    const response = await askHandler(
      postRequest(JSON.stringify({ prompt: "Which city was the old capital?" })),
    );

    expect(response.status).toBe(401);
    expect(network).not.toHaveBeenCalled();
  });
});
