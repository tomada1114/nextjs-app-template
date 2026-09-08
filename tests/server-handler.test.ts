import { describe, expect, it } from "vitest";
import type * as z from "zod";

import {
  createFakeLlmPort,
  type LlmError,
  type LlmErrorCode,
  type LlmPort,
  type LlmRequest,
} from "../src/ai/index";
import { POST } from "../src/app/api/ask/route";
import type { Result } from "../src/core/result";
import { askHandler } from "../src/server/composition";
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

/** The answer the fake port is configured to give unless a test says otherwise. */
const ANSWER = { answer: "Kyoto is the old capital." };

describe("the ask handler", () => {
  it("answers a well-formed request with the model's structured output", async () => {
    const handler = createAskHandler({ llm: createFakeLlmPort({ response: ANSWER }) });

    const response = await handler(
      postRequest(JSON.stringify({ prompt: "Which city was the old capital?" })),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toStrictEqual(ANSWER);
  });

  it("passes the prompt through to the port unchanged", async () => {
    const seen: CapturedRequest[] = [];
    const handler = createAskHandler({
      llm: capturing(createFakeLlmPort({ response: ANSWER }), seen),
    });

    await handler(
      postRequest(JSON.stringify({ prompt: "  Which city? ", locale: "ja" })),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).toBe("  Which city? ");
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

describe("the composed /api/ask route", () => {
  it("is the handler composition.ts builds, re-exported as POST", () => {
    expect(POST).toBe(askHandler);
  });

  // Deliberately silent about the status and the answer: which adapter
  // composition.ts wires is its own decision to change, and a test that pinned
  // the fake adapter's wording here would have to be edited to swap it.
  it("answers a real request with a JSON body", async () => {
    const response = await askHandler(
      postRequest(JSON.stringify({ prompt: "Which city was the old capital?" })),
    );

    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toBeTypeOf("object");
  });

  // Pins the promise README.md and AGENTS.md both make: a fresh checkout with
  // no ANTHROPIC_API_KEY still answers instead of surfacing ERR_LLM_AUTH as a
  // 500 (#77). This is the one test in the suite allowed to depend on the
  // process environment, and only to assert the premise the regression needs:
  // that this run has no credential configured, the same as a fresh clone.
  it("answers 200 with no ANTHROPIC_API_KEY configured", async () => {
    expect(process.env["ANTHROPIC_API_KEY"] ?? "").toBe("");

    const response = await askHandler(
      postRequest(JSON.stringify({ prompt: "Which city was the old capital?" })),
    );

    expect(response.status).toBe(200);
  });
});
