# Remote MCP connector — Ferretry as a Claude connector

Read this before changing anything under `packages/daemon/src/lib/connector/`, the connector listener, the
`/v1/connector/*` routes, `fy connector` or the app's Connectors panel. It is the contract; implement against it,
not against the code.

## The one-sentence version

**The daemon can expose ONE remote MCP endpoint (`<publicUrl>/mcp`) on its own loopback-only listener, behind
a public HTTPS tunnel the owner runs, protected by an OAuth 2.1 authorization server the daemon itself runs;
a sign-in is approved by the owner inside the paired Ferretry app with a passkey, and every tool acts through
the daemon's own API with exactly the nine tools below.**

It is **off by default**. Turning it on is an edit to `<FY_HOME>/config/daemon.json` on the host — a phone cannot
turn it on.

## Why the approval happens in the app, not on the sign-in page

A passkey is bound to the origin it was registered on (WebAuthn `rpId`). The owner's passkeys belong to the
Ferretry app (`https://ferretry.pages.dev`, or `FY_APP_URL`), not to whatever hostname serves `/mcp`. Registering
passkeys on the tunnel hostname would be a second, weaker login nobody asked for. So:

1. Claude opens `<publicUrl>/oauth/authorize?...` (in a browser, a popup, or an in-app browser on a phone).
2. The daemon validates the request and shows a **waiting page**: the client's name, the scopes, a short
   **match code** (`K7Q-2MF`) and an **Open Ferretry** link. The page refreshes itself every 2 s (`<meta
http-equiv="refresh">`, no script).
3. The owner opens Ferretry on any paired device (the link deep-links to the Connectors panel), sees the same
   client, scopes and match code, and taps **Approve** — a passkey step-up for the `approve-connector` act.
4. The waiting page's next refresh redirects to Claude's callback with a one-time code.

This is the device-authorization shape on purpose: on iOS the Claude app opens sign-in in an in-app browser whose
storage is NOT the installed Ferretry app's, so a same-browser hand-off into the app would find no paired device.
The match code is the phishing defence the shape needs: approve only a request whose code is the one on the
page you yourself just opened from Claude.

The waiting page holds a **handle** (256 random bits) the approval side never sees; the app refers to a request
by a separate public id. The authorization code is only ever handed to the holder of the handle, and only by
redirect to the request's registered, allow-listed `redirect_uri`.

At the machine, `fy connector approve <id|match code>` approves without a passkey (the host's admin token is
ungoverned — docs/grants.md). That is also how the automated end-to-end test approves.

## Where it listens

- A **dedicated listener** on `127.0.0.1:<connector.port>` (default `7461`). It is never the API listener and
  never the tunnel listener. `cloudflared` (or any reverse proxy) forwards the public hostname to it.
- Every arrival on it is **remote and unprivileged**, whatever its peer address says: a tunnel terminating on
  this host looks loopback (docs/grants.md "Loopback means how the request arrived"), so this listener grants
  nothing for being local. The only credential `/mcp` accepts is a connector access token.
- It serves exactly these paths and answers `404` to everything else (no `405` that maps the surface):

| method     | path                                                                                    | what                                            |
| ---------- | --------------------------------------------------------------------------------------- | ----------------------------------------------- |
| GET        | `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource` | RFC 9728 protected resource metadata            |
| GET        | `/.well-known/oauth-authorization-server`                                               | RFC 8414 authorization server metadata          |
| POST       | `/oauth/register`                                                                       | RFC 7591 dynamic client registration            |
| GET        | `/oauth/authorize`                                                                      | starts a sign-in, 302 to the waiting page       |
| GET        | `/oauth/authorize/wait?h=<handle>`                                                      | the waiting page / the final redirect           |
| POST       | `/oauth/token`                                                                          | `authorization_code`, `refresh_token`           |
| POST       | `/oauth/revoke`                                                                         | RFC 7009                                        |
| POST       | `/mcp`                                                                                  | MCP Streamable HTTP, stateless, JSON            |
| GET/DELETE | `/mcp`                                                                                  | `405` (no server-initiated stream, no sessions) |

