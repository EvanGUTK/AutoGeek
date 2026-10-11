# Brief: ag-foundation (sonnet-5-5 / high) — M0

Everything else builds on your work, so correctness and clean seams matter more than speed.
Nothing here is optional; if something seems wrong, ask the chief.

## Deliver (as separate atomic commits, in roughly this order)
1. **Workspace tooling:** pnpm workspace + Turborepo, Node version pinned (`.nvmrc` + `engines`),
   `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
   `noImplicitOverride`, `verbatimModuleSyntax`), ESLint flat config (typescript-eslint strict-type-checked,
   `no-explicit-any`, ban `@ts-ignore`/`eslint-disable` without description → we forbid anyway),
   Prettier, Vitest, root scripts: `build`, `typecheck`, `lint`, `test`, `verify` (= typecheck + lint +
   test, fails on any warning), `dev`.
2. **Dependency boundaries:** enforce the rules in ARCHITECTURE.md §4 mechanically (e.g.
   `eslint-plugin-boundaries` or `dependency-cruiser`) with a test that a forbidden import fails.
3. **`@autogeek/core`:** the contracts in ARCHITECTURE.md §5 as real zod schemas + inferred types
   (`Message`, `ContentPart`, `ModelEvent`, `ModelProvider`, `AuthMethod`, `Tool`, `PermissionGate`,
   `CredentialRef`, `AgentEvent`, `Result<T,E>`, error taxonomy), an `AbortSignal`-aware typed event
   emitter, and the IPC contract format (channel name → input schema → output schema). Full unit tests.
   Fill gaps sensibly, but **list every deviation from §5 in your review request**.
4. **Stub packages:** `auth providers agent tools mcp workspace permissions ui-kit` each with
   `package.json`, `tsconfig`, `src/index.ts` (empty public surface), a passing smoke test, so
   wave-2 agents can start in clean packages.
5. **`apps/desktop`:** Electron main + preload + React/Vite renderer that boots a window with the
   secure defaults from ARCHITECTURE.md §8.1 (sandbox, contextIsolation, CSP, navigation and
   `window.open` denied, no remote). A typed IPC bridge in preload built from the core IPC contract
   (no raw `ipcRenderer` exposed), main-side sender verification and zod validation, with one real
   round-trip channel (`app.getInfo`) covered by tests.
6. **Playwright smoke test:** launches the built Electron app, asserts the window renders, that
   `window.require`/`process` are undefined in the renderer, and that the IPC round trip works.
7. **`docs/SECURITY.md`:** threat model (assets, trust boundaries, attackers, mitigations) matching
   ARCHITECTURE.md §8. Concise and specific.

## Acceptance
- Fresh clone: `pnpm install && pnpm verify` is green; `pnpm dev` opens the window.
- Every commit individually passes `pnpm verify`.
- No `any`, no suppressions, no skipped tests.
- Reviewed and APPROVED by `ag-reviewer` on the exact head SHA, then reported ready to merge.

## Notes
- Use latest stable versions; read each library's installed types/docs rather than relying on memory.
- Do not add dependencies beyond what the above requires; justify each in the commit body.
- Request review per slice (after items 1–2, after 3–4, after 5–7), not only at the end.
