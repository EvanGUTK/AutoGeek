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
  display state only; every security decision is made in main.
- Model output, tool output, file contents, file names and terminal output are **untrusted
  strings**. They are rendered as React text nodes. No `dangerouslySetInnerHTML` anywhere in
  `ui-kit`. Markdown rendering (agent transcript) is a separate sanitized path with its own
  XSS test corpus and is out of scope here.
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

`data-theme` is set on `<html>` before first paint (inline in `index.html` is blocked by the strict
CSP, so the preload bridge supplies the initial value synchronously, or the stylesheet defaults via
`@media (prefers-color-scheme)` and the attribute only overrides). `color-scheme` is set to match so
native scrollbars and form controls follow.

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
| `--ag-selected` | `#2f3f5c` | `#d6e4fb` | Selected row / active item background |

**Foreground** (floor 4.5:1 on all four surfaces)

| Token | Dark | Light | Min contrast (dark / light) | Use |
|---|---|---|---|---|
| `--ag-text` | `#e6e8ee` | `#1a1d24` | 10.95 / 15.60 | Body text |
| `--ag-text-muted` | `#a3a9b8` | `#4a5163` | 5.70 / 7.33 | Secondary text, labels |
| `--ag-text-subtle` | `#9199aa` | `#5c6477` | 4.69 / 5.48 | Placeholders, hints, disabled-adjacent metadata |
| `--ag-accent` | `#6ea8ff` | `#0a5bd6` | 5.56 / 5.58 | Links, active indicators |
| `--ag-danger` | `#ff8a80` | `#b3261e` | 5.87 / 6.04 | Errors, destructive, deny |
| `--ag-warning` | `#f2c264` | `#8a5a00` | 8.09 / 5.48 | Cautions, write/exec risk |
| `--ag-success` | `#6fd39a` | `#1b6e3f` | 7.32 / 5.80 | Success, added lines |
| `--ag-info` | `#7cc4ff` | `#0b5f99` | 7.15 / 6.24 | Informational |
| `--ag-on-accent` | `#0b1220` | `#ffffff` | 7.76 / 6.03 on `--ag-accent` fill | Text on filled accent buttons |

Disabled controls are exempt from contrast requirements by WCAG, but they still keep a legible
shape: disabled uses `--ag-text-subtle` at the same contrast as above plus a non-color cue
(dashed or absent border, `cursor: not-allowed`), not reduced opacity alone.

**Lines and focus** (floor 3:1 where the line identifies a control)

| Token | Dark | Light | Contrast | Use |
|---|---|---|---|---|
| `--ag-border` | `#3a4050` | `#d5d9e2` | decorative, no floor | Dividers, panel separators at rest |
| `--ag-border-strong` | `#7a8296` | `#767d90` | ≥ 3.49 / ≥ 3.80 | Input, button, checkbox boundaries (1.4.11) |
| `--ag-focus` | `#8ab8ff` | `#0a5bd6` | ≥ 6.63 / ≥ 5.58 | Focus ring |

State layering (hover, pressed) is expressed as a tint of `--ag-text` at 8% / 14% over the base
surface, so it works on every surface without per-surface tokens. Accent-filled buttons hover to
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
  restored by any persistence layer, and exposes an imperative `clear()` that zeroes the DOM value.
  The consumer clears it immediately after handing the value to the bridge (brief item 7). Tests
  assert the value is absent from component state after submit.

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
| Stop-run shortcut | Always bound and always enabled while a run is active (chosen by the chief with the agent runtime, see §6) |

Shortcuts are registered through one typed registry that detects conflicts in tests and exposes the
list in the command palette. No shortcut may be required to be pressed in a text-entry context
without a modifier.

## 4. Agent panel surfaces that feed the approval flow

Short, because the approval prompt (§5) is the part with security consequences.

- **Run header:** always shows `provider · model · credential label` for the turn currently running
  (from `CredentialRef.label`, never from key material), plus the **Stop** button. Stop is rendered
  outside any scrollable or collapsible region, is never disabled while a run is active, and is
  reachable by `F6` and a global shortcut. Stopping resolves every pending approval as **deny**.
- **Tool-call cards** show the literal call: tool name, risk badge, and the input rendered
  verbatim as described in §5.2. They are collapsible, but a card with an unresolved approval is
  never collapsed.
- **Streaming:** transcript is an `aria-live="off"` region with a "Run finished"/"Awaiting
  approval" polite status line, so screen-reader users are not flooded token by token.

## 5. Approval-prompt UX

Goal: the human approves **the thing that will actually happen**, in a form the model cannot
dress up, with no path to blanket permission. This is UI only: the decision is returned to main,
which enforces it through `PermissionGate`, and the renderer cannot widen what it is offered.

### 5.1 Principles

1. **Show the literal action, not model prose.** What is displayed is derived from the structured
   `PermissionRequest` main sent (tool name, resolved input), never from a free-form model message.