## Configuration

`<FY_HOME>/config/daemon.json`:

```json
{
  "connector": {
    "enabled": true,
    "publicUrl": "https://ferretry-mcp.example.com",
    "port": 7461,
    "extraRedirectUris": []
  }
}
```

- `publicUrl` — `https://` origin (no path, no query, no credentials); the issuer and the resource are derived
  from it: issuer = `publicUrl`, resource = `publicUrl + "/mcp"`. `http://127.0.0.1:<port>` / `http://localhost`
  is accepted only for local testing.
- `extraRedirectUris` — exact redirect URIs allowed IN ADDITION to Claude's (for MCP Inspector or a test client,
  e.g. `http://localhost:6274/oauth/callback`). Each must be `https://`, or `http://` on a loopback host.
- Absent, `enabled: false`, or an invalid `publicUrl` → no listener, and `fy connector` says why.

## Allowed redirect URIs

`https://claude.ai/api/mcp/auth_callback` (verbatim from Anthropic's documentation, see "Sources"), plus
`extraRedirectUris`. Dynamic client registration REFUSES (`invalid_redirect_uri`) a client whose
`redirect_uris` contains anything else, and `/oauth/authorize` matches the redirect URI by exact string against
the client's registered list AND re-checks it against the CURRENT allow-list (configuration can shrink between
restarts, so a URI removed from `extraRedirectUris` stops authorizing even for a client registered with it). An
unknown client or a redirect URI problem is shown as an error page and NEVER redirected to.

## OAuth 2.1 details

- **Clients** (DCR): `client_name` ≤ 100 chars (shown on every screen, control characters stripped),
  `redirect_uris` 1–5 allowed URIs, `grant_types` ⊆ {`authorization_code`, `refresh_token`},
  `response_types` = [`code`], `token_endpoint_auth_method` ∈ {`none` (default), `client_secret_post`,
  `client_secret_basic`}; a secret is issued only for the latter two and stored as a SHA-256 hash.
  Limits: at most 20 registered clients, 10 registrations per hour per source address (200 per hour overall),
  request body ≤ 8 KiB. A client with no grant, no waiting sign-in and no redeemable code is reclaimable 1 h after it
  registered, a client whose grants are all dead 24 h after, and reclaimable clients are dropped first when the cap is
  reached; only if none is reclaimable is a registration refused.
- **Authorize**: `response_type=code`, `client_id`, `redirect_uri` (required, exact), `code_challenge` +
  `code_challenge_method=S256` (required — `plain` and absent are refused), `state` (passed through),
  `scope` (⊆ `fleet:read fleet:write`; absent means both), `resource` (if present, must equal the resource
  URI after canonicalisation — lowercase scheme and host, default port dropped, one trailing `/` ignored). A request lives 10 minutes. Undecided sign-ins are capped at 2 per client, 3 per source address and 10 overall; a new
  one over a cap EVICTS the oldest undecided request of the client or source over its share (overall: of the busiest
  source), so a flood displaces only itself and nobody is refused. After the client and `redirect_uri` are
  validated, a protocol error (`invalid_request` for a missing or non-S256 challenge, `unsupported_response_type`,
  `unauthorized_client`, `invalid_scope`, `invalid_target`) is a `302` to the `redirect_uri` with `error`,
  `error_description`, `state` (when sent) and `iss` (RFC 6749 §4.1.2.1).
- **Codes**: 256 random bits, stored hashed, single-use, 60 s. A second use revokes the grant it minted.
  The redirect carries `code`, `state` and `iss` (RFC 9207).
- **Tokens**: opaque, `fyc_at_` + 43 base64url (access, 1 h) and `fyc_rt_` + 43 base64url (refresh, 30 days,
  rotated on every use). Only SHA-256 digests are stored. Presenting a rotated-away refresh token revokes the
  whole grant (reuse detection). The token response is `Cache-Control: no-store`.
- **Resource / audience**: every token is bound to the one resource URI; a token request naming another
  `resource` is `invalid_target`.
