/**
 * Security Messages - Block and redirect messages
 * ONE source of truth for security-related messages
 */

// === Hard blocks (destructive/dangerous) ===
export const securityBlocks = {
  destructiveDd: 'Destructive dd command',
  diskFormat: 'Disk formatting command',
  forkBomb: 'Fork bomb detected',
  gitCheckout: 'git checkout/restore blocked - destructive operation',
  gitHeredoc: 'git commit with heredoc blocked - use -m or -F file',
};

// === Tool redirects (use MCX tools instead) ===
export const toolRedirects = {
  shellWrite: 'mcx_file({ path: "...", content: "..." })',
  fileRead: 'Output already truncated. For file commands (cat|head|tail|less|more) use mcx_file.',
  grepRedirect: 'mcx_grep({ query: "pattern", path: "..." })',
  findRedirect: 'mcx_find({ query: "*.ts" })',
  sedRedirect: 'mcx_file({ path: "...", storeAs: "f", code: "$f.raw.replace(...)", write: true })',
  
  pythonOpen: 'mcx_file({ path: "...", storeAs: "x" })',
  pythonPath: 'mcx_file({ path: "...", storeAs: "x" })',
  pythonPandas: 'mcx_file for pandas file operations',
  pythonOsPath: 'mcx_file or mcx_find for file system operations',
  
  jsFetch: 'mcx_fetch({ url: "..." })',
  jsReadFile: 'mcx_file({ path: "...", storeAs: "x" })',
  jsWriteFile: 'mcx_file({ path: "...", content: "..." })',
  jsBunFile: 'mcx_file({ path: "...", storeAs: "x" })',
  jsFsStreams: 'mcx_file({ path: "...", storeAs: "x" })',
};

// === SSRF blocks ===
export const ssrfBlocks = {
  loopback: 'Loopback address',
  privateIP: 'Private IP address',
  cloudMetadata: 'Cloud metadata endpoint',
  invalidUrl: 'Invalid URL',
};

// === Detection messages ===
export const detectionMessages = {
  shellEscape: (patterns: string[]) =>
    `Shell escape detected: ${patterns.join(', ')}\n💡 Must use mcx_execute({ shell: "your command" }) instead`,
};