2. **The renderer displays; main decides.** The set of buttons is exactly the set of decisions main
   offered for this request. The UI cannot add an option.
3. **Never allow-all.** There is no "always allow", "allow all", "don't ask again for this tool",
   "allow for this workspace", or wildcard/pattern grant in the UI. See §5.4.
4. **Deny is the default and the easy path.** Default focus, `Escape`, closing, timeout, stopping
   the run, and renderer teardown all resolve to deny.
5. **No time pressure toward yes.** No countdown that auto-approves, ever. A timeout, if main
   defines one, resolves to deny and says so.

### 5.2 What is shown

A prompt is one card (the **approval dock**, §5.5) containing, top to bottom:

1. **Header:** "Approval needed", the risk badge (`READ`/`WRITE`/`EXEC`/`NETWORK` text label, from
   `Tool.risk`), and the context line `tool name · provider · model · credential label` so the user
   can see which agent turn and key this is attributed to. If more requests are queued,
   "1 of 3" is shown.
2. **The literal action**, per tool kind, in `--ag-font-mono` / `mono-md`, in a bordered block with
   its own label. It is rendered as **text with visible escaping**, never interpreted:
   - **Shell:** the exact command string and the exact cwd, plus any env overrides main reports. The
     command is shown in full: long commands wrap (no truncation, no ellipsis) and the block
     scrolls within a max height; line breaks and every `;`, `&&`, `|`, `$()`, backtick, redirect
     and heredoc are visible as written. Control characters, zero-width characters, bidirectional
     overrides, and non-ASCII look-alikes are rendered as visible escapes (e.g. `⟦U+202E⟧`) with a
     marker line "This text contains N hidden or non-ASCII characters", because hiding them is how a
     prompt gets spoofed. The risk classification that main attached (e.g. "destructive", "network")
     is shown as a chip.
   - **File read/write/edit/delete:** the **resolved real path** main computed (symlinks resolved),
     the workspace-relative form, and the operation. If the requested path differs from the resolved
     path, both are shown, labeled. Paths needing explicit approval by policy (`.env`, key files,
     `.git/config`) get a labeled reason ("matches protected pattern") and no session option unless
     main offers it. For writes and edits, the **exact diff** (unified, from main's computed result,
     not the model's description) with `+`/`−` markers, line numbers, and a "create"/"modify"/
     "delete" label; large diffs show stats and the full diff is reachable (virtualized), never
     summarized away.
   - **Network:** method, full URL (scheme, host, port, path, query), with the host separated and
     emphasized, and punycode/IDN hosts shown in both forms.
   - **MCP tool:** server name, tool name, and the argument object pretty-printed as JSON with every
     key and value visible (nested expanded by default up to a bound, with a "show all" that renders
     the rest); risk is shown as main classified it (`network`/`exec` until proven otherwise).
   - **Anything unrecognized:** the tool name and the input as pretty-printed JSON; the prompt never
     degrades to a generic "The agent wants to continue".
3. **Model's stated reason (optional, visually secondary):** if the request carries model-written
   text, it appears below the action in a block labeled "Agent's description (not verified)", in
   `--ag-text-muted`, as plain text, collapsed past three lines. It never replaces or sits above the
   literal action, and it is never styled like a system message.
4. **Actions:** buttons per §5.3.

Untrusted-string handling applies to all of the above: no markdown, no links activated (URLs are
displayed text, not anchors), no images, no HTML. An approval card cannot be restyled by content.

### 5.3 Decisions

| Button | Meaning | Offered when |
|---|---|---|
| **Deny** | Reject this action; the agent is told it was denied | Always. Default focus. |
| **Allow once** | Approve exactly this single call | Always, unless main offers deny-only |
| **Allow this session** | Approve this **exact** action again until the app session ends, no wider | Only if main marks the request session-grantable, see §5.4 |

- Button order, left to right: **Deny**, **Allow once**, **Allow this session**. Deny is first in
  reading and tab order and takes initial focus; allow actions are visually distinct but not
  more prominent than Deny (no hero-colored "Allow").
- Keyboard: `Tab` order as above; `Escape` = Deny. `Enter` activates only the focused button. There
  are no single-key accelerators for Allow (no `Y`, no `Cmd+Enter` approve) so a stray keypress
  cannot approve. Deny may have `Cmd/Ctrl+Backspace` as a convenience.
- **Typing-ahead guard:** a prompt that appears while the user is typing or pressing keys must not
  be approvable by those keystrokes. The dock does not steal focus from the composer or the
  editor (see §5.5) and, once focused, ignores activation events for the first 400ms after it
  receives focus (the buttons are not `disabled`, so assistive tech is unaffected; the guard is in
  the activation handler and covered by a test with fake timers).
- The decision button is disabled while submitting; a second activation is ignored (no double
  resolution). If main reports the request is no longer pending (run stopped, already resolved),
  the card shows that state and dismisses itself; it never shows a stale actionable prompt.

### 5.4 "Allow this session" semantics

- The grant is scoped to the **exact action** shown: for shell, the exact command string + cwd;
  for files, tool + operation + resolved path; for network, method + exact URL; for MCP, server +
  tool + exact argument values. Not the tool, not a directory, not a prefix, not a pattern.
- The label states the scope in words, e.g. "Allow this exact command for this session", and the
  scope is repeated under the button in plain text so it cannot be misread.
- Lifetime is the app session only; nothing is written to disk by this button. Persistent rules
  are made in the permission rules editor (Settings), as explicit, exact rules the user types and
  reviews, which is where `ARCHITECTURE.md` §8.4's "unless the user pinned an exact rule"
  lives. The prompt never writes rules.
- Whether a request is session-grantable is main's decision (e.g. destructive and network
  commands and protected paths may be **deny / allow once only**). The UI renders only what is
  offered and never infers a session option. A session grant is revocable from a "Session approvals"
  list (Settings and agent panel menu) that shows each granted action literally with a Revoke
  button.