- **Revocation**: `POST /oauth/revoke` (RFC 7009, always `200`), `fy connector revoke <grant>`, and the app's
  Connectors panel. A revoked grant's access token is refused on the very next call.
- **Rate limits** (per listener, in memory; "source" is the request's `clientAddress`, which the listener sets from
  CF-Connecting-IP — absent shares one `unknown` bucket): register 10/h per source, 200/h overall; authorize 20/min
  per source, 300/min overall; waiting-page polls 60/min per source, 1200/min overall; token and revoke 120/min per
  source with NO overall ceiling, plus 30 failed attempts per source per 5 min and 30 successful exchanges per
  authenticated client per minute (only a holder of a valid credential spends the latter, so anonymous traffic can
  never starve a valid refresh); `/mcp` 60 calls/min per grant, of which write tools 10/min. Over the limit is `429`
  with `Retry-After`.
- **No public path waits on the owner, and the owner never waits on the public.** All writes share one transaction
  queue with three lanes: owner acts (approve, deny, revoke, lists) run first, then token exchanges for a credential
  the daemon issued to the authenticated client, then anonymous writes (registration, last-use bookkeeping). The
  token lane holds at most 64 waiting writes and the anonymous lane 32; beyond that the answer is `503`
  `temporarily_unavailable` with `Retry-After: 5`. A bearer check, a waiting-page poll, an unknown authorization code
  or refresh token, and an unknown revocation token are answered from an in-memory digest index that every write
  keeps current, and never enter the queue. The index is built from storage once; if storage is unreadable on a cold
  start, bearer checks fail closed, and afterwards the last persisted state keeps serving.

## Discovery and the 401

An unauthenticated or invalid-token `/mcp` request gets `401` and

```
WWW-Authenticate: Bearer resource_metadata="<publicUrl>/.well-known/oauth-protected-resource/mcp", scope="fleet:read fleet:write"
```

(`error="invalid_token"` added when a token was presented). The protected resource metadata names `resource`,
`authorization_servers: [publicUrl]`, `scopes_supported`, `bearer_methods_supported: ["header"]`. The
authorization server metadata names the endpoints above, `code_challenge_methods_supported: ["S256"]`,
`grant_types_supported`, `response_types_supported: ["code"]`, `token_endpoint_auth_methods_supported`,
`revocation_endpoint`, `registration_endpoint`, `scopes_supported` and
`authorization_response_iss_parameter_supported: true`.

## Storage

- `<FY_HOME>/state/connector/connector.json`, `0600` in a `0700` directory, written atomically: clients (secret
  hashes only), grants (scopes, who approved, created/last used, revoked), the digests of live access and refresh
  tokens and the rotated-away refresh digests of each grant. **No token, code or secret is ever written, logged,
  journalled or returned after the response that minted it.**
- Pending requests, handles and codes live in memory only; a restart drops them (the sign-in is simply retried).
- `<FY_HOME>/state/connector/calls.jsonl`, `0600`, rotated to `.1.jsonl` at 1 MiB: one line per **write** tool
  call — time, tool, arguments (passed through the secret redactor, message text cut to 500 characters), grant id,
  the access token's id (the first 12 hex characters of its digest — never the token), and the outcome.
