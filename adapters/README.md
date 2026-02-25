# MCX Custom Adapters

Example adapters for the MCX framework.

## Available Adapters

| Adapter | Description | Tools |
|---------|-------------|-------|
| [chrome-devtools](./chrome-devtools.README.md) | Browser automation via CDP | 25 |

## Usage

Copy any adapter to your MCX adapters directory:

```bash
cp <adapter>.ts ~/.mcx/adapters/
```

MCX auto-loads all `.ts` files from `~/.mcx/adapters/`.

## Creating Custom Adapters

Use `adapter.template.ts` as a starting point:

```typescript
import { defineAdapter } from "@papicandela/mcx-adapters";

export const myAdapter = defineAdapter({
  name: "my-adapter",

  tools: {
    myTool: {
      description: "Does something",
      parameters: {
        param1: { type: "string", required: true, description: "..." },
      },
      execute: async (params) => {
        // Implementation
        return { result: "..." };
      },
    },
  },
});

export default myAdapter;
```

## Structure

```
adapters/
├── README.md                    # This file
├── adapter.template.ts          # Template for new adapters
├── chrome-devtools.ts           # Browser automation
└── chrome-devtools.README.md    # Chrome DevTools docs
```
