import type { ReactNode } from "react";

import "./globals.css";

/**
 * The root layout Next.js requires, with the global stylesheet but no shell.
 *
 * @remarks
 * `<html>` and `<body>` belong to `src/app/[locale]/layout.tsx`, which is the
 * first layout that knows the document's language. Next.js still requires a
 * layout at the root of the App Router tree, so this one passes its children
 * through untouched rather than rendering a second, language-less document
 * shell around them. Importing the stylesheet here makes it available to the
 * root-level not-found boundary too.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>): ReactNode {
  return children;
}
