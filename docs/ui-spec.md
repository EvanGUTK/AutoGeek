# UI Spec — `@autogeek/ui-kit` and renderer shell

Owner: ag-ui. Companion to `docs/briefs/ui.md`. This is a design specification, not an
implementation: no code exists until `ag-foundation` lands on `main`. Where this spec and
`ARCHITECTURE.md` disagree, `ARCHITECTURE.md` wins and the disagreement goes to the chief.

Scope: (1) design tokens, (2) primitive component accessibility and keyboard behavior,
(3) the agent approval-prompt UX. Anything that needs a new IPC channel or a change to a
`@autogeek/core` contract is listed in [Open questions](#6-open-questions-for-the-chief), not
assumed.

## 1. Ground rules

- The renderer is untrusted and holds no secrets (`ARCHITECTURE.md` §3, §8). UI state is
  display state only; every security decision is made in main. That is a design posture: while one
  renderer shows model output and calls privileged channels, its integrity matters. §6 states the
  hardening and the residual risk (D-010).
- Model output, tool output, file contents, file names and terminal output are **untrusted
  strings**. They are rendered as React text nodes. No `dangerouslySetInnerHTML` anywhere. The
  one rich-text path is `SafeMarkdown` (§6.1).
- Keyboard-first: every interactive element is reachable and operable without a pointer.
  Pointer-only affordances are always duplicates of a keyboard path.
- WCAG 2.2 AA is the floor: 1.4.3 text contrast (4.5:1, 3:1 for large text), 1.4.11 non-text
  contrast (3:1), 2.4.7/2.4.11 focus visible and not obscured, 2.5.8 target size (≥ 24×24 CSS px).
- `prefers-reduced-motion`, `prefers-color-scheme`, `prefers-contrast` and `forced-colors` are
  honored. Color is never the only carrier of meaning (status, diff, risk all carry text or glyphs).

## 2. Design tokens

Tokens are the single source of truth, authored as a typed TypeScript object in `ui-kit`,
emitted as CSS custom properties (`--ag-*`) on `:root[data-theme="dark"|"light"]`. Components
consume only custom properties, never literal values. Monaco's theme is derived from the same
object so editor and chrome cannot drift (brief item 3, "theme sync").

### 2.1 Theme selection

| Setting | Behavior |
|---|---|
| `system` (default) | Follows `prefers-color-scheme`, updates live on change |
| `dark` / `light` | Explicit override, persisted through the validated settings channel |

`data-theme` is set on `<html>` before first paint. An inline script in `index.html` is blocked by the
strict CSP, so main passes the validated initial theme through `webPreferences.additionalArguments`;
the sandboxed preload reads it from `process.argv`, re-validates it against the theme enum, and
exposes it as a synchronous bridge value (`docs/ipc-channels.md` §9.6). If that route proves
infeasible, the stylesheet follows `@media (prefers-color-scheme)` and the attribute only
overrides. `color-scheme` is set to match so native scrollbars and form controls follow.

### 2.2 Color

Hex values are the proposal; the **contrast column is measured** with the WCAG 2.x relative-luminance
formula against every surface the foreground can sit on, and the minimum is shown. The `ui-kit`
test suite recomputes these from the token source and fails the build below the stated floor, so
the table cannot rot.

**Surfaces**

| Token | Dark | Light | Use |
|---|---|---|---|
| `--ag-bg` | `#14161a` | `#ffffff` | App background, editor gutter |
| `--ag-surface` | `#1b1e24` | `#f5f6f8` | Side bar, panels, status bar |
| `--ag-raised` | `#232730` | `#ffffff` | Cards, inputs, tab strip |
| `--ag-overlay` | `#2a2f3a` | `#ffffff` | Menus, dialogs, tooltips, command palette |
| `--ag-selected` | `#243049` | `#d6e4fb` | Selected row / active item background (also carries a 2px leading `--ag-accent` bar, so selection is not shown by fill alone) |

**Foreground** (floor 4.5:1 on all five surfaces, selected included)

| Token | Dark | Light | Min contrast (dark / light) | Use |
|---|---|---|---|---|
| `--ag-text` | `#e6e8ee` | `#1a1d24` | 10.75 / 13.13 | Body text |
| `--ag-text-muted` | `#a3a9b8` | `#4a5163` | 5.60 / 6.17 | Secondary text, labels |
| `--ag-text-subtle` | `#9199aa` | `#5c6477` | 4.61 / 4.61 | Placeholders, hints, disabled-adjacent metadata |
| `--ag-accent` | `#6ea8ff` | `#0a5bd6` | 5.46 / 4.70 | Links, active indicators |
| `--ag-danger` | `#ff8a80` | `#b3261e` | 5.77 / 5.09 | Errors, destructive, deny |
| `--ag-warning` | `#f2c264` | `#8a5a00` | 7.95 / 4.61 | Cautions, write/exec risk |
| `--ag-success` | `#6fd39a` | `#1b6e3f` | 7.19 / 4.88 | Success, added lines |
| `--ag-info` | `#7cc4ff` | `#0b5f99` | 7.02 / 5.26 | Informational |
| `--ag-on-accent` | `#0b1220` | `#ffffff` | 7.76 / 6.03 on `--ag-accent` fill | Text on filled accent buttons |

Disabled controls are exempt from contrast requirements by WCAG, but they still keep a legible
shape: disabled uses `--ag-text-subtle` at the same contrast as above plus a non-color cue
(dashed or absent border, `cursor: not-allowed`), not reduced opacity alone.

**Lines and focus** (floor 3:1 where the line identifies a control)

| Token | Dark | Light | Contrast | Use |
|---|---|---|---|---|
| `--ag-border` | `#3a4050` | `#d5d9e2` | decorative, no floor | Dividers, panel separators at rest |
| `--ag-border-strong` | `#7a8296` | `#767d90` | ≥ 3.43 / ≥ 3.20 | Input, button, checkbox boundaries, and icons inside selected rows (1.4.11) |
| `--ag-focus` | `#8ab8ff` | `#0a5bd6` | ≥ 6.51 / ≥ 4.70 | Focus ring |

State layering (hover, pressed) is expressed as a tint of `--ag-text` at 8% / 14% over the base
surface, so it works on every surface without per-surface tokens. A tint lowers the contrast of
foregrounds that sit on it (measured: dark `--ag-text-subtle` on a pressed selected row falls to
3.11, light `--ag-warning` to 3.51, `--ag-border-strong` to 2.31 / 2.44). So in **hover, pressed and
selected+hover states**:

- `--ag-text-muted`, `--ag-text-subtle` and `--ag-accent` text resolve to `--ag-text`;
- the status colors and `--ag-border-strong` resolve to **state variants**, measured as the worst
  case over all five surfaces × rest, hover and pressed:

| Token | Dark | Light | Min contrast (dark / light) | Floor |
|---|---|---|---|---|
| `--ag-danger-state` | `#ffa49c` | `#9e211a` | 4.68 / 4.63 | 4.5 |
| `--ag-warning-state` | `#f2c264` | `#714a00` | 5.37 / 4.64 | 4.5 |
| `--ag-success-state` | `#6fd39a` | `#175c35` | 4.86 / 4.75 | 4.5 |
| `--ag-info-state` | `#7cc4ff` | `#0a5487` | 4.74 / 4.73 | 4.5 |
| `--ag-border-strong-state` | `#9299a9` | `#656c7c` | 3.12 / 3.12 | 3.0 |

A pressed Deny button in danger text therefore uses `--ag-danger-state`. The variants are
chosen with a 0.1 margin over the floor. The `ui-kit` token test builds every surface × state
(rest, hover, pressed) × foreground combination from the token source and fails the build below the
floor, so these tables cannot rot. Accent-filled buttons hover to
`#8ab8ff` (dark, 9.26 with on-accent) and `#084bb0` (light, 7.94 with on-accent).

**Diff and risk** never rely on color alone: added lines carry `+` and `--ag-success`, removed
carry `−` and `--ag-danger`, and risk badges carry a text label (`READ`, `WRITE`, `EXEC`,
`NETWORK`) alongside `--ag-info` / `--ag-warning` / `--ag-danger`.

**High contrast.** Under `forced-colors: active` components fall back to system colors
(`CanvasText`, `Canvas`, `Highlight`, `ButtonText`, `LinkText`), borders become real borders (not
shadows), and focus uses `outline` with `Highlight`. Under `prefers-contrast: more`, `--ag-border`
resolves to `--ag-border-strong` and muted/subtle text resolves to `--ag-text`.

### 2.3 Typography

| Token | Value |
|---|---|
| `--ag-font-ui` | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| `--ag-font-mono` | `ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` |

No web fonts and no font CDN (CSP, offline-first). The editor font is a user setting that defaults
to `--ag-font-mono`.

| Step | Size / line-height | Weight | Use |
|---|---|---|---|
| `xs` | 12 / 16 | 400 | Metadata, badges, status bar |
| `sm` | 13 / 20 | 400 | **Default UI text** |
| `md` | 14 / 20 | 400, 600 | Dialog body, transcript |
| `lg` | 16 / 24 | 600 | Dialog titles, section headings |
| `xl` | 20 / 28 | 600 | Settings page titles |
| `mono-sm` | 12 / 18 | 400 | Tool-call cards, terminal chrome |
| `mono-md` | 13 / 20 | 400 | Approval-prompt literal action |

Sizes are `rem`-based against a 16px root so browser/OS text scaling and the app's zoom
(Cmd/Ctrl +/−) work. Layouts must survive 200% zoom without clipping or two-axis scroll in
dialogs and panels (1.4.4, 1.4.10).

### 2.4 Spacing, shape, elevation

- **Spacing** (4px base): `0, 2, 4, 8, 12, 16, 24, 32, 48` as `--ag-space-0 … --ag-space-8`.
- **Hit targets:** default control height 28px, compact 24px (the floor), dense lists use a 24px row
  with the full row clickable. Icon-only controls are at least 24×24 with at least 24px between
  adjacent targets or are themselves ≥ 24.
- **Radius:** `--ag-radius-sm` 2, `--ag-radius-md` 4, `--ag-radius-lg` 8, `--ag-radius-full`.
- **Elevation:** a step is a surface token plus a 1px `--ag-border`, with a shadow only on
  `--ag-overlay` (`0 8px 24px rgb(0 0 0 / 0.35)` dark, `/ 0.16` light). Shadows are never the sole
  boundary (forced-colors removes them).
- **Layers (z-index):** `base 0`, `panel 10`, `sticky 20`, `overlay 30` (menus, tooltips),
  `modal 40`, `toast 50`. Defined as tokens; no ad-hoc z-index in components.

### 2.5 Motion

| Token | Value |
|---|---|
| `--ag-dur-fast` / `base` / `slow` | 100ms / 160ms / 240ms |
| `--ag-ease` | `cubic-bezier(0.2, 0, 0, 1)` |

Motion is limited to opacity and short (≤ 8px) translate on overlays, and panel-collapse width
transitions. Under `prefers-reduced-motion: reduce` all durations resolve to 0 and transforms are
dropped; JS-driven animation checks `matchMedia` and the setting changes live. Nothing flashes more
than 3 times per second. Streaming text is appended without animation.

### 2.6 Focus ring

One definition, used by every focusable element via `:focus-visible` (never bare `:focus`, and never
`outline: none` without a replacement):

```
outline: 2px solid var(--ag-focus);
outline-offset: 2px;
```

Inside clipped or dense containers (tab strip, tree rows, menu items) where an offset ring would be
cut off, the ring is inset (`outline-offset: -2px`). A focused element is never fully covered by a
sticky header or panel (2.4.11); scroll containers use `scroll-padding` to guarantee it.

## 3. Primitive components

Conventions for all primitives: controlled and uncontrolled variants where meaningful; `ref`
forwarding; props are typed so accessibility requirements are compile-time where possible (an
icon-only `Button` requires `aria-label`; a `Dialog` requires a title; an `Input` requires a label
or `aria-label`). Each row below becomes a Testing Library test, using `userEvent` keyboard
simulation, and asserts roles and aria attributes, not class names.

### 3.1 Button

- Native `<button type="button">` (default type is explicit, never implicit submit). Variants:
  `primary`, `secondary`, `ghost`, `danger`. Sizes: `default` 28px, `compact` 24px.
- Keys: `Enter` and `Space` activate (native). No custom key handling.
- `loading`: sets `aria-busy="true"`, keeps focus and layout width, ignores activation, shows a
  text-bearing busy state (spinner is `aria-hidden`; the label is retained or replaced by visible
  text such as "Saving…", which is announced).
- `disabled`: native `disabled` by default. If a tooltip must explain why, `aria-disabled="true"` is
  used instead so the control stays focusable; activation is blocked in the handler.
- Toggle buttons use `aria-pressed`. Destructive buttons never take the default-focus slot in a
  dialog (see §3.3, §5).

### 3.2 Input (text, search, secret)

- Native `<input>`/`<textarea>` inside a `Field` that wires `<label for>`, hint and error via
  `aria-describedby`; invalid sets `aria-invalid="true"` and the error text is also rendered (not
  color alone), announced via `role="alert"` on first appearance only.
- Placeholder is never the label. Required fields use `aria-required` and a visible marker with a
  text legend.
- Keys: native text editing; `Escape` clears only in the `search` variant; `Enter` submits only if
  the parent form handles it.
- **`SecretInput`** (API keys, settings): `type="password"`, `autocomplete="off"`,
  `autocapitalize="off"`, `spellcheck="false"`, no reveal toggle, no clipboard-copy affordance, not
  restored by any persistence layer. It is **uncontrolled**: the key never enters React state, and the
  consumer reads it once through a ref at submit. `clear()` empties the DOM value and the consumer
  drops its references right after dispatching to the bridge (brief item 7). A JavaScript string
  cannot be zeroed, so this limits exposure and does not erase; the vault is in main. Tests assert
  the value is absent from component state, props and the rendered DOM after submit.

### 3.3 Dialog

- `role="dialog"` (or `alertdialog` for approvals/destructive confirms) with `aria-modal="true"`,
  `aria-labelledby` (required title) and `aria-describedby` (body).
- Focus: on open, move to the first element specified by `initialFocus` (default: the dialog
  container's first focusable; for `alertdialog`, the **safe/cancel** action). Focus is trapped
  (`Tab`/`Shift+Tab` cycle). Background content is `inert`. On close, focus returns to the
  invoking element, or to a provided fallback if that element was removed.
- Keys: `Escape` closes (maps to the cancel action; `alertdialog` Escape = deny/cancel, never
  confirm). `Enter` activates the focused button only; it is not a global "confirm".
- Body scroll is locked; the dialog scrolls internally when taller than the viewport. Minimum width
  survives 200% zoom. Backdrop click closes non-destructive dialogs only.
- Nested dialogs stack, each with its own trap; closing the inner restores focus into the outer.

### 3.4 Menu (dropdown, context menu)

- Trigger: `aria-haspopup="menu"`, `aria-expanded`, `aria-controls`. Popup: `role="menu"`; items
  `role="menuitem"`, `menuitemcheckbox`, `menuitemradio` (with `aria-checked`); groups use
  `role="group"` with a label; separators `role="separator"`.
- Focus is roving: opening focuses the first enabled item (via `ArrowDown`/`Enter`/`Space` on the
  trigger) or the last (`ArrowUp`).
- Keys: `ArrowDown/Up` move (wrapping), `Home/End` first/last, typeahead jumps to the next item
  whose label starts with the typed characters (reset after 500ms), `Enter`/`Space` activate and
  close (checkbox/radio items keep the menu open only if `closeOnSelect={false}`),
  `ArrowRight` opens a submenu and `ArrowLeft`/`Escape` closes it, `Escape` closes and returns focus
  to the trigger, `Tab` closes without moving focus out of order. Disabled items are skipped by
  arrow keys but remain in the accessibility tree (`aria-disabled`).
- Context menus open on right-click, the `ContextMenu` key, and `Shift+F10`, positioned at the
  pointer or the focused element. Positioning flips/shifts to remain within the viewport.
- Shortcut hints are rendered with `aria-keyshortcuts` and platform-correct glyphs (⌘ on macOS,
  `Ctrl` elsewhere).

### 3.5 Tabs

Two variants share one implementation.

- Structure: `role="tablist"` (with `aria-orientation`), `role="tab"` with `aria-selected`,
  `aria-controls`, and `role="tabpanel"` with `aria-labelledby`. Only the selected tab has
  `tabindex="0"`; others `-1` (roving). Inactive panels are unmounted or `hidden`, per consumer.
- **Automatic activation** (settings, bottom-panel tabs): arrow keys move focus and select.
- **Manual activation** (editor tabs, because selecting loads a Monaco model): arrow keys move focus
  only; `Enter`/`Space` selects.
- Keys (both): `ArrowLeft/Right` (`Up/Down` if vertical), wrapping; `Home/End`; `Delete` (and
  `Cmd/Ctrl+W` at the app level) requests close of a closable tab. Middle-click closes. After close,
  focus moves to the neighbor, not to `body`.
- Editor-tab extras: a dirty marker is exposed in the accessible name ("`main.ts`, unsaved") and
  visually as a dot **plus** a distinct close-button glyph, not color alone. Overflow scrolls
  horizontally with the active tab scrolled into view and an overflow menu listing all tabs.
  Drag-reorder has a keyboard equivalent: `Alt+Shift+Arrow` moves the focused tab, announced via a
  polite live region.

### 3.6 Tooltip

- Describes, never labels critical content: tooltip text is supplementary. The trigger keeps its own
  accessible name; the tooltip is linked via `aria-describedby`, `role="tooltip"`.
- Opens on pointer hover (300ms delay, instant when another tooltip was open ≤ 500ms ago) and on
  keyboard focus (no delay, `:focus-visible` only). Closes on blur, pointer leave, scroll, and
  `Escape` (without moving focus or closing a parent dialog: the key is consumed only while a tooltip
  is open).
- Hoverable and persistent: the pointer can move onto the tooltip without it vanishing (1.4.13).
  Never contains interactive content. Touch is not a target platform; no long-press behavior.

### 3.7 Resizable panels

- Splitter is `role="separator"` with `tabindex="0"`, `aria-orientation`, `aria-valuenow`,
  `aria-valuemin`, `aria-valuemax` (percent of the container), `aria-controls` (the primary pane),
  and an accessible name ("Resize side bar").
- Pointer: drag using Pointer Events with pointer capture (works across iframes/webviews such as the
  Monaco area, and releases on `pointercancel`); double-click toggles collapse.
- Keys: `ArrowLeft/Right` (or `Up/Down`) resize by 16px, `Shift+Arrow` by 64px, `Home/End` to
  min/max, `Enter` toggles collapse/restore the last size. Changes are announced through the value
  attributes (no extra live region).
- Constraints: every pane declares `min` and `max`; the layout engine redistributes on window resize
  and never produces a pane below `min`. Collapsed panes are removed from the tab order (`inert`),
  with their activity-bar button exposing `aria-expanded`.
- Persistence: layout (sizes, collapsed flags, active views) is written through the settings IPC
  channel, validated with zod on read, falling back to defaults on any parse failure (never throws on
  a bad stored layout). Writes are debounced and not issued during drag.

### 3.8 Virtualized list

The foundation for the file tree, transcript, command-palette results and the diff file list.

- Renders only visible rows plus an overscan buffer; total height comes from a measured/estimated
  row-height model with a stable scroll position when items prepend/append (transcript tails).
- Semantics: `role="listbox"` (or `tree`/`treeitem` for the file tree, a thin layer over this
  primitive) with `aria-setsize` and `aria-posinset` on each rendered row, so assistive tech reports
  "3 of 12,000" although only ~40 rows are in the DOM. Multi-select lists set
  `aria-multiselectable`.
- Focus model: `aria-activedescendant` on the container for large lists (focus stays put while the
  scroll window changes); the active row is always scrolled into view and is rendered even if it
  leaves the window, so the reference never dangles.
- Keys: `ArrowUp/Down`, `Home/End`, `PageUp/PageDown` (one viewport), typeahead (reset 500ms),
  `Space` selects/toggles, `Enter` activates, `Shift+Arrow` extends and `Cmd/Ctrl+A` selects all in
  multi-select. Tree extras (file tree): `ArrowRight` expands or moves to the first child,
  `ArrowLeft` collapses or moves to the parent, `*` expands siblings.
- Performance contract (tested): a 100,000-row list mounts a constant number of nodes and scrolls
  without per-row React work outside the window; row components are memoized on stable identity.

### 3.9 Shell landmarks and global keys (consumers of the above)

| Region | Role / name |
|---|---|
| Activity bar | `role="toolbar"`, vertical, "Views"; roving focus; buttons expose `aria-pressed`/`aria-expanded` |
| Side bar | `role="complementary"` (named by the active view) |
| Editor area | `role="main"` |
| Bottom panel | `role="region"`, "Panel" |
| Agent panel | `role="complementary"`, "Agent" |
| Status bar | `role="contentinfo"`/`status` as appropriate |

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl+Shift+P` | Command palette (a `Dialog` hosting a `combobox` + virtualized `listbox`) |
| `F6` / `Shift+F6` | Cycle focus between landmarks; each landmark shows a visible focus ring on its container |
| `Cmd/Ctrl+B` | Toggle side bar |
| `Cmd/Ctrl+J` | Toggle bottom panel |
| `Cmd/Ctrl+S` | Save active editor |
| `Escape` (agent panel focused or a run active) | Never starts a run or approves anything; used only to dismiss UI |
| `Cmd/Ctrl+Shift+Backspace` | Stop the active run (proposed; ag-agent to confirm no collision). Always bound and enabled while a run is active. The Stop button is also always visible. Never `Ctrl+C`: with the terminal focused, `Ctrl+C` always goes to the PTY, and the terminal's key handler passes through only registered app chords |

Shortcuts are registered through one typed registry that detects conflicts in tests and exposes the
list in the command palette. No shortcut may be required to be pressed in a text-entry context
without a modifier.

## 4. Agent panel

The shapes the panel renders are defined once, in `docs/agent-contract.md` (`WireAgentEvent`,
`WireAction`, `WireMessage`, `WirePermissionRequest`, `ApprovalRequestedPayload`) and
`docs/ipc-channels.md`. This section is only the UI's rendering rules. Every switch over a union
(`event.type`, `action.kind`, `RunOutcome.reason`, `ToolOutcome.kind`, `DecisionVia`,
`ProviderErrorKind`, `AuthErrorCode`, warning codes) is exhaustive with a typed default, so a new
member is a compile error in the UI package, not a silent blank. All user-facing strings for these
live in one table in the UI, keyed by the code; no vendor or model text is ever used as a label.

### 4.1 Model and credential picker

Data comes from `auth.list` (`CredentialRef`: label, provider, kind), the provider catalog in
`core` (`displayName`, `authKinds`, `acquisition`), and `models.list` (`ModelInfo`,
`docs/model-contract.md` §5). The picker shows what is known and says so plainly when it is not:

- Capabilities (`tools`, `vision`, `reasoning`, `promptCaching`) are tri-state. `'unknown'` renders
  as "Unknown" with its own glyph and text, never as "No" and never as "Yes". A model whose `tools`
  is `'no'` is shown as unable to run in agent mode; `'unknown'` is selectable with a visible note.
- `contextWindow` and `maxOutputTokens` of `null` render "Unknown (AutoGeek assumes 8,192 / 4,096
  to stay safe)", matching `effectiveLimits`, not 0 or a blank.
- **Small windows are flagged.** Below `SMALL_CONTEXT_TOKENS = 32_768` the row shows a warning chip
  and, on selection, "Small context window (N tokens). Long conversations and large files will be
  compacted or cut early." The threshold is a judgment: the agent's input budget is the window minus
  the output reservation minus a 5% margin (`docs/agent-contract.md` §8), and the system prompt plus
  tool definitions already take several thousand tokens, so under about 32k there is little left for
  code. It is one constant, easy to revisit. For local servers (Ollama and similar) the real
  configured value is what `ModelInfo.contextWindow` reports, and the warning adds "Local servers
  may silently cut prompts that exceed their configured context length."
- `pricing` absent renders "Pricing unknown", and the spend meter for that model shows tokens only,
  with "cost unavailable" rather than a computed zero. `source: 'catalog' | 'default'` is labeled
  "estimated".
- **Endpoints.** The URL a provider sends your key and code to is security-critical, so it is not a
  setting in the renderer. Hosted providers (Anthropic, OpenAI, Google, OpenRouter) show their fixed
  catalog URL read-only (`baseUrl.editable: false`). Only OpenAI-compatible endpoints and the local
  servers (Ollama, LM Studio, llama.cpp) show an editable field. Editing calls `models.setBaseUrl`;
  **main** then shows a native confirmation, at the level it decides, that says the key and code
  will be sent to the *new* host (old → new, punycode visible, an extra warning for non-loopback
  `http:`). The UI only shows "Waiting for confirmation in the system dialog" and then the result:
  success refreshes the credential and the model list, `user_declined` leaves the URL unchanged (not
  an error), and `invalid_base_url` / `base_url_not_editable` get constant explanations (a URL with
  embedded credentials or an unsupported scheme is rejected). The UI never builds, substitutes or
  previews the dialog text. Creating a keyless connection to a non-loopback URL goes through the
  same confirmation in main.
- **Local server connection failures.** A failure (`ProviderErrorKind` `network` or `timeout` for a
  local provider) says to check that the server is running and that the port matches, because
  default ports differ by version (for example llama.cpp's). It does not guess a port.
- **Keyless providers.** The catalog's `acquisition` decides which credential step the provider
  shows. A provider that needs no key shows no key field and no "Add key" step, and its credential
  entry in the picker is a secretless record (`CredentialRef.kind: 'none'`) that is simply the
  server and its URL.
- The always-visible "which key and model is this turn using" indicator reads credential label,
  provider, and model id from `run_started.model` (the turn actually running), and it is the same
  data as the approval card's context line.

### 4.2 Run header and composer

- **Run header:** `provider · model · credential label`, the budget meters, and the **Stop** button.
  Stop is rendered outside any scrollable or collapsible region, is never disabled while a run is
  active, and is reachable by `F6` and `Cmd/Ctrl+Shift+Backspace`. It never intercepts `Ctrl+C`.
  Stopping resolves every pending approval for the run as stopped (`run_stopped`).
- **Budgets** (`run_started.budgets`, `usage.totals`): steps (`n / max`), tokens, spend, and elapsed
  time against `maxWallMs`. Spend reads `costUsdMicros`; `null` shows "cost unavailable" and the
  token cap remains the bound. A meter turns to the warning style at 80% and states the limit in
  words. **Pending approvals count against wall time**, so the approval card shows when the run will
  stop if left waiting ("This run stops at 14:32 even while waiting"), computed from the envelope
  `at` of `run_started` plus `maxWallMs`.
- **Composer:** the draft is kept while a run is active. While a run is active in the session,
  Send is replaced by Stop (`agent.send` would return `conflict: run_active`), which also covers a
  pending approval. Mode (`ask`/`plan`/`agent`) and the model selection are chosen per send and
  shown on the composer. In an untrusted folder the composer does not go dark: using it shows the
  trust prompt (§4.8) with the reason, because `agent.*` needs trust in every mode.
- **Settings the budgets read from** are user-adjustable; the key and who applies it are an open
  item (`docs/ipc-channels.md` §9).

### 4.3 Transcript and tool-call cards

- The transcript is an `aria-live="off"` region with a polite status line ("Run finished",
  "Awaiting approval") so screen-reader users are not flooded token by token.
- Deltas are previews. `assistant_message`, `user_message` and `tool_results` are the record of
  truth: when one arrives it replaces the streamed preview for that step. Events are applied
  idempotently by `seq` (anything at or below the last applied `seq` is ignored), so replay and live
  delivery can overlap safely.
- **User messages** show the typed `text` and `contextItems` as chips ("File: src/a.ts"). Expanded
  @-mention content never reaches the renderer.
- **Reasoning** is a collapsed disclosure. Empty text renders "Reasoning hidden".
- **Model text** goes through `SafeMarkdown` only (§6.1). Tool inputs and outputs, paths, commands
  and JSON are inert text through the display-safe function (§5.2), never markdown.
- **Tool-call cards** show tool name, risk badge, and the input verbatim as in §5.2. Input may be an
  object, `{ invalidRaw }` ("The model sent an invalid call", raw text shown inert, ≤ 4 KiB), or
  `{ omittedBytes }` ("Input too large to show, N bytes"). Image parts render only when the wire
  gives bytes; `image_omitted` shows the type and size. A card with an unresolved approval is never
  collapsed.
- **Card states** (one per `ToolOutcome` and lifecycle point), each with text, not color alone:

  | State | Source | Text |
  |---|---|---|
  | Awaiting approval | `approvalRequested` for the `callId`, unresolved | "Waiting for your decision" |
  | Running | `tool_started` | "Running", with elapsed time |
  | Done | `completed`, `isError: false` | "Done" (+ "Output truncated" if `truncated`) |
  | Failed | `completed`, `isError: true` | "The tool reported an error" |
  | Not run | `rejected` | reason table: unknown tool, not available in this mode, invalid input, malformed call, repeated call, "disabled for this session after a permission violation" |
  | Skipped | `skipped` | "Skipped: run stopped / budget reached / run failed" |
  | Interrupted | `interrupted` | "Stopped while running. It may have partly run; check your files." |

- **Decision rows** from `permission_decided` use an exhaustive `DecisionVia` table
  ("Allowed by a saved rule", "Allowed by your session approval", "Allowed: reading a non-sensitive
  file", "Denied by you", "Denied by policy: outside the workspace", "Denied: read-only mode", and so
  on). Policy denials are never presented as the user's choice.
- **Compaction** shows "Conversation compacted: N messages summarized (tokens before → after)" with
  the summary as an expandable `SafeMarkdown` block.
- **Warnings** (`spend_cap_unpriced`, `checkpoint_excluded_files`, `context_near_limit`,
  `reasoning_dropped`) render a constant string per code from the UI table; `warning.message` is not
  displayed.

### 4.4 Run outcomes

`run_finished.outcome` renders once at the end of the run. Error states persist on the run; they are
not toasts.

| `reason` | Presentation |
|---|---|
| `end_turn` | Nothing extra |
| `plan_submitted` | Plan view (§4.5) |
| `aborted` | "Stopped" |
| `budget` | "Stopped: step / token / time / spend budget reached", with the limit. Send a message to continue, or change the budget in Settings |
| `max_tokens` | "The model reached its output limit mid-answer" |
| `refusal` | "The model declined to continue" |
| `provider_error` | Exhaustive `ProviderErrorKind` table (auth, quota, rate limit, network, and so on) with a safe constant text. When `retryable` is true, "Try again" refills the composer and does not auto-send; `retryAfterMs` is shown as a wait hint. `requestId`, if present, is shown as a copyable "Support reference". Never vendor text |
| `loop_detected` | "Stopped: the agent kept repeating a call to `<tool>`" (tool name inert) |
| `invalid_tool_calls` | "Stopped: the model kept sending malformed tool calls" |
| `checkpoint_failed` | "File edits were refused because they could not be made undoable" |
| `gate_violation` | **Error state** (below) |
| `internal_error` | "Something went wrong in AutoGeek" with the `correlationId` as copyable text |

**Gate violation.** The tool `<tool>` completed without a recorded permission check
(`docs/agent-contract.md` §7). The state is an error, persistent on the run and on the tool card, not
dismissable, announced once with `role="alert"`: "Security: `<tool>` completed without a recorded
permission check. Its result was withheld and the tool is disabled for this session. Review your
files; this indicates a bug in AutoGeek." A "Copy details" action copies the run id, tool name and
timestamp only. Later calls to that tool show "disabled for this session".

### 4.5 Plan view

`plan_proposed` shows `summary` and ordered `steps` (title, detail, files) as inert text; `files` are
root-relative paths shown as text, with an "Open" action that calls `workspace.readFile` only after
the UI checks the path has no `..`, is not absolute and contains no NUL. The plan is read-only in
v1. **"Proceed with this plan"** sends `agent.send` in mode `agent` on the same session with a
fixed UI-owned string; the session transcript already holds the plan. **"Ask for changes"** focuses
the composer. Proceed is unavailable in an untrusted workspace, with the reason stated.

### 4.6 Undo

A user message whose run made writes offers **"Restore to before this message"**. It hides when the
run made no writes (`agent.undoRun` returns `not_found`).

1. The action calls `agent.undoRun { dryRun: true }`.
2. An `alertdialog` (initial focus on **Cancel**) lists the files that will be restored, then the
   later messages whose changes will also be reverted ("This also undoes the changes from 2 later
   messages"), then any conflicts (files changed outside the agent since the snapshot).
3. With conflicts, the default action is still Cancel. A separate, not-default, destructive button
   "Overwrite these N files" is the only way to send `force: true`.
4. The dialog states that the workspace goes back to how it was before that message, that the
   conversation is cut at that message, and that this cannot be redone from AutoGeek yet.
5. `conflict: run_active` disables the action with the reason "A run is active".
6. On success the transcript is cut at that message locally, and the undone runs are hidden by the
   `undone` flag on `agent.listRuns`, so a reload does not bring them back
   (`docs/agent-contract.md` §11).

"Review changes" for a run uses `agent.getRunDiff`: a virtualized file list (operation including
`rename` with `from`; binary files labeled "Binary file"; `diffOmitted` shows path and size only)
with the diff for the selected file.

### 4.7 Settings: permission rules and session approvals

- **Session approvals** (`permissions.listSessionApprovals`) show each grant as its literal action
  (same renderer as §5.2) with **Revoke**. Revocation is immediate.
- **Saved rules** (`permissions.listRules`, scope badge global/root) are created from a structured
  form per `match.kind`, never from free text interpreted as a pattern: exact path, path glob,
  exact argv, argv prefix, exact shell string, exact URL, MCP server/tool/input. A rule of kind
  `argv`, `argv_prefix` or `shell` never matches a request that carries env overrides, and the form
  says so. The `any` match is
  offered only for `deny` and `ask`. The form states what the contract guarantees: a broad allow
  never silently auto-allows a sensitive or otherwise elevated action; those still ask.
- **Adding an `allow` rule** calls `permissions.addRule`; main shows its own native confirmation that
  renders the rule literally (for `argv_prefix`: "Allow any command beginning with: …"; for MCP
  without `input`: "Allow ⟨server⟩/⟨tool⟩ with ANY input"). The form shows the same wording beforehand
  so the dialog is no surprise. `user_declined` leaves the list unchanged and is reported neutrally
  ("Not added"), not as an error. Deny and ask rules are added without a dialog.
- A prompt never creates a saved rule (§5.4); this editor is the only way.

### 4.8 Open folder and workspace trust

Opening a folder calls `workspace.openFolder`; main shows the native folder dialog. A new folder is
untrusted ("Restricted mode"). In Restricted mode, listing, reading and editing files work
(`workspace.listDir`, `readFile`, `writeFile`, with the usual containment and protected-path rules),
while `git.*`, `terminal.*` and `agent.*` need trust (`untrusted_workspace`). A persistent
"Restricted mode" indicator in the status bar opens the same trust prompt when activated.

**Features that need trust are never silently disabled.** The controls stay enabled and visible; using
one (the terminal panel or its shortcut, the source-control view, the agent composer in any mode,
the command palette entries) shows the **trust prompt** in place of the feature, and moves focus to
it because the user just asked for something. It is a panel, not an error toast, and it says why for
that feature:

| Feature | Reason shown |
|---|---|
| Terminal | "The terminal runs programs from this folder's environment." |
| Source control | "A repository's own configuration can make git run programs." |
| Agent (ask, plan, agent) | "The agent reads files, edits them and runs commands in this folder." |

The prompt also states what trusting enables, that a folder from an untrusted source can contain
programs and configuration that run when these features are used, and that the user can keep
editing files without trusting. It has two actions: **Trust this folder…** and **Stay in Restricted
mode**. Trusting calls `workspace.setTrust` with `true`; **main** then shows a native confirmation
built from its own data (the folder name and path, display-safe). `user_declined` leaves the folder
untrusted and is not an error; the UI shows the prompt again only when the user next asks for a
feature. `too_long` (a path too long for the dialog) is explained in words. Revoking trust takes
effect at once and the session approvals for that root are cleared (`docs/agent-contract.md` §2);
the UI refreshes from events, not by guessing.

Tests: each of the three features, invoked by pointer, by keyboard shortcut and from the command
palette in an untrusted folder, shows its own reason and never an empty or inert control; the file
tree and editor keep working; declining the native confirmation leaves the folder untrusted; trust
granted from one entry point enables all three without a reload.

## 5. Approval-prompt UX

Goal: the human approves **the thing that will actually happen**, in a form the model cannot
dress up, with no path to blanket permission. This is UI only: the decision is returned to main,
which enforces it through the permission gate, and the renderer cannot widen what it is offered.
It protects a person from a mistake; it does not defend against script running in a compromised
renderer (§6.2).

### 5.1 Principles

1. **Show the literal action, not model prose.** What is displayed is derived from the structured
   `WireAction` main sent, never from a free-form model message. `renderLiteral` text is a
   fallback, not the primary view.
2. **The renderer displays; main decides.** The set of buttons is exactly `offered`. The UI cannot
   add an option.
3. **Never allow-all.** There is no "always allow", "allow all", "don't ask again for this tool",
   "allow for this workspace", or wildcard/pattern grant in the UI. See §5.4.
4. **Deny is the default and the easy path.** Default focus, `Escape` and the Deny button resolve
   to deny with no delay. When the window is destroyed or crashes, **main** denies and aborts; the
   renderer cannot be relied on to do anything after a crash.
5. **No time pressure toward yes.** There is no approval timeout and no countdown, ever. Wall-time
   budgets bound the wait, and the card says when the run will stop (§4.2).

### 5.2 What is shown

A prompt is one card (the **approval dock**, §5.5) containing, top to bottom:

1. **Header:** "Approval needed", the risk badge (`READ`/`WRITE`/`EXEC`/`NETWORK` text label from
   `request.risk`), the context line `tool · provider · model · credential label` (from
   `context`) so the user can see which turn and key this is attributed to, and "1 of N" when more
   than one approval is pending in this window. A line and character count of the action is shown
   in the action header.
2. **The action**, by `action.kind`, in `--ag-font-mono` / `mono-md`, in a bordered block with its
   own label, as text through the display-safe function below:
   - **`exec_shell`:** the exact command string and cwd, plus env overrides. Labeled "Shell command".
     Each env entry is shown as `KEY=value`; a redacted value is shown as `KEY=⟦redacted⟧` with a
     chip "Some values are hidden", because the user is approving something they cannot see. A
     redacted value, or an env key outside the benign allowlist, makes the action elevated, so no
     `session` option is offered (`docs/agent-contract.md` §2).
   - **`exec`:** the argv list, one element per line with its index and visible quotes (`[0] "npm"`,
     `[1] "test"`, an empty element as `""`), so a space inside an element is not read as two
     arguments; cwd; the class as a chip; env. Labeled "Program and arguments". The two forms are
     never flattened into each other.
   - **`fs_read` / `fs_write`:** the operation (`create`, `modify`, `delete`, `rename` with
     `path → to`), the workspace-relative path, and `requestedPath` labeled "Requested as" when it
     differs (a symlink). `sensitive` shows the `sensitiveReason` ("matches protected pattern ⟨…⟩")
     and no session option unless `offered` includes it. A `{outside:true}` path renders "outside the
     workspace: ⟨basename⟩" and is never opened.
   - **`fs_write` content:** the exact `diff` (unified, tool-computed) with `+`/`−` markers, line
     numbers, virtualized so it can be read in full. If `diffOmitted` is present, the card says
     "Diff too large to display (N lines changed, M bytes). Only the path and size are shown.",
     offers no session option, and Deny stays first.
   - **`network`:** method and full URL. The host is separated and emphasized as the parser gives it
     (ASCII, so internationalized hosts appear as `xn--` labels), with a chip "Internationalized
     domain name" when any label is `xn--`. There is no Unicode rendition of the host.
   - **`mcp`:** an "MCP" chip and the name **namespaced `server/tool`**, each part escaped, so a
     server cannot present a tool as a built-in name; the `input` object pretty-printed as JSON with
     every key and value visible (the 64 KiB bound is already enforced upstream). Nested levels are
     expanded to a bound with a "Show all" that reveals the rest.
   - **Unrecognized kind or a payload that fails validation:** see §5.5. The UI never degrades to a
     generic "The agent wants to continue".
3. **`description` (optional, visually secondary):** model-written text appears below the action in
   a block labeled "Agent's description (not verified)", in `--ag-text-muted`, as inert text (through
   `displaySafeProse`), collapsed past three lines. It never replaces or sits above the action and is never styled like a
   system message.
4. **Actions:** buttons per §5.3.

**Display-safe text (applies to every untrusted string that reaches a human).** This covers the
action fields above, `tool` names, server names, paths, cwd, URLs, env keys and values, JSON keys and
values, `contextItems` labels, and the text of main's native dialogs. One function in `core`
implements it so main and the renderer cannot drift; it is specified, with test vectors, in §8. It never interprets markup, and:

- Always escapes to a visible `⟦U+XXXX⟧` marker: control characters (Cc), format characters (Cf),
  bidirectional controls, Default_Ignorable code points, tag characters and U+FEFF. A marker line
  states "This text contains N hidden characters".
- Does not escape all non-ASCII, which would break legitimate paths. Instead it flags a token that
  mixes scripts or is a confusable per UTS #39 with a "Possible look-alike characters" chip.
- Makes layout padding visible: runs of more than 3 consecutive blank lines or more than 8
  consecutive spaces collapse to an explicit marker (`⟦…180 blank lines…⟧`, `⟦…40 spaces…⟧`), and tabs
  render as a visible glyph. Collapsing replaces content with a marker that states what was
  removed; nothing is silently dropped.
- Wraps without truncation. The action block has a maximum height; when it overflows it shows a
  persistent "N more lines below" indicator and a **Show all** control (keyboard-operable) that
  expands it in place. An **end sentinel** sits after the last field of the action (the last
  command line, the last diff line, the last env entry). **The allow buttons stay in their
  armed-off state (§5.3) until the end sentinel has been fully inside the viewport at some point
  since arming**, judged by an `IntersectionObserver` with the viewport as root, so ancestor
  clipping counts. That one condition covers a block taller than its box, a short panel that clips
  the dock, and a "Show all" that grows taller than the screen. The dangerous tail of a long command
  cannot be missed by approving the visible head. Deny is never held back.

### 5.3 Decisions

| Button | Meaning | Offered when |
|---|---|---|
| **Deny** | Reject this action; the agent is told it was denied | Always (`offered` always includes it). Default focus |
| **Allow once** | Approve exactly this single call | Only if `offered` includes `once` |
| **Allow this session** | Approve this action again until the app session ends, scoped as §5.4 states | Only if `offered` includes `session` |

- Button order, left to right: **Deny**, **Allow once**, **Allow this session**. Deny is first in
  reading and tab order and holds initial focus when focus is moved to the card; allow actions are
  visually distinct but not more prominent than Deny (no hero-colored "Allow").
- Keyboard: `Tab` order as above; `Escape` = Deny. `Enter`/`Space` activate only the focused
  button. There are no single-key accelerators for Allow (no `Y`, no `Cmd+Enter` approve).
- **Activation guard (time- and state-based, not focus-based).** An accidental approval is caused by
  an input that was in flight when the card appeared or changed, not by where focus is. The guard
  is on the allow buttons only; Deny and `Escape` are never delayed.
  1. Each request mounts a **fresh card keyed by `approvalId`**, with new DOM buttons. After a
     decision, the next queued request mounts new buttons. Nothing is reused.
  2. A single `canActivate(event)` gates every allow activation, whether by click, pointer, key or
     programmatic `click()`. It is false until **all** hold:
     - at least 400 ms have passed since the card was *armed*;
     - the window is focused and visible;
     - the action's end sentinel has been fully inside the viewport since arming (§5.2);
     - for keyboard: the originating `keydown` happened after arming and is not a repeat
       (`KeyboardEvent.repeat` is ignored), so a held Enter cannot walk through a queue;
     - for pointer: both `pointerdown` and `pointerup` happened after arming and on the same button,
       so a click that began before the card moved under the cursor does nothing.
  3. **Arming happens, and re-happens, on**: the card first being rendered and visible; any change to
     the dock or action-block geometry (resize, panel expand or collapse, "Show all", content change);
     a change to `offered`; the window regaining focus or becoming visible; and queue advance.
  4. While not armed, the allow buttons carry `aria-disabled="true"` and a visible dimmed style, so
     assistive technology and pointer users see the same state; they remain focusable. They are
     linked by `aria-describedby` to a text reason that names what is missing ("Review the full
     command first: 14 more lines" or "Wait a moment"), and **Show all** is reachable by keyboard
     right before them. There is no animation (reduced-motion safe).
- The decision button is disabled while submitting; a second activation is ignored (no double
  resolution). If main reports `no_longer_pending`, the card shows that state and dismisses itself.
  An `invalid_input` (a decision not in `offered`) keeps the card and shows an error.

### 5.4 "Allow this session" semantics

The contract's session grant (`docs/agent-contract.md` §2) is an in-memory exact-match rule, per
workspace root, for the app session. The label must say what that match actually covers, because
for some actions it is wider than "the thing you just saw":

- **`fs_read`:** "Allow reading ⟨path⟩ for this session".
- **`fs_write`:** the grant matches tool + operation + path and **not the content**. The label is
  "Allow any changes to ⟨path⟩ for this session. This also covers content you have not seen.", and
  the same sentence is shown in words under the button. This is deliberately not called "exact". It
  is offered for in-root, non-sensitive writes (the chief's decision: without it, multi-edit tasks
  drown the user in prompts). Files that can execute code when touched (`.git/**`,
  `.github/workflows/**`, `.husky/**`, `.envrc`, shell rc files and similar) are classified
  sensitive by ag-workspace, so they are elevated and never offer `session`.
- **`exec`:** "Allow this exact program and arguments in ⟨cwd⟩ for this session".
- **`exec_shell`:** "Allow this exact command in ⟨cwd⟩ for this session".
- **`mcp`:** "Allow ⟨server⟩/⟨tool⟩ with exactly this input for this session".
- Lifetime is the app session only; nothing is written to disk by this button. Persistent rules are
  made in the permission rules editor (§4.7), as explicit rules the user reviews, which is where
  `ARCHITECTURE.md` §8.4's "unless the user pinned an exact rule" lives. The prompt never writes
  rules.
- Whether a session option is offered is main's decision and the UI never infers it. Elevated
  actions (sensitive paths, omitted diffs, destructive or network `exec`, `network`, redacted or non-benign
  env) never offer it.
  A session grant is revocable from the "Session approvals" list (§4.7).
- Explicitly absent: allow-all, allow for tool, allow for workspace, allow in this folder, allow
  matching, "remember my choice", and any toggle that changes the policy from inside a prompt.

### 5.5 Placement, focus, announcement, reload

- The prompt is the **approval dock**: a non-modal card pinned directly above the composer in the
  agent panel, so Stop, the transcript and the editor stay usable and the user can read the
  surrounding diff before deciding. It has `role="group"` named "Approval needed" and
  `aria-describedby` pointing at the action block.
- **The arrival of a request never moves focus.** Not from the composer, the editor, the terminal, or
  anywhere else. Instead: a polite status line announces "Approval needed: ⟨risk⟩ ⟨tool⟩. Press F6
  to review."; the activity-bar Agent button gets an "approval pending" badge (a count with a text
  label, not a color dot); the OS window title gets a prefix (for example "● "); and `F6` or a
  labeled "Review approval" palette command moves focus to the card, landing on **Deny**. A pointer
  user clicks into the card.
- If the agent panel is collapsed it is expanded because an unseen prompt is a stalled run. That is
  a layout change, so the card re-arms (§5.3) and a click aimed at what was under the cursor cannot
  reach an allow button.
- **Queue.** Approvals in a run are presented one at a time in arrival order; "1 of N" counts pending
  approvals in this window. They are never merged into "approve all N"; each decision is
  independent.
- **Reload and crash.** On a renderer reload, the UI subscribes first, buffers live events, then calls
  `permissions.listPending`, `agent.listRuns` and `agent.replay`, then drains the buffer by `seq`.
  Pending approvals reappear as fresh cards and re-arm. On a crash or close, main has already denied
  and aborted (the window binding in `docs/agent-contract.md` §5).
- **Fail closed.** If an `agent.approvalRequested` payload fails validation (an unknown `kind` from
  version skew, or a malformed field) but carries a parseable `approvalId`, the UI answers
  `permissions.respondApproval` with `deny` and shows "A request could not be displayed and was
  denied." It never drops the event silently, which would stall the run.
- The decision is sent as `{ approvalId, decision }` only. The renderer keeps the outcome only as the
  transcript record ("Denied", "Allowed once", "Allowed this session", "Run stopped").

### 5.6 Required tests (acceptance for this flow)

- Rendering: for each `action.kind` in §5.2, every field is present verbatim (after the
  display-safe function) in the DOM text; `description` never appears above or in place of the action.
- Hostile content: strings containing `<script>`, `<img onerror>`, markdown links, ANSI escapes,
  RTL overrides, zero-width characters, tag characters, mixed-script look-alikes, and 200 blank lines
  or 500 spaces before a dangerous tail render as inert text with visible markers; no element other
  than text nodes is created from them. The same corpus is run through every field, including
  `tool`, MCP names, paths, URLs, env and JSON keys.
- Long content: an overflowing command keeps the allow buttons unarmed until the end sentinel has
  been fully in the viewport; the same holds when a short panel clips the dock and when "Show all"
  grows taller than the window. The reason text is exposed through `aria-describedby`. Deny works
  throughout.
- Buttons: only `offered` decisions render; no allow-all/"always"/pattern control exists in the
  component's API or DOM (a type-level and a runtime test).
- Guard: a click 100 ms after the card appears does nothing; a `pointerdown` before arming with a
  `pointerup` after does nothing; a held Enter (`repeat`) across a queue advance approves nothing;
  an Enter keydown that began before the new card mounted does nothing; a click on window refocus does
  nothing; a layout change re-arms; Deny and `Escape` work immediately in every case.
- Focus: a request arriving while the composer, editor or terminal has focus does not change
  `document.activeElement`.
- Lifecycle: stop-run, `run_stopped`, and `no_longer_pending` each dismiss the card and never leave
  a stale actionable one; a reload restores pending cards from `permissions.listPending`.
- Fail closed: an unknown-kind payload with an `approvalId` produces a `deny` and a visible notice.
- Queue: three pending approvals show "1 of 3", resolve independently, in order, each with fresh
  buttons.
- A11y: axe-clean in light and dark; the action block is reachable and readable by name; the
  announcement text is asserted via the live region.

## 6. Renderer hardening and role-split readiness (D-010)

"The renderer is untrusted" is a design posture, not a property the renderer has. This section
states what the UI does to make an attack hard, what it does not defend against, and how the code is
shaped so privileged capabilities can later move out of the view that renders model output.

### 6.1 Hardening invariants (M0–M2, each with a test)

1. **Strict CSP** set by main on responses (not a `<meta>`): no inline script, no `eval`, no remote
   origins. Monaco is bundled locally with its workers served from the app origin. The exact policy
   is ag-foundation's; the UI requirement is an e2e test that an injected inline script and an
   injected `javascript:` URL do not execute.
2. **Exactly one rich-text path for untrusted content**: a single `SafeMarkdown` component in
   `ui-kit`. It parses to an AST and renders React elements from an allowlist of node types. Raw
   HTML in the source is shown as text, never parsed. It never uses `innerHTML`. Its test suite
   runs an XSS corpus (script tags, event-handler attributes, `javascript:`/`data:`/`vbscript:`
   URLs, SVG and MathML payloads, nested and malformed markup, entity tricks, mXSS patterns,
   CSS `url()` payloads) and asserts on the rendered DOM: no `script`, no `on*` attributes, no
   dangerous URL schemes, no elements outside the allowlist.
3. **No `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`,
   `eval` or `new Function` anywhere else.** Two layers, because lint cannot see computed or
   spread property names:
   - **Lint** in the shared tooling package, tested through the real `eslint` CLI with the
     circumventions that would be tried (a ref plus assignment, an alias import), per L-003. It is
     the early signal and fails `pnpm verify`; there is no suppression path.
   - **Trusted Types at runtime**, requested from ag-foundation as part of the CSP:
     `require-trusted-types-for 'script'`, with `trusted-types` listing only the policy names
     Monaco actually registers (read from the installed Monaco version, not guessed). An e2e test
     asserts that assigning a string to `innerHTML` throws, and that a spread-prop attempt fails
     the same way. This is what makes the ban hold against code the linter cannot read.
4. **External links go through main.** A link is rendered with its URL visible (the link text never
   hides the destination) and a "copy" action. The open action calls `app.openExternal { url }`
   (`docs/ipc-channels.md` §7.1): http and https only, always a native confirmation that shows the
   exact normalized URL through the display-safe function, no "remember this site", and no
   renderer-supplied trust flag. `target="_blank"`, `window.open` and in-renderer navigation are
   never used (`ARCHITECTURE.md` §8.1).
5. **One display-safe string function** for every untrusted string that reaches a human (§5.2):
   action fields, tool and server names, paths, URLs, env, JSON keys and values, and the text of
   native dialogs. Native dialogs are built in main, so the function lives in `core` and both sides
   import it. It is specified, with test vectors, in §8.

### 6.2 Residual risk, stated plainly

Until the isolation work below ships, one renderer both displays model output and can call
privileged channels (`terminal.*`, `permissions.respondApproval` and `addRule`, `auth.*`,
`workspace.setTrust`). A renderer compromise, for example a sanitizer bypass in the transcript, would
therefore give an attacker command execution in the integrated terminal and the ability to approve
their own requests. The approval guard in §5.3 protects a human from an accidental click; it is no
defense against script that calls the bridge directly. The invariants in §6.1 reduce the likelihood;
they do not remove the risk. Per D-010, agent mode does not ship until the chosen isolation is
implemented or the user explicitly accepts this risk.

### 6.3 Shaped for a later split of `webContents` by role

D-010's gate before M3 candidates are separate views per role (transcript without
`terminal.*`/`auth.*`/`permissions.*`/`setTrust`; approvals in a small privileged view that renders
structured data as inert text) or a sandboxed frame for model content. The UI code is written so
either is a configuration change, not a rewrite:

- **No code assumes one window calls every channel.** The bridge client is created per view with a
  declared channel set (a typed `ChannelSet`). A feature module imports only the set it needs, and a
  test fails if a module invokes a channel outside its declared set. The transcript's set contains no
  privileged channel.
- **Roles are separately mountable roots**: transcript, approvals, terminal, settings and auth, and
  workspace chrome each have their own entry component with their own subscriptions. None reaches
  into another's state.
- **No shared mutable JS state between roles.** State that more than one role needs (settings,
  pending approvals, workspace trust) arrives from main as events (`settings.changed`,
  `agent.approvalRequested`/`Resolved`, `workspace.*`), so a second view stays consistent without
  access to the first one's memory.
- **Model content is rendered in one place** (the transcript role, via `SafeMarkdown`), so that role
  is the one that can be moved into a sandbox.
- **The approval view takes only structured data** (`ApprovalRequestedPayload`) and renders it as
  inert text; it never imports `SafeMarkdown`.
- The D-010 design-gate proposal is a joint ag-foundation and ag-ui deliverable. I will draft the
  UI half (view split, what each view may call, how focus and keyboard routing work across views)
  when the chief schedules it; this section is the constraint it must respect.

## 7. Open questions

Tracked with their owners in `docs/ipc-channels.md` §9. Each blocks only the matching implementation
step. Decided by the chief and recorded as such: session grants for in-root, non-sensitive writes stay
(with the honest label, §5.4; ag-workspace classifies code-execution vectors as sensitive); the
display-safe function is a `core` export specified in §8 (ag-foundation implements, ag-reviewer
reviews); `app.openExternal` is the external-link channel (`docs/ipc-channels.md` §7.1); the D-010
isolation proposal starts with M2 and is decided before M3.

1. **Session-grant identity** (§5.4): the contract's `exec` grant matches argv + cwd, which leaves out
   `env`. Request to ag-agent: include `env` and the exec `class`, key by the workspace-root realpath,
   and clear grants on root change and on `setTrust(false)`.
2. **Redacted env values**: a value the tool redacted is something the user approves without seeing.
   Request: treat any redaction as elevated (no `session`), and label it in the card.
3. **Undo and reload**: after `agent.undoRun`, a reload would rebuild the transcript from the replay
   buffer and show the undone runs again. Request: `agent.listRuns` and `agent.replay` exclude (or
   mark) undone runs.
4. **Budget settings key**: the budgets are user-adjustable (`docs/agent-contract.md` §4); which
   settings key holds them and that main reads it when starting a run (drafted as `agent.budgets`).
5. **Theme bootstrap**: ag-foundation to confirm the `additionalArguments` route
   (`docs/ipc-channels.md` §9.6).

## 8. Display-safe text function (spec and test vectors)

One pure function in `@autogeek/core`, used by the renderer and by main's native dialogs. ag-foundation
implements it, ag-reviewer reviews it, and this section is its specification. It exists because the
approval prompt, trust prompt, rule confirmation, protected-path confirmation and external-link
confirmation all show strings that a model, a file, a server or a web page controlled, and a human
decides on what they see.

### 8.1 Contract

```ts
interface DisplaySafeOptions {
  mode: 'block' | 'inline' | 'dialog';   // block: unlimited, multi-line. inline: one line, bounded.
                                         // dialog: bounded; exceeding the bound is refused, never cut
  maxChars?: number;                     // code points. inline default 256; dialog default 2_000; block none
}
type Segment =
  | { kind: 'text'; text: string }                       // contains no always-escaped code point
  | { kind: 'escape'; codePoint: number }                // rendered as ⟦U+XXXX⟧ (hex, upper case, ≥ 4 digits)
  | { kind: 'tab' }                                      // rendered as ⟦TAB⟧
  | { kind: 'collapsed'; what: 'blank_lines' | 'spaces' | 'combining_marks'; count: number }
  | { kind: 'omitted'; chars: number };                  // inline only: ⟦…N more characters…⟧
interface DisplaySafe {
  segments: Segment[];
  plain: string;                                         // the same content as one string, markers inline (for native dialogs)
  stats: { chars: number; lines: number; hidden: number; truncated: boolean; normalizedCrlf: number };
                                                         // hidden = code points shown as an escape or inside a collapsed marker
  flags: { mixedScript: boolean; confusable: boolean };
  flagged: Array<[start: number, end: number]>;          // code-point ranges of tokens that set a flag
}
// Two exports, so a field that is part of what runs can never be rendered in prose mode by mistake:
declare function displaySafeLiteral(input: string, options: DisplaySafeOptions): Result<DisplaySafe, 'too_long'>;
declare function displaySafeProse(input: string, options: DisplaySafeOptions): Result<DisplaySafe, 'too_long'>;
```

`displaySafeLiteral` is for every action field (command, argv, cwd, paths, URLs, env, MCP names and
input), native-dialog text, tool and server names, and anything else that is part of what runs or
what the user is consenting to. `displaySafeProse` is for model-written descriptions and plan text
only; it differs in exactly one rule (CRLF, below). There is no option that switches one into the
other, and a lint rule in the tooling package restricts importing `displaySafeProse` to the
description and plan components.

It never changes the characters it keeps (no case folding, no normalization, no line-ending rewriting
except in `displaySafeProse`, which counts it), so what is shown is what will be used. It is total (any string, including lone surrogates), deterministic (no locale, no
runtime-dependent Unicode data) and linear time.

### 8.2 Rules, in order

1. **Always escape** these code points as `⟦U+XXXX⟧`: general categories Cc (except `\n` and `\t`,
   below), Cf, Cs (lone surrogates), Co and Cn (unassigned); noncharacters (`U+FDD0..FDEF`,
   `U+xxFFFE/xxFFFF`); the Default_Ignorable_Code_Point set (includes soft hyphen, combining grapheme
   joiner, variation selectors, Hangul fillers, Mongolian free variation selectors); bidirectional
   controls (`U+061C`, `U+200E/200F`, `U+202A..202E`, `U+2066..2069`); zero-width characters
   (`U+200B..200D`, `U+2060..2064`, `U+FEFF`); tag characters (`U+E0000..E007F`); the line and
   paragraph separators `U+2028/2029`; **every space separator (Zs) except `U+0020`** (NBSP,
   `U+2000..200A`, `U+202F`, `U+205F`, `U+3000`, `U+1680`), because an NBSP inside a shell command is
   not a word break even though it looks like one; and **every enclosing mark (Me)** (`U+0488/0489`,
   `U+1ABE`, `U+20DD..20E0`, `U+20E2..20E4`, `U+A670..A672`), which draws a shape over its
   neighbours.
2. **Escape the marker characters and their look-alikes**: `⟦` (`U+27E6`), `⟧` (`U+27E7`),
   `〚` (`U+301A`) and `〛` (`U+301B`) in the input are escaped, so input cannot imitate a marker. A
   native dialog shows `plain` as unstyled text, so this is the only protection there. The list is
   explicit and is reviewed against the pinned UTS #39 confusables data whenever the Unicode version
   changes (a test fails if a code point whose prototype is a double bracket is missing). In the
   renderer, `escape`, `tab`, `collapsed` and `omitted` segments are also drawn as a styled chip that
   body text cannot reproduce.
3. **Line breaks:** `\n` is the only line break. **Every `\r` is escaped, including the one in `\r\n`**,
   because a CR is part of what runs (`rm -rf build\r` names a different file than `rm -rf build`).
   `displaySafeProse` alone reads `\r\n` as one line break and counts it in `stats.normalizedCrlf`.
   `\t` becomes a `tab` segment.
4. **Collapse padding:** a run of more than 8 consecutive `U+0020` becomes one `collapsed spaces`
   segment with the count, and a run of more than 3 consecutive blank lines (empty or spaces only)
   becomes one `collapsed blank_lines` segment on its own line. Runs at or under the limits are
   kept as they are. Nothing is dropped without a marker that states how much.
   **Combining marks:** a run of **5 or more** consecutive nonspacing marks (Mn) on one base
   character becomes one `collapsed combining_marks` segment with the count, and the base stays
   (UTS #39 §5 treats more than 4 as suspicious; Biblical Hebrew and Tibetan legitimately reach 4, and
   4 marks cannot reach a neighbouring line). A stacked run (Zalgo text) would otherwise draw ink
   over the neighbouring lines of the action block. An escaped, tab or collapsed segment ends a run.
   **Orphan marks:** an Mn with no base, which is at the start of the input, after `\n`, or directly
   after an `escape`, `tab`, `collapsed` or `omitted` segment, is escaped on its own. In `plain` it
   would decorate the preceding `⟧`, and in the renderer it would draw over the chip.
5. **Bounds:** in `inline` mode, beyond `maxChars` the rest becomes one `omitted` segment with the
   count. In `dialog` mode, beyond `maxChars` the function returns `too_long`; the caller refuses the
   operation, because a native dialog cannot scroll and a truncated dialog hides the tail. `block` mode
   is never cut; the UI handles overflow (`§5.2`). A dialog that shows a path passes a `maxChars` no
   smaller than the platform's `PATH_MAX` plus the fixed text around it, so a legitimately deep path
   can still be confirmed (the wire schema's own bound still applies); only text beyond that is
   refused.
6. **Flags (not edits).** Tokenize on whitespace, path separators `/` and `\`, and ASCII punctuation.
   For each token, using the Script_Extensions property and ignoring Common and Inherited:
   `mixedScript` is set when more than one script remains, except the UTS #39 Highly Restrictive
   allowances (Latin with Han, Hiragana, Katakana, Bopomofo or Hangul in their usual combinations).
   `confusable` is set when the token contains non-ASCII characters and its UTS #39 *skeleton* is
   entirely ASCII (a token that renders like ASCII but is not). The UI shows a "Possible look-alike
   characters" chip and highlights `flagged` ranges. Tokens that merely contain legitimate
   non-ASCII text are not flagged.
7. **Unicode data is pinned**, not read from the runtime. The tables for rules 1 and 6 are generated by
   a checked-in script from a named Unicode version and committed with a test that regenerates them
   and compares. Main (Node) and the renderer (Chromium) therefore classify identically even when
   their runtimes differ. No new runtime dependency is needed.

Trade-off, stated: the Default_Ignorable and Cf rules also escape the zero-width joiner and
`U+FE0F` that legitimate emoji sequences use. In a security prompt, seeing `⟦U+200D⟧` inside an emoji
is acceptable; hiding it is not.

### 8.3 Test vectors

Input shown with escapes; expected `plain` (and flags) on the right.

| Input | Expected `plain` | Notes |
|---|---|---|
| `ls` | `ls` | unchanged, `hidden: 0` |
| `a‮b` | `a⟦U+202E⟧b` | bidi override |
| `x​y` | `x⟦U+200B⟧y` | zero-width space |
| `rm -rf` | `rm⟦U+00A0⟧-rf` | NBSP is not a word break |
| `a\u0007b` | `a⟦U+0007⟧b` | control |
| `e\u{E0041}` | `e⟦U+E0041⟧` | tag character |
| `﻿foo` | `⟦U+FEFF⟧foo` | BOM |
| `\uD800` | `⟦U+D800⟧` | lone surrogate |
| `͸` | `⟦U+0378⟧` | unassigned |
| `` | `⟦U+E000⟧` | private use |
| `￿` | `⟦U+FFFF⟧` | noncharacter |
| `a b` | `a⟦U+2028⟧b` | line separator |
| `a͏b` | `a⟦U+034F⟧b` | combining grapheme joiner |
| `a\tb` | `a⟦TAB⟧b` | |
| `a\rb` | `a⟦U+000D⟧b` | lone CR |
| `a\r\nb` | `a⟦U+000D⟧\nb` | CR is part of what runs |
| `a\r\nb` via `displaySafeProse` | `a\nb`, `normalizedCrlf: 1` | prose fields only |
| `a\u20DDb` | `a⟦U+20DD⟧b` | enclosing mark |
| `a\u1ABEb` | `a⟦U+1ABE⟧b` | enclosing mark (Me) |
| `e` + 4 × `\u0301` | unchanged | at the limit (UTS #39 §5) |
| `e` + 5 × `\u0301` | `e⟦…5 combining marks…⟧`, `hidden: 5` | |
| `e` + 20 × `\u0301` | `e⟦…20 combining marks…⟧`, `hidden: 20` | Zalgo |
| `\u0301a` | `⟦U+0301⟧a` | orphan mark at the start |
| `x\n\u0301y` | `x\n⟦U+0301⟧y` | orphan mark after a line break |
| `\u202E\u0301` | `⟦U+202E⟧⟦U+0301⟧` | orphan mark after an escape |
| `\u301AU+202E\u301B` | `⟦U+301A⟧U+202E⟦U+301B⟧` | bracket look-alikes cannot imitate a marker |
| `⟦U+202E⟧` (literal text) | `⟦U+27E6⟧U+202E⟦U+27E7⟧` | cannot imitate a marker |
| `ls` + 5 blank lines + `; curl x` | `ls\n⟦…5 blank lines…⟧\n; curl x` | padding exposed |
| `ls` + 3 blank lines + `; curl x` | unchanged | at the limit |
| `a` + 20 spaces + `b` | `a⟦…20 spaces…⟧b` | |
| `a` + 8 spaces + `b` | unchanged | at the limit |
| `❤️` | `❤⟦U+FE0F⟧` | emoji selector escaped (trade-off above) |
| `pаypal` (Cyrillic а) | text unchanged, `mixedScript`, `confusable`; `flagged [[0,6]]` | mixed-script look-alike |
| `ѕсоре` ("ѕсоре") | unchanged, `confusable` | whole-script look-alike of `scope` |
| `naïve.txt`, `résumé`, `Привет`, `日本語/ファイル.ts` | unchanged, no flags | legitimate non-ASCII |
| 300 × `a`, `inline`, `maxChars: 256` | 256 `a` + `⟦…44 more characters…⟧`, `truncated` | |
| 2_500 × `a`, `dialog` | `Result` error `too_long` | refused, never cut |

### 8.4 Property tests

For arbitrary strings (including lone surrogates and long runs):

- **No silent loss:** the sum of the code points in `text` segments, one per `escape` and `tab`
  segment, and the counts in `collapsed` and `omitted` segments equals the input's code-point count
  (`displaySafeProse` adds `normalizedCrlf`).
- **Clean output:** no `text` segment contains an always-escaped code point, `⟦`/`⟧` or `〚`/`〛`.
- **Idempotent on its own text:** running the function over the concatenated `text` segments returns
  the same text segments.
- **Totality and bounds:** it never throws, and runs in time linear in the input (checked on a 1 MiB
  input).
- **Parity:** the main-process and renderer builds return the same `plain` for a fixed corpus of
  10,000 generated strings.
