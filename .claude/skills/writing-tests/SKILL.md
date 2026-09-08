---
name: writing-tests
description: >
  Use when writing or reviewing a test under tests/ — a .test.ts or a .test.tsx — or
  adding the regression test a src/ bug fix needs: naming an it() after behavior,
  driving a handler factory with new Request(), rendering a Client Component under
  NextIntlClientProvider, running the LlmPort contract suite against an adapter,
  asserting an error's class and `code`, not its message, sweeping edge cases with
  it.each, choosing a fake over a mock, replacing a real sleep with vi.useFakeTimers,
  isolating a filesystem test in mkdtempSync, or fixing a flaky or skipped test.
---

# Writing Tests

**Owns:** how one test case is written — its name, the interface it asserts through,
what it asserts, how it fakes the world, and the anti-patterns to reject in review.
**Does not own:** which file a test lives in, which vitest project it joins, and the
coverage floors (`placing-tests`); compile-time assertions with `expectTypeOf`
(`type-testing`); the shape of the error classes a test asserts against
(`designing-errors`); where the code under test belongs (`building-app-routes`).

## Naming and scope

- `describe`/`it` names state behavior, not implementation:
  `it("rejects a body that is not JSON", ...)`, not `it("calls parse")`.
- One behavior per `it`. Branching inside a test body belongs in a separate `it` or an
  `it.each` table, never an `if` in the test.
- Cover the happy path and the failure path of everything a zone publishes.

## Test through an interface, not around one

There is no single entry point to test this application through — each zone has its own
surface, and that surface is the seam. The four this repository ships:

- **A handler factory, driven with a real `Request`.** `createAskHandler` in
  `src/server/handlers/ask.ts` takes its port as an argument, so a test builds a
  `new Request("http://localhost/api/ask", { method: "POST", body })` and asserts the
  `Response` it gets back — status, `content-type`, and the parsed JSON body. Nothing is
  mocked: the dependency is injected because the factory asks for it.
  `tests/server-handler.test.ts` is the model, down to the recording wrapper it uses to
  assert what the handler passed the port without counting calls.
- **A Route Handler module.** `src/app/api/<name>/route.ts` re-exports a handler
  composed elsewhere, so the only thing left to assert about the file itself is that
  identity — `expect(POST).toBe(askHandler)`. Everything else is a test of the handler.
- **A Client Component**, rendered under jsdom through Testing Library, with the context
  a Server Component tree would have supplied passed explicitly:
  `NextIntlClientProvider` with a `locale` and the real `messages/en.json`.
  `tests/home-page.test.tsx` is the model, and it queries by role and accessible name
  rather than by class or test id. An asynchronous Server Component is deliberately out
  of scope — no gate here renders one.
- **The `LlmPort` contract suite.** `describeLlmPortContract` in `tests/ai-port.test.ts`
  is the behavior every adapter owes, written once and called once per adapter with a
  harness that builds the ports each case needs. A new adapter adds a call, never a
  second copy of the assertions. A behavior every adapter must share belongs inside the
  shared suite; a quirk of one adapter goes in its own `describe` beside it.

A zone is reached through what its `index.ts` publishes — `src/ai/index.ts`, never the
adapter underneath it. Enforced by: `eslint.config.mjs`'s
`boundaries/private-trees-are-not-importable` block. Wanting to reach past a surface to
assert something means the module is the wrong shape, not that the test needs an
exception.

## Asserting errors

Assert the error class and its stable `code`, never the message text:

```ts
expect(error).toBeInstanceOf(LlmError);
expect(error.code).toBe("ERR_LLM_TIMEOUT");
```

**BACKGROUND:** `designing-errors` explains why `message` is not a contract.

A port reports an expected failure as a `Result`'s error branch rather than by throwing,
so assert on the returned value — `rejects.toThrow` on a call that is supposed to
resolve to a failure passes only when the contract is already broken. Check that an
error propagates through the whole call chain (an `LlmErrorCode` reaching the HTTP
status a caller sees), and that cleanup runs on the failure path too, not only on
success.

## Expected values come from outside the code

