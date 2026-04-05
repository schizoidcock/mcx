const input = await Bun.stdin.json();
const filePath = input.tool_input?.file_path;

if (filePath) {
  try {
    const size = Bun.file(filePath).size;
    if (size > 50 * 1024) {
      const sizeKB = Math.round(size / 1024);
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          additionalContext: `File is ${sizeKB}KB. Use mcx_file({ path: "${filePath}", storeAs: "src" }) + grep/around/outline to explore. Use mcx_edit to modify.`
        }
      }));
    }
  } catch {}
}
