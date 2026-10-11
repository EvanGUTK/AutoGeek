# Brief: ag-mcp (opus-5-5 / high) — `@autogeek/mcp` (M4, wave 3)

You make AutoGeek an MCP client host. Servers are third-party code: treat all of their output as
untrusted data.

## Deliver (atomic commits)
1. **Transports:** stdio (spawn with scrubbed env + explicit allowlisted vars, cwd pinned, process-
   group kill, stderr captured and bounded) and streamable HTTP (+ SSE fallback where required),
   per the current MCP spec — read the spec and the official SDK's installed types; decide
   (with the chief) whether to wrap the official SDK or implement the protocol directly, and
   record it in `docs/DECISIONS.md`.
2. **Lifecycle:** initialize/capability negotiation, ping/health, reconnect with backoff, clean
   shutdown, per-server isolation (one server crashing never affects others), AbortSignal everywhere.
3. **Tool bridge:** MCP tools exposed as core `Tool`s (name-spaced `mcp__server__tool`), JSON-Schema
   → zod validation of inputs and of results, risk classified `exec`/`network` by default, always
   through the `PermissionGate`. Tool-list changes (`listChanged`) handled live.
4. **Resources & prompts** bridged for @-mentions and slash commands; result size caps with
   explicit truncation markers.
5. **OAuth for remote servers** reusing the `@autogeek/auth` PKCE engine (inject; do not copy).
6. **Config:** user + project `mcp.json`, zod-validated; project-level servers require explicit
   workspace-trust approval before first spawn; show the exact command to be run.
7. **Conformance tests** against an in-repo reference server (stdio + HTTP): hang, crash, huge
   output, malformed JSON-RPC, duplicate tool names, hostile tool descriptions (must not alter
   permissions).

## Acceptance
`pnpm verify` green per commit; ag-reviewer APPROVE. Start only after M3's gate is merged.
