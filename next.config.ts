import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` otherwise appends a block of its own to AGENTS.md on every
  // start. AGENTS.md is this repository's hand-written source of truth for
  // every agent, and a file a tool rewrites behind the author is not one a
  // reviewer can read a diff of.
  agentRules: false,
};

export default nextConfig;
