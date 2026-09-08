---
name: writing-typescript
description: >
  Use when writing or reviewing TypeScript under src/**, in a .ts module or a .tsx
  component: narrowing unknown instead of any, `satisfies` vs `as`, a type guard,
  interface vs type, an exhaustive switch over a union, inline `import type` under
  verbatimModuleSyntax, why `enum` is rejected (no-restricted-syntax), what a zone
  surface like src/ai/index.ts may export, annotating a return type or a generic
  boundary, hitting noUncheckedIndexedAccess, exactOptionalPropertyTypes or
  noPropertyAccessFromIndexSignature, placing a new constant, or fixing a logic bug in
  an existing src/ function.
---

# Writing TypeScript

**Owns:** type-system judgment, naming, and constant placement inside a module under
`src/**`. **Does not own:** the shape of an error class and the `ERR_*` code vocabulary
(`designing-errors`); which file a page, a handler or a client component belongs in
(`building-app-routes`); compile-time assertions with `expectTypeOf` (`type-testing`);
the `.mjs` files under `scripts/` (`writing-repo-scripts`).

## Naming and constants

- An error `code` string is not a naming decision made here — **REQUIRED:**
  `designing-errors` owns the `ERR_*` vocabulary for both `src/` and `scripts/`.
- Keep a constant next to the code that reads it. `OUTPUT_LANGUAGE_BY_LOCALE` and
  `STATUS_BY_LLM_CODE` both sit in `src/server/handlers/ask.ts` because that handler is
  the only module that reads either. Do not create a shared `constants.ts` grab-bag that
  forces unrelated modules to import each other.

## Boundary types: unknown, any, and assertions

- Take `unknown` at an untyped boundary and narrow it before use. A parsed request body
  (`let body: unknown = await request.json()`), a caught error, a value handed in for a
  schema to validate — `FakeLlmPortOptions.response` is `unknown` on purpose, so a value
  that does _not_ match the caller's schema stays expressible. `any` disables checking
  for everything downstream of the boundary, not just at it.
- Prefer `satisfies` to `as` on a typed literal: `satisfies` keeps excess-property and
  missing-property checking, `as` silences both. `as const satisfies Record<K, V>` also
  keeps the literal keys, which is what makes a table exhaustive against a union —
  `STATUS_BY_LLM_CODE` fails to compile when a code is added rather than falling through
  to a default status.
- A type assertion (`as T`) changes only the compile-time type — it provides zero
  runtime safety. Reach for a type guard (`value is T`) when narrowing on runtime shape,
  and keep any assertion that survives review local and non-exported.

## Imports

- Mark a type-only named import inline (`import { value, type X } from "./x"`), the form
  `@typescript-eslint/consistent-type-imports` autofixes to, per `eslint.config.mjs`'s
  `fixStyle` setting for that rule. A separate `import type { X } from "./x"` statement
  also satisfies the rule and is fine when every named import in the statement is
  type-only.
- The marking is load-bearing, not cosmetic: `verbatimModuleSyntax` emits an unmarked
  import as a real runtime import, so an unmarked type-only import of a module with side
  effects changes what runs.
- Never hand-fix an import differently from what `pnpm fix` produces.

## interface vs type

- Prefer `interface X extends Y` to `type X = Y & Z` when composing object types — the
  `&` operator is markedly slower to type-check, and the gap widens with the number of
  intersected members.
- `@typescript-eslint/consistent-type-definitions` (from the stylistic type-checked set
  `eslint.config.mjs` extends) already prefers `interface` for object shapes; this is
  the reason behind that rule, not an extra rule of its own.

## Strictness flags to work with, not around

- Indexed access (`arr[i]`, `record[key]`) yields `T | undefined` here —
  `noUncheckedIndexedAccess` is on. Treat the `undefined` branch as real rather than
  asserting it away.
- `exactOptionalPropertyTypes` makes an absent property and an explicit `undefined`
  distinct types. An options interface whose properties are genuinely omissible declares
  them `readonly` and `?:` — `LlmRequest.signal` and every field of `FakeLlmPortOptions`
  are the shape to copy. An internal argument whose omission would be a bug takes a
  required `T | undefined` instead, so a caller cannot drop it by accident.
- The same flag meets React props: passing `prop={undefined}` explicitly does not
  satisfy `readonly prop?: string`. When a caller really does pass `undefined` — a value
  forwarded from a lookup, a prop threaded through a wrapper — widen that one prop to
  `prop?: string | undefined`. Do not reach for the compiler option.
- `noPropertyAccessFromIndexSignature` forbids dot access on an index signature, while
  typed-lint's `dot-notation` pushes the other way for a literal key. A literal
  `as const` object escapes the conflict because its keys are literal, not an index
  signature; a widened `Record<string, T>` does not. `scripts/lib/json.mjs`'s
  `readKey`/`readString` are the resolution used for parsed-JSON reads — see
  `writing-repo-scripts` for that rule itself.
- Do not introduce `enum`. `eslint.config.mjs` blocks `TSEnumDeclaration` through
  `no-restricted-syntax`, and the message there says why. A union of string literals
  (`LlmErrorCode`) or an `as const` object is what replaces it.

## Function boundaries and generics

- `@typescript-eslint/explicit-module-boundary-types` already requires an annotation on
  every export, so the judgment left here is what to annotate it _with_.
- On a generic export, annotate the return type only if the annotation is provably no
  wider than what inference would produce, and cover the exported signature with a
  compile-time assertion either way — a hand-written annotation is the standard way to
  accidentally widen a generic that should stay preserved. **BACKGROUND:**
  `type-testing`.
- Keep exported generics narrow: accept the widest reasonable input, return the
  narrowest true output. `LlmPort.generate` is the worked example — it returns
  `Promise<Result<z.infer<TSchema>, LlmError>>`, so a caller gets its own schema's type
  back instead of a widened one. `ok<T>(value: T): Result<T, never>` in
  `src/core/result.ts` is the same idea on the other branch: `never` keeps the value
  assignable to a `Result<T, E>` for any `E` without the caller restating it.
- Let inference do the work inside a function body; reserve explicit annotations for
  boundaries (parameters, exported return types), not every local binding.

## Discriminated unions and exhaustiveness

- Prefer a discriminated union with a literal field (`ok`, `code`, `kind`) over a bag of
  optional flags when a value has mutually exclusive shapes, and narrow it by branching
  on that field. `Result` is the one every zone is written against: `if (!result.ok)`
  gives back `error` typed and `value` gone.
- Handle a union exhaustively by giving each member its own `case`. Do not add a
  `default` branch to make the check pass:
  `@typescript-eslint/switch-exhaustiveness-check` in `eslint.config.mjs` sets
  `considerDefaultExhaustiveForUnions`, so a `default` is read as the deliberate answer
  to a new union member, not a placeholder — adding one to silence the rule is what
  disables the protection it exists to give.

## What a module may import

- `node:*` is not restricted anywhere under `src/`. `@types/node` is a devDependency and
  `tsconfig.json` declares no `types` array, so the Node types are in scope, and
  `eslint.config.mjs` names the protocol nowhere. No module under `src/` imports one
  today, but that is a description of this tree, not a rule to defend — the restriction
  older prose here claimed never existed in this repository.
- What is real is the zone boundary. `src/core/**` may not import the framework or a
  vendor SDK; `src/app/**` and `src/server/**` reach the AI layer only through
  `src/ai/index.ts`; `src/ai/port.ts` may not import an adapter. AGENTS.md's
  Architecture section states the direction and `eslint.config.mjs`'s `boundaries/*`
  blocks carry the patterns, with `tests/boundaries.test.ts` asserting the same shape
  from the module graph. Read those rather than a summary here.
- A zone publishes through one file, and that file names every symbol: `src/ai/index.ts`
  re-exports the port, its error vocabulary and one adapter by name. `export *` is
  banned under `src/` (`no-restricted-syntax`), so what a zone above may reach is
  exactly what a reviewer can read in that file's diff. Adding a symbol there is a
  decision about the zone's surface, not a re-export detail — and reaching past it into
  a private tree is what the boundary rules exist to stop.
- A module that outgrows the per-file size budget in `eslint.config.mjs`'s
  `src/size-budget` block is a module doing more than one thing. Split it; the number is
  a ceiling, not a target, and raising it is what AGENTS.md rules out.