An expected value must come from an independent source — a known literal, a worked
example, the spec — never recomputed the way the implementation computes it.
`expect(add(a, b)).toBe(a + b)` passes by construction: it restates the implementation
and can never disagree with it, even when the implementation is wrong. Write the number,
string, or object you expect by hand, or take it from a source outside the function
under test. A message catalog read from disk is the same idea: `tests/messages.test.ts`
asserts against `messages/*.json` rather than against what a bundler resolved.

## Edge cases to sweep every time

`0`, `1`, negative, fractional where an integer is required, `Number.MAX_SAFE_INTEGER`;
an absent optional property versus an explicit `undefined`; long, unicode, and emoji
strings; single-element and duplicate-element collections; cancellation and cleanup for
anything async. For anything parsing a request: a body that is not JSON at all, a JSON
array, a bare JSON string, a missing field, an empty string where one is required, and a
value outside the closed set the app ships.

Use `it.each([...])` for input/output variations, labelled through the `%s`/`%p`
placeholders in the title rather than a bare index. When the table is a mapping the
source states too, close it with `as const satisfies` so a new union member fails to
compile until the table covers it — `ALL_CODES` in `tests/ai-port.test.ts` is the model.

## Fixtures and isolation

- Prefer factory functions (`function makeX(overrides = {})`) to shared mutable
  fixtures.
- `tests/fixtures/` is reserved for data under test, including deliberately malformed
  inputs that must remain byte-for-byte invalid. Fixture files are never imported as
  modules.
- Filesystem tests use a fresh `mkdtempSync(path.join(tmpdir(), "prefix-"))` removed in
  `afterEach` with `rmSync(dir, { recursive: true, force: true })` — never write into a
  real project directory.
- Environment and global replacements go through `vi.stubEnv`/`vi.stubGlobal`, not
  direct mutation.
- `vitest.config.ts` already resets mocks and env/global stubs between tests, so an
  `afterEach` whose only body is `vi.restoreAllMocks()` is noise that hides the cleanup
  a test actually needs. Anything the runner does not know about — a timer, a listener,
  a temp directory, a child process, a rendered DOM tree — is still cleaned up
  explicitly, including after a failure. `tests/dom-setup.ts` is where the jsdom
  project's own `cleanup` is wired, once, rather than per file.

## Independence

Tests are independent: no shared mutable module state, no ordering dependency, no
dependence on timezone, locale, CPU count, or wall-clock time.

Nothing is left as `it.skip`/`it.todo` on `main`, and a flaky test is fixed rather than
retried. Enforced by: the `vitest/*` rules in `eslint.config.mjs`'s `tests/vitest-rules`
block, which covers `tests/**/*.ts` and `tests/**/*.tsx` alike.

## Fakes over mocks

Mock only at boundaries: network, filesystem, clock, child process, randomness. Never
mock the module under test or an internal collaborator — a test that mocks an internal
collaborator breaks on refactor while behavior is unchanged. Prefer a real in-memory
fake to a mock for anything beyond a one-shot call: `createFakeLlmPort` is a real
implementation of the port, configured per case, so the code under test runs the same
path it runs in production. Assert on behavior and captured arguments rather than call
counts, unless the count itself is the contract.

Do not introduce an abstraction, or a fake for it, until something actually varies
across it.

## Fake timers

No real `setTimeout` or sleep: `vi.useFakeTimers()` plus
`await vi.advanceTimersByTimeAsync(ms)`, restored with `vi.useRealTimers()` in a
`finally`. An abortable API is tested for the caller-visible effect of the abort _and_
for the timer and listener it removes, on both outcomes — the delay cases in
`tests/ai-port.test.ts` are the model, including the one asserting `vi.getTimerCount()`
is back to zero after an abort.

## Anti-patterns

- Testing trivial property access while skipping business-logic edge cases.
- `toBeDefined()`/`not.toBeNull()` where a specific value is checkable.
- Testing that a dependency works, rather than how this application uses it.
- Mocking so much that the real code under test never runs.
- Pinning, in a test of one seam, a value another seam owns — a test of the composed
  route that asserted the fake adapter's wording would have to be edited to swap the
  adapter.

## Property-based testing

`fast-check` is worth reaching for when a function has a well-defined invariant over a
large input space — a round trip, an idempotent normalization, an ordering guarantee —
not as a default for ordinary tests. It is not a dependency of this repository today,
and adding it goes through the same review as any other dependency. **REQUIRED:**
`managing-dependencies`.
