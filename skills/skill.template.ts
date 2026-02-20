/**
 * Skill Template
 *
 * Copy this file to skills/your-skill.ts and customize:
 *   cp templates/skill.template.ts skills/my-skill.ts
 */
import { defineSkill, skillBuilder } from "@mcx/core";

/**
 * Example 1: Using defineSkill with code string
 *
 * Best for: Simple operations that can be expressed as a code snippet
 */
export const summarizeData = defineSkill({
  name: "summarize-data",
  description: "Fetch and summarize data from an API",
  adapters: ["myApi"], // Adapters this skill needs access to

  // Code runs in sandbox with access to:
  // - adapters: object with requested adapters
  // - inputs: parameters passed to the skill
  // - pick, sum, count, first, table: built-in helpers
  code: `
    const items = await adapters.myApi.listItems({ limit: 100 });

    // Use built-in helpers for efficient data handling
    return {
      total: items.length,
      byStatus: count(items, 'status'),
      recent: first(pick(items, ['id', 'name', 'createdAt']), 5),
    };
  `,

  // Optional sandbox configuration
  sandbox: {
    timeout: 10000,
    memoryLimit: 128,
  },
});

/**
 * Example 2: Using defineSkill with native function
 *
 * Best for: Complex logic that needs full TypeScript support
 */
export const processItems = defineSkill({
  name: "process-items",
  description: "Process items with complex business logic",
  adapters: ["myApi", "db"],

  run: async ({ adapters, inputs }) => {
    // Full TypeScript support
    const items = await adapters.myApi.listItems({
      status: inputs.status || "active",
    });

    // Complex processing
    const processed = items
      .filter((item: any) => item.amount > 0)
      .map((item: any) => ({
        id: item.id,
        name: item.name,
        score: calculateScore(item),
      }))
      .sort((a: any, b: any) => b.score - a.score);

    // Save results
    if (inputs.save) {
      await adapters.db.insert("processed_items", processed);
    }

    return {
      processed: processed.length,
      topItems: processed.slice(0, 10),
    };
  },
});

// Helper function (available in native function skills)
function calculateScore(item: any): number {
  return item.amount * (item.priority || 1);
}

/**
 * Example 3: Using skillBuilder (fluent API)
 *
 * Best for: Building skills programmatically or with cleaner syntax
 */
export const dailyReport = skillBuilder("daily-report")
  .description("Generate a daily activity report")
  .requires("crm", "analytics")
  .timeout(30000)
  .memoryLimit(256)
  .code(`
    const [leads, visits, sales] = await Promise.all([
      adapters.crm.getLeads({ date: inputs.date }),
      adapters.analytics.getPageViews({ date: inputs.date }),
      adapters.crm.getSales({ date: inputs.date }),
    ]);

    return {
      date: inputs.date,
      summary: {
        leads: leads.length,
        visits: sum(visits, 'count'),
        sales: sales.length,
        revenue: sum(sales, 'amount'),
      },
      topSources: count(leads, 'source'),
      topPages: first(
        visits.sort((a, b) => b.count - a.count),
        5
      ),
    };
  `)
  .build();
