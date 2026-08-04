# Running your own Cloudflare relay

**This is an expert opt-in path. Almost nobody needs it.**

Ferretry connects a browser to a daemon directly whenever it can, and falls back to a relay Ferretry
operates when it cannot. Neither is a question setup asks. This document is for the person who would
rather that fallback ran in their own Cloudflare account — because they do not want a third party on
the path at all, because they want the metadata to stay with them, or because they simply prefer to
own the infrastructure they depend on.

Nothing in onboarding links here on purpose. If you are setting Ferretry up for the first time, close
this and use the app.

- **What a relay is, and what its operator can observe** — [relay-protocol.md](relay-protocol.md)
  §§9–11. Architecture lives there; procedure lives here.
- **The wire contract**, if you would rather implement a relay than deploy this one —
  [relay-protocol.md](relay-protocol.md). It is written so it can be implemented without reading this
  repository.

---

## Read this before you start: what you will and will not get

Deploying this Worker gets you **a working relay**. It does not yet get you a remote connection,
because the two ends that would dial it are not written.

- No code outside `packages/relay` reads a relay address. `packages/pwa/src/lib/daemon-transport.ts`
  builds every request from one direct `baseUrl`, and `ConnectionMethod` — the carrier type that
  would replace it — has no consumer outside that package.
- `fyd` has no dial-out relay client at all.

