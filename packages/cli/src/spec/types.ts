export interface ParameterSpec {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  example?: unknown;
}

export interface ToolSpec {
  name: string;
  method: string;
  path: string;
  description?: string;
  parameters: ParameterSpec[];
  requestBody?: {
    required: boolean;
    schema: Record<string, unknown>;
  };
  responses?: Record<string, unknown>;
  /** Inferred dependencies: parameter -> likely source methods */
  requires?: Record<string, string[]>;
  /** Simplified response schema */
  responseSchema?: Record<string, unknown>;
}

export interface AdapterSpec {
  name: string;
  description?: string;
  baseUrl?: string;
  tools: Record<string, ToolSpec>;
  components?: Record<string, unknown>;
}

export interface ResolvedSpec {
  adapters: Record<string, AdapterSpec>;
  products: string[];
}
