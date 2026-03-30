/**
 * Security utilities for MCX
 * SSRF protection, environment variable validation, etc.
 */

// SECURITY: Environment variables that must never be overwritten from .env files
// These could enable privilege escalation, code injection, or other attacks
export const DANGEROUS_ENV_KEYS = new Set([
  // Node.js/Bun runtime flags that could inject code or change behavior
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_PATH",
  "NODE_REPL_HISTORY",
  "NODE_REDIRECT_WARNINGS",
  "BUN_OPTIONS",
  // Python startup/injection
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONWARNINGS",
  // Ruby startup/injection
  "RUBYOPT",
  "RUBYLIB",
  "RUBYPATH",
  // Perl startup/injection
  "PERL5OPT",
  "PERLLIB",
  "PERL5LIB",
  // System path manipulation / shared lib injection
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_BIND_NOW",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  // Shell injection vectors
  "SHELL",
  "BASH_ENV",
  "BASH_FUNC_",
  "ENV",
  "PROMPT_COMMAND",
  "PS1",
  "PS4",
  "CDPATH",
  "IFS",
  // Git command injection
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "GIT_EXEC_PATH",
  "GIT_PROXY_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_EDITOR",
  // Editor injection
  "EDITOR",
  "VISUAL",
  "PAGER",
  "BROWSER",
  // System identity (prevent spoofing)
  "HOME",
  "USER",
  "LOGNAME",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "TMP",
  "TEMP",
]);

/** Check if an env key is in the dangerous list (case-insensitive) */
export function isDangerousEnvKey(key: string): boolean {
  return DANGEROUS_ENV_KEYS.has(key.toUpperCase());
}

// Cloud metadata endpoints (AWS, GCP, Azure, DigitalOcean, etc.)
export const CLOUD_METADATA_HOSTS = new Set([
  "169.254.169.254",           // AWS/GCP/Azure metadata
  "metadata.google.internal",   // GCP
  "metadata.goog",              // GCP alternate
  "169.254.170.2",              // AWS ECS task metadata
  "fd00:ec2::254",              // AWS IPv6 metadata
]);

/**
 * SECURITY: Block requests to internal/private IP addresses and cloud metadata endpoints.
 * Prevents Server-Side Request Forgery (SSRF) attacks.
 */
export function isBlockedUrl(url: string): { blocked: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { blocked: true, reason: "Invalid URL" };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (CLOUD_METADATA_HOSTS.has(hostname)) {
    return { blocked: true, reason: "Cloud metadata endpoint blocked" };
  }

  // Parse IP address
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b, c, d] = ipv4Match.map(Number);

    // Block private IPv4 ranges (RFC 1918)
    if (a === 10) return { blocked: true, reason: "Private IP (10.x.x.x)" };
    if (a === 172 && b >= 16 && b <= 31) return { blocked: true, reason: "Private IP (172.16-31.x.x)" };
    if (a === 192 && b === 168) return { blocked: true, reason: "Private IP (192.168.x.x)" };

    // Block loopback
    if (a === 127) return { blocked: true, reason: "Loopback address" };

    // Block link-local (169.254.x.x)
    if (a === 169 && b === 254) return { blocked: true, reason: "Link-local address" };

    // Block 0.0.0.0
    if (a === 0 && b === 0 && c === 0 && d === 0) return { blocked: true, reason: "Invalid address 0.0.0.0" };

    // Block broadcast
    if (a === 255 && b === 255 && c === 255 && d === 255) return { blocked: true, reason: "Broadcast address" };
  }

  // Block IPv6 private/special ranges
  if (hostname.startsWith("[")) {
    const ipv6 = hostname.slice(1, -1).toLowerCase();
    // Loopback ::1
    if (ipv6 === "::1") return { blocked: true, reason: "IPv6 loopback" };
    // Link-local fe80::/10
    if (ipv6.startsWith("fe80:")) return { blocked: true, reason: "IPv6 link-local" };
    // Unique local fc00::/7 (fc00:: and fd00::)
    if (ipv6.startsWith("fc") || ipv6.startsWith("fd")) return { blocked: true, reason: "IPv6 unique local" };
    // IPv4-mapped ::ffff:x.x.x.x - check the mapped IPv4
    if (ipv6.startsWith("::ffff:")) {
      const mappedIp = ipv6.slice(7);
      const result = isBlockedUrl(`http://${mappedIp}/`);
      if (result.blocked) return { blocked: true, reason: `IPv4-mapped ${result.reason}` };
    }
  }

  // Block localhost variants
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { blocked: true, reason: "Localhost blocked" };
  }

  // Block internal TLDs
  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    return { blocked: true, reason: "Internal domain blocked" };
  }

  return { blocked: false };
}
