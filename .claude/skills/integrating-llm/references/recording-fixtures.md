# Recording and replaying an LLM fixture

The mechanics live in `tests/llm-replay.ts`, and its TSDoc explains each helper. This
file is the procedure and the judgment around it.

## What a fixture is

`tests/fixtures/llm/<name>.json` holds one recorded exchange as `{ status, body }` —
never a whole `Response`. Dropping the headers is what makes a credential _structurally_
unable to reach a committed file: the request, where the SDK puts `x-api-key`, is not
written down at all, and neither is any response header a future API version might add.
The body is verbatim, so a real message `id` or `request_id` is committed with it; those
are opaque per-request identifiers, and keeping them is what makes the file a recording
rather than a guess.

`headers` is an optional third field for a hand-written fixture that needs one (a
`retry-after`, say). The recorder never writes it.

`tests/fixtures/` is excluded from ESLint, Prettier, `typos`, `tsconfig.json` and
Vitest's own collection, because reformatting captured data would change the bytes a
replay asserts on. It is **not** excluded from `scripts/check-staged.mjs`, which
inspects every staged blob whatever its extension.

## Which fixtures exist, and which are real recordings

`tests/ai-anthropic.test.ts` holds an `OUTCOMES` map naming every fixture and the result
replaying it must produce, and asserts that the map and the directory agree exactly — a
fixture nothing has an expectation for is a file that could decay into anything.

Only `success` and `auth-401` are recordings of real exchanges. A `429` and a `529`
cannot be provoked on demand, so those are written by hand against the documented error
shape; `ERR_LLM_TIMEOUT` has no fixture at all, because a deadline is a property of the
connection rather than of a response and is arranged with a `fetch` that never answers.
Prefer a hand-written fixture over inventing a way to make a provider misbehave.

## Recording

Recording reaches the real provider and spends money. It is a local operation and never
something CI does.

```bash
LLM_RECORD=1 pnpm exec vitest run tests/ai-port.test.ts
```

`describe.runIf(isRecording())` at the bottom of `tests/ai-port.test.ts` is the only
block that runs; without `LLM_RECORD=1` it is skipped entirely. The credential comes
from your own environment (`ANTHROPIC_API_KEY`), which `.env.example` names and
`src/server/env.ts` declares — never read a `.env` file to get one, and never put a key
on a command line.

Two properties of the recorder are worth knowing before you use it:

- It writes a fixture only when the response carries the status the recording set out to
  capture. A session that met a `429` instead would otherwise overwrite a good fixture
  with that body, and `git add` would stage the damaged file before the assertion
  downstream failed.
- The recorded prompt is built from `CONTRACT_ANSWER`, and the recording block asserts
  the real answer equals it. That is what stops the fixture and the contract suite's
  assertions drifting apart — the check happens at record time rather than as a mystery
  failure on the next run.

## Replaying

`replayFetch(name)` returns a `fetch` that answers from the fixture and never opens a
socket, and it is handed to the adapter through `AnthropicClientOptions.fetch`. Nothing
else about the adapter changes, which is the point: the request is still built, signed
and sent, and the response still decoded, by the real SDK.

`tests/ai-anthropic.test.ts` stubs the global `fetch` with one that rejects and asserts
it was never called, so a replay that silently fell back to the network fails rather
than passing slowly.

## Before you commit

Review the diff of every fixture you touched, then commit normally. If
`scripts/check-staged.mjs` blocks the commit, a credential is in the staged content:
scrub the fixture and record again. Never `--no-verify` — it disables the secret check
along with everything else, and AGENTS.md's "Security and human approval" rules it out.
