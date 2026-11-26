# Remote MCP connector — Ferretry as a Claude connector

Read this before changing anything under `packages/plugins/connector/`, the connector's door, the
`/v1/connector/*` routes, `fy connector` or the app's Claude connector panel. It is the contract; implement against it,
not against the code.

**What 5.0 has built.** The OAuth authorization server, the waiting and "sign in again" pages, the owner routes, the
own-address listener, the built-in tunnel's door, `fy connector`, the approval with its own passkey act, and **`POST /mcp`
with the eleven tools**, which act through `kernel.delegate` (see "How the tools are built"). The settings tab in the app (Settings › Claude connector) is built: see "Settings › Claude connector (the app)" below.

## What changed from v4 (the deliberate differences)

1. **Config** moves from the `connector` block of `config/daemon.json` (which 5.0 no longer has) to
   `<FY_HOME>/config/connector.yaml`. The keys are the same: `enabled`, `publicUrl`, `port` (default **7461**, so a
   `cloudflared` set up for v4 keeps working), `extraRedirectUris`.
2. **Live config.** The file is watched. A changed `publicUrl` or `port` re-opens the listener at once, and a change to
   `enabled` is served at once. v4's "restart it so they apply" and "still starting" refusals are gone. The issuer changes
   with the address, so tokens for the old address stop working **by design** (unchanged), and so do the pending sign-ins
   and codes of the old address (v4 lost them to the restart this edit used to need; 5.0 drops them explicitly).
3. **A file edit that loosens is held.** Switching it on, a redirect URI that was not allowed before, and a new `publicUrl`
   are each a loosening: an agent's `fy config write`, or a hand edit, is **held for the owner** and the tighter version
   stays in effect ([config-files.md](config-files.md)). The app's switch and the machine's own admin token apply at once.
4. **The door is a kernel seam, not a second server.** The authorization server's routes are declared in the plugin's
   manifest as `door: 'public'` routes. The kernel serves them only to a public listener (this plugin's own, or the
   built-in tunnel's), never on the API listener or inside a session, and Gate reads no credential there — see "Where it
   listens". Nothing is mounted in the daemon's own route table, so there is no `405` map to probe.
5. **Storage** is one format. A `connector.json` written by v4 is carried by the migration converter, which writes
   this shape; 5.0 reads no older spelling.
6. **Tools** act through `kernel.delegate`: the real route dispatcher and Gate, as the principal
   `connector` — governed by the daemon-wide grants only, never a device, and refused every step-up act. Its demands are
   5.0's: `restart_ferret` and `spawn_ferret` are `fleet.configure` routes (`POST /v1/restarts`, `POST /v1/ferrets`) the
   connector passes as the owner's authority; `list/get_attention` is a person route. That is parity with v4, not a
   widening, and the daemon-wide grants narrow it exactly as before.

## The one-sentence version

**The daemon can expose ONE remote MCP endpoint (`<publicUrl>/mcp`) on a public door: either its own loopback-only
listener, behind a public HTTPS tunnel the owner runs, or the machine's built-in tunnel. It is protected by an OAuth 2.1
authorization server the daemon itself runs; a sign-in is approved by the owner inside the paired Ferretry app with a
passkey, and every tool acts through the daemon's own API with exactly the eleven tools below.**

It is **off by default**. Turn it on from the app (Settings › Claude connector — a passkey step-up, see "Over the
built-in tunnel") or with `fy config` / by editing `<FY_HOME>/config/connector.yaml` on the host (a file edit that turns
it on is held for the owner — see "What changed from v4"); both write the same `enabled`. With no address of your own,
it is served by the machine's built-in tunnel and nothing else needs setting up.

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

The connector's routes are the plugin's **door routes**: `door: 'public'` in its manifest, `minimum: 'none'`, no
capability. The kernel serves a door route ONLY to a door arrival, and a door arrival reaches ONLY door routes
(docs/grants.md "Public connector arrivals").

- **The own-address listener**: `kernel.publicDoor.open({ port })` binds `127.0.0.1:<port>` (default `7461`) — never the
  API listener and never the tunnel listener — whenever the connector is on AND `publicUrl` is set. `cloudflared` (or any
  reverse proxy) forwards the public hostname to it. It is opened and closed live as the config changes; with the
  connector off no port is bound. If the port is taken, nothing falls back: `fy connector` and the app say so, and the
  switch refuses with that sentence.
- **The built-in tunnel's listener** serves the same routes while the connector is on, has no `publicUrl`, and the tunnel
  has a hostname (see "Over the built-in tunnel").
- Every arrival on either is **remote and unprivileged**, whatever its peer address says: a tunnel terminating on this
  host looks loopback (docs/grants.md "Loopback means how the request arrived"), so a door grants nothing for being
  local. Gate parses NO credential there: an admin token, a ferret's bearer or a device credential in `Authorization`
  establishes nothing, and the only bearer `/mcp` accepts is a connector access token its own handler reads.
- Rate limits are keyed by `CF-Connecting-IP` (an IPv6 address by its /64; a missing or garbled header shares one
  bucket). That is a rate-limit identity only, never authority.
- `/v1/*`, `/healthz` and `/metrics` do not exist on a door, with any credential. Off, or not this door's address, every
  path below is the same `404` an unrouted path answers (`{"code":"unknown_route"}`), so a prober learns nothing.
- It serves exactly these paths:

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

## The owner's routes

All five are a **person's** (`caller: 'person'`: a ferret, the warden and the connector's own principal are refused with
`403 owner_only` before any handler runs) and are served on the API like any other `/v1` route — never on a door.

