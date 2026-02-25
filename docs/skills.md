# Skills

Skills are reusable operations that combine multiple adapter calls.

## Using defineSkill

```typescript
import { defineSkill } from '@papicandela/mcx-core';

export const dailySummary = defineSkill({
  name: 'daily-summary',
  description: 'Summarize daily activity across systems',
  adapters: ['crm', 'analytics'],
  code: `
    const leads = await crm.getLeads({ date: inputs.date });
    const visits = await analytics.getPageViews({ date: inputs.date });
    return {
      date: inputs.date,
      leads: leads.length,
      visits: sum(visits, 'count'),
      conversion: (leads.length / sum(visits, 'count') * 100).toFixed(2) + '%'
    };
  `,
  sandbox: {
    timeout: 10000,
    memoryLimit: 128,
  },
});
```

## Using skillBuilder (Fluent API)

```typescript
import { skillBuilder } from '@papicandela/mcx-core';

export const processData = skillBuilder('process-data')
  .description('Fetch, transform, and store data')
  .requires('api', 'db')
  .timeout(15000)
  .memoryLimit(256)
  .code(`
    const raw = await api.fetchRecords({ limit: 1000 });
    const filtered = pick(raw, ['id', 'name', 'amount']);
    const result = await db.bulkInsert(filtered);
    return { inserted: result.count };
  `)
  .build();
```

## Native Function Skills

For complex logic, use a native TypeScript function instead of code string:

```typescript
export const complexSkill = defineSkill({
  name: 'complex-operation',
  description: 'Skill with native TypeScript logic',
  adapters: ['api'],
  run: async ({ adapters, inputs }) => {
    const data = await adapters.api.getData(inputs);

    // Complex processing with full TypeScript support
    const processed = data
      .filter(item => item.active)
      .map(item => ({
        ...item,
        score: calculateScore(item),
      }))
      .sort((a, b) => b.score - a.score);

    return { top10: processed.slice(0, 10) };
  },
});
```

## Directory Structure

Skills can be single files or directories:

```
skills/
├── daily-summary.ts           # Single file skill
├── complex-workflow/          # Directory skill
│   ├── index.ts               # Entry point (required)
│   └── helpers.ts             # Supporting modules
```

## Running Skills

```bash
# Run via CLI
mcx run daily-summary date=2024-01-15

# Via MCP tool
mcx_run_skill({ name: "daily-summary", inputs: { date: "2024-01-15" } })
```
