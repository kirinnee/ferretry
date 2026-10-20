# Running your own Cloudflare relay

**This is an expert opt-in path. Almost nobody needs it.**

Ferretry's required behaviour connects a browser to a daemon directly whenever it can and falls back
to a relay Ferretry operates when it cannot, without asking for a carrier choice. This document is
for the person who would rather that fallback ran in their own Cloudflare account — because they do
not want a third party on the path at all, because they want the metadata to stay with them, or
because they simply prefer to own the infrastructure they depend on.

Onboarding does not offer this: it tries the daemon directly and falls back to the hosted relay on
its own. This is the expert runbook, not an ordinary setup step. If you are setting Ferretry up for
the first time, close this and use the app.

- **What a relay is, and what its operator can observe** — [relay-protocol.md](relay-protocol.md)
  §§9–11. Architecture lives there; procedure lives here.
- **The wire contract**, if you would rather implement a relay than deploy this one —
  [relay-protocol.md](relay-protocol.md). It is written so it can be implemented without reading this
  repository.

---

## Read this before you start: what you will and will not get

Deploying this Worker gets you **a relay both ends can use**. `fyd` dials out to it and carries
sessions over it (`packages/daemon/src/lib/relay/`), and the PWA reaches a daemon through it
(`packages/pwa/src/lib/relay-session.ts`, `relay-carrier.ts`, `relay-pairing.ts`). Pointing a daemon
at it is one entry in that daemon's configuration — [Step 6](#step-6--point-fyd-at-it).

One limit is declared rather than solved, and it decides whether this is useful to you:

