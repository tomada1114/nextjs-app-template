# Verifying a dependency change

## Verifying a dependency change before it lands

A manifest and lockfile change is verified by a real install and a real run, never by a
test that mocks a package manager at its subprocess boundary. Run, in order:

```bash
pnpm install            # regenerates pnpm-lock.yaml; must succeed under the install policy in the main skill
pnpm check:quick        # format, lint, typecheck, tests
pnpm build              # next build — the App Router entry points and the framework's
                        # own build pipeline, which no unit test exercises
pnpm test:coverage      # the coverage floors, which a swapped dependency can move
```

The last three are together what `pnpm check:source` runs, so one green run of that
covers them all. One narrower run is worth naming, because the gate reports its failure
only as a wall of output: the suite for the module that actually consumes the bumped
package, run on its own.

```bash
pnpm exec vitest run tests/<module>.test.ts
```

A `zod` bump surfaces first in whichever contract suite parses with it; a `react` bump
in the component tests. No suite reaches a live service either way:
`tests/ai-port.test.ts`'s contract suite runs `describeLlmPortContract` against both the
fake adapter and, through `tests/llm-replay.ts`'s replayed fixtures under
`tests/fixtures/llm/`, the OpenRouter adapter — a `zod` bump that changes the JSON
Schema it sends or the way it parses an answer shows up there first — and
`tests/ai-openrouter.test.ts` covers the adapter's remaining edge cases the same way,
some against those same fixtures and the rest against a synthetic `fetch`. The adapter
speaks plain `fetch` and has no vendor SDK to bump, so nothing about a provider ever
arrives as a dependency change; re-recording a fixture is never something a bump does on
its way through — recording is a deliberate local run under `LLM_RECORD=1` with a real
credential, and it costs money. `integrating-llm` owns that procedure.

Two checks run only on the PR. The `Dependency review` workflow fails on a new advisory
or a denied license, and the weekly production audit described in the main skill is now
a gate that can actually fail: with runtime `dependencies` no longer empty,
`pnpm audit --prod` is no longer the no-op it was, so a red one is a finding about a
package this application ships, not noise.
