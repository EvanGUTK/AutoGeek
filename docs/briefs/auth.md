# Brief: ag-auth (opus-5-5 / high) — `@autogeek/auth` (M2)

You own how AutoGeek holds and uses user credentials. This is the most security-sensitive package;
when unsure, deny and ask the chief.

## Deliver (atomic commits)
1. **`CredentialStore`** over Electron `safeStorage` behind an injected `SecretCipher` interface
   (so it is unit-testable without Electron). Encrypted blob file in the app's userData dir, atomic
   write (temp + fsync + rename), file mode 0600. Refuse to store when only the plaintext fallback
   backend (`basic_text` on Linux) is available; surface a typed error the UI can explain.
2. **Credential model:** `CredentialRef` (opaque id + label + providerId + kind + createdAt, safe for
   the renderer) vs `ResolvedCredential` (secret material, **main-process only**, never serializable
   across IPC: enforce with a branded type and a test that IPC serialization of it fails).
3. **API-key method:** add / validate (provider-supplied cheap check via an injected validator) /
   rotate / delete / list refs. Keys never logged; a redacting logger wrapper + tests with known
   key shapes.
4. **OAuth 2.0 PKCE (loopback redirect) engine:** state + code_verifier, random port bound to
   127.0.0.1 only, single-use callback with timeout and abort, token refresh with single-flight
   (concurrent callers share one refresh), clock-skew tolerance, revocation on delete. Generic
   engine configured per provider; **no provider-specific subscription flows** (see DECISIONS D-002).
5. **Spend/limit metadata:** per-credential optional monthly cap + usage ledger (updated from
   `usage` ModelEvents via an injected sink).
6. **IPC handlers** for the above via the core IPC contract (define the channels in `core` with
   the chief's OK; renderer only ever receives refs).

## Acceptance
Threat-model tests: secret never appears in IPC payloads, logs, thrown error messages, or child
process env; tampered/corrupt store fails closed; crash mid-write does not lose the old store.
`pnpm verify` green per commit; ag-reviewer APPROVE.
