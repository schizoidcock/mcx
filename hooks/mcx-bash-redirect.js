try {
  const input = await Bun.stdin.json();
  const cmd = input.tool_input?.command?.trim() || '';
  
  const escapedCmd = cmd.replace(/"/g, '\\"');
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      additionalContext: `Use mcx_execute instead:\n  mcx_execute({ shell: "${escapedCmd}" })`
    }
  }));
} catch (e) {
  console.error("mcx-bash-redirect hook error:", e);
}
