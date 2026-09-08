import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Points the plugin at the request configuration and wires the message
// catalogs into the build. Stated explicitly rather than left to the plugin's
// default search, so `src/i18n/request.ts` can be found by reading this file.
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // `next dev` otherwise appends a block of its own to AGENTS.md on every
  // start. AGENTS.md is this repository's hand-written source of truth for
  // every agent, and a file a tool rewrites behind the author is not one a
  // reviewer can read a diff of.
  agentRules: false,
};

export default withNextIntl(nextConfig);
