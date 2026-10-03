# MCP server dependencies

## The one dependency outside pnpm's graph

`.mcp.json` runs `next-devtools-mcp` through `pnpm dlx`, straight from the npm registry,
with no `package.json` entry and no `pnpm-lock.yaml` line. Every pnpm protection in the
main skill is a `pnpm`-install-time mechanism, so none of it reaches this file: no
lockfile pins the resolved version, `minimumReleaseAge` never sees a `dlx` fetch, and
`pnpm audit` never walks a graph this file is not part of. Left unpinned
(`next-devtools-mcp@latest`), the same commit runs a different tool depending on when it
happens to be fetched — no lockfile, no cooldown, no review record, for a server that
runs inside real development sessions.

The command is `pnpm dlx`, never `npx` — that choice is load-bearing, not stylistic.
`npx` is npm's own runner, so it evaluates this repository's `package.json`
`devEngines.packageManager` (`pnpm@…`) before doing anything else; npm sees itself as
the running manager and aborts with `EBADDEVENGINES`. An MCP client always launches the
server with the project root as its cwd, so `npx` fails from every real launch, not just
occasionally. `pnpm dlx` never evaluates that check. Do not "simplify" this back to
`npx` — the failure it reintroduces reports `devEngines`, not `.mcp.json`, so it reads
as unrelated to this line and is easy to chase in the wrong file.

The fix is a manual substitute for what the lockfile does automatically elsewhere:

- Pin an exact version in the `args` array (`next-devtools-mcp@<version>`) — never
  `@latest` and never a `^`/`~` range. A range here has no lockfile to freeze its
  resolution, so it would still float to whatever is newest each time `pnpm dlx` runs;
  only an exact string is reproducible outside pnpm's graph.
- Resolve the version by hand with `npm view next-devtools-mcp version`, and check how
  recently it was published with `npm view next-devtools-mcp time --json` before
  adopting it — the release-age cooldown in the main skill exists for exactly this
  reason (a freshly published version installed unreviewed), and nothing enforces it
  here, so apply it by eye: prefer a version that has been out for at least the
  `minimumReleaseAge` window over the newest one.
- Verify the pinned version actually starts **from the repository root**, not from a
  temp directory or any other cwd: run it there and send it an `initialize` request over
  stdio (or otherwise confirm the MCP client connects to it) — a crash or a malformed
  response is the whole of what "starts" means for a version with no test suite of its
  own here. Verifying from anywhere else can pass while the pin is broken for every real
  MCP client, which always launches from the project root — that gap is exactly how the
  `npx` form above shipped broken and unnoticed.
- Bumping is a manual PR by whoever notices the pin is stale or hits a bug fixed
  upstream — there is no bot PR for this one, unlike every dependency `package.json`
  declares. The PR that bumps it repeats the two steps above: resolve and age-check the
  new version, then verify it starts, from the repository root.
