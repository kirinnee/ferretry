# Signing in to a remote MCP server

A person adds a **remote** MCP server (one reached at a `url`) that asks for OAuth, and finishes the
whole sign-in from the PWA — on a phone or a desktop — without opening a terminal. The daemon is the
OAuth client. The access token it receives goes into the daemon's [secret store](secrets.md); the
refresh token and any client secret go into a daemon-internal store nothing else can read.

A **project's** `.mcp.json` server signs in through this same flow, under a subject naming the server and
its project, and reaches Claude Code as a local-scope entry for that project — see
[mcp-scopes.md](mcp-scopes.md#signing-in-to-a-project-server), which also lists every scope a ferret reads
servers from and how a server is checked.

Read [secrets.md](secrets.md) first, and the [threat model](#threat-model) below. The useful property
here is narrower than "the agent never sees the token" — **an agent CAN read the access token.**

## The shape

1. The MCP component says it signs in: `auth: oauth` on a server that has an `https://` `url`.

   ```yaml
   components:
     mcp:
       linear:
         url: https://mcp.linear.app/mcp
         auth: oauth
   ```

   In the PWA this is the **Signs in with OAuth** switch in the MCP component's form. `auth: oauth` on
   a plain-`http://` address is refused by the schema and by the daemon — the token would travel in
   cleartext — except on this machine (`localhost`, `127.0.0.0/8`, `[::1]`).

2. **Components → the server → Sign in.** The daemon discovers the server's authorization server,
   registers itself as a client, and answers with an authorization link. The sheet names the host that
   link actually opens.
3. The person opens the link, signs in at the provider, and the provider sends the browser back to the
   PWA's callback page. The callback page hands the address to the tab that started the sign-in, and
   that tab sends it to the daemon over the session it already has.
4. The daemon checks the address, exchanges the code with the PKCE verifier only it holds, and files
   the tokens. The component now reads **Signed in · expires …**.
5. Every runtime that uses the component is launched with the access token in an environment variable
   that the harness turns into an `Authorization: Bearer` header.

**Sign out** asks the provider to revoke the refresh token when it advertises a revocation endpoint,
then deletes every token, client secret and record the sign-in left.

## Threat model

### What this protects against

- **A token on a screen, in a response, in a log or in the audit log.** No route returns one; the wire
  schemas have no field for one; refusals are sentences chosen by the daemon — the one place a provider's
  own words appear is a REGISTRATION refusal, whose request carried no credential to echo, and even there
  they are cleaned and masked ([below](#when-a-provider-will-not-register-ferretry)); audit entries hold the component name,
  the flow id and the outcome.
- **A token in a configuration file.** `.claude.json` and `config.toml` hold a variable NAME.
- **A token sent to a server it was not issued for.** The secret's name is derived from the component
  AND the server's canonical address. Change a component's `url` — by hand, in the PWA, or by importing
  a same-named component — and the runtime names a secret the store does not hold: the launch is
  **refused**, nothing is sent, and the component reads **Needs sign-in**.
- **A code from one provider finishing a flow with another (the mix-up attack).** Every authorization
  server gets its own callback address — a path on the PWA, a port on loopback — and `iss` is required whenever the provider advertises
  `authorization_response_iss_parameter_supported` (RFC 9207). See [the callback rules](#the-rules-a-pasted-or-delivered-address-must-pass).
- **Spending the refresh token from outside.** The refresh token and any client secret are kept in a
  separate sealed document (`state/mcp-oauth-secrets.json`, same key as the vault). No route lists
  them, `POST /v1/secrets/use` cannot spend them, and `${secret:…}` cannot resolve them. Only the
  sign-in service reads them, and only to send them to the token or revocation endpoint of the
  provider that issued them.
- **Burning the refresh token with concurrent launches.** A refresh is single-flight per server.

### What this does NOT protect against

- **The agent reading the access token. — GAP.** The token is in the harness process's environment,
  because that is where Claude's `${VAR}` header expansion and Codex's `bearer_token_env_var` read it
  from — and an agent's shell tools inherit that environment. `printenv FY_MCP_*` shows it; a
  prompt-injected agent can send it anywhere. This is the same boundary as a profile's
  `store: environment` credential ([secrets.md](secrets.md#why-use-instead-of-injecting-into-the-agent)).
  The access token is short-lived and scoped to one MCP server, and redaction masks it in transcripts,
  but **treat an agent that uses a signed-in server as holding that server's access token.** Moving the
  value out of the agent's environment needs a harness header helper (Claude's `headersHelper`) calling
  a daemon `use`-style command; not built.
- **A slow or hostile authorization server delaying launches. — partial.** Expiring tokens are
  refreshed in parallel, each bounded by the 15-second request timeout, so a launch waits at most about
  15 seconds for them; there is no separate overall deadline.
- **A public name that resolves to a private address during discovery. — residual risk.** Discovery
  refuses endpoints on loopback, private, link-local, CGNAT (`100.64/10`), unspecified and
  IPv4-mapped-IPv6 forms of those when they are written as IP literals and the server itself is not
  on one; a DNS name is not resolved and checked. Discovery only runs for a server a configure-holder
  named.
- **Anyone who can read the state home.** As [secrets.md](secrets.md) says: the key sits beside the
  ciphertext.

## What the protocol is

The [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
for HTTP transports, which is OAuth 2.1 with these pieces:

| Step                          | Standard                                    | What the daemon does                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find the resource's metadata  | RFC 9728 (Protected Resource Metadata)      | Sends one unauthenticated MCP `initialize` and reads `resource_metadata` from the `401`'s `WWW-Authenticate`; otherwise tries `/.well-known/oauth-protected-resource<path>` then `/.well-known/oauth-protected-resource`. `resource` must name this server by whole path segments.                                                                                                                                               |
| Find the authorization server | RFC 8414, OpenID Connect Discovery          | Takes the first `authorization_servers` entry and tries the RFC 8414 and OIDC well-known addresses in the order the MCP spec gives. A server with no resource metadata is treated as its own authorization server (the 2025-03-26 behaviour).                                                                                                                                                                                    |
| Become a client               | RFC 7591 (Dynamic Client Registration)      | Registers the way Claude Code does — a public client (`token_endpoint_auth_method: none`, or what `token_endpoint_auth_methods_supported` allows), its scope included — retrying a `4xx` a few ways at most ([below](#when-a-provider-will-not-register-ferretry)). Keeps at most four registrations per component, never the one the live sign-in uses. A [client registered by hand](#a-client-registered-by-hand) skips this. |
| Authorize                     | OAuth 2.1 auth code + PKCE (S256), RFC 8707 | Sends `code_challenge`, a single-use `state` and `resource` (the server's canonical address). A server whose metadata does not list `S256` is refused.                                                                                                                                                                                                                                                                           |
| Mix-up defence                | OAuth Security BCP §4.4, RFC 9207           | A callback path per authorization server; `iss` checked when present and required when advertised.                                                                                                                                                                                                                                                                                                                               |
| Redeem and refresh            | RFC 6749 §4.1.3, §6                         | Posts the code with the verifier; later posts the refresh token, once per server however many launches ask. Never follows a redirect. A stored endpoint is re-checked before anything is sent to it.                                                                                                                                                                                                                             |
| Sign out                      | RFC 7009                                    | Best-effort revocation of the refresh token, then deletion.                                                                                                                                                                                                                                                                                                                                                                      |

## The callback: which one is built, and why

**Built: a redirect to the PWA, with the pasted address as the fallback for the same page.**

The PWA sends its callback base, `<PWA origin>/oauth/mcp-callback`, when it starts a sign-in. The
daemon appends one segment naming the authorization server — the first 16 hex digits of SHA-256 of its
issuer (`mcpOAuthRedirectPath`) — so the redirect for the hosted PWA looks like
`https://ferretry.pages.dev/oauth/mcp-callback/3f1a…`. Every path under the base is the same tiny
static page (`packages/pwa/public/oauth/`, rewritten by `/oauth/mcp-callback/*` in `_redirects`), not
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
for public clients. When registration with the PWA address is refused with any `4xx`, the daemon registers
`http://localhost:<port>/callback` instead — Claude Code's own shape, so a provider that admits Claude admits
it — on a random ephemeral port drawn once per provider (RFC 8252 §7.3) and never one another provider's
loopback registration holds: on loopback, the PORT is the per-provider part of the address that the mix-up
defence needs (the PWA address carries a per-provider path instead). The sheet switches to the Codex pattern: _"After you sign in, the
page will fail to load. Copy its address and paste it here."_ A person can also ask for this mode from
the sheet when the provider's own page rejects the redirect. Nothing listens on that address; the
browser's failed page is the point.

## When a provider will not register Ferretry

Registration is where a provider decides whether to take a new app, so it is where most sign-ins that
work for Claude Code but not for Ferretry would fail. The daemon asks the way Claude Code asks first, and
then a few other ways — at most **four requests** per sign-in, each changing one thing — before it gives up
(`packages/daemon/src/lib/mcp-oauth/registration.ts`):

1. **The provider's error talks about client authentication** (`token_endpoint_auth_method`, "public
   clients", "client secret") → ask for `client_secret_post`, then `client_secret_basic`. A secret the
   provider returns goes into the internal store as before, and is sent the way it was registered for —
   in the form, or as an RFC 6749 §2.3.1 Basic credential — on every token, refresh and revocation request.
2. **It talks about another field** (a scope, a grant or response type) → send only the required fields.
3. **The PWA's address was sent** → a `localhost` address, and the sheet becomes a paste flow
   ([the fallback](#the-callback-which-one-is-built-and-why)).
4. **A plain `400`** → only the required fields, once.

A `5xx`, an answer with no client id, or no answer at all is not retried. When the provider's metadata
lists `token_endpoint_auth_methods_supported` without `none`, the first request already asks for a method
it lists.

**A refusal says why.** It leads with a plain line and then the facts: the endpoint's host, the HTTP
status, and the provider's RFC 7591 §3.2.2 `error` and `error_description`, and every way it was asked:

> The sign-in provider refused new apps: invalid_client_metadata — redirect_uris must be https.
> auth.example.com answered HTTP 400 to Ferretry's registration. Tried 3 ways: the Ferretry page; a
> localhost address; a localhost address, required fields only. If it only accepts apps registered by hand,
> register one there and give its client id to this server's "oauth" settings (docs/mcp-oauth.md).

The provider's words are repeated only here, because a registration request carries no credential for them
to echo. They are still cut to one line of at most 300 characters, a web address loses its query and
fragment, and a `name=value` whose name says secret, token, password, key or code — and any long word with
digits in it — reads `[redacted]`. A token endpoint's words are never repeated.

The PWA shows this under **Details**, with **Couldn't start signing in to <server>** as the headline. A
refusal the daemon worded is never read as the machine being unreachable, whatever words it uses.

## When the daemon can't reach the provider

A registration (or discovery) request that gets no answer at all says so, with the kind of failure:

> Ferretry's daemon couldn't reach auth.example.com to register Ferretry — its certificate is not one the
> daemon trusts (network error: UNABLE_TO_GET_ISSUER_CERT_LOCALLY). If this machine needs a proxy or a
> company certificate, the daemon needs them too…

The code is the runtime's own (`ENOTFOUND` for a name that does not resolve, `ConnectionRefused`,
`TIMEOUT` after 15 seconds, a certificate code for TLS). **Check** can succeed while this fails: the MCP
server and its sign-in provider are often different hosts, and only the provider may sit behind a proxy or a
company certificate authority.

The daemon runs under the service manager, not your shell, so it does **not** see what your shell exports.
Its `fetch` honours `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`, and reads extra certificate authorities from
`NODE_EXTRA_CA_CERTS` (a PEM file) — when the DAEMON's environment has them:

- **macOS (launchd).** Set them for your login session's launchd, then restart the daemon:

  ```sh
  launchctl setenv HTTPS_PROXY http://proxy.example.com:8080
  launchctl setenv NO_PROXY localhost,127.0.0.1,.internal.example.com
  launchctl setenv NODE_EXTRA_CA_CERTS /path/to/company-root-ca.pem
  fy daemon restart
  ```

  `launchctl setenv` lasts until you log out or restart, so set it again (or from a login item) after a
  reboot. `fy daemon install` rewrites the daemon's own service file, so do not edit that file instead.

- **Linux (systemd user unit).** `systemctl --user edit <the daemon's unit>` and add the same variables as
  `Environment=` lines under `[Service]` (a drop-in survives `fy daemon install`), then `fy daemon restart`.

A proxy address with a password in it is a credential in the service manager's environment, readable by
anything that can read that environment — prefer a proxy that authenticates another way.
`config/daemon.json`'s `secretEnvironment` is NOT the place for these: it shapes what a ferret's launch
gets ([secrets.md](secrets.md)), not the daemon's own requests.

## A client registered by hand

Some providers do not let apps register themselves at all (no registration endpoint), or refuse every way
above. Register an app with the provider yourself — as a desktop / native app whose redirect is
`http://localhost:<port>/callback` — and give the server its client id. The daemon then registers nothing,
and the sign-in is a paste flow returning to that address.

**A Ferretry MCP component** takes Claude Code's field names, plus the client secret as a reference to the
[secret store](secrets.md) — never the value; the schema refuses anything but `${secret:NAME}`:

```yaml
components:
  mcp:
    phoebe:
      url: https://phoebe.example.com/mcp
      auth: oauth
      oauth:
        clientId: 0oa1b2c3d4
        clientSecret: ${secret:PHOEBE_CLIENT_SECRET} # optional; only for a confidential client
        callbackPort: 8123 # optional; the port you registered
```

`oauth` needs `auth: oauth`. An edit of the component in the PWA keeps the block (it has no field there).
Put the secret in **Settings → Secrets** (or `fy secret set PHOEBE_CLIENT_SECRET`) first: a sign-in for a
component naming a secret the store does not hold is refused before anybody is sent anywhere. The daemon
reads that secret only to send it to the provider's token or revocation endpoint — `client_secret_basic`
when the provider's metadata lists only that, `client_secret_post` otherwise — and sign-out leaves it where
you put it.

**A project's `.mcp.json`** server is read the way Claude Code reads it: its `oauth.clientId` and
`oauth.callbackPort` are used as above.

```json
{
  "mcpServers": {
    "phoebe": {
      "type": "http",
      "url": "https://phoebe.example.com/mcp",
      "oauth": { "clientId": "0oa1b2c3d4", "callbackPort": 8123 }
    }
  }
}
```

Without `callbackPort`, the redirect is a fresh `localhost` port each time, which works only with a provider
that accepts any loopback port (RFC 8252 §7.3) — the same as Claude Code.

## The rules a pasted or delivered address must pass

The address carries an authorization code, so it is treated like the Codex link
(`packages/daemon/src/lib/fleet-login/codex-link.ts`):

- It must parse as a URL with the flow's redirect address's exact scheme, host, port and path — which
  includes the authorization server's own segment — no credentials and no fragment.
- Its query may hold only `code`, `state`, `iss`, `scope`, `session_state` (and `error`,
  `error_description`, `error_uri` on a failure), each at most once.
- `state` must equal the flow's state, compared in constant time. The flow is **single-use**: it is
  consumed before the code is redeemed, so a second submission — including a replay — is refused.
- `iss`, when present, must equal the discovered issuer, and it must be present when the provider
  advertised `authorization_response_iss_parameter_supported`.
- A flow expires **ten minutes** after it starts.
- Every refusal is a sentence about the KIND of thing pasted. None quotes it.
- The value travels in a POST body, is never logged, never stored, never put in a response and never
  reaches the audit log.

## Where the tokens live

| Name                        | Store                                     | Holds                                                                               |
| --------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `MCP_<NAME>_<HASH>_ACCESS`  | the secret store (`state/secrets.json`)   | the access token                                                                    |
| `MCP_<NAME>_<HASH>_REFRESH` | internal (`state/mcp-oauth-secrets.json`) | the refresh token, when the provider issued one                                     |
| `MCP_CLIENT_<HASH>`         | internal                                  | a client secret, when registration returned one                                     |
| the name you chose          | the secret store                          | a [hand-registered client](#a-client-registered-by-hand)'s secret, by `${secret:…}` |

`<NAME>` is the component name upper-cased with every other character turned into `_` (at most 16
characters). `<HASH>` is 16 hex digits of SHA-256 over the component's exact name **and the server's
canonical address**, so `my-server` and `my_server` never share a token, and neither does one component
at two addresses. The derivation has one owner, `mcpOAuthSecretNames` in `@ferretry/protocol`, which
the fleet's materialiser and the daemon both call. The access token is an ordinary secret: it appears by
name in **Settings → Secrets**, it is redacted from transcripts, and no route returns it.

What is not secret — the issuer, the endpoints, the client id, the scope, the expiry — is kept in
`state/mcp-oauth.json`, which never holds a value from either store.

## How an agent uses the token

The materialiser writes, for an `auth: oauth` server named `linear`:

- **Claude** (`.claude.json`):
  `"linear": { "type": "http", "url": "…", "headers": { "Authorization": "Bearer ${FY_MCP_LINEAR_<HASH>_TOKEN}" } }`
  — Claude Code expands `${VAR}` in an MCP server's headers from its own environment.
- **Codex** (`config.toml`): `[mcp_servers.linear] url = "…"` and
  `bearer_token_env_var = "FY_MCP_LINEAR_<HASH>_TOKEN"`.

and binds `FY_MCP_LINEAR_<HASH>_TOKEN` to `${secret:MCP_LINEAR_<HASH>_ACCESS}` in the runtime's launch
environment, which the launch resolves exactly as it resolves a settings component's `env`. The
configuration file holds a variable NAME; the runtime's environment holds the VALUE (see the
[threat model](#what-this-does-not-protect-against)).

Both harness behaviours are INFERRED from their documentation, like the rest of the adapter table in
`packages/fleet/src/lib/account/adapt.ts`.

A server marked `auth: oauth` that has never been signed in — or has moved to another address since —
**refuses the launch** with the missing secret's name, the store's ordinary rule. A blank
`Authorization` header would fail twenty minutes later with nothing to point at.

## Refresh: on use only

There is no timer. When a runtime is launched, the launch environment asks the MCP sign-in service to
make the access tokens it is about to resolve current: any that expires within the next minute and has
a refresh token is refreshed first — in parallel across servers, and once per server however many
launches ask at the same moment — and the new tokens replace the old ones. A refresh answer is filed only if the
sign-in is still the same one when it lands; a sign-out or a new sign-in elsewhere in the meantime wins,
and the late tokens are revoked. A refresh that fails does not
stop the launch — the harness then reports the server as unauthorised, and the component reads **Needs
sign-in** — because one expired server should not keep an agent from starting. A refresh the provider
REJECTS (`invalid_grant`), or a stored endpoint that no longer passes the endpoint rules, marks the
sign-in as needing a new one.

## Governance

| Route                                     | Capability / axis   | Audited as                                        |
| ----------------------------------------- | ------------------- | ------------------------------------------------- |
| `GET /v1/fleet/mcp-auth`                  | `fleet` / use       | —                                                 |
| `POST /v1/fleet/mcp-auth/:component`      | `fleet` / configure | `fleet.configured` `mcp-sign-in`, subject = name  |
| `POST /v1/fleet/mcp-auth/flows/:flowId`   | `fleet` / configure | `fleet.configured` `mcp-sign-in-finish`, + name   |
| `DELETE /v1/fleet/mcp-auth/flows/:flowId` | `fleet` / configure | `fleet.configured` `mcp-sign-in-cancel`           |
| `DELETE /v1/fleet/mcp-auth/:component`    | `fleet` / configure | `fleet.configured` `mcp-sign-out`, subject = name |

`:component` is a component's name, or a project server's subject (`<name>..<project key>`,
[mcp-scopes.md](mcp-scopes.md#signing-in-to-a-project-server)).

Starting and finishing a sign-in binds this fleet to an account at a provider, which is the same risk
the harness sign-in carries — account substitution — so it takes the same gate: `fleet`/`configure`,
which a caller off this host passes only behind the passkey unlock. A relayed caller is remote by the
carrier rule in [grants.md](grants.md), so a phone through the relay always meets the unlock. The audit
entries carry the component name, the flow id and the outcome — never an address, a code or a token,
because an audit rule can read only path parameters and named response fields.

## Security properties, and the tests that hold each

Paths are under `packages/daemon/tests/` unless they name another package.

| Property                                                                                                | Test                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PKCE S256 (RFC 7636 Appendix B vector), state and verifier shape                                        | `unit/mcp-oauth/pkce-tokens.test.ts`                                                                                                                      |
| Discovery order, issuer match, S256 required, https/loopback rule, private literals incl. mapped/CGNAT  | `unit/mcp-oauth/discovery.test.ts`                                                                                                                        |
| A callback address is checked strictly, `iss` required when advertised, no refusal quotes it            | `unit/mcp-oauth/callback.test.ts`                                                                                                                         |
| Single-use state, expiry, replay refused                                                                | `unit/mcp-oauth/service.test.ts` › "finishing a sign-in"                                                                                                  |
| H1: a moved component's launch names a secret nobody holds; nothing is sent                             | `unit/mcp-oauth/service.test.ts` › "H1: …", `integration/mcp-oauth/mcp-oauth-routes.test.ts` › "H1: …", `packages/fleet/tests/unit/account-adapt.test.ts` |
| M1: a code at another provider's path cannot finish the flow; `iss` required when advertised            | `unit/mcp-oauth/service.test.ts` › "M1: …"                                                                                                                |
| M2: no sign-in to a plain-HTTP remote server                                                            | `unit/mcp-oauth/service.test.ts` › "M2: …", `packages/fleet/tests/unit/account-schema.test.ts`                                                            |
| M4: the refresh token is not usable through `use` or `${secret:}`                                       | `integration/mcp-oauth/mcp-oauth-routes.test.ts` › "M4: …"                                                                                                |
| M5: concurrent launches spend the refresh token once                                                    | `unit/mcp-oauth/service.test.ts` › "M5: …"                                                                                                                |
| A sign-out (or a new sign-in elsewhere) during an in-flight refresh is not undone by it                 | `unit/mcp-oauth/service.test.ts` › "M-A: …", "L-A: …"                                                                                                     |
| The registration cap never evicts the live sign-in's registration                                       | `unit/mcp-oauth/service.test.ts` › "L-B: …"                                                                                                               |
| No token in any response, console line, audit entry or state file, end to end on loopback               | `integration/mcp-oauth/mcp-oauth-routes.test.ts` › "…and leak no token anywhere"                                                                          |
| Every act needs the unlock from a remote device and never reaches the service before it                 | `unit/runtime/mounts/unlock-gate.test.ts` › "the MCP sign-in behind the unlock"                                                                           |
| The materialised runtime config holds a variable name, never a value                                    | `packages/fleet/tests/unit/account-adapt.test.ts`                                                                                                         |
| Registration asks the way Claude Code does, retries a 4xx at most four ways, never a 5xx                | `unit/mcp-oauth/registration.test.ts`, `unit/mcp-oauth/service.test.ts` › "registering the way real clients do"                                           |
| A registration refusal says the host, status and provider reason, with credential-shaped text masked    | `unit/mcp-oauth/registration.test.ts` › "providerText", `integration/mcp-oauth/mcp-oauth-routes.test.ts` › "…refuses every registration…"                 |
| A secret registered for `client_secret_basic` is sent as Basic on the code, refresh and revoke requests | `unit/mcp-oauth/service.test.ts` › "…client_secret_basic…"                                                                                                |
| A hand-registered client registers nothing; its secret is read by name and survives sign-out            | `unit/mcp-oauth/service.test.ts` › "a client registered by hand", `packages/pwa/tests/integration/mcp-project-sign-in.test.ts`                            |
| A client secret in configuration is only ever a `${secret:NAME}` reference                              | `packages/fleet/tests/unit/account-schema.test.ts`                                                                                                        |
| No answer names the host and the transport's code, never the address                                    | `unit/mcp-oauth/service.test.ts`, `integration/mcp-oauth/mcp-oauth-routes.test.ts` › "…a dead host…"                                                      |

## What is not built

- **Keeping the access token out of the agent's environment — GAP.** See the threat model.
- **A project server's hand-registered client SECRET — GAP.** Claude Code keeps it in its own keychain,
  out of `.mcp.json`, where Ferretry cannot read it; a project server's `oauth.clientId` works as a public
  client only. Give the server a Ferretry component with `oauth.clientSecret` instead.
- **Claude's `oauth.authServerMetadataUrl` and `oauth.scopes` — not read.** Discovery and the server's own
  challenge decide those.
- **The daemon's proxy and certificate environment is not set by `fy daemon install` — GAP.** It is set in
  the service manager by hand ([above](#when-the-daemon-cant-reach-the-provider)); copying the installing
  shell's variables would write a proxy password into the service file.
- **Client ID Metadata Documents — GAP.** The newer MCP revision lets a client be identified by a URL
  it hosts; the PWA origin could host one. Not built.
- **Step-up scopes — GAP.** A `403 insufficient_scope` from a running server does not start a new
  sign-in; the person signs in again.
- **An overall refresh deadline at launch — GAP** (see the threat model).
- **Registration calls to the provider are not capped — accepted.** At most four registrations are
  KEPT per component (never the one the live sign-in uses), but each sign-in started from a new PWA
  origin still sends up to four registration requests to the provider before the local cap prunes. It takes
  `fleet`/`configure` to cause, so it is self-inflicted; allowing only one PWA origin per component
  would close it at the cost of signing in from a self-hosted and the hosted PWA alike.