So today this runbook takes you as far as **"the relay is deployed, reachable, and serving the
fingerprints I listed"**, verified at the Worker itself. The end-to-end sections below are written
out in full, and marked with the prerequisite they wait on. See
[The client gap, exactly](#the-client-gap-exactly) for the four named pieces and how to tell when
they have landed.

If that is not useful to you yet, stop here and come back when the prerequisite ships.

---

## Prerequisites

| You need                     | Notes                                                                      |
| ---------------------------- | -------------------------------------------------------------------------- |
| A Cloudflare account         | Free is enough — see [Cost](#cost-and-what-drives-it).                     |
| This repository, checked out | `git clone https://github.com/kirinnee/ferretry`                           |
| The repo's devshell          | `direnv allow`, or `nix develop`. Every command below runs inside it.      |
| `fyd` installed and running  | You need a daemon fingerprint, and the daemon must be running to print it. |

Wrangler is not vendored. It is fetched from npm on first use by `bunx`, so the first `task
relay:check` may take a minute and needs network access to the npm registry.

### Getting the code

Every command in this runbook runs from the repository root, inside its devshell. Nothing here needs
Cloudflare credentials yet.

```bash
git clone https://github.com/kirinnee/ferretry
cd ferretry
direnv allow            # or, without direnv: nix develop
```

`direnv allow` prints the shell loading, once per new environment:

```
direnv: loading ~/ferretry/.envrc
direnv: using flake
```

Confirm you are actually in the devshell before going further — the relay tasks are the check:

```bash
task --list | grep relay
```

```
* relay:check:              Expert: compile the relay Worker and print its bindings without deploying anything
* relay:deploy:             Expert: deploy the rendezvous relay to your own Cloudflare account
```

If `task` is not found, the devshell is not loaded and nothing below will work.

---

## Cost, and what drives it

**A paid plan is not required.** This relay uses SQLite-backed Durable Objects
(`new_sqlite_classes` in `packages/relay/wrangler.jsonc`), and Cloudflare documents those as
available on the Workers Free plan: _"Durable Objects are available both on Workers Free and Workers
Paid plans"_, with the Free plan restricted to the SQLite storage backend — which is the backend this
Worker uses. Verified against Cloudflare's own pricing pages on **2026-08-04**; check them again
before you rely on the numbers, because they are Cloudflare's to change.

### Included, per plan

| Meter                   | Workers Free      | Workers Paid ($5/month base) |
| ----------------------- | ----------------- | ---------------------------- |
| Worker requests         | 100,000 / day     | 10 million / month           |
| Worker CPU              | 10 ms per request | 30 million CPU ms / month    |
| Durable Object requests | 100,000 / day     | 1 million / month            |
| Durable Object duration | 13,000 GB-s / day | 400,000 GB-s / month         |
| SQLite rows read        | 5 million / day   | first 25 billion / month     |
| SQLite rows written     | 100,000 / day     | first 50 million / month     |
| SQLite stored data      | 5 GB total        | 5 GB-month                   |
| Storage cap per object  | 1 GB              | 10 GB                        |

Overages, on the paid plan only: requests **$0.15 / million**, duration **$12.50 / million GB-s**,
rows read **$0.001 / million**, rows written **$1.00 / million**, stored data **$0.20 / GB-month**;
Worker requests **$0.30 / million** and Worker CPU **$0.02 / million CPU ms**.

**There is no bandwidth bill.** Cloudflare: _"There are no additional charges for data transfer
(egress) or throughput (bandwidth)."_ That matters here, because a relay's whole job is moving bytes.

### What actually costs you money

1. **Duration (GB-s) — the one to watch.** You are billed for wall-clock time a Durable Object is
   active, not for traffic. A held session is a held object. This Worker uses the WebSocket
   Hibernation API and lets the runtime answer heartbeats itself, so an _idle_ rendezvous should not
   be billed for waiting — Cloudflare says hibernation _"can dramatically reduce duration-related
   charges"_. An idle-but-connected session costing nothing is a claim only your own bill can settle;
   [relay-protocol.md](relay-protocol.md) §12 says the same, and says it has not been measured here.
2. **Requests — cheaper than "one per frame".** WebSocket traffic is not billed message-for-message.
   Cloudflare: _"a request is needed to create a WebSocket connection"_, and then for compute-request
   billing _"a 20:1 ratio is applied to incoming WebSocket messages … For example, 100 WebSocket
   incoming messages would be charged as 5 requests for billing purposes."_ Outgoing messages and
   incoming protocol pings are free: _"there is no charge for outgoing WebSocket messages, nor for
   incoming WebSocket protocol pings."_ So chatty terminal output is far less expensive than the
   frame count suggests, and the socket opens themselves are what you count.
3. **Storage.** One small state document per rendezvous. Effectively free at personal scale.

For one person with a handful of machines, the Free plan's 100,000 Durable Object requests per day is
the ceiling you would hit first, and you would have to be trying. If you exceed a Free plan limit,
operations fail rather than silently billing you — and when a SQLite-backed object hits its storage
cap, Cloudflare documents that writes fail with `SQLITE_FULL` while reads and deletes keep working.

There is also a documented **soft limit of 1,000 requests per second per Durable Object**. One
rendezvous is one object per daemon, so that is a per-daemon ceiling, not an account one.

---

## Step 1 — Create a narrowly scoped API token

Do **not** use a Global API Key, and do not reach for the "Edit Cloudflare Workers" template.
Cloudflare documents that template as granting _"Workers Routes Write, Workers Scripts Write, Workers
KV Storage Write, Workers Tail Read, Workers R2 Storage Write, Account Settings Read, User Details
Read, and User Memberships Read"_. This deployment needs exactly one of those, binds no KV and no R2,
and adds no route.

In the Cloudflare dashboard, go to **Manage Account → API Tokens** and create a **custom token**
(account-owned, so it survives you losing access to a personal login):

| Field                           | Value                                                                     |
| ------------------------------- | ------------------------------------------------------------------------- |
| **Permissions**                 | `Account` · `Workers Scripts` · **Edit**                                  |
| **Account Resources**           | Include → **only the one account** you are deploying into                 |
| **Zone Resources**              | Leave empty. `workers.dev` needs no zone.                                 |
| **Client IP Address Filtering** | Optional. Set it if you always deploy from one address.                   |
| **TTL**                         | Optional, and worth setting. A deploy token does not need to be immortal. |

`Workers Scripts: Edit` is what uploads the script and creates its Durable Object namespaces. You do
not need `Workers KV Storage` or `Workers R2 Storage` — this Worker binds neither.

**One deliberate consequence: this token cannot run `wrangler tail`.** Log tailing is a separate
permission, `Account · Workers Tail · Read`. Add it only if you want the live log described in
[step 5](#step-5--verify-at-the-worker), and consider putting it on a second, shorter-lived token
rather than widening your deploy token — a credential that can read live request logs is a different
thing from one that can upload a script.

Then, in your shell:

```bash
export CLOUDFLARE_API_TOKEN='<the token you just created>'
export CLOUDFLARE_ACCOUNT_ID='<your account id>'
```

Both are the environment variables Wrangler documents for non-interactive use:
`CLOUDFLARE_API_TOKEN` is _"the API token for your Cloudflare account, can be used for
authentication for situations like CI/CD"_, and `CLOUDFLARE_ACCOUNT_ID` is _"the account ID for the
Workers related account"_.

**Set `CLOUDFLARE_ACCOUNT_ID`.** With it set, the token does not need permission to enumerate your
accounts. If Wrangler still reports that it cannot determine the account, add
`Account · Account Settings · Read` — and nothing more.

The token is a credential. Keep it in your shell's secret store or a password manager, never in a
file inside this repository.

---

## Step 2 — Get your daemon's fingerprint

With `fyd` running on the machine you want reachable:

```bash
fy pair --no-wait
```

That prints the pairing code and link without waiting for a scan. The fingerprint is the `fp=`
parameter of the link's fragment — the link is
`https://…/pair#v1;url=<daemon url>;code=<code>;fp=fy_daemon_…`, and the `fy_daemon_…` value is what
you want. It is **public**: it is in every pairing QR, and it is what addresses a rendezvous. It is
not a secret and does not need to be treated as one.

Repeat for every machine this relay should carry.

---

## Step 3 — List the fingerprints your relay will serve

Edit `packages/relay/wrangler.jsonc`:

```jsonc
"vars": {
  "RELAY_DAEMON_IDS": "fy_daemon_AAAA… fy_daemon_BBBB…",
},
```

Space- or comma-separated. **An empty list serves nobody** — that is the deliberate reading of a
relay whose operator never said who it is for, not a bug.

This list is your entire access control at the relay layer. A fingerprint that is not on it gets a
`404` from the stateless Worker before any Durable Object exists, so scanning your relay costs the
scanner a request rather than costing you an instance. Keep it current: remove machines you retire.

---

## Step 4 — Rehearse, then deploy

```bash
task relay:check
```

`--dry-run` compiles the Worker and resolves bindings and migrations without publishing anything to
Cloudflare. Expected output (verified against Wrangler 4.118.0 in this repository's devshell):

```
 ⛅️ wrangler 4.118.0
────────────────────
Total Upload: 757.13 KiB / gzip: 118.99 KiB
Your Worker has access to the following bindings:
Binding                                             Resource
env.RENDEZVOUS (RendezvousDurableObject)            Durable Object
env.RELAY_DAEMON_IDS ("fy_daemon_AAAA…")            Environment Variable

--dry-run: exiting now.
```

Check that `RELAY_DAEMON_IDS` shows the fingerprints you expect. If it shows `""`, step 3 did not
take effect and your relay would serve nobody.

Then:

```bash
task relay:deploy
```

That is `bunx wrangler deploy` in `packages/relay`. On success Wrangler prints the deployed Worker's
URL, of the form:

```
https://ferretry-relay.<your-subdomain>.workers.dev
```

Cloudflare documents the `workers_dev` configuration key as enabling use of the `*.workers.dev`
subdomain to deploy your Worker, and as defaulting to `true`. That is why no route configuration is
needed here. Note that URL —
it is the relay address, and everything below uses it as `$RELAY`.

```bash
export RELAY='https://ferretry-relay.<your-subdomain>.workers.dev'
```

### Using a custom hostname instead

`workers.dev` is fine and needs no DNS. If you want your own hostname, add a route to
`wrangler.jsonc` and redeploy; the token then also needs `Zone · Workers Routes · Edit` **for that
one zone only**. The relay address the two ends use is whatever hostname you settle on — it is the
`host` the daemon's claim signature covers, so it must be spelled identically on both ends and must
not change casually.

---

## Step 5 — Verify at the Worker

Three probes, in order of what they actually prove.

**1. It is alive and refuses strangers.** Anything that is not a rendezvous route is a flat `404`:

```bash
curl -i "$RELAY/"
```

```
HTTP/2 404
not found
```

**2. It is speaking the rendezvous protocol.** A well-formed rendezvous path without a WebSocket
upgrade is refused with `426`:

```bash
curl -i "$RELAY/v1/rendezvous/fy_daemon_AAAA…/client"
```

```
HTTP/2 426
expected a websocket upgrade
```

⚠️ **This does not prove your fingerprint is listed.** The upgrade check runs before the allowlist
check, so an unlisted fingerprint answers `426` here too. It only proves the Worker is deployed and
routing.

**3. The allowlist is doing its job.** Only a real upgrade attempt distinguishes them — a listed
fingerprint is accepted, an unlisted one is a `404`:

```bash
curl -i --http1.1 --max-time 5 \
  --header 'Connection: Upgrade' \
  --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' \
  --header 'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==' \
  "$RELAY/v1/rendezvous/fy_daemon_AAAA…/client"
```

A **listed** fingerprint answers `HTTP/1.1 101 Switching Protocols` — curl prints the headers and
then holds the upgraded connection until `--max-time` cuts it, so a `101` followed by a timeout is
the success signal, not a failure. An **unlisted** one answers `404` with `not found` and exits
immediately. Run it once with a fingerprint you listed and once with one you did not; if both answer
the same, `RELAY_DAEMON_IDS` did not deploy the way you think it did.

**4. Watch it live**, if you want to see requests arrive:

```bash
cd packages/relay && bunx wrangler tail
```

Cloudflare describes `wrangler tail` as _"start a log tailing session for a Worker"_. Your relay
cannot log what it carries — there is nothing in the payload it can read — so what you see is
request metadata.

---

## Step 6 — Point `fyd` and the PWA at it

### The client gap, exactly

**There is no shipped interface for this step.** Nothing is missing from your relay; what is missing
is the code on the two ends that would dial one. Naming it precisely so you can tell when it lands:

1. **A build-time discovery-origin constant in the PWA.** The relay lives on its own hostname, so
   the browser cannot find a relay advertisement at its own origin. A relative `/v1/default-relay`
   is wrong, and the PWA is served as a static Cloudflare Pages bundle — no Function, no proxy — so
   the discovery origin is compiled into the build. That origin identifies a _service_; it is not a
   daemon URL and identifies no user.
2. **A fetch-and-parse step** that reads the advertisement through `HostedRelayAdvertisementSchema`
   and turns it into a carrier via `hostedRelayConnection` — both already exist in
   `packages/relay/src/lib/hosted.ts` with no caller.
3. **A relay-capable transport on both ends.** This is the large one, and it is unstarted.
   - **The daemon.** `packages/daemon/src` has **no relay client and no relay configuration at
     all** — not a partial one, zero references to `packages/relay`. It needs a relay client that
     dials out and holds the socket open, the persisted key material it signs its rendezvous claim
     with, and the `fy` command surface and config layout to point it at an address.
   - **The browser.** `DaemonConnection` in `packages/pwa/src/lib/daemon-connection.ts` is
     `{ daemonId, baseUrl, deviceToken }` — it has no carrier field, so there is nowhere to record
     that a daemon is reached through a relay. Four files move together:
     `daemon-connection.ts` (the carrier on the record), `connections.ts` (persisting it),
     `daemon-transport.ts` and `event-transport.ts` (both build every request and socket from that
     single direct `baseUrl` today).
4. **Active-carrier disclosure on screen** — rendering `chooseConnection().reason` and the
   `describeConnectionMethod` observer list for a _live session_, so a session on a relay never looks
   like a direct one.

The decision layer those four would call is already written and tested in
`packages/relay/src/lib/connection.ts`: `connectionPreferenceOrder` puts direct first,
`chooseConnection` returns the plain sentence saying which carrier won and what it passed over.

**Prerequisite: [PR #198](https://github.com/kirinnee/ferretry/pull/198) (`986d1125`), and it is
discovery-only.** It removes the carrier chooser from onboarding, reads the hosted advertisement at
runtime, and compiles the discovery origin in as `FY_RELAY_DIRECTORY_ORIGIN` — supplied by the Pages
workflow from the same repository variable the relay's own deploy uses, and shipping no directory at
all rather than guessing when it is unset. That is pieces **1 and 2**. It says on its own screen that
nothing dials a relay yet, because nothing does.

Pieces **3 and 4** are still unwritten, so merging #198 does not make the steps below runnable, and
it does nothing for a relay of your own either way: what it discovers is the **hosted** deployment's
advertisement, and `/v1/default-relay` is a hosted-mode route that your `wrangler.jsonc` deployment
does not serve at all. Your relay is verified at the Worker, by
[step 5](#step-5--verify-at-the-worker), and by nothing in a browser yet.

**An expert override — a way to name a relay address for a specific daemon by hand — does not exist,
and this document will not invent a command for it.** When one lands, the intended shape is unchanged
from what the protocol already requires:

- the **same** relay address string is configured on the daemon and in the browser, because it is the
  `host` the daemon's claim signature covers, and a mismatch fails the claim rather than falling back;
- the daemon dials `/v1/rendezvous/<its fingerprint>/daemon` and the browser dials
  `/v1/rendezvous/<that fingerprint>/client`;
- direct is still attempted first, and the surface still names the carrier it ended up on.

Nothing about your relay changes when that ships. A relay deployed today is the relay those clients
will dial.

### End-to-end verification, once the prerequisite is met

Written out so the procedure is on record, not because you can run it today.

1. Put the daemon somewhere direct genuinely does not work — a different network from the phone, no
   VPN. This is the case the relay exists for, and testing on one LAN proves nothing, because direct
   would win.
2. `fy pair` on the host; scan the QR with the phone.
3. The session opens. **Confirm the screen names the carrier** and says why direct was passed over.
   A session that connects without naming its carrier is the failure mode this whole design is
   guarding against — report it rather than accepting it.
4. On the host, `cd packages/relay && bunx wrangler tail` should show the two socket arrivals
   (`/daemon` and `/client`) and then traffic. Two arrivals and no traffic means the sockets
   connected but the handshake did not complete.
5. Confirm your own relay is the one carrying it — the address on screen should be your
   `workers.dev` (or custom) hostname, not Ferretry's.

---

## What you can see, and what you cannot

Deploying a relay makes you an observer of your own traffic. Be honest with anyone else whose machine
you carry.

**You can see:**

- the **daemon fingerprint** in the URL — it is what addresses the rendezvous, and it is a stable
  pseudonymous identifier for one machine;
- the **daemon's long-term Ed25519 public key**, which it presents in the claim before any session
  exists. The fingerprint is a hash of it, so this is the same identity in unhashed form, and it is
  public by design — it is what proves the rendezvous belongs to that daemon;
- the **IP addresses** of both ends, when each connected, and for how long;
- **frame counts, frame sizes and timing** — enough to tell a burst of typing from a screenshot,
  because there is no padding or cover traffic in this version;
- **how many clients** are connected to a daemon, and when each arrived and left.

**You cannot see, and cannot make yourself able to see:**

- any frame payload;
- device tokens, session content, commands, command output;
- daemon names or device names.

The session is X25519 / Ed25519 / AES-256-GCM end to end between the daemon and the browser
([relay-protocol.md](relay-protocol.md) §§2, 6, 7). The relay forwards ciphertext it holds no key
for. That is structural: it is not a policy you could relax, and it holds even when a limit is hit
and the relay is refusing traffic.

Your Cloudflare account's own logs see the same metadata, on Cloudflare's terms rather than yours.

---

## Operating it

**You are now the availability.** If your relay is down, every daemon that depended on it is
unreachable from outside its own network. There is no automatic failover to Ferretry's hosted relay
from a relay you configured by hand — the address is a value you supplied, and the product will tell
you it could not reach it rather than quietly using something else.

**Monitor:**

- Cloudflare's **Workers & Pages → your Worker → Metrics** for requests, errors and duration;
- your **plan usage**, if you are on Free — the daily Durable Object caps are the first wall;
- `bunx wrangler tail` when something is wrong and you want to watch it happen.

**Upgrades are yours.** This relay is deployed from a checkout of this repository. Protocol changes
ship in this repository; a relay running old code against new clients is your problem to notice.
Re-run `git pull && task relay:check && task relay:deploy` when you update Ferretry. The
`compatibility_date` in `wrangler.jsonc` pins which Workers runtime version your Worker gets —
Cloudflare describes it as _"a date in the form `yyyy-mm-dd`, which will be used to determine which
version of the Workers runtime is used"_ — so a redeploy is not silently a runtime upgrade.

**If you stop operating it:** every daemon that named it stops being reachable through it. Nothing
is lost — no session content ever lived there, and the relay holds no key material — but the route
is gone. Move those daemons back to the hosted default, or to another relay, before you tear it down.

---

## Teardown

### Turn it off without deleting it

Set `RELAY_DAEMON_IDS` to an empty string in `wrangler.jsonc` and redeploy. The Worker stays up and
serves nobody. This is reversible and destroys nothing, and it is the right move if you are unsure.

### Delete it

⚠️ **This is destructive and cannot be undone.** Cloudflare documents `wrangler delete` as _"delete
your Worker and all associated Cloudflare developer platform resources"_ — that includes the Durable
Objects and their stored data. There is no trash and no restore. Deleting a Durable Object class
permanently deletes its data.

Rehearse first:

```bash
cd packages/relay
bunx wrangler delete --config wrangler.jsonc --dry-run
```

`--dry-run` is documented as _"do not actually delete the Worker"_. Read what it says it will remove.
Then, if you are sure:

```bash
bunx wrangler delete --config wrangler.jsonc
```

Do not attempt to hand-edit the `migrations` block into a delete migration to clean up classes
first — this configuration uses the `migrations` form, `migrations` and `exports` are mutually
exclusive, and a delete migration permanently deletes that class's data anyway. `wrangler delete` is
the supported path.

### Return to the hosted default

There is nothing to undo on the Ferretry side: a relay you ran was never registered anywhere central,
and the hosted default is a runtime advertisement your client reads, not a per-user setting. Remove
the relay address from the daemon and browser once the client override exists (see
[the client gap](#the-client-gap-exactly)), and the hosted fallback applies again. Until it exists,
there is nothing configured to remove.

### Credential cleanup

```bash
cd packages/relay
bunx wrangler secret list          # expect an empty list
```

This deployment stores **no Worker secrets**. `RELAY_DAEMON_IDS` is a plaintext `var`, deliberately:
a fingerprint is public. If `secret list` shows anything, you put it there, and
`bunx wrangler secret delete <NAME>` removes it.

Then **revoke the API token** in **Manage Account → API Tokens**. A deploy token that outlives the
deployment is a credential nobody is watching. Finally, clear it from your shell:

```bash
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
```

---

## Official sources

Verified **2026-08-04**. Cloudflare's plans, limits and prices are theirs to change — re-check before
you depend on any figure above.

- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) —
  plan availability, included limits, overage prices, hibernation and duration billing
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) — request and CPU
  limits, the $5 paid plan, and the no-egress-charge statement
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) —
  per-object storage caps, `SQLITE_FULL` behaviour, the 1,000 req/s soft limit
- [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/) —
  `deploy`, `delete`, `secret`, `tail` and their flags
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) —
  `workers_dev`, `migrations` / `new_sqlite_classes`, `compatibility_date`
- [Wrangler system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) —
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) —
  the exact permission names and their Read/Edit variants
- [Create an API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) —
  where account-owned tokens live and how they are scoped
- [API token templates](https://developers.cloudflare.com/fundamentals/api/reference/template/) —
  what the "Edit Cloudflare Workers" template actually grants
