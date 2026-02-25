/**
 * Network Policy for Sandbox Execution
 *
 * Controls network access within the sandbox environment.
 * Inspired by Cloudflare's `globalOutbound: null` pattern.
 *
 * @example
 * ```ts
 * // Block all network (default - most secure)
 * const policy: NetworkPolicy = { mode: 'blocked' };
 *
 * // Allow specific domains
 * const policy: NetworkPolicy = {
 *   mode: 'allowed',
 *   domains: ['api.example.com', 'cdn.example.com']
 * };
 *
 * // Unrestricted (use with caution)
 * const policy: NetworkPolicy = { mode: 'unrestricted' };
 * ```
 */

/**
 * Network access policy for sandbox execution.
 */
export type NetworkPolicy =
  | { mode: "blocked" }
  | { mode: "allowed"; domains: string[] }
  | { mode: "unrestricted" };

/**
 * Default network policy - block all external network access.
 * This is the most secure option and recommended for untrusted code.
 */
export const DEFAULT_NETWORK_POLICY: NetworkPolicy = { mode: "blocked" };

/**
 * Check if a URL is allowed by the network policy.
 *
 * @param url - The URL to check
 * @param policy - The network policy to apply
 * @returns true if the URL is allowed, false otherwise
 */
export function isUrlAllowed(url: string, policy: NetworkPolicy): boolean {
  if (policy.mode === "unrestricted") {
    return true;
  }

  if (policy.mode === "blocked") {
    return false;
  }

  // mode === 'allowed' - check against whitelist
  try {
    const hostname = new URL(url).hostname;
    return policy.domains.some(
      (domain) => hostname === domain || hostname.endsWith("." + domain)
    );
  } catch {
    // Invalid URL - block it
    return false;
  }
}

/**
 * Generate the network isolation code to inject into the worker.
 * This creates fetch/WebSocket overrides that enforce the policy.
 *
 * @param policy - The network policy to enforce
 * @returns JavaScript code string to inject
 */
export function generateNetworkIsolationCode(policy: NetworkPolicy): string {
  if (policy.mode === "unrestricted") {
    return "// Network: unrestricted";
  }

  if (policy.mode === "blocked") {
    return `
// Network isolation: BLOCKED
const __original_fetch = globalThis.fetch;
globalThis.fetch = async function(url, options) {
  throw new Error('Network access is blocked in sandbox. Use adapters instead.');
};

// Block XMLHttpRequest
globalThis.XMLHttpRequest = class {
  constructor() {
    throw new Error('XMLHttpRequest is blocked in sandbox.');
  }
};

// Block WebSocket
globalThis.WebSocket = class {
  constructor(url) {
    throw new Error('WebSocket is blocked in sandbox.');
  }
};

// Block EventSource (SSE)
globalThis.EventSource = class {
  constructor(url) {
    throw new Error('EventSource is blocked in sandbox.');
  }
};
`;
  }

  // mode === 'allowed' - whitelist specific domains
  const domainsJson = JSON.stringify(policy.domains);
  return `
// Network isolation: ALLOWED (whitelist)
const __allowed_domains = ${domainsJson};
const __original_fetch = globalThis.fetch;

function __isUrlAllowed(url) {
  try {
    const hostname = new URL(url).hostname;
    return __allowed_domains.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

globalThis.fetch = async function(url, options) {
  const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
  if (!__isUrlAllowed(urlStr)) {
    const hostname = new URL(urlStr).hostname;
    throw new Error(\`Network access blocked: \${hostname} not in allowed domains: \${__allowed_domains.join(', ')}\`);
  }
  return __original_fetch(url, options);
};

// Block XMLHttpRequest (not easily whitelistable)
globalThis.XMLHttpRequest = class {
  constructor() {
    throw new Error('XMLHttpRequest is blocked. Use fetch() with allowed domains.');
  }
};

// Block WebSocket (would need separate whitelist)
globalThis.WebSocket = class {
  constructor(url) {
    if (!__isUrlAllowed(url)) {
      throw new Error('WebSocket blocked: domain not in allowed list.');
    }
    throw new Error('WebSocket not supported in sandbox even for allowed domains.');
  }
};

// Block EventSource
globalThis.EventSource = class {
  constructor(url) {
    throw new Error('EventSource is blocked in sandbox.');
  }
};
`;
}
