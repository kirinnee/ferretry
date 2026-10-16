# Signing in to a remote MCP server

A person adds a **remote** MCP server (one reached at a `url`) that asks for OAuth, and finishes the
whole sign-in from the PWA — on a phone or a desktop — without opening a terminal. The daemon is the
OAuth client. The tokens it receives go into the daemon's [secret store](secrets.md) and an agent
uses them the way it uses every other secret: by name, never by value.

Read [secrets.md](secrets.md) first. Everything this page promises about a token is that store's
promise, and its threat model is this feature's threat model.

## The shape

1. The MCP component says it signs in: `auth: oauth` on a server that has a `url`.

   ```yaml
   components:
     mcp:
       linear:
         url: https://mcp.linear.app/mcp
         auth: oauth
   ```

   In the PWA this is the **Signs in with OAuth** switch in the MCP component's form.

2. **Components → the server → Sign in.** The daemon discovers the server's authorization server,
   registers itself as a client, and answers with an authorization link.
3. The person opens the link, signs in at the provider, and the provider sends the browser back to the
   PWA's callback page. The callback page hands the address to the tab that started the sign-in, and
   that tab sends it to the daemon over the session it already has.
4. The daemon checks the address, exchanges the code with the PKCE verifier only it holds, and stores
   the tokens as secrets. The component now reads **Signed in · expires …**.
5. Every runtime that uses the component is launched with the access token in an environment variable
   that the harness turns into an `Authorization: Bearer` header. The agent never sees it.

**Sign out** deletes the stored tokens (and asks the provider to revoke the refresh token when it
advertises a revocation endpoint).

## What the protocol is

