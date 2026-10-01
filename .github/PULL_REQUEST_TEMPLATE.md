## Summary

<!-- One or two lines: what does this change do, and why? Link the issue it closes with "Closes #…". -->

## Test Plan

<!-- Which commands did you run, and what did they print? -->

## Checklist

- [ ] `pnpm check:source` passes
- [ ] New environment variables are documented in `.env.example` and validated in
      `src/server/env.ts`
- [ ] New UI strings are added to every locale catalog under `messages/*.json`
- [ ] No new dependency, or its reason is stated here for sign-off
- [ ] No gate weakened (an eslint-disable, @ts-ignore, a lowered coverage threshold, a
      coverage.exclude entry, a skipped test)
