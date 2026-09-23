// Tailwind v4 has no `tailwind.config.js`: the framework is a single PostCSS
// plugin, and what that file used to configure — content sources, theme tokens
// — is declared in CSS instead, from `@import "tailwindcss"` in
// `src/app/globals.css`. This file is therefore the whole of Tailwind's build
// wiring, and Next.js picks it up by name.

export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
