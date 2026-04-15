/**
 * Security utilities for MCX
 * SSRF protection, environment variable validation, shell escape detection
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

// ============================================================================
// Shell Escape Detection
// ============================================================================

/**
 * Patterns that detect shell escape attempts in code.
 * These functions execute shell commands, bypassing MCX controls.
 */
const SHELL_ESCAPE_PATTERNS: Record<string, RegExp[]> = {
  python: [
    /\bos\.system\s*\(/,
    /\bos\.popen\s*\(/,
    /\bsubprocess\.(run|call|Popen|check_output|check_call)\s*\(/,
  ],
  javascript: [
    /\bexec(Sync)?\s*\(/,
    /\bexecFile(Sync)?\s*\(/,
    /\bspawn(Sync)?\s*\(/,
    /\bchild_process\b/,
    /\bBun\.spawn(Sync)?\s*\(/,
  ],
  typescript: [
    /\bexec(Sync)?\s*\(/,
    /\bexecFile(Sync)?\s*\(/,
    /\bspawn(Sync)?\s*\(/,
    /\bchild_process\b/,
    /\bBun\.spawn(Sync)?\s*\(/,
  ],
  ruby: [
    /\bsystem\s*\(/,
    /\bexec\s*\(/,
    /\bIO\.popen\s*\(/,
  ],
  go: [
    /\bexec\.Command(Context)?\s*\(/,
  ],
  rust: [
    /\bCommand::new\s*\(/,
  ],
  php: [
    /\bshell_exec\s*\(/,
    /\bexec\s*\(/,
    /\bsystem\s*\(/,
    /\bpassthru\s*\(/,
    /\bproc_open\s*\(/,
  ],
  perl: [
    /\bsystem\s*\(/,
    /\bexec\s*\(/,
  ],
};

export interface ShellEscapeResult {
  detected: boolean;
  patterns: string[];
  suggestion: string;
}

/**
 * Detect shell escape patterns in code.
 * Returns detected patterns and suggestion for safe alternative.
 */
export function detectShellEscape(code: string, language: string): ShellEscapeResult {
  const lang = language.toLowerCase();
  const patterns = SHELL_ESCAPE_PATTERNS[lang];
  
  if (!patterns) {
    return { detected: false, patterns: [], suggestion: '' };
  }

  const detected: string[] = [];
  
  for (const pattern of patterns) {
    const match = code.match(pattern);
    if (match) {
      detected.push(match[0].trim());
    }
  }

  if (detected.length === 0) {
    return { detected: false, patterns: [], suggestion: '' };
  }

  return {
    detected: true,
    patterns: detected,
    suggestion: `Shell escape detected: ${detected.join(', ')}\n💡 Must use mcx_execute({ shell: "your command" }) instead`,
  };
}

// ============================================================================
// Tool Redirect Enforcement
// ============================================================================

export type BlockedResponse = { 
  content: Array<{ type: "text"; text: string }>; 
  isError: true 
};

/** Create blocked response for tool redirects */
export function blockedResponse(msg: string): BlockedResponse {
  return { content: [{ type: "text", text: msg }], isError: true };
}

/** Enforce shell command redirects to MCX tools. Returns error response or null. */
export function enforceShellRedirects(cmd: string): BlockedResponse | null {
  // BLOCK destructive commands (security - these should never execute)
  if (/\brm\s+(-[rf]+\s+)*(\/\*?|~|\$HOME|\.\.?)($|\s)/.test(cmd)) {
    return blockedResponse('🔴 BLOCKED: Destructive rm command on critical path');
  }
  if (/\bdd\s+.*if=\/dev\/(zero|random|urandom)/.test(cmd)) {
    return blockedResponse('🔴 BLOCKED: Destructive dd command');
  }
  if (/\b(mkfs|fdisk|parted|wipefs)\b/.test(cmd)) {
    return blockedResponse('🔴 BLOCKED: Disk formatting command');
  }
  if (/:(){ :|:& };:|fork\s*bomb/i.test(cmd)) {
    return blockedResponse('🔴 BLOCKED: Fork bomb detected');
  }
  
  // File operations → mcx_file
  const fileMatch = cmd.match(/\b(cat|head|tail|sed|awk|wc|less|more|cut|sort|tr)\b.*?(["']?)([^\s|>"']*[\.\/\\][^\s|>"']+)\2/);
  if (fileMatch) {
    const filePath = fileMatch[3];
    const varName = filePath.split(/[\/\\]/).pop()?.replace(/\.[^.]+$/, '') || 'f';
    return blockedResponse(`Must use mcx_file for file operations\n💡 mcx_file({ path: "${filePath}", storeAs: "${varName}" }), then grep($${varName}, 'pattern')`);
  }
  
  // grep/rg → mcx_grep
  if (/\b(grep|rg)\s+/.test(cmd)) {
    return blockedResponse(`Must use mcx_grep instead\n💡 mcx_grep({ pattern: "...", path: "..." })`);
  }
  
  // find → mcx_find
  const findMatch = cmd.match(/\bfind\s+["']?([^\s|>"']*)/);
  if (findMatch) {
    return blockedResponse(`Must use mcx_find instead\n💡 mcx_find({ pattern: "...", path: "${findMatch[1] || '.'}" })`);
  }
  
  // curl/wget → mcx_fetch
  const curlMatch = cmd.match(/\b(curl|wget)\s+.*?(https?:\/\/[^\s"']+)/);
  if (curlMatch) {
    return blockedResponse(`Must use mcx_fetch instead\n💡 mcx_fetch({ url: "${curlMatch[2]}" })`);
  }
  
  // bun -e / node -e with file operations → mcx_file
  if (/\b(bun|node)\s+-e\s+/.test(cmd)) {
    // Check for file operations inside the inline code
    if (/Bun\.(file|write|stdin)|readFile|writeFile|fs\.(promises|createRead|createWrite)/.test(cmd)) {
      return blockedResponse(`File operations in inline code must use mcx_file instead
💡 mcx_file({ path: "...", storeAs: "x" })`);
    }
  }
  
  return null;
}

/** Enforce Python code redirects to MCX tools. Returns error response or null. */
export function enforcePythonRedirects(code: string): BlockedResponse | null {
  // File reading operations → mcx_file
  if (/\b(open\s*\(|with\s+open)/.test(code)) {
    return blockedResponse(`Must use mcx_file for file reading
💡 mcx_file({ path: "...", storeAs: "x" }), then use helpers`);
  }
  
  // pathlib operations → mcx_file
  if (/\b(Path\s*\(|pathlib\.)/.test(code)) {
    return blockedResponse(`Must use mcx_file for path operations
💡 mcx_file({ path: "...", storeAs: "x" })`);
  }
  
  // pandas file reading → mcx_file
  if (/\b(pd|pandas)\.(read_\w+|to_\w+)\s*\(/.test(code)) {
    return blockedResponse(`Must use mcx_file for pandas file operations
💡 mcx_file({ path: "...", storeAs: "data" }), then process in Python separately`);
  }
  
  // os.path, shutil, glob → mcx_file/mcx_find
  if (/\b(os\.path\.|shutil\.|glob\.glob)/.test(code)) {
    return blockedResponse(`Must use mcx_file or mcx_find for file system operations
💡 mcx_find({ query: "*.py" }) or mcx_file({ path: "..." })`);
  }
  
  return null;
}

/** Enforce JS/TS code redirects to MCX tools. Returns error response or null. */
export function enforceCodeRedirects(code: string): BlockedResponse | null {
  // Network requests → mcx_fetch
  if (/\bfetch\s*\(/.test(code) || /\baxios\s*\./.test(code) || /\bgot\s*\(/.test(code)) {
    return blockedResponse(`Network requests must use mcx_fetch instead
💡 mcx_fetch({ url: "..." })`);
  }
  
  // File operations → mcx_file (Node.js)
  if (/\b(readFileSync|readFile|writeFileSync|writeFile)\s*\(/.test(code)) {
    return blockedResponse(`File operations must use mcx_file instead
💡 mcx_file({ path: "...", storeAs: "x" })`);
  }
  
  // File operations → mcx_file (Bun)
  if (/\bBun\.(file|write|stdin|stdout)\s*\(/.test(code)) {
    return blockedResponse(`Bun file operations must use mcx_file instead
💡 mcx_file({ path: "...", storeAs: "x" })`);
  }
  
  // File operations → mcx_file (fs.promises, streams)
  if (/\bfs\.(promises\.|createReadStream|createWriteStream)/.test(code)) {
    return blockedResponse(`File operations must use mcx_file instead
💡 mcx_file({ path: "...", storeAs: "x" })`);
  }
  
  return null;
}
