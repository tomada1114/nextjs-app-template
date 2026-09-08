import { describe, expect, expectTypeOf, it } from "vitest";

import { err, ok, type Result } from "../src/core/result";

describe("ok", () => {
  it("wraps a value as the success branch", () => {
    expect(ok(42)).toStrictEqual({ ok: true, value: 42 });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["zero", 0],
    ["an empty string", ""],
    ["false", false],
  ])("carries %s as a value rather than treating it as absent", (_, value) => {
    expect(ok(value)).toStrictEqual({ ok: true, value });
  });

  it("produces a value assignable to a Result with any error type", () => {
    const result: Result<number, RangeError> = ok(1);

    expect(result.ok).toBe(true);
  });
});

describe("err", () => {
  it("wraps an error as the failure branch", () => {
    const error = new RangeError("out of range");

    expect(err(error)).toStrictEqual({ ok: false, error });
  });

  it("produces a value assignable to a Result with any value type", () => {
    const result: Result<string, RangeError> = err(new RangeError("nope"));

    expect(result.ok).toBe(false);
  });
});

describe("Result", () => {
  it("narrows to the value branch when ok is true", () => {
    const result: Result<string, RangeError> = ok("hello");

    if (!result.ok) {
      throw new Error("expected the success branch");
    }

    expectTypeOf(result.value).toEqualTypeOf<string>();
    expect(result.value).toBe("hello");
  });

  it("narrows to the error branch when ok is false", () => {
    const result: Result<string, RangeError> = err(new RangeError("nope"));

    if (result.ok) {
      throw new Error("expected the failure branch");
    }

    expectTypeOf(result.error).toEqualTypeOf<RangeError>();
    expect(result.error.message).toBe("nope");
  });
});
