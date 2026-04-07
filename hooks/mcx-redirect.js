try {
  const input = await Bun.stdin.json();
  const tool = input.tool_name;
  const path = input.tool_input?.file_path || input.tool_input?.path || '';

  const messages = {
    Read: `Use mcx_file instead:\n  mcx_file({ path: "${path || '...'}", storeAs: "x" })`,
    Grep: `Use mcx_grep instead:\n  mcx_grep({ query: "pattern", path: "${path || '...'}" })`,
    Glob: `Use mcx_find instead:\n  mcx_find({ query: "*.ts" })`,
    Edit: `Use mcx_edit instead:\n  mcx_edit({ file_path: "${path || '...'}", start: N, end: M, new_string: "..." })`,
    Update: `Use mcx_edit instead:\n  mcx_edit({ file_path: "${path || '...'}", start: N, end: M, new_string: "..." })`,
    Write: `Use mcx_write instead:\n  mcx_write({ file_path: "${path || '...'}", content: "..." })`
  };

  if (messages[tool]) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        additionalContext: messages[tool]
      }
    }));
  }
} catch (e) {
  console.error("mcx-redirect hook error:", e);
}
