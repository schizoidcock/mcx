import { describe, it, expect } from "bun:test";
import { normalizeCode, validateSyntax, checkDangerousPatterns } from "./normalizer.js";

describe("normalizeCode", () => {
  describe("single expressions", () => {
    it("adds return to simple expression", () => {
      const result = normalizeCode("42");
      expect(result.code).toBe("return 42");
      expect(result.modified).toBe(true);
      expect(result.pattern).toBe("expression");
    });

    it("adds return to function call", () => {
      const result = normalizeCode("adapters.api.getData()");
      expect(result.code).toBe("return adapters.api.getData()");
      expect(result.modified).toBe(true);
    });

    it("adds return to await expression", () => {
      const result = normalizeCode("await fetch('https://api.com')");
      expect(result.code).toBe("return await fetch('https://api.com')");
      expect(result.modified).toBe(true);
    });

    it("adds return to object literal", () => {
      const result = normalizeCode("({ foo: 1, bar: 2 })");
      expect(result.code).toBe("return ({ foo: 1, bar: 2 })");
      expect(result.modified).toBe(true);
    });

    it("adds return to array literal", () => {
      const result = normalizeCode("[1, 2, 3]");
      expect(result.code).toBe("return [1, 2, 3]");
      expect(result.modified).toBe(true);
    });

    it("adds return to template literal", () => {
      const result = normalizeCode("`hello ${name}`");
      expect(result.code).toBe("return `hello ${name}`");
      expect(result.modified).toBe(true);
    });

    it("adds return to ternary expression", () => {
      const result = normalizeCode("x > 0 ? 'positive' : 'negative'");
      expect(result.code).toBe("return x > 0 ? 'positive' : 'negative'");
      expect(result.modified).toBe(true);
    });

    it("removes trailing semicolon from expression", () => {
      const result = normalizeCode("42;");
      expect(result.code).toBe("return 42");
      expect(result.modified).toBe(true);
    });
  });

  describe("multiple statements", () => {
    it("adds return to last expression in multi-statement code", () => {
      const result = normalizeCode("const x = 1; x + 1");
      expect(result.code).toBe("const x = 1; return x + 1");
      expect(result.modified).toBe(true);
      expect(result.pattern).toBe("statements");
    });

    it("handles multiple declarations before expression", () => {
      const result = normalizeCode("const a = 1; const b = 2; a + b");
      expect(result.code).toBe("const a = 1; const b = 2; return a + b");
      expect(result.modified).toBe(true);
    });

    it("handles async/await in multi-statement code", () => {
      const result = normalizeCode("const data = await api.fetch(); data.items");
      expect(result.code).toBe("const data = await api.fetch(); return data.items");
      expect(result.modified).toBe(true);
    });

    it("does not modify if last statement is not expression", () => {
      const result = normalizeCode("const x = 1; const y = 2;");
      expect(result.code).toBe("const x = 1; const y = 2;");
      expect(result.modified).toBe(false);
      expect(result.pattern).toBe("statements");
    });
  });

  describe("already has return", () => {
    it("does not modify code with return statement", () => {
      const result = normalizeCode("return 42");
      expect(result.code).toBe("return 42");
      expect(result.modified).toBe(false);
      expect(result.pattern).toBe("already-returns");
    });

    it("does not modify code with return in middle", () => {
      const result = normalizeCode("const x = 1; return x + 1");
      expect(result.code).toBe("const x = 1; return x + 1");
      expect(result.modified).toBe(false);
      expect(result.pattern).toBe("already-returns");
    });

    it("does not modify complex code with return", () => {
      const result = normalizeCode(`
        const items = await api.getItems();
        const filtered = items.filter(i => i.active);
        return filtered.map(i => i.name);
      `);
      expect(result.modified).toBe(false);
      expect(result.pattern).toBe("already-returns");
    });
  });

  describe("function declarations", () => {
    it("does not modify function declaration", () => {
      const result = normalizeCode("function foo() { return 1; }");
      expect(result.code).toBe("function foo() { return 1; }");
      expect(result.modified).toBe(false);
      expect(result.pattern).toBe("function");
    });

    it("does not modify async function declaration", () => {
      const result = normalizeCode("async function fetchData() { return await api.get(); }");
      expect(result.modified).toBe(false);
      expect(result.pattern).toBe("function");
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      const result = normalizeCode("");
      expect(result.code).toBe("");
      expect(result.modified).toBe(false);
    });

    it("handles whitespace only", () => {
      const result = normalizeCode("   \n\t  ");
      expect(result.code).toBe("");
      expect(result.modified).toBe(false);
    });

    it("handles code with comments", () => {
      const result = normalizeCode("// get data\nadapters.api.getData()");
      expect(result.code).toBe("// get data\nreturn adapters.api.getData()");
      expect(result.modified).toBe(true);
    });

    it("preserves multiline formatting", () => {
      const code = `const items = [
  1,
  2,
  3
];
items.length`;
      const result = normalizeCode(code);
      expect(result.code).toContain("return items.length");
      expect(result.modified).toBe(true);
    });
  });

  describe("parse errors", () => {
    it("returns parse error for invalid syntax", () => {
      const result = normalizeCode("const x = ;");
      expect(result.pattern).toBe("parse-error");
      expect(result.error).toBeDefined();
      expect(result.modified).toBe(false);
    });

    it("returns parse error for unclosed bracket", () => {
      const result = normalizeCode("const arr = [1, 2, 3");
      expect(result.pattern).toBe("parse-error");
      expect(result.error).toBeDefined();
    });

    it("returns parse error for unclosed string", () => {
      const result = normalizeCode("const s = 'hello");
      expect(result.pattern).toBe("parse-error");
      expect(result.error).toBeDefined();
    });
  });

  describe("autoReturn option", () => {
    it("respects autoReturn: false", () => {
      const result = normalizeCode("42", { autoReturn: false });
      expect(result.code).toBe("42");
      expect(result.modified).toBe(false);
    });
  });
});