| route                                     | asks                                                      | does                                                             |
| ----------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /v1/connector`                       | `pairing.use`                                             | on or off and why, the MCP URL, what waits, the approved clients |
| `PUT /v1/connector` `{ enabled }`         | `pairing.configure`                                       | switch it; writes ONLY `enabled`                                 |
| `POST /v1/connector/requests/:id/approve` | `pairing.configure` + a fresh `approve-connector` passkey | approve one sign-in, by id or match code                         |
| `POST /v1/connector/requests/:id/deny`    | `pairing.use` (narrowing)                                 | turn one down                                                    |
| `POST /v1/connector/grants/:id/revoke`    | `pairing.use` (narrowing)                                 | end a grant, off or on; idempotent                               |

- **Approving** adds access, so a governed caller (a phone, a browser — even one on the host) must prove a fresh passkey
  FOR THIS ACT, claimed atomically so one confirmation approves one sign-in; a `catalog-install` or `add-device` proof, or
  the unlock, never buys a connector. The host's own admin token over loopback (`fy connector approve`) is ungoverned and
  needs no passkey. The first refusal names the act to confirm (`403 grant_step_up_required`).
- **Denying and revoking** only take access away, so they ask no proof of their own, as a device revocation does.
- The answers are the strict wire schemas in `contract/wire.ts`: there is no field for a token, a code, a client secret or a
  waiting-page handle, so a view that grew one would fail rather than reach a client.
- Refusals carry a code a client can branch on: `connector_disabled` (409, approve/deny while it is off),
  `connector_not_found` (404), `connector_expired` (410), `connector_already_decided` (409), `connector_cannot_switch` (409).

## Settings › Claude connector (the app)

The tab lives in the connector plugin's own app half (`app/`), in the **Devices & access** group beside Connection. It
reads and acts only through the owner's routes above, by route key, through the one client the shell gives it; it holds
no token and the strict wire schemas leave no field for one.

- **Let Claude connect** — the switch (`PUT /v1/connector`, only `enabled`). There is no optimistic state: it is pending
  while the call runs, then shows exactly the status the daemon answered. While on and reachable the **address** Claude is
  given shows with a copy button, and where it comes from (`config/connector.yaml`, or the built-in tunnel — "waiting for
  the tunnel" is the daemon's own `disabledReason` until a hostname exists).
- **Waiting for you** — each sign-in with its **match code**, set large, and the warning "Only approve if this code is on
  the page you just opened from Claude." in the same breath. **Approve with passkey** asks the shell's step-up prompt
  for `approve-connector` (the daemon names the act in its first `403 grant_step_up_required`; the client proves it and
  resends once); **Deny** asks nothing.
- **Connected apps** — what each may do, who approved it, when it last called; **Revoke** behind a confirm that says it
  stops on its very next call. Live apps are listed before revoked ones.
- It reads again every 2 s while open and visible, and keeps what it shows through a failed read.
- **Version skew.** A daemon built before the connector does not list it, so the shell's inventory gate stops the tab
  before it can ask anything, and the shell's own line says "Connector is not on this daemon, which is older than this
  app: run `fy update` on that machine." (any plugin a daemon older than the app does not list reads so). A machine that
  lists the connector but answers `404 unknown_route` for `GET /v1/connector` gets the tab's own "needs an update" note
  with the same command. The visual test draws the shell over a pre-connector inventory.
- **Round-safe.** The tab is built from the settings kit's rows, so it follows the theme's corners; no text, icon or
  button of it may sit where a corner is cut away, which the visual test checks at the highest rounding (Neumorphism).

The waiting page's "Open Ferretry" link is `<app>/d/<daemon id>/settings/connector?request=<cr_ id>`: the tab puts that
sign-in first and scrolls to it. The request id is public; the page's handle and the match code never ride in a link.

## Configuration

`<FY_HOME>/config/connector.yaml`:

```yaml
enabled: true
publicUrl: https://ferretry-mcp.example.com
port: 7461
extraRedirectUris: []
```

- `publicUrl` — `https://` origin (no path, no query, no credentials); the issuer and the resource are derived
  from it: issuer = `publicUrl`, resource = `publicUrl + "/mcp"`. `http://127.0.0.1:<port>` / `http://localhost`
  is accepted only for local testing.
- `extraRedirectUris` — exact redirect URIs allowed IN ADDITION to Claude's (for MCP Inspector or a test client,
  e.g. `http://localhost:6274/oauth/callback`). Each must be `https://`, or `http://` on a loopback host.
- `publicUrl` may be left out: the issuer is then the built-in tunnel's hostname (see "Over the built-in tunnel") and no
  listener is bound.
- Absent, or `enabled: false` → off. A file that does not check keeps its **last good version** in effect (and a file
  that never checked reads as off), and `fy connector` and the app say why. The app's switch edits only `enabled`.
- Turning it on, a new redirect URI and a new `publicUrl` are loosenings: held for the owner when a file edit makes
  them (docs/config-files.md).

## Over the built-in tunnel (no setup on the machine)

Every daemon that has switched on Ferretry's built-in tunnel (docs/relay-protocol.md §15, Settings › Connection) already
has a public hostname, `https://<id>.ferretry.stream`. The connector reuses it, so a machine needs **no terminal, no
`cloudflared` of its own, no launch agent and no hand-edited file** — only two switches in the app.

**What the owner does:** turn the tunnel on (Settings › Connection), turn the connector on (Settings › Claude connector,
confirmed with a passkey), copy the MCP URL the panel shows into Claude (Settings › Connectors › Add custom connector),
and approve the sign-in in the app as usual.

**What changes on the machine:** one key, `enabled`, in `config/connector.yaml` (nothing else is written, and a
`publicUrl`, `port` or `extraRedirectUris` you wrote stays exactly as it was), and `state/connector/` once a client
signs in. No port is bound for the connector, no process is started.

How it is served:

- The tunnel's own loopback listener (docs/relay-protocol.md §15, opted in with `doors: true`) dispatches a request that
  matches one of the connector's door routes — the very same handlers the own-address listener serves, not a copy —
  **only while the connector is switched on, has no `publicUrl`, and the tunnel has a hostname**. Every arrival is remote and unprivileged, whatever its peer address says, and the
  only credential any of those handlers accepts is a connector token. With the connector off, every connector path is
  the same `404` as any other path.
