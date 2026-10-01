---
name: running-the-app
description: >
  Covers getting evidence from the running Next.js application when no test asserts the
  behavior: pnpm build then pnpm test:smoke first, then pnpm dev --port or pnpm start
  --port on a free port with curl, the next-devtools MCP server's nextjs_index and
  nextjs_call, a host browser tool, asking a human to look once, telling whether a
  server is serving the fresh build of this checkout, stopping it, and the evidence a
  pull request carries. Use when asked to run the app, check a page or a route in a live
  server, or show that a change works.
---

# Running the App

**Owns:** how an agent observes the running application — which kind of evidence, in
what order, from which server — and what that evidence looks like in a pull request.
**Does not own:** the rules for starting a server beside the developer's, which
AGENTS.md's "Running a server without taking over the developer's" states and this skill
follows; writing a page or a Route Handler (`building-app-routes`); a smoke assertion's
body and file (`writing-tests`, `placing-tests`); the visual review of a screen
(`designing-ui`); the pull request's mechanics (`create-pr`).

No browser and no E2E harness, deliberately — `tests/server-smoke.test.ts` records the
decision. Nothing here adds one, and proposing one is a dependency and a gate change,
not a step of a check.

## Evidence, cheapest first

Stop at the first tier that shows what the change does.

1. **`pnpm build && pnpm test:smoke`.** It serves the production build with `next start`
   on a port the OS picks, refuses a stale build, and stops the server itself. When it
   covers the behavior, it is the whole answer; when a lasting assertion would, add one
   there instead of observing by hand.
2. **A server of your own, then `curl`.** For what the suite does not ask: a page's
   HTML, a status code, a header, a redirect from the locale proxy, a Route Handler's
   JSON. See "Starting and stopping your own server" below.
3. **The next-devtools MCP server**, on a host that has it registered (this repository
   registers it in `.mcp.json`). It answers only for a `next dev` server: errors with
   source-mapped stacks, the route list, compilation issues across every route, and the
   project path the server runs from.
4. **A browser tool the host provides**, for what only a client shows: behavior after
   hydration, a console error, a focus move. Use it only when it neither opens a window
   on the developer's screen nor takes focus; otherwise this tier is the human's.

## Starting and stopping your own server

- **A free port.** Ask the OS rather than guessing:
  `node -e "const s=require('node:net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"`.
  Never :3000, and never a port another process holds — a sibling worktree's server may.
- **Which server.** `pnpm dev --port <port>` recompiles on every edit and is the only
  one the MCP server talks to. `pnpm start --port <port>` serves the last `pnpm build`,
  so it shows production behavior and goes stale on the next edit.
- **Loopback only.** `next dev` also listens on the machine's network address (observed
  with `pnpm dev --port <port>`, 2026-10-01); add `--hostname 127.0.0.1` to keep a check
  off the network.
- **The environment.** Give it the environment `tests/server-smoke.test.ts` gives the
  server it spawns — read the `env` of its `spawn` call rather than a list copied from
  here, which goes stale when that changes. Never read a `.env` to find a value, per
  AGENTS.md; Next.js loads one on its own at start-up, so a checkout that has one may
  serve with a real credential behind it. Send no request to a route that calls a paid
  service unless the change needs it.
- **In the background.** Start it the way your host runs a command that does not end,
  with its output in a log file outside the checkout, and poll `curl` for a status code
  until it answers — the first request compiles the route.
- **Stop it.** `lsof -nP -tiTCP:<port> -sTCP:LISTEN` prints the listening pid; `kill`
  that pid, then run the same `lsof` until it prints nothing. Never stop by name
  (`pkill next`, `killall node`): that reaches the developer's server and every sibling
  worktree's.

## The next-devtools MCP server

- Always pass your port: `nextjs_index` with `port` set, then `nextjs_call` with that
  port and a tool name it listed. Without a port, `nextjs_index` discovers every running
  Next.js dev server on the machine, the developer's among them.
- Read-only tools only, and only against your own server: `get_errors`, `get_routes`,
  `get_compilation_issues`, `get_project_metadata`, `get_logs` (observed through
  `nextjs_index` against Next.js 16.3.4, 2026-10-01). The list varies by Next.js
  version, so read it from `nextjs_index` rather than from here.
- Its `browser_eval` tool drives no browser: it points at installing a separate browser
  CLI. That is a new dependency, not a step of a check — stop and ask.
- Its version pin in `.mcp.json` is `managing-dependencies`' subject.

## Is it the fresh build of this checkout?

A server that answers is not yet evidence: it has to be serving this checkout's code as
it is now.

- **`next start`** serves `.next/`, which is stale the moment a build input changes
  after `.next/BUILD_ID` was written. The smoke suite's `BUILD_INPUTS` is the list;
  `find <each path in BUILD_INPUTS> -newer .next/BUILD_ID` printing anything means
  rebuild before you look. Simplest is to run `pnpm build` after your last edit and
  before `pnpm start`.
- **`next dev`** recompiles on edit, so the question is only whose checkout it runs
  from. `lsof -a -p <pid> -d cwd` prints the server's working directory, and the MCP
  server's `get_project_metadata` returns its `projectPath`; either must be this
  checkout, not a sibling worktree or the main one.

## When only eyes can judge it: ask once

Layout, the focus ring, both color schemes, a mobile width — no command here sees them.
**REQUIRED:** `designing-ui` › Reviewing a screen for what a screen review covers.

Ask in one message, not a conversation:

- the command that starts the server (`pnpm dev --port <port>`) and the URL to open —
  asking ends your turn, and AGENTS.md has your own server stopped before it does;
- the exact steps: the locale, what to click or type, in what order;
- what to look at, item by item;
- what to send back: a yes or no per item, and a screenshot of anything that is wrong.

## The evidence a pull request carries

Under the template's Test Plan, for each thing observed rather than asserted:

- the exact command or request, as run (`curl -sS -i http://127.0.0.1:<port>/en`);
- the tail of the output that shows the behavior — the status line, the header, the few
  lines of body or error that matter — not the whole log;
- which server and build it came from (`next dev`, or `next start` after a fresh build);
- what a human saw, item by item, and "not checked" for anything nobody looked at.

Redact before pasting: a home directory path becomes `~/…`, a worktree path the
repository-relative one, and no credential, cookie, or authorization header appears.

## Cleanup

- The `lsof` on every port you used prints nothing; no server of yours outlives the
  turn.
- `git status --porcelain` shows only the change. A dev server writes under `.next/`,
  which Git ignores; a log or a response body you saved belongs outside the checkout.

## Checklist

- [ ] The smoke suite ran first, and a server of your own ran only for what it cannot
      show.
- [ ] That server was on a free port, from this checkout, of the current code.
- [ ] Any MCP call named your port.
- [ ] A human was asked once, with a command, steps, items, and what to send back.
- [ ] The pull request carries the commands and output tails, redacted.
- [ ] No server of yours is listening, and `git status --porcelain` shows only the
      change.
