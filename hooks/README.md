# MCX Claude Code Hooks

Redirect native Claude Code tools to MCX alternatives.

## Installation

Copy hooks to `~/.claude/hooks/`:

```bash
cp hooks/*.js ~/.claude/hooks/
```

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Grep", "hooks": [{ "type": "command", "command": "bun ~/.claude/hooks/mcx-redirect.js" }] },
      { "matcher": "Glob", "hooks": [{ "type": "command", "command": "bun ~/.claude/hooks/mcx-redirect.js" }] },
      { "matcher": "Edit", "hooks": [{ "type": "command", "command": "bun ~/.claude/hooks/mcx-redirect.js" }] },
      { "matcher": "Write", "hooks": [{ "type": "command", "command": "bun ~/.claude/hooks/mcx-redirect.js" }] },
      { "matcher": "Read", "hooks": [{ "type": "command", "command": "bun ~/.claude/hooks/mcx-read-check.js" }] },
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "bun ~/.claude/hooks/mcx-bash-check.js" }] }
    ]
  }
}
```

## Hooks

| Hook | Blocks | Redirects to |
|------|--------|--------------|
| `mcx-redirect.js` | Grep, Glob, Edit, Write | mcx_grep, mcx_find, mcx_edit, mcx_write |
| `mcx-read-check.js` | Read (>50KB) | mcx_file with storeAs |
| `mcx-bash-check.js` | cat, grep, rg, find, heredoc | mcx_file, mcx_grep, mcx_find, mcx_edit |

## Notes

- `mcx_find` is fuzzy name search only. For advanced `find` options (`-exec`, `-mtime`, `-size`), allow the command manually.
- Requires [Bun](https://bun.sh) runtime.