- The path set is exactly the table in "Where it listens" and nothing else. The hosted service's edge ingress forwards
  the same set (`TUNNEL_CONNECTOR_PATH_PATTERN` in Connections' Worker, written beside the session rule by
  `tunnelIngress`): the edge forwards it for every tunnel because it cannot know who switched what on, and the daemon is
  the wall that refuses it. Neither the owner's `/v1/connector/*` routes nor any other `/v1/*` route is reachable
  through the tunnel; the kernel's door tests pin that with the admin token, a connector token and no credential, and the
  connector's own tests pin that the tunnel does not serve an explicit `publicUrl`.
- **The address.** With no `connector.publicUrl`, the issuer is the tunnel's hostname (`resource` is
  `https://<id>.ferretry.stream/mcp`, which is every token's audience). **An explicit `publicUrl` always wins and is
  never overwritten**: the connector then listens on its own `127.0.0.1:<port>` for the tunnel you run, exactly as
  before, and the built-in tunnel does not serve it (the server's `https://ferretry.atomi.cloud` is the example).
- **If the hostname changes** — the hosted service gave this machine another one, or the tunnel was released and
  provisioned anew — issuer and audience change with it. Every token issued for the old hostname stops working **by
  design** (a token is only good for the audience it was issued for), Claude's connector shows signed out, and the
  owner adds the new URL and approves again. Until the tunnel has a hostname the panel says "waiting for the tunnel".
- **Rolling out.** The Worker that writes the tunnel's ingress must run a version that forwards the connector paths
  before the connector answers through a tunnel; an existing tunnel gets the new ingress the next time its daemon
  provisions with a new origin port, which every daemon start does (the ingress is rewritten only when the port
  changed). A daemon that is not yet re-provisioned says nothing wrong: the connector paths are simply not forwarded.

**The switch** is `PUT /v1/connector` `{ "enabled": boolean }`, answered with the status document. It is
`pairing.configure` (docs/grants.md "Turning the connector on or off"): a governed device needs that grant and the
passkey step-up every `configure` demand takes — the app's passkey is the owner's confirmation — and the host's own
admin token over loopback is ungoverned. It is a person's route (a ferret or the connector itself is refused with
`403 owner_only`). It writes ONLY `enabled`, through the kernel's one config writer, and opens the listener in the same
turn: a damaged `connector.json`, a file that does not check, a switch-on the config judge holds, or a taken port
answers `409 connector_cannot_switch` with a sentence and leaves the file saying off. The switch is recorded as
`security.changed` with the subject `connector` (and `detail.enabled`). Turning it on grants nothing by itself: each
sign-in still needs its own `approve-connector` passkey. Turning it off stops serving at once — every door route answers
`404` from that moment, so a request already in flight cannot reach a fleet route after the off — keeps the grants (they
are only good while it is on) and needs no restart; **grants stay listed and revocable while it is off**, so containing
one never means switching the connector back on. The config is watched, so a changed `publicUrl`, `port` or
`extraRedirectUris` applies live; there is no "restart it" refusal.

**An approval is durable in three steps, each safe to die in.** The owner's approve writes a grant record marked
`pending` first; judges trust once more, synchronously; audits `connector.grant.approved`; and only then writes the record
as approved. A `pending` record is never connected: the index does not know it, the owner never sees it, a code cannot
redeem it and it holds no credential, so a crash between any two steps leaves nothing a person or a credential can use,
and the next write drops it. A connected grant therefore always has its approval already audited.

**Trust that changes while a sign-in is in the air.** The address and the callback allow-list apply LIVE (above), so a
flow already under way must not outlive the trust it was started under. Every pending sign-in and every unredeemed code is
**bound to the origin (issuer) that issued it**, and the CURRENT callback policy is enforced again at every later step:

- a sign-in whose origin is no longer the issuer, or whose callback is no longer allowed, is dropped — it leaves the
  owner's pending list, `approve` and `deny` answer `expired` and approve nothing, and its waiting page is "no longer
  waiting";
- at the waiting page's continuation, the code is minted only if the origin still matches and the callback is still
  allowed; otherwise nothing is minted;
- at redemption, a code issued under another origin, or for a callback no longer allowed, is `invalid_grant` and mints no
  token (a code that was already spent still revokes its grant on replay, as always).

**v4's 60-second tunnel-hostname exception no longer holds, and is removed.** v4 declared that a code approved but not yet
redeemed (at most 60 s) was not bound to its origin, so a tunnel hostname that changed inside that window would have issued a token
for the new hostname. v4 could say that because an explicit address or an allow-list edit needed a restart, which lost every
pending flow anyway. 5.0 applies those edits live, so the binding above is what stops it: there is no window in which an
old sign-in or code is good for a new origin. A re-provisioned tunnel therefore costs a sign-in in flight a retry, never
a token for an address the owner did not approve it for. `GET /v1/connector` also says `switchedOn` (the owner's decision) beside `enabled` (reachable
now) and `publicUrlSource` (`tunnel` or `configured`).

## Allowed redirect URIs

