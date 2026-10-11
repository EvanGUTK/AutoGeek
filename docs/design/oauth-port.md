# Design: `OAuthPort` — OAuth for remote MCP servers

- **Status:** proposed (ag-auth). This is a design for review, not a decision; the chief signs off.
  It gets discussed with ag-mcp when wave 3 starts.
- **Context:** `mcp` needs OAuth for remote (streamable HTTP) servers, but it has no dependency edge
  to `auth` (ARCHITECTURE.md §4, LEARNINGS L-005). So `core` defines a port, `auth` implements it
  with its existing PKCE engine, and `apps/desktop` wires the two together.
- **Spec caveat:** the MCP authorization spec is revised from time to time. Items marked **[verify]**
  must be checked against the revision that is current when wave 3 starts. Nothing here is built
  from memory of the spec.

## 1. Principle: `mcp` never holds a token

The port does not hand `mcp` a token string, or even a pre-built `Authorization` header. It gives
`mcp` an **authorized fetch** instead: `mcp` describes the request, and `auth` attaches the token
and sends it, but only to the origin the grant is bound to. Consequences:

- A compromised or buggy `mcp` (or a hostile server's output steering it) cannot exfiltrate a token
  or replay it to another host. The worst it can do is make requests to the server the user already
  authorized.
- Token audience binding (no token passthrough to other servers) is enforced in one place, by
  construction.
- Refresh, 401 handling and storage stay entirely inside `auth`.

## 2. Port shape (in `@autogeek/core`)

```ts
/** Opaque handle to one authorization: one MCP server (resource) at one authorization server. */
type OAuthGrantId = string & { readonly __brand: 'OAuthGrantId' };   // /^grant_[A-Za-z0-9_-]{22}$/

interface McpAuthorizationRequest {
  /** Canonical URI of the MCP server: the RFC 8707 `resource` and the audience of every token. */
  readonly resource: string;
  /** The `resource_metadata` URL from the server's 401 WWW-Authenticate header, if any. Untrusted. */
  readonly resourceMetadataUrl: string | null;
  /** Requested scopes. auth may narrow them to what the metadata advertises. */
  readonly scopes: readonly string[];
  /** Shown in the consent confirmation, through the display-safe function (ui-spec §8). */
  readonly serverDisplayName: string;
}

/** A request `mcp` wants sent. auth adds `Authorization` and refuses any other target origin. */
interface AuthorizedRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly headers: Readonly<Record<string, string>>;   // must not contain Authorization or Cookie
  readonly body: Uint8Array | null;                     // buffered, so one 401 retry is possible
}

interface OAuthPort {
  /** Discovers the authorization server, registers the client if needed, runs consent in the
   *  browser, and stores the tokens. Long-lived: it resolves when the user finishes or cancels. */
  authorize(req: McpAuthorizationRequest, signal: AbortSignal):
    Promise<Result<{ grantId: OAuthGrantId }, OAuthPortError>>;

  /** Sends `req` with a fresh access token for `grantId`. Only to the grant's resource origin.
   *  On 401 it refreshes once (single-flight) and retries once; the response stream is returned. */
  fetch(grantId: OAuthGrantId, req: AuthorizedRequest, signal: AbortSignal):
    Promise<Result<Response, OAuthPortError>>;

  /** Revokes (RFC 7009, when the server supports it) and deletes the grant. */
  revoke(grantId: OAuthGrantId, signal: AbortSignal):
    Promise<Result<{ revoked: boolean }, OAuthPortError>>;
}

type OAuthPortError =
  | { kind: 'discovery_failed' }        // metadata unreachable, invalid, or failed a binding check
  | { kind: 'registration_failed' }     // dynamic client registration refused or invalid
  | { kind: 'user_declined' }           // the main-built consent confirmation was declined
  | { kind: 'oauth_timeout' } | { kind: 'oauth_aborted' }
  | { kind: 'oauth_provider_error'; oauthError: string }   // RFC 6749 shape only, else 'unknown'
  | { kind: 'reauth_required' }         // refresh token missing, revoked or expired
  | { kind: 'target_mismatch' }         // req.url is not the grant's resource origin; no I/O done
  | { kind: 'not_found' } | { kind: 'network' } | { kind: 'secure_storage_unavailable' };
```

`mcp` keeps only `grantId` plus display data in its server config. The renderer sees neither the
grant id nor any token. It sees MCP server status, including a `reauth_required` state it can offer
to resolve.

## 3. What `auth` does inside the port

1. **Discovery (RFC 9728, then RFC 8414)** **[verify]**
   - Fetch Protected Resource Metadata, from `resourceMetadataUrl` if given, else from the
     well-known path under `resource`.
   - Require its `resource` to equal the request's canonical `resource` (RFC 9728 §3.3), and
     pick an authorization server from `authorization_servers`.
   - Fetch Authorization Server Metadata. Require `issuer` to equal the issuer it was fetched
     for (RFC 8414 §3.3), `code_challenge_methods_supported` to include `S256`, and every
     endpoint to be https.
2. **Client identity** **[verify: current MCP spec order of preference]**
   - A pre-registered client id from config, else whatever the current spec prefers (Dynamic
     Client Registration, RFC 7591, or a client-ID metadata document).
   - The client id is stored per issuer and never shared across issuers.
3. **Consent:** before opening the browser, main shows a native confirmation built from main's
   own data:
   - "<server display name> at <resource host> wants you to sign in at <issuer host>"
   - shown through the display-safe function, with punycode visible
   - declining returns `user_declined`
   - this follows the D-010 pattern (main-built native dialogs)
4. **Flow:** the existing `runPkceFlow` engine.
   - One-shot 127.0.0.1 listener, fresh state and S256 verifier, browser via `openExternal`.
   - `resource` is sent on the authorization request AND on the token requests (exchange and
     refresh), per RFC 8707.
   - The token client gains a `resource` parameter at that point, with tests. Per the chief, it
     is not added before ag-mcp needs it.
5. **Storage:** a grant record lives in the vault's encrypted document, next to credentials:
   `{ grantId, resource, issuer, clientId, scopes, tokens }`. Same envelope, same atomic writes,
   same redaction registry.
6. **Fetch:**
   - Check that `req.url`'s origin equals the grant's resource origin. Otherwise
     `target_mismatch`, before any I/O.
   - Get the access token through the token refresher (single-flight, rotation-safe).
   - Attach `Authorization: Bearer …`, send with redirects refused, and return the streaming
     response.
   - On 401, call the refresher with `rejected` set to the token just used, then retry once.
     A second 401 returns `reauth_required`.
7. **Revoke:** RFC 7009 if the authorization server advertises `revocation_endpoint`. Local
   deletion happens regardless, and `revoked: false` is reported honestly.

## 4. Security notes

- **SSRF on discovery.** `resourceMetadataUrl` and every metadata-provided endpoint come from the
  server or the authorization server, so they are untrusted. Rules:
  - https only; no userinfo or fragment; redirects refused
  - body cap, timeout, and zod-validated schemas with the same total-parse rules as the token
    client
  - **Open question for the chief:** whether to refuse private, loopback and link-local
    addresses for discovery when the MCP server itself is public. Recommendation: refuse,
    unless the address is the MCP server's own origin, and check after DNS resolution.
- **Issuer and resource binding:**
  - the `resource` check (RFC 9728 §3.3) and the `issuer` check (RFC 8414 §3.3) are mandatory
  - every token request carries `resource`
  - a grant's tokens are only ever sent to its resource origin (§3.6)
- **Mix-up defense:**
  - each flow has its own listener port, so a distinct `redirect_uri`, and its own `state`;
    a code can only complete the flow that started it
  - when the AS advertises `authorization_response_iss_parameter_supported`, require `iss` in
    the redirect and match it to the expected issuer (RFC 9207)
- **Per-server isolation:**
  - grants are keyed by (resource, issuer); there is no grant sharing between servers, even on
    the same authorization server
  - removing a server removes its grant
- **Redirect refusal** on every OAuth and metadata HTTP request, so codes, tokens and refresh
  tokens never follow a redirect to another host.
- **No raw tokens outside `auth`:** not in `mcp`, not in IPC, not in logs, not in error values
  (constant messages per code, as with `AuthError`).
- **Consent shows the real parties**, built by main and never by the renderer or the server, so a
  server cannot disguise which authorization server it sends the user to.

## 5. Out of scope here

- Subscription or consumer OAuth for model providers (D-002); this port is for MCP servers only.
- stdio MCP servers, which do not use OAuth.
- Client secrets or confidential clients: AutoGeek is a public client and uses PKCE only.

## 6. Open questions

1. SSRF policy for private addresses during discovery (§4).
2. **[verify]** The current MCP spec's preferred client-identity mechanism (§3.2).
3. Whether `fetch` should also cover the SSE GET stream, or `mcp` opens it through the same call
   (proposed: same call; the response body is a stream).