- The security log (docs/audit.md) records `connector.client.registered`, `connector.grant.approved`,
  `connector.grant.denied`, `connector.grant.revoked`, `connector.refresh.reused` and `connector.tool` (write
  tools: tool name, grant id, the ferret's session id), names and ids only.
  `connector.grant.revoked` carries who ended the grant: an owner act names the device or this computer; the client's own
  RFC 7009 revocation is logged as `anonymous` with `via: oauth-revoke`; a replayed code or rotated refresh token as
  `anonymous` with `via: reuse`.

## Scopes and tools

- `fleet:read` — the four read tools. `fleet:write` — the five write tools. A token without `fleet:write` is
  never offered the write tools in `tools/list`, and a call to one is a tool error saying so.
- Every tool that takes a ferret takes `ferret`: its call sign, its session id or short id, or its task name —
  case-insensitive, ignoring spaces, hyphens and a leading `:`. Nothing matching is a tool error that lists
  up to three close matches (names come from speech recognition), e.g. `No ferret called "lizet". Did you
mean lizzette (Build MCP Connector)?` More than one match lists them and asks which.
- Results are SHORT PLAIN TEXT, because they are often read aloud. No JSON blobs.

| tool                | scope | annotations  | does                                                                        |
| ------------------- | ----- | ------------ | --------------------------------------------------------------------------- |
| `list_ferrets`      | read  | readOnly     | live ferrets: call sign, task name, state, last activity                    |
| `get_ferret`        | read  | readOnly     | one ferret: state, current task, recent-activity summary, last error        |
| `get_ferret_output` | read  | readOnly     | tail of recent output; `lines` default 40, hard cap 200 lines / 8 000 chars |
| `list_attention`    | read  | readOnly     | open agenda items (`!A12`): who asks, title, question                       |
| `send_to_ferret`    | write | not readOnly | send a message to a ferret, exactly as the app's composer does              |
| `answer_attention`  | write | not readOnly | answer one open agenda item                                                 |
| `restart_ferret`    | write | destructive  | restart a ferret, as the app's Restart does                                 |
| `stop_ferret`       | write | destructive  | stop a ferret, as `fy stop` does                                            |
| `spawn_ferret`      | write | not readOnly | start a new ferret with a task description, as `fy new` does                |

## What a tool may do, and how

- **Through the daemon's own API, never beside it.** Each tool is one or more ordinary requests to the daemon's
  own route table, dispatched in-process under the host admin credential, with the actor `connector:<grantId>` so
  the journal and the security log say who acted. The request is stamped as arriving REMOTE, so the daemon governs
  it like the admin token off loopback: the boundary applies the daemon-wide grants, and every act that needs a
  passkey step-up (confirming a held configuration change, restoring a cut-off ferret, any widen) is refused. There is no second control path:
  validation, ledgers, journalling and every route's own checks apply.
- **Why the owner's authority, and what bounds it.** A connector grant is approved by the owner with a passkey
  (or at the machine), so it acts for the owner — but ONLY through the nine tools, whose arguments are fixed
  schemas: no tool takes a path, a command, a URL, an environment variable or a raw route.
- **The operator's daemon-wide grants narrow it** (docs/grants.md: a grant only ever narrows). Before every tool
  call the connector reads the machine's enforced daemon-wide grants: every tool needs `fleet.use`, and each also
  needs every capability and axis that the routes it calls declare. A narrowed grant refuses the call and names the
  capability; a grant document the daemon cannot read refuses every call. A paired device's OWN grant record does
  not apply — the connector is not a device — and its own switch, scopes and revocation narrow it further.
- **A voice never answers what needs the owner's passkey.** `answer_attention` closes only PLAIN asks — an
  open question, a choice, a yes/no, a permission, an answer review, a to-do or a note — and refuses, with "That
  one needs your passkey in the Ferretry app.", any item that carries a held configuration change (`confirms`), a
  card gate or card ask, a task or paste plan, a phone approval, a 2FA seed, a sign-in rule, a form or a typed
  input. It is an allow-list of kinds plus a list of owner-only fields, so a kind added later is refused until
  someone decides a voice may answer it; `list_attention` still lists such an item and says only the app can
  answer it. This is the second defence: the daemon's boundary refuses these acts first, because tool requests
  arrive governed.
- **An answer names the ask it was given to.** The resolve body carries the item's `askVersion`; if the ferret
  has replaced the ask since, the daemon refuses `ask_changed` and the tool says "That question changed, so
  nothing was sent; here it is now: …" so the owner answers the question that is really being asked.
- **No secrets.** No tool returns a secret, an environment, a credential or a token. Every text a tool returns
  that came from a ferret (output, summaries, errors, agenda questions) passes the daemon's fail-closed secret
  redactor first; if it cannot run, the text is `[output withheld]`.
- **No shell.** No tool runs a command. Control is only through ferrets.

### How the tools are built (`packages/daemon/src/{lib,adapters}/connector/mcp/`)

- **Order of gates** on `POST /mcp`: path → method (`GET`/`DELETE` are `405`, `Allow: POST`) → `Origin` (any
  `Origin` header not in the injected allow-list, default empty, is `403`) → bearer (`401` from the OAuth part's
  builder, nothing else runs) → `application/json` → body ≤ 1 MiB → JSON (no batches) → rate limit → the SDK
  (stateless, `enableJsonResponse`, a fresh server and transport per request, protocol `2025-11-25`). Write tools
  are registered only for a token with `fleet:write`; calling one without it is a tool error saying the
  connection is read-only.
- **The operator's daemon-wide grants are read before EVERY tool call** (`demands.ts`, one table). Undetermined
  grants refuse with "This machine cannot say what remote callers may do right now, so the connector is
  refusing."; `fleet.use` off refuses with "The machine owner has turned off remote fleet access (fleet.use)."
  `tools/list` still lists the tools — the refusal is per call. Every tool demands `fleet.use`; the table also
  demands whatever the routes it calls declare, and today none declares one (the output tool reads the scrubbed
  transcript through `/logs`, which is not `terminal.use`; a start with a registered project and no harness
  flags is an ordinary act).
- **Rate limit is HTTP-level**: `429` with `Retry-After`, 60 `tools/call`s a minute per grant, 10 of them write
  tools. `initialize` and `tools/list` are free. (A tool-level error would be read aloud as one more sentence and
  would not tell the client to back off.)
- **Naming** (`names.ts`, `resolveFerret`): normalised (case, spaces, hyphens, leading `:`, doubled letters,
  `ph`/`ck`/`y` folded) and matched in tiers — EXACT IDENTITIES FIRST, over every ferret whatever its state (call
  sign, session id, short id, exact task name), then a unique prefix/substring (3+ characters); a close edit
  distance only ever SUGGESTS ("Did you mean …?"), because the next sentence may be "stop it". Ambiguity is a
  question. A tool that changes something (send, restart, stop, and `answer_attention` naming a ferret) matches
  across all states at once and never prefers a live ferret, so a retried call meets the same ferret: "stop
  lizzette" twice says "already stopped" the second time, never stops another ferret whose name starts the same.
  A reading tool prefers the one live ferret when a call sign is shared with stopped ones. A ferret the caller
  names for `answer_attention` is always honoured: no such item on it is a refusal, never another ferret's item.
- **Routes the tools call**: `GET /v1/sessions`, `GET /v1/sessions/:id/logs`, `POST /v1/sessions/:id/send`,
  `POST /v1/sessions/:id/stop`, `POST /v1/restarts` (`scope: ids`), `GET /v1/projects`,
  `POST /v1/sessions` (`mode: auto`, `cwd` = a REGISTERED project's path — never a caller's string),
  `GET /v1/agenda/open` and `POST /v1/sessions/:id/agenda` (`action: resolve`). `ConnectorApiCall` gained an
  optional `headers` map for `x-fy-request-id`, which send, start and restart require; the listener wiring must
  forward exactly those and nothing else.
- **Redaction**: every returned text passes the daemon's stored-secret redactor AND a credential-shape redactor
  (`fys_`/`fyc_`, `sk-ant-`, `sk-`, GitHub, AWS, Slack, Google, JWTs, `Bearer`/`Basic`, PEM private keys,
  `password=`-style assignments (value only), URL userinfo). If either throws the text is `[output withheld]`.
- **Calls log**: write calls only, args redacted and message/answer/task cut to 500 characters, appended with
  `O_APPEND | O_NOFOLLOW`, `0600`, rotated to `calls.1.jsonl` at 1 MiB. Each line, and each `connector.tool`
  security-log event, says HOW the call ended: `ok` (`succeeded`), `error` (`failed`: the daemon or the tool
  could not do it) or `refused` (`refused`: the tool or the daemon said not this, e.g. an item that needs the
  passkey, or a 401/403). A call refused at the gate (scope or grants) before the tool ran is in the calls log with
  outcome `refused` but not in the security log, because nothing was attempted.
- **Protocol version**: the endpoint's own refusal reply for a write tool a read-only token may not call never
  reaches the SDK, so it checks `MCP-Protocol-Version` itself (an unsupported value is `400`, as the SDK does).

## Turning it on (the owner, at the machine)

The daemon never runs the tunnel itself. You run `cloudflared` (or any HTTPS reverse proxy) in front of the
connector listener. `fy.example.com` below stands for the hostname you choose.

1. Create a named Cloudflare tunnel for the hostname (one time; `login` opens a browser to pick the zone):

   ```sh
   cloudflared tunnel login
   cloudflared tunnel create ferretry-mcp
   cloudflared tunnel route dns ferretry-mcp fy.example.com
   ```

2. Point it at the connector listener and nothing else — `~/.cloudflared/ferretry-mcp.yml`:

   ```yaml
   tunnel: ferretry-mcp
   credentials-file: /home/<you>/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: fy.example.com
       service: http://127.0.0.1:7461
     - service: http_status:404
   ```

   Run it as a user service: `cloudflared tunnel --config ~/.cloudflared/ferretry-mcp.yml run` (a systemd user unit
   or launchd agent with `Restart=always`).

3. Turn the connector on in `<FY_HOME>/config/daemon.json` and restart the daemon (`fy daemon restart`):

   ```json
   "connector": { "enabled": true, "publicUrl": "https://fy.example.com" }
   ```

   Check it: `fy connector` prints the MCP URL, and
   `curl -si https://fy.example.com/mcp -X POST` answers `401` with a `WWW-Authenticate` header.

4. In Claude: Settings › Connectors › Add custom connector, URL `https://fy.example.com/mcp`, then Connect. A
   Ferretry page opens with a match code. Open Ferretry on any paired device (the page links to it), check the code
   matches, and tap Approve (passkey). The Claude page continues by itself. At the machine, `fy connector approve
<code>` does the same.

5. Revoke any time: the app's Connectors panel, or `fy connector revoke <grant>`. To turn it off, set `enabled` to
   `false` (or stop the tunnel) and restart the daemon.

A quick tunnel (`cloudflared tunnel --url http://127.0.0.1:7461`) works for a trial, but its `trycloudflare.com`
address changes on every run, and `publicUrl` must match it exactly — so a connector added with one stops working
when the tunnel restarts.

## Not in this version

Voice inside Ferretry; more than one owner / team permissions; Client ID Metadata Documents; a daemon-managed
tunnel (the owner runs `cloudflared` — see "Turning it on"); per-tool consent; restricting `/mcp` and `/oauth/token` to
Anthropic's published address range.

## Sources

Checked 2026-11-24. Where they disagree with the owner's spec, these win.

- MCP specification **2025-11-25** — Authorization
  (https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) and Streamable HTTP
  (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). A newer 2026-07-28 revision
  exists, but Claude lists support only up to 2025-11-25 and `@modelcontextprotocol/sdk` 1.32.2 implements up
  to 2025-11-25, so that is the target.
- Anthropic, connector authentication (https://claude.com/docs/connectors/building/authentication.md): the
  hosted Claude apps (claude.ai, Desktop, mobile) use exactly `https://claude.ai/api/mcp/auth_callback`; Claude
  supports DCR and CIMD (CIMD only when advertised — we do not); it sends RFC 8707 `resource` on authorize and
  token requests (canonical MCP URL, compared canonically, not byte-for-byte); it refreshes on `401` and up to
  five minutes before expiry; a dead refresh token must be `invalid_grant`; `/token` is form-urlencoded; a `403`
  re-authorizes only with `error="insufficient_scope"`; it tries `/.well-known/oauth-authorization-server`
  first; its traffic comes from `160.79.104.0/21` (not enforced — GAP).
- Claude Code uses a loopback redirect (`http://localhost:<port>/callback`); it is NOT allowed by default — add
  it to `extraRedirectUris` to use the connector from Claude Code.
- `https://claude.com/api/mcp/auth_callback` appears in third-party docs only; it is not allowed by default.