- Explicitly absent: allow-all, allow for tool, allow for workspace, allow in this folder, allow
  matching, "remember my choice", and any toggle that changes the policy from inside a prompt.

### 5.5 Placement, focus and announcement

- The prompt is the **approval dock**: a non-modal card pinned directly above the composer in the
  agent panel (not a modal dialog), so Stop, the transcript, and the editor stay usable and the
  user can read the surrounding diff before deciding. It has `role="group"` named "Approval
  needed", and `aria-describedby` pointing at the literal action block.
- When a request arrives: a polite status line announces "Approval needed: <risk> <tool>", the
  activity-bar Agent button gets an "approval pending" badge (a count with a text label, not a
  color dot), and the OS window title gets a prefix (e.g. "● ") so a backgrounded window is
  noticeable. If the agent panel is collapsed it is expanded (the user's layout choice is restored
  afterward) because an unseen prompt is a stalled run.
- Focus: moves to **Deny** only when focus is already inside the agent panel or on `body`.
  Otherwise focus is not stolen (the typing-ahead rule), and `F6` or a labeled "Review approval"
  command in the palette jumps to it. The composer is **not** disabled; sending a new message while
  an approval is pending is allowed and does not resolve it.
- Multiple requests (parallel read-only calls are not gated by the UI; parallel gated calls can
  occur) are shown **one at a time in arrival order** with "1 of N", never merged into a single
  "approve all N". Each decision is independent.
- The decision is sent to main as a typed message carrying the request id and one of the offered
  decisions; the renderer retains nothing about it beyond the transcript record ("Denied",
  "Allowed once", "Allowed this session"), which is shown on the tool-call card.

### 5.6 Required tests (acceptance for this flow)

- Rendering: for each tool kind in §5.2, the literal action is present verbatim in the DOM text;
  the model's description never appears above or in place of it.
- Hostile content: command/path/URL/JSON strings containing `<script>`, `<img onerror>`, markdown
  links, ANSI escapes, RTL override, zero-width and homoglyph characters render as inert text with
  visible escapes; no element other than text nodes is created from them.
- Buttons: only offered decisions render; no allow-all/“always”/pattern control exists in the
  component's API or DOM (a type-level and a runtime test).
- Keyboard: initial focus is Deny; `Escape` denies; `Enter` on Deny denies; no key approves from a
  non-focused state; activation within 400ms of focus is ignored; double activation resolves once.
- Lifecycle: stop-run, renderer unmount, and main's "no longer pending" notification each result in
  deny/dismiss and never a stale actionable card.
- Queue: three queued requests show "1 of 3", resolve independently, in order.
- A11y: axe-clean in light and dark; the literal action block is reachable and readable by name;
  announcement text asserted via the live region.

## 6. Open questions for the chief

The IPC the renderer needs is specified in `docs/ipc-channels.md`, which is where questions 1, 2
and 4 are tracked. Remaining items, each blocking only the matching implementation step:

1. **`PermissionRequest` shape.** The structured, main-built `action` union agreed with the chief
   covers command, write_file, read_sensitive, network and mcp. §5 additionally needs an
   `offered` decisions set, a `context` line, resolved-path and operation fields, and a
   classification; these are requested from ag-agent in `docs/ipc-channels.md` §5, not assumed.
2. **Session grants and `ARCHITECTURE.md` §8.4.** "Allow this session" is a non-persistent,
   exact-action grant that main may withhold (deny / allow once only) for destructive and network
   commands and protected paths. The chief confirmed `'session'` creates an exact-match rule only;
   whether it is offered for exec/network is main's decision, delivered through `offered`.
3. **Theme bootstrap.** Whether the preload may expose the initial theme synchronously so
   `data-theme` is correct before first paint under the strict CSP (`docs/ipc-channels.md` §9.3).
4. **Stop shortcut.** Which global accelerator stops a run, chosen with ag-agent.
