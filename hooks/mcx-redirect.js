const input = await Bun.stdin.json();
const mcx = { Grep: "mcx_grep", Glob: "mcx_find", Edit: "mcx_edit", Write: "mcx_write" }[input.tool_name];
if (mcx) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      additionalContext: `Use ${mcx} instead`
    }
  }));
}
