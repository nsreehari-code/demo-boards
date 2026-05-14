# demo-boards/mcp-server

Manifest-driven MCP server scaffold for `demo-boards` and adjacent repo-backed tool surfaces.

## Why this shape

Use one shared MCP server codebase with multiple manifests, not one custom server per feature.

That gives you:
- one runtime for tool registration, auth checks, error formatting, and transport wiring
- one manifest format for `demo-boards` tools and future `fintech/data-repos/*` tools
- the option to run a combined local server or separate instances per trust boundary

## Recommendation

Use the same server code with separate manifests.

Use one generic `mcp` source kind in `demo-task-executor`, with the target MCP server supplied per source definition.

That is better than introducing one source kind per server such as `demo-boards-mcp`, `sentinel-mcp`, or `repo-mcp`.

Why:
- the executor keeps one stable abstraction: `mcp`
- each card or source definition chooses its own tool and server
- local and remote MCP servers fit the same shape
- tomorrow's Sentinel server can be used by changing source config, not runtime code

Recommended split:
- `demo-boards/mcp-server/src/` holds the reusable runtime and handler registry
- `demo-boards/mcp-server/manifests/` holds manifest files for each tool set
- each data repo can either:
  - keep its own manifest inside the repo and point this server at it, or
  - contribute a manifest file into this directory during local development

## Important WorkIQ note

The current WorkIQ invocation in `src/handlers/workiq.js` inherits terminal stdin. That is a strong signal that WorkIQ should not be hosted behind an MCP `stdio` transport, because MCP stdio uses the same stdin/stdout channels.

So:
- use this scaffold for manifest and tool registration now
- use the hosted Streamable HTTP transport for WorkIQ
- stdio remains fine for repo tools that do not need terminal-backed stdin

The runtime in `src/index.js` therefore refuses to load a manifest that declares `requiresTerminalStdin` when `--transport stdio` is selected.

## Manifest model

A manifest declares:
- server metadata
- tools
- handler IDs resolved by the runtime
- runtime hints such as `requiresTerminalStdin`

Example tool entry:

```json
{
  "name": "workiq.ask",
  "title": "Ask WorkIQ",
  "description": "Query Microsoft 365 through the WorkIQ CLI.",
  "handler": "workiq.ask",
  "runtime": {
    "requiresTerminalStdin": true,
    "recommendedTransport": "streamable-http"
  },
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string" },
      "timeoutMs": { "type": "integer", "minimum": 1000 }
    },
    "required": ["query"],
    "additionalProperties": false
  }
}
```

Example source definition shape for the executor:

```json
{
  "bindTo": "identity",
  "mcp": {
    "manifest": "demo-boards.workiq.json",
    "tool": "workiq.ask",
    "input": {
      "query": "Who am I in Microsoft 365?"
    }
  }
}
```

Example overriding the server per source for a remote MCP host:

```json
{
  "bindTo": "sentinel-alerts",
  "mcp": {
    "manifest": "sentinel.json",
    "tool": "sentinel.alerts.search",
    "server": {
      "transport": "streamable-http",
      "url": "https://sentinel.example.com/mcp"
    },
    "input": {
      "query": "high severity incidents for the last 24 hours"
    }
  }
}
```

## Commands

Install dependencies inside this folder:

```bash
cd demo-boards/mcp-server
npm install
```

Validate the current manifests without starting transport:

```bash
npm run dry-run -- --manifest manifests/demo-boards.workiq.json
```

Start the hosted MCP server for WorkIQ:

```bash
npm run start:http
```

That serves the demo WorkIQ manifest at `http://127.0.0.1:7823/mcp` by default.

Start a stdio MCP server for non-TTY tools:

```bash
npm run start:stdio -- --manifest manifests/your-non-tty-tools.json
```

That will intentionally fail if the selected manifest declares `requiresTerminalStdin`.

## Next steps

1. Add per-repo manifests for `fintech/data-repos/*` tools such as export/query/report.
2. Decide whether local development runs one combined server instance or one process per repo/tool boundary.
3. Add manifest-to-schema conversion if you want MCP-side input validation from JSON Schema rather than handler-level validation.
