/**
 * Tests for serve.ts utilities
 */
import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { coerceJsonArray } from "../utils/zod";

describe("coerceJsonArray", () => {
  const schema = coerceJsonArray(z.array(z.string()));

  test("passes through normal arrays", () => {
    const result = schema.parse(["a", "b", "c"]);
    expect(result).toEqual(["a", "b", "c"]);
  });

  test("coerces JSON string to array", () => {
    const result = schema.parse('["a", "b", "c"]');
    expect(result).toEqual(["a", "b", "c"]);
  });

  test("handles empty array string", () => {
    const result = schema.parse("[]");
    expect(result).toEqual([]);
  });

  test("passes non-JSON strings to schema (will fail validation)", () => {
    expect(() => schema.parse("not json")).toThrow();
  });

  test("passes invalid JSON strings to schema", () => {
    expect(() => schema.parse("{not valid}")).toThrow();
  });

  test("works with complex objects in array", () => {
    const objectSchema = coerceJsonArray(z.array(z.object({
      code: z.string(),
      storeAs: z.string().optional(),
    })));

    const input = '[{"code": "test()", "storeAs": "result"}]';
    const result = objectSchema.parse(input);
    expect(result).toEqual([{ code: "test()", storeAs: "result" }]);
  });

  test("handles nested arrays in JSON string", () => {
    const result = schema.parse('["a", "b"]');
    expect(result).toEqual(["a", "b"]);
  });
});