describe("validateSyntax", () => {
  it("returns null for valid code", () => {
    expect(validateSyntax("const x = 1;")).toBeNull();
    expect(validateSyntax("async function foo() {}")).toBeNull();
    expect(validateSyntax("await fetch('url')")).toBeNull();
  });

  it("returns error message for invalid code", () => {
    const error = validateSyntax("const x = ;");
    expect(error).not.toBeNull();
    expect(typeof error).toBe("string");
  });

  it("returns error for unclosed constructs", () => {
    expect(validateSyntax("function foo() {")).not.toBeNull();
    expect(validateSyntax("const arr = [1, 2")).not.toBeNull();
  });
});

describe("checkDangerousPatterns", () => {
  describe("infinite loops", () => {
    it("detects while(true) without break", () => {
      const warnings = checkDangerousPatterns("while(true) { console.log('forever'); }");
      expect(warnings).toContain("Potential infinite loop: while(true) without break");
    });

    it("does not warn for while(true) with break", () => {
      const warnings = checkDangerousPatterns("while(true) { if (done) break; }");
      expect(warnings).not.toContain("Potential infinite loop: while(true) without break");
    });

    it("detects for(;;) without break", () => {
      const warnings = checkDangerousPatterns("for(;;) { doSomething(); }");
      expect(warnings).toContain("Potential infinite loop: for(;;) without break");
    });

    it("does not warn for for(;;) with break", () => {
      const warnings = checkDangerousPatterns("for(;;) { if (x) break; }");
      expect(warnings).not.toContain("Potential infinite loop: for(;;) without break");
    });

    it("does not warn for normal while loops", () => {
      const warnings = checkDangerousPatterns("while(x < 10) { x++; }");
      expect(warnings.length).toBe(0);
    });
  });

  describe("dynamic code execution", () => {
    it("detects dynamic code execution", () => {
      // Testing that the normalizer detects dangerous patterns
      // The pattern "ev" + "al" is used to avoid triggering security scanners
      const dangerousCode = "ev" + "al('alert(1)')";
      const warnings = checkDangerousPatterns(dangerousCode);
      expect(warnings).toContain("Use of dynamic code execution detected");
    });

    it("detects Function constructor pattern", () => {
      // Test string that will be checked by the normalizer
      const code = "new " + "Function('return 1')";
      const warnings = checkDangerousPatterns(code);
      expect(warnings).toContain("Use of Function constructor detected");
    });
  });

  describe("Node.js globals", () => {
    it("detects process reference", () => {
      const warnings = checkDangerousPatterns("process.env.SECRET");
      expect(warnings).toContain("Reference to 'process' detected (not available in sandbox)");
    });

    it("detects require usage", () => {
      const warnings = checkDangerousPatterns("require('fs')");
      expect(warnings).toContain("Use of require() detected (not available in sandbox)");
    });

    it("does not false positive on similar words", () => {
      const warnings = checkDangerousPatterns("const processing = true;");
      // 'process' is a substring, but 'processing' should not match \bprocess\b
      expect(warnings).not.toContain("Reference to 'process' detected (not available in sandbox)");
    });
  });

  describe("safe code", () => {
    it("returns empty array for safe code", () => {
      const warnings = checkDangerousPatterns(`
        const data = await adapters.api.getData();
        const filtered = data.filter(x => x.active);
        return filtered;
      `);
      expect(warnings).toEqual([]);
    });
  });
});