`https://claude.ai/api/mcp/auth_callback` (verbatim from Anthropic's documentation, see "Sources"), plus
`extraRedirectUris`. Dynamic client registration REFUSES (`invalid_redirect_uri`) a client whose
`redirect_uris` contains anything else, and `/oauth/authorize` matches the redirect URI by exact string against
the client's registered list AND re-checks it against the CURRENT allow-list (configuration shrinks live, so a URI removed from `extraRedirectUris` stops authorizing even for a client registered with it). The same
current list is enforced again when a sign-in continues and when its code is redeemed (see "Trust that changes while a sign-in
is in the air"). An
unknown client or a redirect URI problem is shown as an error page (see "Pages a person sees") and NEVER redirected to.

## OAuth 2.1 details

- **Clients** (DCR): `client_name` ≤ 100 chars (shown on every screen, control characters stripped),
  `redirect_uris` 1–5 allowed URIs, `grant_types` ⊆ {`authorization_code`, `refresh_token`},
  `response_types` = [`code`], `token_endpoint_auth_method` ∈ {`none` (default), `client_secret_post`,
  `client_secret_basic`}; a secret is issued only for the latter two and stored as a SHA-256 hash.
  Limits: at most 20 registered clients, 10 registrations per hour per source address (200 per hour overall),
  request body ≤ 8 KiB. A client with no grant, no waiting sign-in and no redeemable code is reclaimable 1 h after it
  registered, a client whose grants are all dead 24 h after, and reclaimable clients are dropped first when the cap is
  reached. If every slot is still taken, the OLDEST client that holds nothing at all (no grant of any kind, no waiting
  sign-in, no redeemable code) is dropped whatever its age; only when every client holds something is a registration
  refused.
- **Authorize**: `response_type=code`, `client_id`, `redirect_uri` (required, exact), `code_challenge` +
  `code_challenge_method=S256` (required — `plain` and absent are refused), `state` (passed through),
  `scope` (⊆ `fleet:read fleet:write`; absent means both), `resource` (if present, must equal the resource
  URI after canonicalisation — lowercase scheme and host, default port dropped, one trailing `/` ignored). A request lives 10 minutes. Undecided sign-ins are capped at 2 per client, 3 per source address and 10 overall; a new
  one over the per-client or per-source cap EVICTS that client's or source's OWN oldest undecided request, so a
  flood from one source displaces only that source. Over the overall cap, the busiest source (on a tie, the one
  holding the newest sign-in) gives up its oldest — but only a source holding MORE than one does: when every source
  holds exactly one, the new sign-in is refused (`503`, a plain page) and no existing sign-in, usually the
  owner's, is displaced. After the client and `redirect_uri` are
  validated, a protocol error (`invalid_request` for a missing or non-S256 challenge, `unsupported_response_type`,
  `unauthorized_client`, `invalid_scope`, `invalid_target`) is a `302` to the `redirect_uri` with `error`,
  `error_description`, `state` (when sent) and `iss` (RFC 6749 §4.1.2.1).
- **Codes**: 256 random bits, stored hashed, single-use, 60 s, bound to the issuing origin and checked against the current
  callback allow-list at redemption. A second use revokes the grant it minted.
  The redirect carries `code`, `state` and `iss` (RFC 9207).
- **Tokens**: opaque, `fyc_at_` + 43 base64url (access, 1 h) and `fyc_rt_` + 43 base64url (refresh, 30 days,
  rotated on every use). Only SHA-256 digests are stored. Presenting a rotated-away refresh token revokes the
  whole grant (reuse detection), with one exception for a lost response: the token just rotated is accepted again for
  60 s after its rotation, as long as nothing has yet been rotated from its successor. **That retry is one-shot**
  (RFC 9700 §4.14.2): it issues one fresh pair and revokes the pair the first exchange issued, and does not extend the
  window. Tokens are stored as digests only, so the first pair cannot be handed out again; instead the second
  presentation of the same rotated token, inside the window or not, issues nothing, revokes the grant (every access
  and refresh token) and emits `connector.refresh.reused`, so a stolen token cannot be replayed for live pairs.
  The pair the retry superseded is remembered as used too, so a client that did receive it and presents it later
  revokes the grant as well. Only a first rotation marks its token retryable.
  Outside the window, or for a token rotated two generations ago, reuse revokes the grant as before. A rotated-away token
  that has passed its own 30-day expiry is simply `invalid_grant`. The token response is `Cache-Control: no-store`.
- **Resource / audience**: every token is bound to the one resource URI; a token request naming another
  `resource` is `invalid_target`.
- **Revocation**: `POST /oauth/revoke` (RFC 7009, always `200`), `fy connector revoke <grant>`, and the app's
  Connectors panel. A revoked grant's access token is refused on the very next call.
- **Rate limits** (per listener, in memory; "source" is the request's `clientAddress`, which the listener sets from
  CF-Connecting-IP — absent shares one `unknown` bucket): register 10/h per source, 200/h overall; authorize 20/min
  per source, 300/min overall; waiting-page polls 60/min per source, 1200/min overall; token and revoke 120/min per
  source with NO overall ceiling, plus 30 failed attempts per source per 5 min and 30 successful exchanges per
  authenticated client per minute (only a holder of a valid credential spends the latter, so anonymous traffic can
  never starve a valid refresh; the budget is judged AFTER the reuse decision and just before minting, so a replayed
  code or rotated refresh token still revokes the grant at a full budget); `/mcp` 60 calls/min per grant, of which write tools 10/min — except the two agenda
  acts (`answer_attention`, `snooze_attention`), which have their own 30/min so an agenda clean-up burst fits; they
  still count toward the 60. Over the limit is `429`
  with `Retry-After`. Only the per-source counters are kept in a bounded table (10,000 sources; at the bound the
  oldest source's counter is forgotten). The overall ceilings and the per-client budgets are never evicted, so a flood
  of sources cannot reset them.
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

## Pages a person sees, and what Claude is told

Whenever a sign-in cannot continue, the person lands on a plain page that says what happened in one sentence, gives
one obvious button ("Open Claude connector settings"), lists the steps to connect again, and links Ferretry's Claude
connector panel. The OAuth error code sits in small print as `Reference: …` for support, never in the headline. All
of them are built by one template (`packages/plugins/connector/daemon/lib/http/pages.ts`): no script, no external asset,
no token, secret or handle in the page or in any URL it links, dark mode by `prefers-color-scheme`, readable at phone
width. The steps always read **Settings > Connectors > Ferretry > Connect**, plus "open Ferretry and approve the new
code" where an approval is involved.

| What happened                                                                                           | Where                       | Page headline                                                                                           | Status |
| ------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------- | ------ |
| Waiting for the owner                                                                                   | `GET /oauth/authorize/wait` | Approve this connection in Ferretry (code, Open Ferretry, "If nothing happens" steps; refreshes itself) | 200    |
| Handle unknown, malformed, missing, past 10 minutes, already finished, or forgotten by a daemon restart | `/oauth/authorize/wait`     | This sign-in is no longer waiting                                                                       | 400    |
| Grant revoked (owner, or reuse detection) between approval and redemption                               | `/oauth/authorize/wait`     | This connection was cancelled ("connecting again is safe")                                              | 400    |
| Unknown client, redirect URI mismatch, missing or invalid parameters (never redirected)                 | `/oauth/authorize`          | Ferretry does not recognise this connection request                                                     | 400    |
| Too many sign-ins already waiting                                                                       | `/oauth/authorize`          | Ferretry has too many sign-ins waiting                                                                  | 503    |
| Rate limit on either page path                                                                          | both                        | Too many tries in a short time (`Retry-After`)                                                          | 429    |
| Storage or other internal failure                                                                       | both                        | Ferretry could not finish this sign-in                                                                  | 503    |

A switched-off connector (or one that failed to start) serves nothing: every path is the same bare 404, so a prober learns nothing. A person opening an old sign-in link then sees that 404; a page for this case is a declared gap (as in v4), because with the connector off a door route answers as an unrouted path does.

The "Open Ferretry" link (and the "Open Ferretry's Claude connector panel" link) points at `<app>/d/<daemon id>/settings/connector` (the 5.0 settings route; the waiting page adds `?request=<cr_ id>`, a public id), which opens Settings › Claude connector with that sign-in first.

**What Claude is told.** A denied sign-in still redirects to Claude with `error=access_denied`, and now an
`error_description`. Every JSON error Claude may show carries an `error_description` ending in "Reconnect in Claude:
Settings > Connectors > Ferretry > Connect.": `invalid_grant` (dead, expired or disconnected token or code),
`invalid_client` (a client this daemon no longer knows), and the `401` for an invalid bearer (`invalid_token`). When
reuse detection cancelled the grant (a replayed code or rotated refresh token) the text says it was cancelled to keep
the account safe and that connecting again is safe. Protocol errors redirected to Claude after the client is trusted
(bad scope, missing PKCE and the like) keep their descriptions, which are about the request, not the person.

## Storage

- `<FY_HOME>/state/connector/connector.json` (`format: 1`), `0600` in a `0700` directory, written atomically by the
  kernel's state port: clients (secret hashes only), grants (scopes, who approved, created/last used, revoked), the
  digests of live access and refresh tokens and the rotated-away refresh digests of each grant (each with its own expiry,
  the rotation time and the digests of the pair its rotation issued, all dropped on the next write once expired). A
  revoked grant is kept 30 days, then dropped on the next write. **Damaged is not empty:** a file that does not check
  fails the connector closed (every bearer check refuses, and the switch-on refuses with "restore connector.json") and is
  never read as "nobody is signed in" and rewritten. There is no reader for any older spelling. **No token, code or secret is ever written, logged,
  journalled or returned after the response that minted it.**
- Pending requests, handles and codes live in memory only, each with the origin it was issued under; a restart or a change of
  origin or callback drops them (the sign-in is simply retried).
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

- `fleet:read` — the five read tools. `fleet:write` — the six write tools. A token without `fleet:write` is
  never offered the write tools in `tools/list`, and a call to one is a tool error saying so.
- Every tool that takes a ferret takes `ferret`: its call sign, its session id or short id, or its task name —
  case-insensitive, ignoring spaces, hyphens and a leading `:`. Nothing matching is a tool error that lists
  up to three close matches (names come from speech recognition), e.g. `No ferret called "lizet". Did you
mean lizzette (Build MCP Connector)?` More than one match lists them and asks which.
- Results are SHORT PLAIN TEXT, because they are often read aloud. No JSON blobs. The one exception is
  `get_attention`, which exists to hand Claude a whole agenda item to work from: see below.

| tool                | scope | annotations  | does                                                                                          |
| ------------------- | ----- | ------------ | --------------------------------------------------------------------------------------------- |
| `list_ferrets`      | read  | readOnly     | live ferrets: call sign, task name, state, last activity                                      |
| `get_ferret`        | read  | readOnly     | one ferret: state, current task, recent-activity summary, last error                          |
| `get_ferret_output` | read  | readOnly     | tail of recent output; `lines` default 40, hard cap 200 lines / 8 000 chars                   |
| `list_attention`    | read  | readOnly     | open agenda items (`^A12`): who asks, title, question; `snoozed: true` adds the sleeping ones |
| `get_attention`     | read  | readOnly     | ONE agenda item in full: options, context, every tab; 24 000 chars, see below                 |
| `send_to_ferret`    | write | not readOnly | send a message to a ferret, exactly as the app's composer does                                |
| `answer_attention`  | write | not readOnly | answer one open agenda item                                                                   |
| `snooze_attention`  | write | not readOnly | hide one open agenda item until a time (Pacific by default), as Snooze does                   |
| `restart_ferret`    | write | destructive  | restart a ferret, as the app's Restart does                                                   |
| `stop_ferret`       | write | destructive  | stop a ferret, as `fy stop` does                                                              |
| `spawn_ferret`      | write | not readOnly | start a new ferret with a task description, as `fy new` does                                  |

### `get_attention` — one agenda item, in full

The agenda is the main channel between the owner and Claude, and `list_attention` shows only a summary line. `get_attention`
reads ONE item completely, so Claude can work from what the ferret wrote.

- **Input**: `item` — the id as `list_attention` prints it (`A12`, `^A12`, `12`, `a 12`); a title also works when exactly one
  item has it (a part of a title is enough for READING; `snooze_attention` wants the whole title). `ferret` — when two
  ferrets have an item with the same id (the same rule, and the same sentence, as `answer_attention`); a `ferret` that
  is named narrows a title match FIRST too, so the title is looked for among that ferret's items only. `tab` — one section by name in any case or by id. `from` — with `tab`, the character to start at.
- **Output** (Markdown-ish text, an item's own Markdown kept exactly as written, so a table stays a table): a heading
  `^A12 — Title — from Lizzette`, the list of sections, then each section under `## Name`:
  **Overview** (title, summary, who raised it and on whose agenda, state, kind, waiting since, whether only the app can
  answer it, the question, the options with their one-line description and longer explanation, the recommendation,
  numbered questions, form fields, premise, impact, urgency, steps with their ticks, links with their meaning, terms,
  a task ask's how-to-test), **Replies** (the owner's latest answer, then the conversation — the newest 20 entries — or,
  on an item from before conversations were kept, what its history recorded), **Context**, then **every tab** in the order
  the app draws them (the main tab "Where we are now" with the ferret's answer, what is decided and what is still open;
  "The full picture"; the ferret's own tabs), then **Detail** (the from-zero explanation). An empty section is left out.
  A section that would share a name with one of the item's own tabs is called "… (item)" (or "… (item 2)" when that is
  taken too), so a name and an id never mean two sections.
- **Read, not answer.** Parked (snoozed or resting) items can be read though `list_attention` hides them; an
  `input` item (a value only the owner types) is never shown, as it is never listed. Scope `fleet:read`; it makes
  only the two reads `list_attention` makes (`GET /v1/agenda/open`, `GET /v1/sessions`), through the same gateway.
- **The cap**: the whole answer is at most **24 000 characters**. That is room for a typical item whole (a few
  thousand characters of overview, a few tabs) while staying well inside what a model can take in one tool result
  next to the conversation; items run to 560 000, so it is a cap, not a promise. The room is shared by
  _water-filling_: a section shorter than its share is whole, longer ones each show their start, and the answer
  says `Clipped to fit one answer. Cut: <names>` with, under each cut section, how to read it whole. A first long tab
  therefore never pushes the later tabs out. The cap is ENFORCED, not estimated: the room is worked out from the real
  lengths of the heading, the (redacted) section names, each cut marker and the notice, the answer is drawn, and if it is
  still over the cap the room is shrunk and it is drawn again (a bounded number of times); the last resort, when even the
  names alone do not fit, is a hard cut at the cap.
- **Nothing is out of reach**: `tab` returns that one section, capped the same way; when it is longer than the cap the
  answer ends with the `from` offset that continues it, so a 200 000-character tab is read in a few calls.
- **Secrets**: every section — and each section's NAME and the heading — goes through the connector's one redaction
  door BEFORE it is cut (the same holds for every short line a tool makes of an item's title, summary or question: the
  whole text is cleaned, then cut) (stored-secret values, live host tokens, credential shapes), so a credential is never cut in
  half and left half-visible; a section that cannot be cleaned is `[output withheld]` while the others still show.
- **Unknown id**: a plain sentence plus the close matches, as ferret names get ("There is no open item A22. Did you
  mean !A21 (Other thing)?"), else the open ids, else "Nothing is waiting on you."
- **Audit**: like the other read tools — a read writes nothing to the calls log or the security log (those record what
  a tool CHANGED). A call refused at the gate is refused in words before it reaches the tool.

### `snooze_attention` — put one item away until later

Hides one open agenda item until a time and lists it again afterwards — the daemon's OWN snooze, not a second one.

- **Mechanism**: `POST /v1/sessions/:id/agenda` (or `/v1/machine/agenda` for a machine notice) with `{ action: 'snooze', id, until }`,
  exactly what the app's Snooze sends. The item gets `parked: { reason: 'snoozed', until }`; `list_attention` stops listing
  it, and the daemon's minute timer (`agenda/waker.ts`) wakes it at `until`, fresh (`waitingSince` = then), so it reads as new.
  `list_attention` also lists a snoozed item whose time has come before the timer has run, so it is never late by the
  timer's minute. ONE predicate, "open for the owner now" (not parked, or snoozed with its time come), decides what
  `list_attention` lists, which items `answer_attention` may close, and which items count when two ferrets share an id — so
  a due item is answerable, and an unqualified answer can never go to the OTHER board's item instead. `list_attention` with `snoozed: true` also lists the sleeping ones, marked "(snoozed until …)".
- **Governance**: the same as the other write tools. The snooze action asks no passkey step-up and no capability beyond
  `fleet.use` (the daemon's route declares none), so the connector reaches it as the owner's own act, stamped remote and
  governed like every connector call. Scope `fleet:write`; it is in the calls log and the security log (`connector.tool`,
  with the ferret's session id) like `answer_attention`. It never answers, closes or edits the item.
- **Input**: `item` (the same forms and lookup as `get_attention`: `A12`, `^A12`, `12`; `ferret` when two ferrets
  share an id; but a TITLE must be the whole title, matched exactly in any case, because this changes something: a part
  of a title is only offered back as "Did you mean …?") and EXACTLY ONE of:
  - `until` — an ISO time with a zone (`2026-11-25T09:00:00Z`) or without (**read as Pacific, `America/Los_Angeles`**,
    daylight saving included), a date alone (9:00 AM Pacific), a clock time (`17:00`, `5pm`: the next one) or
    `today`/`tomorrow` with a clock time (`tomorrow 9am`). The calendar is checked for a zoned time too (`2026-02-29T09:00:00Z`
    is refused, not rolled to March), and a Pacific time the clocks skip (02:30 on the day daylight saving starts) is
    refused in a sentence rather than moved. The hour that REPEATS when the clocks go back reads as its first occurrence
    (a known limitation);
  - `duration` — `90m`, `2h`, `1d`, `1w`, together (`1d 2h`), an optional leading "in".
    Anything else is refused with the forms on offer, never guessed.
- **Bounds**: at least one minute and at most **30 days** ahead (a snooze is "not now", not "never"; the daemon itself only
  needs "still ahead"). An item that waits on its ferret (resting: `parked: replied`, or `waitingOn: ferret` for more information or a
  discussion — `agendaState` says `resting`) is refused ("not on you, nothing to snooze"); a
  notice is refused by the daemon in its own words; an already snoozed item may be snoozed again and the answer says so.
- **Answer**: "Snoozed ^A12 (Title) until Wed, Nov 25, 9:00 AM PST (in 29 h)." — the wake time in Pacific, always, and the
  time the DAEMON will wake it: an item with a `neededBy` before the time asked for wakes at the deadline (`agendaWakeAt`),
  so the answer says that time and "sooner than the … you asked for, because it is needed by …"; a deadline that has
  already passed is said too ("which has passed, so the daemon wakes it again at once").

## What a tool may do, and how

- **Through the daemon's own API, never beside it.** Each tool is one or more ordinary requests to the daemon's
  own route table, dispatched in-process under the host admin credential, with the actor `connector:<grantId>` so
  the journal and the security log say who acted: a route-level row a tool causes (`agent.prompted`, `session.opened`,
  a restart or stop) is recorded with actor `connector` and the grant in `detail.grant`, never as `host` ("this computer"). The request is stamped as arriving REMOTE, so the daemon governs
  it like the admin token off loopback: the boundary applies the daemon-wide grants, and every act that needs a
  passkey step-up (confirming a held configuration change, restoring a cut-off ferret, any widen) is refused. There is no second control path:
  validation, ledgers, journalling and every route's own checks apply.
- **Why the owner's authority, and what bounds it.** A connector grant is approved by the owner with a passkey
  (or at the machine), so it acts for the owner — but ONLY through the eleven tools, whose arguments are fixed
  schemas: no tool takes a path, a command, a URL, an environment variable or a raw route.
- **The operator's daemon-wide grants narrow it** (docs/grants.md: a grant only ever narrows). Before every tool
  call the connector reads the machine's enforced daemon-wide grants: every tool needs `fleet.use`, and each also
  needs every capability and axis that the routes it calls declare. A narrowed grant refuses the call and names the
  capability; a grant document the daemon cannot read refuses every call. A paired device's OWN grant record does
  not apply — the connector is not a device — and its own switch, scopes and revocation narrow it further.
- **A voice never answers what needs the owner's passkey.** `answer_attention` closes only PLAIN asks — an
  open question, a choice, a yes/no, a permission, an answer review, a to-do or a note — and refuses, with "That
  one needs your passkey in the Ferretry app.", any item that carries a held configuration change (`confirms`), a
  task gate or task ask, a task or paste plan, a phone approval, a 2FA seed, a sign-in rule, a form or a typed
  input. It is an allow-list of kinds plus a list of owner-only fields, so a kind added later is refused until
  someone decides a voice may answer it; `list_attention` still lists such an item and says only the app can
  answer it. This is the second defence: the daemon's boundary refuses these acts first, because tool requests
  arrive governed.
- **An answer is for the question that was read out.** `list_attention` and `get_attention` mark a question a ferret has
  revised ("revised: say version N"), and `answer_attention` takes that `version`: an answer that names none, or an older one,
  for a revised question is refused with the question as it is now, and nothing is sent. A spoken choice never matches a
  label loosely when either side has a digit ("100" is not "10").
- **An answer names the ask it was given to.** The resolve body carries the item's `askVersion`; if the ferret
  has replaced the ask since, the daemon refuses `ask_changed` and the tool says "That question changed, so
  nothing was sent; here it is now: …" so the owner answers the question that is really being asked.
- **No secrets.** No tool returns a secret, an environment, a credential or a token. Every text a tool returns
  that came from a ferret (output, summaries, errors, agenda questions) passes the daemon's fail-closed secret
  redactor first; if it cannot run, the text is `[output withheld]`. The guard also masks the live host admin
  token and warden token as literals (bare base64url values no pattern would catch), so a ferret that printed
  `~/.ferretry/api-token` does not hand it to Claude.
- **No tool runs a shell itself — but a write grant is, in effect, code execution as the owner.** No tool takes a
  path, a command or a raw route, and none starts a process of its own. But `spawn_ferret` and `send_to_ferret`
  hand free text to a ferret, and a ferret is an agent that runs commands on this machine as the owner. So whoever
  can put words in front of Claude can say "start a ferret and run X", and `fleet:write` carries it out. That includes
  a prompt injected into something Claude read (a web page, an email, a document). The ferret's own limits (its
  runtime, `limits.yaml`, what the daemon lets agents control) still apply to what it does; the connector adds none
  of its own to the ferret's work. Treat a `fleet:write` grant like handing a stranger a terminal.
- **It never needs the unlock, for as long as its grant lives.** The passkey unlock (docs/grants.md) is asked only of
  a device the tunnel proved. The connector holds the admin token off loopback and no device, so nothing ever asks
  it to unlock: it is governed by the daemon-wide grants, and refused every act that wants a passkey, but between
  those it works with the owner's phone locked, the owner away, and the machine unattended. That is why
  APPROVING one asks more than any ordinary act: `pairing.configure` (not merely `use`) and a fresh passkey proved
  for that one act (`approve-connector`) from a paired device, or the owner at the machine. Revoking a grant, or
  turning the connector off, is the only thing that ends it.
- **Prefer a read-only grant where voice control is not needed.** A grant with only `fleet:read` can list and
  describe ferrets and read their (redacted) output, and can run nothing. Today the owner CANNOT pick this when
  approving: the grant carries the scopes the client asked for (both, when it names none), and the app and the
  waiting page only show them. Letting the owner narrow the scopes at approval is a FOLLOW-UP, not built. Until then,
  the controls are the ones that exist: revoke a grant you no longer use, turn the connector off in
  `config/connector.yaml` when nobody needs it, or narrow `fleet.use` in the daemon-wide grants to refuse every call.

### How the tools are built (`packages/plugins/connector/daemon/`)

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
  tools other than the agenda acts, which have their own 30. `initialize` and `tools/list` are free. (A tool-level error would be read aloud as one more sentence and
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
- **Routes the tools call** are 5.0's, and exactly twelve: `GET /v1/ferrets`, `GET /v1/ferrets/:ferretId`,
  `GET /v1/ferrets/:ferretId/logs`, `POST /v1/ferrets/:ferretId/send`, `POST /v1/ferrets/:ferretId/stop`,
  `POST /v1/restarts`, `POST /v1/ferrets` (the flat start body, `mode: auto`, a REGISTERED project — never a caller's
  string), `GET /v1/projects`, `GET /v1/agenda/open`, `POST /v1/ferrets/:ferretId/agenda`, `GET /v1/machine/agenda` and
  `POST /v1/machine/agenda`. They are the manifest's `permissions.delegate` list, the kernel refuses any other key, and a
  delegated arrival is looked up in the API route table alone. **Never delegated:** the pull-request post route, the git
  accounts route, the terminals route and the board lanes route. Only `x-fy-request-id` crosses (send, start and
  restart carry one), and the kernel masks the host's admin and warden token literals in every answer.
- **The agenda sends only `resolve` and `snooze`.** Never a dismiss, un-snooze, edit or add. A ferret's own board takes the
  full resolve (`askVersion`, `response`). The machine's own list (`/v1/machine/agenda`) takes a bare `{action, id}` plus
  `note` or `until`, with nowhere to put a decision, so `answer_attention` on a machine item that needs a choice, verdict or
  permission is **refused** ("only the Ferretry app can answer it") instead of resolving it and dropping the answer.
- **Agenda budget.** Agenda acts (`answer_attention`, `snooze_attention`) have their own 30 a minute per grant, inside the 60.
- **A call in flight when the connector is switched off stops** (S17): the delegated call is refused once `enabled` is false,
  so a switch-off ends what was already running at the next step, not only what comes next.
- **An invalid or dead bearer** gets `401 invalid_token` whose `error_description` is the same sentence the sign-in pages
  use for a dead connection, with how to connect again.
- **Redaction**: every returned text passes the daemon's stored-secret redactor AND a credential-shape redactor
  (`fys_`/`fyc_`, `sk-ant-`, `sk-`, GitHub, AWS, Slack, Google, JWTs, `Bearer`/`Basic`, PEM private keys,
  `password=`-style assignments (value only), URL userinfo). If either throws the text is `[output withheld]`.
- **Calls log** (`state/connector/calls.jsonl`, strict line schema, a plugin-owned file): write calls only (reads, `get_attention` included, are not recorded), args redacted and message/answer/task cut to 500 characters, appended with
  `O_APPEND | O_NOFOLLOW`, `0600`, rotated to `calls.1.jsonl` at 1 MiB. Each line, and each `connector.tool`
  security-log event, says HOW the call ended: `ok` (`succeeded`), `error` (`failed`: the daemon or the tool
  could not do it) or `refused` (`refused`: the tool or the daemon said not this, e.g. an item that needs the
  passkey, or a 401/403). A call refused at the gate (scope or grants) before the tool ran is in the calls log with
  outcome `refused` but not in the security log, because nothing was attempted.
- **Declared gap — the calls log.** The plugin masks what it records (credential shapes, Vault values), and every
  host-token-SHAPED run in a logged argument (43 characters of base64url, the form of a host admin or warden token). The
  kernel masks the host's literals only in responses, so a bare literal is caught by its shape alone: a value of some other
  shape typed into an argument is the residual. Nothing in the tool surface hands such a value to Claude.
- **Before every delegated call** the endpoint checks that the connector is on AND the bearer still verifies as the same
  token of the same grant, so a revoke or an off stops the NEXT call of a request in flight (the one dispatch already
  running is the kernel's and cannot be cancelled). The calls log keeps only the arguments a tool declares, never a
  caller-chosen property name; a ferret-written text is cleaned before any tool cuts it short.
- **The machine's own list is read from its own route** (`GET /v1/machine/agenda`): the all-ferrets roll-up leaves it out.
- **Declared gaps (owned elsewhere).** An append re-tightens an already-existing `calls.jsonl` with broader permissions
  back to `0600` (the state port applies the mode on every write, not only at creation). A project nested inside a registered
  one that was removed after the lookup can still be launched while its parent is registered (core ferrets' launch check,
  not the connector's).
- **Protocol version**: the endpoint's own refusal reply for a write tool a read-only token may not call never
  reaches the SDK, so it checks `MCP-Protocol-Version` itself (an unsupported value is `400`, as the SDK does).

## Turning it on with your own tunnel (the owner, at the machine)

This is the path for a server with its own public address (`connector.publicUrl` set). A machine with the built-in tunnel
needs none of it — see "Over the built-in tunnel".

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

3. Write `<FY_HOME>/config/connector.yaml` (no restart: the file is watched). The owner confirms the edit, because
   turning the connector on and naming an address are loosenings:

   ```yaml
   enabled: true
   publicUrl: https://fy.example.com
   ```

   Check it: `fy connector` prints the MCP URL, and
   `curl -si https://fy.example.com/mcp -X POST` answers `401` with a `WWW-Authenticate` header.

4. In Claude: Settings › Connectors › Add custom connector, URL `https://fy.example.com/mcp`, then Connect. A
   Ferretry page opens with a match code. Open Ferretry on any paired device (the page links to it), check the code
   matches, and tap Approve (passkey). The Claude page continues by itself. At the machine, `fy connector approve
<code>` does the same.

5. Revoke any time: the app's Connectors panel, or `fy connector revoke <grant>`. To turn it off, set `enabled` to
   `false` (or stop the tunnel); the listener closes at once.

A quick tunnel (`cloudflared tunnel --url http://127.0.0.1:7461`) works for a trial, but its `trycloudflare.com`
address changes on every run, and `publicUrl` must match it exactly — so a connector added with one stops working
when the tunnel restarts.

## Not in this version

Voice inside Ferretry; more than one owner / team permissions; Client ID Metadata Documents; a daemon-managed
tunnel of the connector's own (the built-in tunnel serves it — see "Over the built-in tunnel"; anything else is the
operator's own `cloudflared` — see "Turning it on"); per-tool consent; restricting `/mcp` and `/oauth/token` to
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
