import { z } from "zod";
import { defineAdapter, type AdapterTool } from "./base.js";

// Save reference to global fetch before any potential shadowing
const globalFetch = globalThis.fetch;

/**
 * Configuration schema for HTTP fetch adapter
 */
export const FetchConfigSchema = z.object({
  baseUrl: z.string().url().optional().describe("Base URL for all requests"),
  headers: z
    .record(z.string())
    .optional()
    .describe("Default headers to include in all requests"),
  timeout: z.number().optional().default(30000).describe("Request timeout in milliseconds"),
  debug: z.boolean().optional().default(false),
});

export type FetchConfig = z.infer<typeof FetchConfigSchema>;

/**
 * HTTP request options
 */
export interface RequestOptions {
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
  timeout?: number;
  responseType?: "json" | "text" | "blob" | "arrayBuffer";
}

/**
 * HTTP response structure
 */
export interface HttpResponse<T = unknown> {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: T;
}

/**
 * Create an HTTP fetch adapter instance
 */
export function createFetchAdapter(config: Partial<FetchConfig> = {}) {
  const debug = (message: string, ...args: unknown[]) => {
    if (config.debug) {
      // Use stderr to avoid breaking stdio MCP transport
      console.error(`[fetch] ${message}`, ...args);
    }
  };

  /**
   * Validate URL scheme to prevent SSRF attacks
   */
  const validateUrl = (url: string): void => {
    try {
      const parsed = new URL(url);
      // Only allow http and https protocols
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`Disallowed URL scheme: ${parsed.protocol}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Disallowed")) throw e;
      throw new Error(`Invalid URL: ${url}`);
    }
  };

  /**
   * Build full URL with query parameters
   */
  const buildUrl = (
    url: string,
    params?: Record<string, string | number | boolean>
  ): string => {
    // Handle base URL
    let fullUrl = url;
    if (config.baseUrl && !url.startsWith("http://") && !url.startsWith("https://")) {
      const base = config.baseUrl.endsWith("/") ? config.baseUrl.slice(0, -1) : config.baseUrl;
      const path = url.startsWith("/") ? url : `/${url}`;
      fullUrl = `${base}${path}`;
    }

    // SECURITY: Validate URL scheme to prevent SSRF (file://, data://, etc.)
    validateUrl(fullUrl);

    // Add query parameters
    if (params && Object.keys(params).length > 0) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        // Skip prototype pollution keys
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        searchParams.append(key, String(value));
      }
      const separator = fullUrl.includes("?") ? "&" : "?";
      fullUrl = `${fullUrl}${separator}${searchParams.toString()}`;
    }

    return fullUrl;
  };

  /**
   * Merge headers with defaults
   */
  const buildHeaders = (options?: RequestOptions): Record<string, string> => {
    return {
      ...config.headers,
      ...options?.headers,
    };
  };

  /** Maximum response size (10 MB) - prevents memory exhaustion */
  const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

  /**
   * Parse response based on content type or explicit type
   */
  const parseResponse = async <T>(
    response: Response,
    responseType?: "json" | "text" | "blob" | "arrayBuffer"
  ): Promise<T> => {
    // SECURITY: Check Content-Length header to reject oversized responses early
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
      throw new Error(`Response too large: ${contentLength} bytes (limit: ${MAX_RESPONSE_BYTES})`);
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (responseType === "text") {
      return (await response.text()) as T;
    }
    if (responseType === "blob") {
      return (await response.blob()) as T;
    }
    if (responseType === "arrayBuffer") {
      return (await response.arrayBuffer()) as T;
    }

    // Auto-detect based on content-type
    if (contentType.includes("application/json")) {
      return (await response.json()) as T;
    }
    if (contentType.includes("text/")) {
      return (await response.text()) as T;
    }

    // Default to JSON for responseType === 'json' or undefined
    try {
      return (await response.json()) as T;
    } catch {
      return (await response.text()) as T;
    }
  };

  /**
   * Convert Response headers to plain object
   */
  const headersToObject = (headers: Headers): Record<string, string> => {
    const obj: Record<string, string> = {};
    headers.forEach((value, key) => {
      obj[key] = value;
    });
    return obj;
  };

  /**
   * Execute HTTP request with timeout
   */
  const executeRequest = async <T>(
    method: string,
    url: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<HttpResponse<T>> => {
    const fullUrl = buildUrl(url, options?.params);
    const headers = buildHeaders(options);
    const timeout = options?.timeout ?? config.timeout ?? 30000;

    debug(`${method} ${fullUrl}`);

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const requestInit: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body !== undefined) {
        if (typeof body === "string") {
          requestInit.body = body;
        } else {
          requestInit.body = JSON.stringify(body);
          if (!headers["Content-Type"]) {
            (requestInit.headers as Record<string, string>)["Content-Type"] = "application/json";
          }
        }
      }

      const response = await globalFetch(fullUrl, requestInit);
      const data = await parseResponse<T>(response, options?.responseType);

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: headersToObject(response.headers),
        data,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timeout after ${timeout}ms: ${method} ${fullUrl}`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const tools: Record<string, AdapterTool> = {
    get: {
      description: "Make an HTTP GET request",
      parameters: {
        url: { type: "string", description: "URL to request", required: true },
        options: {
          type: "object",
          description: "Request options (headers, params, timeout, responseType)",
        },
      },
      execute: async <T>({
        url,
        options,
      }: {
        url: string;
        options?: RequestOptions;
      }): Promise<HttpResponse<T>> => {
        return executeRequest<T>("GET", url, undefined, options);
      },
    },

    post: {
      description: "Make an HTTP POST request",
      parameters: {
        url: { type: "string", description: "URL to request", required: true },
        body: { type: "object", description: "Request body" },
        options: {
          type: "object",
          description: "Request options (headers, params, timeout, responseType)",
        },
      },
      execute: async <T>({
        url,
        body,
        options,
      }: {
        url: string;
        body?: unknown;
        options?: RequestOptions;
      }): Promise<HttpResponse<T>> => {
        return executeRequest<T>("POST", url, body, options);
      },
    },

    put: {
      description: "Make an HTTP PUT request",
      parameters: {
        url: { type: "string", description: "URL to request", required: true },
        body: { type: "object", description: "Request body" },
        options: {
          type: "object",
          description: "Request options (headers, params, timeout, responseType)",
        },
      },
      execute: async <T>({
        url,
        body,
        options,
      }: {
        url: string;
        body?: unknown;
        options?: RequestOptions;
      }): Promise<HttpResponse<T>> => {
        return executeRequest<T>("PUT", url, body, options);
      },
    },

    patch: {
      description: "Make an HTTP PATCH request",
      parameters: {
        url: { type: "string", description: "URL to request", required: true },
        body: { type: "object", description: "Request body" },
        options: {
          type: "object",
          description: "Request options (headers, params, timeout, responseType)",
        },
      },
      execute: async <T>({
        url,
        body,
        options,
      }: {
        url: string;
        body?: unknown;
        options?: RequestOptions;
      }): Promise<HttpResponse<T>> => {
        return executeRequest<T>("PATCH", url, body, options);
      },
    },

    delete: {
      description: "Make an HTTP DELETE request",
      parameters: {
        url: { type: "string", description: "URL to request", required: true },
        options: {
          type: "object",
          description: "Request options (headers, params, timeout, responseType)",
        },
      },
      execute: async <T>({
        url,
        options,
      }: {
        url: string;
        options?: RequestOptions;
      }): Promise<HttpResponse<T>> => {
        return executeRequest<T>("DELETE", url, undefined, options);
      },
    },

    head: {
      description: "Make an HTTP HEAD request (headers only)",
      parameters: {
        url: { type: "string", description: "URL to request", required: true },
        options: {
          type: "object",
          description: "Request options (headers, params, timeout)",
        },
      },
      execute: async ({
        url,
        options,
      }: {
        url: string;
        options?: RequestOptions;
      }): Promise<HttpResponse<null>> => {
        const fullUrl = buildUrl(url, options?.params);
        const headers = buildHeaders(options);
        const timeout = options?.timeout ?? config.timeout ?? 30000;

        debug(`HEAD ${fullUrl}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
          const response = await globalFetch(fullUrl, {
            method: "HEAD",
            headers,
            signal: controller.signal,
          });

          return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers: headersToObject(response.headers),
            data: null,
          };
        } finally {
          clearTimeout(timeoutId);
        }
      },
    },

    request: {
      description: "Make a custom HTTP request with any method",
      parameters: {
        method: {
          type: "string",
          description: "HTTP method (GET, POST, PUT, PATCH, DELETE, etc.)",
          required: true,
        },
        url: { type: "string", description: "URL to request", required: true },
        body: { type: "object", description: "Request body" },
        options: {
          type: "object",
          description: "Request options (headers, params, timeout, responseType)",
        },
      },
      execute: async <T>({
        method,
        url,
        body,
        options,
      }: {
        method: string;
        url: string;
        body?: unknown;
        options?: RequestOptions;
      }): Promise<HttpResponse<T>> => {
        return executeRequest<T>(method.toUpperCase(), url, body, options);
      },
    },
  };

  return defineAdapter({
    name: "fetch",
    description: "HTTP fetch adapter for making API requests",
    version: "0.1.0",
    config: FetchConfigSchema,
    tools,
  });
}

/**
 * Pre-configured fetch adapter definition
 * Use createFetchAdapter() for runtime instantiation with baseUrl/headers
 */
export const fetchAdapter = defineAdapter({
  name: "fetch",
  description: "HTTP fetch adapter for making API requests",
  version: "0.1.0",
  config: FetchConfigSchema,
  tools: {
    get: {
      description: "Make an HTTP GET request",
      parameters: {
        url: { type: "string", required: true },
        options: { type: "object" },
      },
      execute: async ({ url, options }: { url: string; options?: RequestOptions }) => {
        const adapter = createFetchAdapter();
        return adapter.tools.get.execute({ url, options });
      },
    },
    post: {
      description: "Make an HTTP POST request",
      parameters: {
        url: { type: "string", required: true },
        body: { type: "object" },
        options: { type: "object" },
      },
      execute: async ({
        url,
        body,
        options,
      }: {
        url: string;
        body?: unknown;
        options?: RequestOptions;
      }) => {
        const adapter = createFetchAdapter();
        return adapter.tools.post.execute({ url, body, options });
      },
    },
    put: {
      description: "Make an HTTP PUT request",
      parameters: {
        url: { type: "string", required: true },
        body: { type: "object" },
        options: { type: "object" },
      },
      execute: async ({
        url,
        body,
        options,
      }: {
        url: string;
        body?: unknown;
        options?: RequestOptions;
      }) => {
        const adapter = createFetchAdapter();
        return adapter.tools.put.execute({ url, body, options });
      },
    },
    delete: {
      description: "Make an HTTP DELETE request",
      parameters: {
        url: { type: "string", required: true },
        options: { type: "object" },
      },
      execute: async ({ url, options }: { url: string; options?: RequestOptions }) => {
        const adapter = createFetchAdapter();
        return adapter.tools.delete.execute({ url, options });
      },
    },
  },
});
