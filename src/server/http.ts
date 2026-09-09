import { err, ok, type Result } from "../core/result";

/**
 * The most bytes a request body may carry before it is refused part-read.
 *
 * @remarks
 * A Route Handler has nothing in front of it — `src/proxy.ts` matches no `api`
 * path — and a self-hosted `next start` enforces no payload limit of its own,
 * which is the deployment this template has to be safe in. 64 KiB is small
 * enough that concurrent requests cannot exhaust memory between them, and
 * comfortably above the largest body an endpoint here accepts: a
 * maximum-length prompt reaches at most about 48 KiB of JSON, since the
 * longest escape a character can take is six bytes. Lowering it under that
 * headroom would make a request the schema calls legal unreachable.
 */
export const MAX_REQUEST_BODY_BYTES = 65_536;

/**
 * The failure body every non-2xx answer carries.
 *
 * @remarks
 * `code` is the contract a client branches on; `message` is prose and may be
 * reworded. A message names the shape of what was refused — a field, a limit,
 * the set of accepted values — and never the content that was sent, which
 * would copy a caller's own data into every log that records the answer.
 */
export function failure(
  status: number,
  code: string,
  message: string,
  headers: HeadersInit = {},
): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

/**
 * Reads `request`'s body as JSON, refusing one that is too large to buffer.
 *
 * @remarks
 * The body is read chunk by chunk and abandoned the moment it crosses
 * {@link MAX_REQUEST_BODY_BYTES}, rather than trusting `Content-Length`. That
 * header is absent under chunked transfer encoding and is otherwise whatever
 * the client says it is, so bounding what is actually read is the only bound
 * an attacker does not control. The cost is this wrapper around a reader that
 * `request.json()` would otherwise hide.
 *
 * @returns The parsed body, or the failure to answer with: `413` for a body
 * over the ceiling, `400` for one that is not JSON.
 */
export async function readJsonBody(
  request: Request,
): Promise<Result<unknown, Response>> {
  const text = await readBodyWithin(request, MAX_REQUEST_BODY_BYTES);
  if (text === undefined) {
    return err(
      failure(
        413,
        "ERR_PAYLOAD_TOO_LARGE",
        `The request body must be at most ${String(MAX_REQUEST_BODY_BYTES)} bytes.`,
      ),
    );
  }

  try {
    const value: unknown = JSON.parse(text);
    return ok(value);
  } catch {
    return err(failure(400, "ERR_BAD_REQUEST", "The request body is not valid JSON."));
  }
}

/**
 * `request`'s body as text, or `undefined` once it crosses `maxBytes`.
 *
 * @remarks
 * Decoding each chunk as it arrives rather than concatenating them first keeps
 * one copy of the body in memory instead of two. The ceiling is checked before
 * a chunk is decoded, so what is held is bounded by `maxBytes` plus the one
 * chunk that crossed it — the transport's read size, not the sender's claim.
 * A request with no body at all reads as the empty string, which the caller
 * reports as invalid JSON like any other body it cannot parse.
 */
async function readBodyWithin(
  request: Request,
  maxBytes: number,
): Promise<string | undefined> {
  if (request.body === null) {
    return "";
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      return text + decoder.decode();
    }

    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) {
      // Tell the sender to stop rather than draining the rest of the body.
      await reader.cancel();
      return undefined;
    }

    text += decoder.decode(chunk.value, { stream: true });
  }
}
