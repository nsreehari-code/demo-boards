# demo-boards/mcp-server

Manifest-driven MCP server scaffold for `demo-boards` and adjacent repo-backed tool surfaces.

## Why this shape

Use one shared MCP server codebase with multiple manifests, not one custom server per feature.

That gives you:
- one runtime for tool registration, auth checks, error formatting, and transport wiring
- one manifest format for `demo-boards` tools and other repo-owned tool surfaces
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

## Copilot CLI tools

The server can also expose local GitHub Copilot CLI tools for custom agents defined in project or
user agent directories.

Current first-pass tools:
- `copilot.check_environment` — verify that `copilot` is installed and report discovered local agents
- `copilot.list_agents` — enumerate local custom agents from `.github/agents` and `~/.copilot/agents`
- `copilot.list_source_roots` — show extra configured source directory roots used for agent discovery
- `copilot.upsert_source_root` — add or update one extra source directory root used for agent discovery
- `copilot.remove_source_root` — remove one configured extra source directory root by id
- `copilot.run_agent` — run Copilot with either:
  - direct custom-agent selection via `--agent <name>`; or
  - prompt-based agent targeting when you choose `invocationMode: "prompt"`
  - native session control through `continueSession`, `sessionId`, `resumeSession`, and `sessionName`
  - initial file attachments, model selection, reasoning effort, working-directory access, and timeout control
  - synchronous completion or process-owned async execution through `runMode`
- `copilot.list_runs` — list async Copilot runs started by this MCP server process
- `copilot.get_run` — inspect a previously started async run, including accumulated stdout/stderr
- `copilot.cancel_run` — terminate a running Copilot process by run id

The installed CLI currently advertises `--agent`, `--continue`, and `--session-id`, but does **not**
advertise a dedicated stop/cancel command. The MCP host now owns async child processes itself, so
`copilot.run_agent` can be used with `runMode: "async"` and later managed through the run lifecycle
tools above. Async run records are process-local and are cleared when the MCP server restarts.

Configured extra source roots are stored in the managed Lore truthset under the app-scoped Lore
namespace `app/copilot-c2` using the key `source-roots`. Each root can point at either a repository root or a direct
`.github/agents` directory. Discovery still includes the default workspace `.github/agents`, the
nearest project `.github/agents` for the requested `cwd`, and the MCP server user's
`~/.copilot/agents`.

Session selectors are mutually exclusive. Use `continueSession` for the most recent session,
`sessionId` to create or resume a UUID-backed session, or `resumeSession` to resume by ID, prefix,
task ID, or exact session name. Bare `--resume` is not exposed because its interactive picker is not
appropriate for the hosted MCP transport.

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
npm run dry-run -- --manifest ../mcp-server-managed-truthsets/finbook/mcp-executable-manifest.json
```

For Finbook, the host should consume the repo-owned executable manifest from `mcp-server-managed-truthsets/finbook/mcp-executable-manifest.json` directly instead of maintaining a copied host-local manifest.

Start the hosted MCP server for WorkIQ:

```bash
npm run start:http
```

That serves the demo WorkIQ manifest at `http://127.0.0.1:7801/mcp` by default.

Start a stdio MCP server for non-TTY tools:

```bash
npm run start:stdio -- --manifest manifests/your-non-tty-tools.json
```

That will intentionally fail if the selected manifest declares `requiresTerminalStdin`.

## Sentinel auth troubleshooting

If Sentinel cards/tools fail with tenant or token errors:
- Confirm `SENTINEL_TENANT_ID` in `mcp-server/.env` matches the tenant you expect.
- Run `npm run smoke:sentinel:tenant` from `mcp-server/` to verify Azure CLI account context and Sentinel token mint.
- If the check fails due to stale or wrong login, run `npm run smoke:sentinel:tenant -- --login` and complete the browser prompt for the target tenant.
- If you still see `AADSTS500213`, your signed-in identity is blocked by cross-tenant policy in that tenant; use an allowed account.

From `demo-boards-ns-code/` root, the same check is available as:

```bash
npm run mcp:sentinel:tenant-check
```

## Next steps

1. Add more repo-owned executable manifests for other local tool surfaces.
2. Decide whether local development runs one combined server instance or one process per repo/tool boundary.
3. Add manifest-to-schema conversion if you want MCP-side input validation from JSON Schema rather than handler-level validation.