- **A device that has never paired cannot find a relay you run yourself.** The only rendezvous a
  fresh device can discover for itself is Ferretry's hosted one, and the pairing link does not name a
  relay. So a daemon whose only relay is yours pairs a new device **only over a network where that
  device can reach the daemon's own address** — the same LAN, or a VPN. Once paired, the device is
  told about your relay and uses it from anywhere. Listing the hosted relay beside yours
  ([Step 6](#step-6--point-fyd-at-it)) gives off-network first pairing back, at the cost of using
  Ferretry's rendezvous for it.

The full list of what is built and what is still missing around the relay — including the browser
screens that still connect directly only — is [relay-protocol.md](relay-protocol.md) §13,
_What is built, and what is not_. This runbook does not restate it.

---

## Prerequisites

| You need                     | Notes                                                                      |
| ---------------------------- | -------------------------------------------------------------------------- |
| A Cloudflare account         | Free is enough — see [Cost](#cost-and-what-drives-it).                     |
| This repository, checked out | `git clone https://github.com/kirinnee/ferretry`                           |
| The repo's devshell          | `direnv allow`, or `nix develop`. Every command below runs inside it.      |
| `fyd` installed and running  | You need a daemon fingerprint, and the daemon must be running to print it. |

Wrangler comes from the repository's flake-locked Nix devshell. The first `direnv allow` or `nix
develop` may need network access to fetch that pinned toolchain; relay commands never resolve npm's
latest Wrangler while they hold your Cloudflare credential.

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
Cloudflare. Expected output at this revision (the version and bundle sizes change when the flake or
Worker changes):

```
 ⛅️ wrangler 4.93.0 (update available 4.118.0)
──────────────────────────────────────────────
Total Upload: 759.98 KiB / gzip: 119.82 KiB
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

That is `wrangler deploy` in `packages/relay`. On success Wrangler prints the deployed Worker's
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
cd packages/relay && wrangler tail
```

Cloudflare describes `wrangler tail` as _"start a log tailing session for a Worker"_. Your relay
cannot log what it carries — there is nothing in the payload it can read — so what you see is
request metadata.

---

## Step 6 — Point `fyd` at it

You configure **the daemon only**. A paired browser learns where its daemon can be reached from the
daemon itself — the `carriers` set on the pairing response and on `GET /v1/carriers`
([relay-protocol.md](relay-protocol.md) §13, _The carrier set a daemon publishes_) — so there is no
browser setting, and the relay address the browser dials is the exact string the daemon's claim
signature covers. The app's Connection panel links back to this runbook for exactly that reason: it
reports which carrier is live and never offers a relay setting of its own.

**1. Add your relay to the daemon's carrier list.** Edit `${FY_HOME:-~/.ferretry}/config/daemon.json`
(there is no `fy` command for this list yet):

```jsonc
"carriers": [
  { "kind": "relay", "url": "wss://ferretry-relay.<your-subdomain>.workers.dev" }
]
```

Use the address from [step 5](#step-5--verify-at-the-worker), or your custom hostname. It must be
`wss:` (or `https:`); plain `ws:` is accepted only against loopback. An entry you write **wins and is
never overwritten** by discovery. To keep Ferretry's hosted relay as well — which is what lets a
device that has never paired reach the daemon off-network — list it beside yours:

```jsonc
"carriers": [
  { "kind": "relay", "url": "wss://ferretry-relay.<your-subdomain>.workers.dev" },
  { "kind": "relay", "source": "discovery" }
]
```

At most four relays. A list with a duplicate or a fifth one refuses the boot rather than quietly
dropping one. The schema is `packages/daemon/src/lib/runtime/carriers.ts`.

**2. Restart `fyd`, then check what it decided:**

```bash
fyd --check
```

It names the relay posture in one line — direct-only, hosted, or self-hosted, and which.

**3. Pair a device.** Because a fresh device cannot discover your relay
([the declared limit](#read-this-before-you-start-what-you-will-and-will-not-get)), first pairing
goes direct unless the hosted entry is also listed. That means the device must be able to reach the
daemon's own address for the pairing itself — the daemon has to listen beyond loopback, which is
`"host": "0.0.0.0"` plus `"publicUrl"` in the same file ([pairing.md](pairing.md)). For a daemon
that only listens on loopback and lists only your relay, `fy pair` draws no QR and says so, because
nothing off that machine could redeem it.

**4. Use it from anywhere.** Once paired, the device holds the daemon's published set and walks it:
every direct address first, then every relay, in the daemon's order. The Connection panel on the
machine’s Machine tab in Settings leads with direct, via relay (naming which relay and its host) or
reconnecting, then names the carrier the live session is actually on and why the others were passed
over.

### End-to-end verification

1. Pair the device as in step 3 above.
2. Move the device to a network where the daemon's address is genuinely unreachable — a different
   network, no VPN. Testing on one LAN proves nothing, because direct would win.
3. Open the app. **Confirm the Connection panel on the machine’s Machine tab in Settings reads "Via relay" and names your relay as the carrier** and says why direct was
   passed over. A session that connects without naming its carrier is the failure mode this design
   guards against — report it rather than accepting it.
4. On the host, `cd packages/relay && wrangler tail` should show the two socket arrivals (`/daemon`
   and `/client`) and then traffic. Two arrivals and no traffic means the sockets connected but the
   handshake did not complete.
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
unreachable from outside its own network — unless its `carriers` list also names the hosted relay
(`"source": "discovery"`), in which case the device moves on to that one. A daemon whose list names
only yours does not dial Ferretry's, and the product tells you it could not reach your relay rather
than quietly using something else.

**Monitor:**

- Cloudflare's **Workers & Pages → your Worker → Metrics** for requests, errors and duration;
- your **plan usage**, if you are on Free — the daily Durable Object caps are the first wall;
- `wrangler tail` when something is wrong and you want to watch it happen.

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
wrangler delete --config wrangler.jsonc --dry-run
```

`--dry-run` is documented as _"do not actually delete the Worker"_. Read what it says it will remove.
Then, if you are sure:

```bash
wrangler delete --config wrangler.jsonc
```

Do not attempt to hand-edit the `migrations` block into a delete migration to clean up classes
first — this configuration uses the `migrations` form, `migrations` and `exports` are mutually
exclusive, and a delete migration permanently deletes that class's data anyway. `wrangler delete` is
the supported path.

### Return to the hosted default

There is nothing to undo on the Ferretry side: a relay you ran was never registered anywhere central,
and the hosted default is a runtime advertisement both ends read, not a per-user setting. Remove
your relay's entry from the daemon's `carriers` list and restart `fyd`: a list that declares no
rendezvous takes the hosted one again. Nothing is changed in the browser — a paired device replaces
its stored carriers with the daemon's published set after its next successful connection, so the
old address drops out on its own.

### Credential cleanup

```bash
cd packages/relay
wrangler secret list          # expect an empty list
```

This deployment stores **no Worker secrets**. `RELAY_DAEMON_IDS` is a plaintext `var`, deliberately:
a fingerprint is public. If `secret list` shows anything, you put it there, and
`wrangler secret delete <NAME>` removes it.

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
