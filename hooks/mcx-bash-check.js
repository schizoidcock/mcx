const input = await Bun.stdin.json();
const command = input.tool_input?.command || '';
const cmd = command.trim();

// Block file reading commands -> mcx_file
if (/^cat\s+/.test(cmd)) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      additionalContext: "Use mcx_file({ path, storeAs }) instead of cat"
    }
  }));
}

// Block grep -> mcx_grep
else if (/^grep\s+/.test(cmd) || /^rg\s+/.test(cmd)) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      additionalContext: "Use mcx_grep instead of grep/rg"
    }
  }));
}

// Block find/ls patterns -> mcx_find
else if (/^find\s+/.test(cmd) || /^ls\s+.*\*/.test(cmd)) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      additionalContext: "Use mcx_find instead of find/ls"
    }
  }));
}

// Block heredoc/echo for file creation -> mcx_edit or Write
else if (/<<\s*['"]?EOF/.test(cmd) || /^echo\s+.*>/.test(cmd)) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      additionalContext: "Use mcx_edit or mcx_write instead of heredoc/echo redirection"
    }
  }));
}