The [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
for HTTP transports, which is OAuth 2.1 with these pieces:

| Step                          | Standard                                    | What the daemon does                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find the resource's metadata  | RFC 9728 (Protected Resource Metadata)      | Sends one unauthenticated MCP `initialize` and reads `resource_metadata` from the `401`'s `WWW-Authenticate`; otherwise tries `/.well-known/oauth-protected-resource<path>` then `/.well-known/oauth-protected-resource`.                     |
| Find the authorization server | RFC 8414, OpenID Connect Discovery          | Takes the first `authorization_servers` entry and tries the RFC 8414 and OIDC well-known addresses in the order the MCP spec gives. A server with no resource metadata is treated as its own authorization server (the 2025-03-26 behaviour). |
| Become a client               | RFC 7591 (Dynamic Client Registration)      | Registers a public client (`token_endpoint_auth_method: none`) for the exact redirect address, once per authorization server and redirect, and keeps the registration.                                                                        |
| Authorize                     | OAuth 2.1 auth code + PKCE (S256), RFC 8707 | Sends `code_challenge`, a single-use `state` and `resource` (the server's canonical address). A server whose metadata does not list `S256` is refused.                                                                                        |
| Mix-up defence                | RFC 9207                                    | When the callback carries `iss`, it must be the issuer this flow discovered.                                                                                                                                                                  |
| Redeem and refresh            | RFC 6749 §4.1.3, §6                         | Posts the code with the verifier; later posts the refresh token. Never follows a redirect.                                                                                                                                                    |
| Sign out                      | RFC 7009                                    | Best-effort revocation of the refresh token, then deletion.                                                                                                                                                                                   |

## The callback: which one is built, and why

**Built: a redirect to the PWA, with the pasted address as the fallback for the same page.**

The redirect address is `<PWA origin>/oauth/mcp-callback` — for the hosted PWA,
`https://ferretry.pages.dev/oauth/mcp-callback`. The PWA computes it from its own origin and sends it
when it starts the sign-in. That page is a tiny static document (`packages/pwa/public/oauth/`), not
the app: it does not need the daemon, the pairing store or a service worker to do its job, and it
holds the code for no longer than it takes to hand it on.

- **Same browser (desktop, Android, a phone browser tab).** The callback page posts
  `{ type: 'callback', id, href }` on the same-origin `BroadcastChannel` `ferretry-mcp-oauth`. Only
  the tab whose flow `state` matches takes it: it answers `{ type: 'received', id }` at once — the
  callback page then wipes the code from its own address bar — submits the address to the daemon over
  its existing (direct or relayed) session, and answers `{ type: 'finished', id, ok }` once the daemon
  has redeemed it. Only then does the callback page say "Signed in". No answer repeats the address. The
  page is served with `Cache-Control: no-store` (`/oauth/*` in `_headers`), so no cache or
  back-forward copy keeps the code.
- **A different browser context (an installed iOS PWA opens links in Safari, a private window).**
  Nobody answers on the channel. The callback page says so and offers **Copy this address**; the
  person pastes it into the sign-in sheet, which takes it through exactly the same check.

Why not a callback the DAEMON serves? The daemon is usually not reachable by the browser at the
address an OAuth provider can redirect to — on a phone, through the relay, it never is — and a
provider must be given one fixed address at registration. The PWA's origin is the one address every
browser that uses Ferretry can already load.

**Fallback when a provider refuses the PWA address.** Some providers only allow loopback redirects
for public clients. When registration with the PWA address is refused, the daemon registers
`http://127.0.0.1/oauth/mcp-callback` instead (RFC 8252 §7.3) and the sheet switches to the Codex
pattern: _"After you sign in, the page will fail to load. Copy its address and paste it here."_ A
person can also ask for this mode from the sheet when the provider's own page rejects the redirect.
Nothing listens on that address; the browser's failed page is the point.

## The rules a pasted or delivered address must pass

The address carries an authorization code, so it is treated like the Codex link
(`packages/daemon/src/lib/fleet-login/codex-link.ts`):

- It must parse as a URL with the flow's redirect address's exact scheme, host, port and path, no
  credentials and no fragment.
- Its query may hold only `code`, `state`, `iss`, `scope`, `session_state` (and `error`,
  `error_description`, `error_uri` on a failure), each at most once.
- `state` must equal the flow's state. The flow is **single-use**: it is consumed before the code is
  redeemed, so a second submission — including a replay of the same address — is refused.
- `iss`, when present, must equal the discovered issuer.
- A flow expires **ten minutes** after it starts.
- Every refusal is a sentence about the KIND of thing pasted. None quotes it.
- The value travels in a POST body, is never logged, never stored, never put in a response and never
  reaches the audit log.

## Where the tokens live

| Secret name                 | Holds                                           |
| --------------------------- | ----------------------------------------------- |
| `MCP_<NAME>_<HASH>_ACCESS`  | the access token                                |
| `MCP_<NAME>_<HASH>_REFRESH` | the refresh token, when the provider issued one |
| `MCP_<NAME>_<HASH>_CLIENT`  | a client secret, when registration returned one |

`<NAME>` is the component name upper-cased with every other character turned into `_` (at most 24
characters) and `<HASH>` is eight hex digits of the component's exact name, so `my-server` and
`my_server` never share a secret. The derivation has one owner, `mcpOAuthSecretNames` in
`@ferretry/protocol`, which the fleet's materialiser and the daemon both call. These are ordinary
secrets: they appear by name in **Settings → Secrets**, they are redacted from transcripts, and no route
returns one.

What is not secret — the issuer, the token endpoint, the client id, the scope, the expiry — is kept
beside them in `<FY_HOME>/state/mcp-oauth.json`, which never holds a value from the store.

## How an agent uses the token

The materialiser writes, for an `auth: oauth` server named `linear`:

- **Claude** (`.claude.json`):
  `"linear": { "type": "http", "url": "…", "headers": { "Authorization": "Bearer ${FY_MCP_LINEAR_1A2B3C4D_TOKEN}" } }`
  — Claude Code expands `${VAR}` in an MCP server's headers from its own environment.
- **Codex** (`config.toml`): `[mcp_servers.linear] url = "…"` and
  `bearer_token_env_var = "FY_MCP_LINEAR_1A2B3C4D_TOKEN"`.

and binds `FY_MCP_LINEAR_1A2B3C4D_TOKEN` to `${secret:MCP_LINEAR_1A2B3C4D_ACCESS}` in the runtime's
launch environment, which the launch resolves exactly as it resolves a settings component's `env`. The
configuration file holds a variable NAME, never a value.

Both harness behaviours are INFERRED from their documentation, like the rest of the adapter table in
`packages/fleet/src/lib/account/adapt.ts`.

A server marked `auth: oauth` that has never been signed in **refuses the launch** with the missing
secret's name — the store's ordinary rule. A blank `Authorization` header would fail twenty minutes
later with nothing to point at.

## Refresh: on use only

There is no timer. When a runtime is launched, the launch environment asks the MCP sign-in service to
make the access tokens it is about to resolve current: any that expires within the next minute and has
a refresh token is refreshed first, and the new tokens replace the old ones in the store. A refresh
that fails does not stop the launch — the harness then reports the server as unauthorised, and the
component reads **Needs sign-in** — because one expired server should not keep an agent from starting.
A refresh the provider REJECTS (`invalid_grant`) marks the sign-in as needing a new one.

## Governance

| Route                                     | Capability / axis   | Audited as                                        |
| ----------------------------------------- | ------------------- | ------------------------------------------------- |
| `GET /v1/fleet/mcp-auth`                  | `fleet` / use       | —                                                 |
| `POST /v1/fleet/mcp-auth/:component`      | `fleet` / configure | `fleet.configured` `mcp-sign-in`, subject = name  |
| `POST /v1/fleet/mcp-auth/flows/:flowId`   | `fleet` / configure | `fleet.configured` `mcp-sign-in-finish`, + name   |
| `DELETE /v1/fleet/mcp-auth/flows/:flowId` | `fleet` / configure | `fleet.configured` `mcp-sign-in-cancel`           |
| `DELETE /v1/fleet/mcp-auth/:component`    | `fleet` / configure | `fleet.configured` `mcp-sign-out`, subject = name |

Starting and finishing a sign-in binds this fleet to an account at a provider, which is the same risk
the harness sign-in carries — account substitution — so it takes the same gate: `fleet`/`configure`,
which a caller off this host passes only behind the passkey unlock. A relayed caller is remote by the
carrier rule in [grants.md](grants.md), so a phone through the relay always meets the unlock. The audit
entries carry the component name, the flow id and the outcome — never an address, a code or a token,
because an audit rule can read only path parameters and named response fields.

## Security properties, and the tests that hold each

| Property                                                                                         | Test                                                                   |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| PKCE S256 verifier/challenge are RFC 7636-shaped                                                 | `packages/daemon/tests/unit/mcp-oauth/pkce.test.ts`                    |
| Metadata discovery order, issuer match, S256 required, https/loopback rule                       | `packages/daemon/tests/unit/mcp-oauth/discovery.test.ts`               |
| A callback address is checked strictly and no refusal quotes it                                  | `packages/daemon/tests/unit/mcp-oauth/callback.test.ts`                |
| State is single-use, flows expire, a replay is refused                                           | `packages/daemon/tests/unit/mcp-oauth/service.test.ts`                 |
| End to end against a fake local OAuth + MCP server; no token in any response, log or audit entry | `packages/daemon/tests/integration/mcp-oauth/mcp-oauth-routes.test.ts` |
| The materialised runtime holds a variable name, never a value                                    | `packages/fleet/tests/unit/account-adapt.test.ts` (`auth: oauth`)      |

## What is not built

- **Pre-registered clients — GAP.** A server with no registration endpoint is refused with words. A
  field for a client id the person registered by hand is the next step.
- **Client ID Metadata Documents — GAP.** The newer MCP revision lets a client be identified by a URL
  it hosts; the PWA origin could host one. Not built.
- **Step-up scopes — GAP.** A `403 insufficient_scope` from a running server does not start a new
  sign-in; the person signs in again.
- **Private-address discovery — residual risk.** The daemon refuses a discovered endpoint on a
  loopback or private IP LITERAL when the server itself is not on one, but a public name that resolves
  to a private address is not caught. Discovery only ever runs for a server an operator configured.
