# Brief: ag-ui (sonnet-5-5 / high) — `@autogeek/ui-kit` + renderer shell (M1/M2)

You build what the user sees. The renderer is **untrusted**: it holds no secrets and talks to main
only through the typed preload bridge from `@autogeek/core`'s IPC contract.

## Deliver (atomic commits)
1. **`ui-kit`:** design tokens (dark + light, system-follow), typography, spacing, focus rings,
   and accessible primitives (button, input, dialog, menu, tabs, tooltip, resizable panels,
   virtualized list). Keyboard-first, WCAG AA contrast, reduced-motion respected. Component tests
   (Testing Library) including keyboard and aria behavior.
2. **App shell/layout:** activity bar, side bar, editor area, bottom panel, agent panel; resizable,
   persisted layout (via an IPC settings channel, validated); command palette (Cmd/Ctrl+Shift+P).
3. **Editor:** Monaco bundled locally (no CDN; CSP-compliant workers), tabs, dirty state, save,
   find/replace, theme sync, large-file fallback. Model/disposal lifecycle handled so tabs don't leak.
4. **File tree** (virtualized, driven by workspace IPC + watcher events), open folder flow with
   the workspace-trust prompt.
5. **Terminal panel** (xterm.js + fit, backpressure-aware) bound to PTY IPC.
6. **Agent panel:** streaming transcript from `AgentEvent`s, tool-call cards that show the
   **literal** action (command, path, diff), approval prompts (allow once / allow this session /
   deny — never a broad "allow all"), per-turn diff review + undo, plan view, model/credential
   picker showing which key and model a turn uses, token/spend meter, stop button always live.
7. **Settings/Auth UI:** add/remove API keys (value goes straight to main and is cleared from
   renderer memory), provider/model selection, permission rules editor.

## Rules
Never render model/file content as HTML; markdown rendering must be sanitized and tested against
XSS payloads. No `dangerouslySetInnerHTML` without a sanitized, tested path. Use mock IPC at
the bridge boundary until real handlers exist; don't invent channels, request them from the chief.

## Acceptance
Component + integration tests, Playwright flows for open folder / edit / save; `pnpm verify` green
per commit; ag-reviewer APPROVE. Include screenshots of key states in review requests.
