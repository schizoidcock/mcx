import { describe, it, expect } from "bun:test";
import { analyze, formatFindings } from "./analyzer.js";

describe("analyze", () => {
  describe("no-infinite-loop", () => {
    it("detects while(true) without break", () => {
      const result = analyze("while(true) { console.log('forever'); }");
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].rule).toBe("no-infinite-loop");
      expect(result.errors[0].message).toContain("while(true)");
    });

    it("allows while(true) with break", () => {
      const result = analyze("while(true) { if (done) break; }");
      const infiniteLoopErrors = result.errors.filter(e => e.rule === "no-infinite-loop");
      expect(infiniteLoopErrors.length).toBe(0);
    });

    it("detects for(;;) without break", () => {
      const result = analyze("for(;;) { doSomething(); }");
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].rule).toBe("no-infinite-loop");
      expect(result.errors[0].message).toContain("for(;;)");
    });

    it("allows for(;;) with break", () => {
      const result = analyze("for(;;) { if (x) break; }");
      const infiniteLoopErrors = result.errors.filter(e => e.rule === "no-infinite-loop");
      expect(infiniteLoopErrors.length).toBe(0);
    });

    it("allows normal while loops", () => {
      const result = analyze("while(x < 10) { x++; }");
      const infiniteLoopErrors = result.errors.filter(e => e.rule === "no-infinite-loop");
      expect(infiniteLoopErrors.length).toBe(0);
    });
  });

  describe("no-nested-loops", () => {
    it("warns about nested for loops", () => {
      const result = analyze(`
        for (let i = 0; i < 10; i++) {
          for (let j = 0; j < 10; j++) {
            console.log(i, j);
          }
        }
      `);
      expect(result.warnings.some(w => w.rule === "no-nested-loops")).toBe(true);
    });

    it("warns about for inside while", () => {
      const result = analyze(`
        while (condition) {
          for (const item of items) {
            process(item);
          }
        }
      `);
      expect(result.warnings.some(w => w.rule === "no-nested-loops")).toBe(true);
    });

    it("does not warn about single loops", () => {
      const result = analyze("for (const item of items) { process(item); }");
      expect(result.warnings.filter(w => w.rule === "no-nested-loops").length).toBe(0);
    });

    it("does not warn about loops in separate functions", () => {
      const result = analyze(`
        for (const item of items) {
          const fn = () => {
            for (const x of arr) { process(x); }
          };
          fn();
        }
      `);
      // The inner loop is in a function, so not directly nested
      expect(result.warnings.filter(w => w.rule === "no-nested-loops").length).toBe(0);
    });
  });

  describe("no-adapter-in-loop", () => {
    it("warns about adapters.x.method() in for loop", () => {
      const result = analyze(`
        for (const id of ids) {
          const data = await adapters.api.getData(id);
          console.log(data);
        }
      `);
      expect(result.warnings.some(w => w.rule === "no-adapter-in-loop")).toBe(true);
    });

    it("warns about adapters in while loop", () => {
      const result = analyze(`
        while (hasMore) {
          const page = await adapters.db.getPage(cursor);
          cursor = page.nextCursor;
          hasMore = !!cursor;
        }
      `);
      expect(result.warnings.some(w => w.rule === "no-adapter-in-loop")).toBe(true);
    });

    it("warns about adapters in forEach", () => {
      const result = analyze(`
        ids.forEach(async (id) => {
          await adapters.api.delete(id);
        });
      `);
      expect(result.warnings.some(w => w.rule === "no-adapter-in-loop")).toBe(true);
    });

    it("warns about adapters in map", () => {
      const result = analyze(`
        const results = ids.map(async (id) => {
          return await adapters.api.getData(id);
        });
      `);
      expect(result.warnings.some(w => w.rule === "no-adapter-in-loop")).toBe(true);
    });

    it("does not warn about adapters outside loops", () => {
      const result = analyze(`
        const data = await adapters.api.getData(123);
        console.log(data);
      `);
      expect(result.warnings.filter(w => w.rule === "no-adapter-in-loop").length).toBe(0);
    });
  });

  describe("no-unhandled-async", () => {
    it("warns about async forEach", () => {
      const result = analyze(`
        items.forEach(async (item) => {
          await process(item);
        });
      `);
      expect(result.warnings.some(w =>
        w.rule === "no-unhandled-async" && w.message.includes("forEach")
      )).toBe(true);
    });

    it("warns about async map without Promise.all context", () => {
      const result = analyze(`
        const results = items.map(async (item) => {
          return await fetch(item.url);
        });
      `);
      expect(result.warnings.some(w =>
        w.rule === "no-unhandled-async" && w.message.includes("map")
      )).toBe(true);
    });

    it("warns about async filter", () => {
      const result = analyze(`
        const filtered = items.filter(async (item) => {
          return await checkItem(item);
        });
      `);
      expect(result.warnings.some(w =>
        w.rule === "no-unhandled-async" && w.message.includes("filter")
      )).toBe(true);
    });

    it("does not warn about sync callbacks", () => {
      const result = analyze(`
        items.forEach((item) => {
          console.log(item);
        });
      `);
      expect(result.warnings.filter(w => w.rule === "no-unhandled-async").length).toBe(0);
    });
  });

  describe("no-dangerous-globals", () => {
    it("warns about process reference", () => {
      const result = analyze("const secret = process.env.SECRET;");
      expect(result.warnings.some(w =>
        w.rule === "no-dangerous-globals" && w.message.includes("process")
      )).toBe(true);
    });

    it("errors on require (security: could access dangerous modules)", () => {
      const result = analyze("const fs = require('fs');");
      expect(result.errors.some(e =>
        e.rule === "no-dangerous-globals" && e.message.includes("require")
      )).toBe(true);
    });

    it("does not warn about safe code", () => {
      const result = analyze(`
        const data = await adapters.api.getData();
        const filtered = data.filter(x => x.active);
        return filtered;
      `);
      expect(result.warnings.filter(w => w.rule === "no-dangerous-globals").length).toBe(0);
    });
  });

  describe("configuration", () => {
    it("respects enabled: false", () => {
      const result = analyze("while(true) {}", { enabled: false });
      expect(result.errors.length).toBe(0);
      expect(result.warnings.length).toBe(0);
    });

    it("respects rule severity override", () => {
      const result = analyze("while(true) {}", {
        rules: { "no-infinite-loop": "warn" }
      });
      // Should be warning instead of error
      expect(result.errors.length).toBe(0);
      expect(result.warnings.some(w => w.rule === "no-infinite-loop")).toBe(true);
    });

    it("respects rule off", () => {
      const result = analyze("while(true) {}", {
        rules: { "no-infinite-loop": "off" }
      });
      expect(result.errors.filter(e => e.rule === "no-infinite-loop").length).toBe(0);
    });
  });

  describe("performance", () => {
    it("analyzes typical code in < 50ms", () => {
      const code = `
        const items = await adapters.api.listItems({ limit: 100 });
        const processed = items.map(item => ({
          id: item.id,
          name: item.name,
          active: item.status === 'active'
        }));
        const active = processed.filter(p => p.active);
        return active;
      `;

      const result = analyze(code);
      expect(result.elapsed).toBeLessThan(50);
    });
  });
});

describe("formatFindings", () => {
  it("formats warnings correctly", () => {
    const formatted = formatFindings([
      { rule: "test-rule", severity: "warn", message: "Test message", line: 5 }
    ]);
    expect(formatted[0]).toBe("[WARN] test-rule (line 5): Test message");
  });

  it("formats errors correctly", () => {
    const formatted = formatFindings([
      { rule: "test-rule", severity: "error", message: "Error message" }
    ]);
    expect(formatted[0]).toBe("[ERROR] test-rule: Error message");
  });
});
