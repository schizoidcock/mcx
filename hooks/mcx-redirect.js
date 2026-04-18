try {
  const input = await Bun.stdin.json();
  const tool = input.tool_name;
  const path = input.tool_input?.file_path || input.tool_input?.path || '';
  const url = input.tool_input?.url || '';
  
  // Allow Read for image files (multimodal viewing)
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico'];
  const isImage = imageExts.some(ext => path.toLowerCase().endsWith(ext));

  const messages = {
    read: `Use mcx_file instead:\n  mcx_file({ path: "${path || '...'}", storeAs: "x" })`,
    grep: `Use mcx_grep instead:\n  mcx_grep({ query: "pattern", path: "${path || '...'}" })`,
    glob: `Use mcx_find instead:\n  mcx_find({ query: "*.ts" })`,
    edit: `Use mcx_file instead:\n  mcx_file({ file_path: "${path || '...'}", start: N, end: M, new_string: "..." })`,
    update: `Use mcx_file instead:\n  mcx_file({ file_path: "${path || '...'}", start: N, end: M, new_string: "..." })`,
    write: `Use mcx_write instead:\n  mcx_write({ file_path: "${path || '...'}", content: "..." })`,
    webfetch: `Use mcx_fetch instead:\n  mcx_fetch({ url: "${url || '...'}" })`
  };


  const msg = messages[tool.toLowerCase()];
  // Allow Read for images (multimodal) - don't block
  if (msg && !(tool.toLowerCase() === 'read' && isImage)) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        additionalContext: msg
      }
    }));
  }
} catch (e) {
  console.error("mcx-redirect hook error:", e);
}
