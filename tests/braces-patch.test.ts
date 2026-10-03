import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

interface Ast {
  type: string;
  value?: string;
  nodes?: Ast[];
}
interface Options {
  maxDepth?: number;
}
interface Braces {
  compile(input: string | Ast, options?: Options): string;
  expand(input: string | Ast, options?: Options): string[];
  stringify(input: string | Ast, options?: Options): string;
  parse(input: string, options?: Options): Ast;
}

// Resolve the copy ESLint actually loads, rather than a separate direct package.
const here = createRequire(import.meta.url);
const config = createRequire(here.resolve("eslint-config-next"));
const plugin = createRequire(config.resolve("@next/eslint-plugin-next"));
const glob = createRequire(plugin.resolve("fast-glob"));
const match = createRequire(glob.resolve("micromatch"));
const braces = match("braces") as Braces;

function nestedAst(depth: number): Ast {
  let node: Ast = { type: "text", value: "a" };
  for (let i = 0; i < depth; i += 1) {
    node = { type: "brace", nodes: [node] };
  }
  return { type: "root", nodes: [node] };
}

describe("the braces depth patch used by ESLint", () => {
  it.each(["compile", "expand", "stringify", "parse"] as const)(
    "%s rejects a deeply nested pattern before recursive traversal",
    (mode) => {
      const pattern = "{".repeat(4500) + "a,b" + "}".repeat(4500);
      expect(() => braces[mode](pattern)).toThrow(SyntaxError);
      expect(() => braces[mode](pattern)).toThrow(/exceeds max depth/);
    },
  );

  it.each(["(".repeat(101) + ")".repeat(101), "{(".repeat(51) + ")}".repeat(51)])(
    "bounds parenthesis and mixed nesting in %s",
    (pattern) => {
      expect(() => braces.parse(pattern)).toThrow(SyntaxError);
    },
  );

  it.each(["compile", "expand", "stringify"] as const)(
    "%s bounds a caller-supplied AST that bypasses parsing",
    (mode) => {
      expect(() => braces[mode](nestedAst(101))).toThrow(/exceeds max depth/);
    },
  );

  it.each([1000, Infinity, NaN])("cannot raise the safe limit to %s", (maxDepth) => {
    const pattern = "{".repeat(101) + "a,b" + "}".repeat(101);
    expect(() => braces.parse(pattern, { maxDepth })).toThrow(SyntaxError);
    expect(() => braces.compile(nestedAst(101), { maxDepth })).toThrow(
      /exceeds max depth/,
    );
  });

  it("supports a stricter caller limit", () => {
    expect(() => braces.parse("{{a,b},c}", { maxDepth: 1 })).toThrow(SyntaxError);
    expect(() => braces.parse("{{a,b},c}", { maxDepth: 2 })).not.toThrow();
  });

  it("allows the safe boundary through every output mode", () => {
    const pattern = "{".repeat(100) + "a,b" + "}".repeat(100);
    expect(() => braces.parse(pattern)).not.toThrow();
    expect(() => braces.compile(braces.parse(pattern))).not.toThrow();
    expect(braces.expand(braces.parse(pattern))).toEqual([
      "{".repeat(99) + "a" + "}".repeat(99),
      "{".repeat(99) + "b" + "}".repeat(99),
    ]);
    expect(braces.stringify(braces.parse(pattern))).toBe(pattern);
  });

  it("preserves ordinary file globs", () => {
    expect(braces.expand("{src,tests}/api.{ts,tsx}")).toEqual([
      "src/api.ts",
      "src/api.tsx",
      "tests/api.ts",
      "tests/api.tsx",
    ]);
  });

  it.each([
    '"' + "{".repeat(200) + '"',
    "\\{".repeat(200),
    "[" + "{".repeat(200) + "]",
  ])("does not treat literal braces as nesting in %s", (pattern) => {
    expect(() => braces.parse(pattern)).not.toThrow();
  });
});
