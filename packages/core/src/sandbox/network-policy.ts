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
    // SECURITY: Wrap in IIFE to prevent user code from accessing __original_fetch
    // Use Object.defineProperty with writable:false to prevent user code from overwriting
    return `
// Network isolation: BLOCKED
(function() {
  const blockedFetch = async function() {
    throw new Error('Network access is blocked in sandbox. Use adapters instead.');
  };
  Object.defineProperty(globalThis, 'fetch', {
    value: blockedFetch,
    writable: false,
    configurable: false
  });
})();

// Block XMLHttpRequest
Object.defineProperty(globalThis, 'XMLHttpRequest', {
  value: class {
    constructor() {
      throw new Error('XMLHttpRequest is blocked in sandbox.');
    }
  },
  writable: false,
  configurable: false
});

// Block WebSocket
Object.defineProperty(globalThis, 'WebSocket', {
  value: class {
    constructor() {
      throw new Error('WebSocket is blocked in sandbox.');
    }
  },
  writable: false,
  configurable: false
});

// Block EventSource (SSE)
Object.defineProperty(globalThis, 'EventSource', {
  value: class {
    constructor() {
      throw new Error('EventSource is blocked in sandbox.');
    }
  },
  writable: false,
  configurable: false
});
`;
  }

  // mode === 'allowed' - whitelist specific domains
  // SECURITY: Wrap in IIFE to prevent user code from accessing internals
  // Use Object.defineProperty with writable:false to prevent user code from overwriting
  const domainsJson = JSON.stringify(policy.domains);
  return `
// Network isolation: ALLOWED (whitelist)
(function() {
  const _domains = ${domainsJson};
  const _real_fetch = globalThis.fetch;

  // Block private/link-local IPs to prevent DNS rebinding attacks
  function _isPrivateIp(hostname) {
    return /^(localhost|127\\.|10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.|169\\.254\\.|\\[::1\\]|\\[fc|\\[fd)/.test(hostname);
  }

  function _isUrlAllowed(url) {
    try {
      const parsed = new URL(url);
      // Only allow http/https protocols
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
      const hostname = parsed.hostname;
      if (!hostname || _isPrivateIp(hostname)) return false;
      return _domains.some(d => d && (hostname === d || hostname.endsWith('.' + d)));
    } catch {
      return false;
    }
  }

  const whitelistedFetch = async function(url, options) {
    // Safely extract URL string from various input types
    let urlStr;
    try {
      if (typeof url === 'string') urlStr = url;
      else if (url instanceof URL) urlStr = url.toString();
      else if (url && typeof url.url === 'string') urlStr = url.url;
      else throw new Error('Invalid URL type');
    } catch {
      throw new Error('Network access blocked: could not determine request URL.');
    }
    if (!_isUrlAllowed(urlStr)) {
      throw new Error('Network access blocked: domain not in allowed list.');
    }
    return _real_fetch(url, options);
  };

  Object.defineProperty(globalThis, 'fetch', {
    value: whitelistedFetch,
    writable: false,
    configurable: false
  });
})();

// Block XMLHttpRequest (not easily whitelistable)
Object.defineProperty(globalThis, 'XMLHttpRequest', {
  value: class {
    constructor() {
      throw new Error('XMLHttpRequest is blocked. Use fetch() with allowed domains.');
    }
  },
  writable: false,
  configurable: false
});

// Block WebSocket - opaque error to prevent allowlist enumeration
Object.defineProperty(globalThis, 'WebSocket', {
  value: class {
    constructor() {
      throw new Error('WebSocket is not supported in sandbox.');
    }
  },
  writable: false,
  configurable: false
});

// Block EventSource
Object.defineProperty(globalThis, 'EventSource', {
  value: class {
    constructor() {
      throw new Error('EventSource is blocked in sandbox.');
  }
  },
  writable: false,
  configurable: false
});
`;
}
