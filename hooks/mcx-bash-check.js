const input = await Bun.stdin.json();
const command = input.tool_input?.command || '';
const cmd = command.trim();

// Block file reading commands -> mcx_file
const catMatch = cmd.match(/^cat\s+["']?([^"'\s]+)/);
if (catMatch) {
  const file = catMatch[1];
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      additionalContext: `Use mcx_file instead of cat:\n  mcx_file({ path: "${file}", storeAs: "x" })`
    }
  }));
}

// Block grep -> mcx_grep
else if (/^grep\s+/.test(cmd) || /^rg\s+/.test(cmd)) {
  const pattern = cmd.match(/(?:grep|rg)\s+(?:-[^\s]+\s+)*["']?([^"'\s]+)/)?.[1] || 'pattern';
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      additionalContext: `Use mcx_grep instead:\n  mcx_grep({ query: "${pattern}" })`
    }
  }));
}

// Block find/ls patterns -> mcx_find
else if (/^find\s+/.test(cmd) || /^ls\s+.*\*/.test(cmd)) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      additionalContext: "Use mcx_find instead with query parameter"
    }
  }));
}

// Block heredoc/echo for file creation -> mcx_edit or Write
else if (/<<\s*['"]?EOF/.test(cmd) || /^echo\s+.*>/.test(cmd)) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      additionalContext: "Use mcx_write for new files, mcx_edit for modifications"
    }
  }));
}

// Block curl/wget -> mcx_fetch
else if (/^(curl|wget)\s+/.test(cmd)) {
  const urlMatch = cmd.match(/https?:\/\/[^\s"']+/);
  const url = urlMatch ? urlMatch[0] : '...';
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      additionalContext: `Use mcx_fetch instead:\n  mcx_fetch({ url: "${url}" })`
    }
  }));
}
