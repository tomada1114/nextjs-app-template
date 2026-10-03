# Removing the AI layer

`tests/ai-layer-removal.test.ts` is the specification. Read it, then run it **before**
deleting anything:

```bash
pnpm exec vitest run tests/ai-layer-removal.test.ts
```

Green means the layer is still separable and the lists in that file are complete — the
property it exists to defend, checkable only while the layer is present. It cannot be
the check you run afterwards, because it is on its own removal list. Those lists are the
procedure:

- **`REMOVED_PATHS`** — deleted outright. `src/server/composition.ts` is on it because
  wiring a port is the whole of what that file does, `src/app/api` because the one route
  there is the layer's only caller, and the `integrating-llm` skill with its
  `.claude/skills/` mirror because the subject it documents is what leaves.
- **`AI_LAYER_TOKENS`** — `OPENROUTER_API_KEY`, the vendor name a file can carry without
  naming a path. **`AI_LAYER_SYMBOLS`** is the other half: the names this repository
  gives the layer's own surface — `LLM_MODEL` and `LLM_ADAPTER` among them — which a
  document cites as often as it cites a path.
- **`REMOVED_SKILL_NAMES`** — the bare name of each whole skill on
  `REMOVED_SKILL_ROOTS`, derived from it rather than listed again; today just
  `integrating-llm`. Sibling skills cross-reference each other by name and never by
  path, so without this a `**BACKGROUND:** \`integrating-llm\`` line would survive the
  removal unnoticed.
- **`EDITED_CODE_FILES`** — files that survive but must stop naming it, whose subject is
  the repository's machinery. That this list is short, and holds no application module,
  _is_ the separability property.
- **`EDITED_DOCUMENT_FILES`** — files that survive but must stop describing the layer to
  a reader. This one claims completeness and nothing else: it grows whenever a skill
  teaches a rule through the port or the handler, and that growth is expected.

Delete the paths, then work through both edited lists:

- `src/server/env.ts` loses `OPENROUTER_API_KEY`, `LLM_MODEL` and `LLM_ADAPTER` from its
  schema, along with the provider key's half of the billed rule, and `.env.example` the
  matching lines. `API_ACCESS_KEY` and its half of the rule stay, build-phase deferral
  included: the rule is keyed off what the composition root wires (`billsAProvider`),
  not off a vendor's variable, so it survives the vendor leaving and is waiting for the
  first endpoint of your own that costs money to answer. Keep `src/server/env.ts`
  itself, empty schema and all — it is the seam the next secret enters through, and
  deleting it means rediscovering where `process.env` is allowed to be read.
- `eslint.config.mjs` loses the AI layer's zone rules (`AI_LAYER_PRIVATE` and the
  `src/ai/` blocks), and `tests/boundaries.test.ts` the cases asserting them.
- `vitest.config.ts` loses the deleted suites from `automationTests` and the removed
  zone from its coverage glob. Narrowing a glob over a directory that no longer exists
  is not lowering a floor; no threshold number moves, and none may.
- `README.md` and AGENTS.md lose the route and the port from their prose — AGENTS.md's
  Architecture tree, its three seams, and the contract statement all name them.
- `tests/server-env.test.ts` loses the cases for the removed variables and the
  composition-root boot, and `tests/server-smoke.test.ts` its `LLM_ADAPTER=fake` pin
  along with the `POST /api/ask` cases.
- The skills on `EDITED_DOCUMENT_FILES` teach rules that outlive the layer and
  illustrate them with it. **Delete the illustration and leave the rule standing** — the
  sentence, the bullet, or the section whose _subject_ is the layer. Do not write a
  replacement now: you are here before your own code exists, and a rule with no example
  is still a rule. Add one when you have code worth pointing at.
- Grep to find the sites, then read the file: the needles
  `tests/ai-layer-removal.test.ts` lists — `REMOVED_PATHS`, `AI_LAYER_TOKENS`,
  `AI_LAYER_SYMBOLS` and `REMOVED_SKILL_NAMES` — are a lower bound, not a substitute for
  reading it. The skills on `EDITED_DOCUMENT_FILES` were written before
  `authoring-skills` required a new mention to carry a needle, so a paragraph can name
  the layer with none: the `building-app-routes` handler reference's "Key any gate of
  this kind off what the composition root wires" paragraph names no path, token, symbol
  or skill, and a grep alone walks past it. A skill's frontmatter `description` is a
  site like any other: it is that skill's one trigger surface, and a trigger naming a
  file that is gone is dead weight nothing reports once this suite is deleted. Several
  descriptions name a removed path today, `starting-an-app`'s own among them.
- Two are not sentence surgery. `integrating-llm` is deleted rather than edited, its
  whole subject being the layer; and `localizing-ui` loses its `outputLanguage` section
  whole, heading included — that seam is the port's, and the UI locale it maps from has
  nowhere left to reach. The catalogs and the locale routing are untouched, but the
  section is not the only place `outputLanguage` appears: the skill's frontmatter
  `description` and its **Owns:** sentence both name the same seam and both need the
  same edit.
- `starting-an-app` loses its "Removing the AI layer" section and this reference is
  deleted through `REMOVED_PATHS`: a procedure for deleting something already gone is
  stale prose. Edit the `.agents/` copy and run `pnpm agents:sync`; never hand-edit the
  mirror.

Delete `tests/ai-layer-removal.test.ts` last: it is the checklist while you work, and
the first dangling reference the moment the paths are gone. The proof that nothing
dangles afterwards is the gate — `pnpm check:source` type-checks, lints, builds and
tests the tree that remains, which is exactly the set of failures a stale import, a
stale zone rule or a stale test would produce.
