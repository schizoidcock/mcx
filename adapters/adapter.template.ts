/**
 * Adapter Template
 *
 * Copy this file to adapters/your-adapter.ts and customize:
 *   cp templates/adapter.template.ts adapters/my-api.ts
 */
import { defineAdapter } from "@mcx/adapters";

// Configuration from environment variables
const BASE_URL = process.env.MY_API_URL || "https://api.example.com";
const API_KEY = process.env.MY_API_KEY || "";

/**
 * Helper to make authenticated requests
 */
async function request(endpoint: string, options: RequestInit = {}) {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Define your adapter
 */
export const myApi = defineAdapter({
  name: "my-api",

  tools: {
    /**
     * Example: List items
     */
    listItems: {
      description: "List all items with optional filtering",
      parameters: {
        limit: { type: "number", description: "Max items to return" },
        offset: { type: "number", description: "Pagination offset" },
        status: { type: "string", description: "Filter by status" },
      },
      execute: async (params) => {
        const query = new URLSearchParams();
        if (params.limit) query.set("limit", String(params.limit));
        if (params.offset) query.set("offset", String(params.offset));
        if (params.status) query.set("status", params.status);

        return request(`/items?${query}`);
      },
    },

    /**
     * Example: Get single item
     */
    getItem: {
      description: "Get item by ID",
      parameters: {
        id: { type: "string", required: true, description: "Item ID" },
      },
      execute: async (params) => {
        return request(`/items/${params.id}`);
      },
    },

    /**
     * Example: Create item
     */
    createItem: {
      description: "Create a new item",
      parameters: {
        name: { type: "string", required: true, description: "Item name" },
        description: { type: "string", description: "Item description" },
        data: { type: "object", description: "Additional item data" },
      },
      execute: async (params) => {
        return request("/items", {
          method: "POST",
          body: JSON.stringify(params),
        });
      },
    },

    /**
     * Example: Update item
     */
    updateItem: {
      description: "Update an existing item",
      parameters: {
        id: { type: "string", required: true, description: "Item ID" },
        name: { type: "string", description: "New name" },
        description: { type: "string", description: "New description" },
        data: { type: "object", description: "Updated data" },
      },
      execute: async (params) => {
        const { id, ...body } = params;
        return request(`/items/${id}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
      },
    },

    /**
     * Example: Delete item
     */
    deleteItem: {
      description: "Delete an item",
      parameters: {
        id: { type: "string", required: true, description: "Item ID" },
      },
      execute: async (params) => {
        return request(`/items/${params.id}`, {
          method: "DELETE",
        });
      },
    },
  },
});
