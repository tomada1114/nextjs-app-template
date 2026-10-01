# Patterns this template does not adopt

Each row is a pattern an implementer tends to reach for out of habit, and the reason
this template does without it. Adopting one is a change of stance: propose it in a pull
request the owner signs off, rather than introducing it inside an unrelated change.

| Pattern                           | Why not                                                                                                                       | Instead                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A dependency-injection container  | The composition root under `src/server/` already joins the environment and each dependency in plain code a reader can follow. | Build dependencies there and hand them to a handler factory as arguments.          |
| A client state-management library | Server Components render from server data and props carry it down; a store adds a client bundle and a second source of truth. | Server Components and props first; `useState` in the smallest `"use client"` file. |
| An in-process event bus           | Who calls whom stops being visible in the import graph that `eslint.config.mjs` and `tests/boundaries.test.ts` check.         | A direct function call, sequenced by the caller.                                   |
| A repository per entity           | An interface per table is speculative; a seam is earned by a real external system.                                            | One port interface shaped by what core needs, once that system exists.             |
| Use-case or interactor classes    | A class with one `execute` method is a function with ceremony, and a handler already orchestrates.                            | A plain exported function in `src/core/`, called from the handler.                 |
| A global mutable singleton        | Module state is shared by every concurrent request in a server process and leaks between tests.                               | Immutable module constants; per-request state passed as arguments.                 |

**BACKGROUND:** `building-app-routes`, for where a Server Component ends and a
`"use client"` file begins.
