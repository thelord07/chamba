---
"@chamba/claude-extras": patch
"@chamba/mcp": patch
---

Add a `--version` flag (alias `-v`) to both bins.

`npx @chamba/claude-extras --version` and `npx @chamba/mcp --version` now print the installed version and exit — handy for confirming which version `npx` actually resolved. The MCP server prints and exits before any protocol starts, so it doesn't interfere with normal stdio startup.
