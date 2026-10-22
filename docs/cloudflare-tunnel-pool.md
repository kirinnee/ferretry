# Operating the hosted tunnel pool

This is the operator runbook for the **hosted tunnel carrier**: the Cloudflare accounts Ferretry's
hosted service provisions one tunnel per daemon on. The wire contract is
[`relay-protocol.md` §15](relay-protocol.md#15-the-tunnel-carrier-and-the-carrier-choice); this page is
only how to run it.

**Nobody using Ferretry needs this page.** A daemon finds the service by itself and a device chooses
a tunnel in Settings. This page is for whoever operates the hosted Worker
(`ferretry-hosted-relay`, `.github/workflows/relay-hosted.yaml`).

## Tunnels are opt-in

A daemon asks this service for a tunnel **only when its owner turned the tunnel on for that machine**:
`fy daemon tunnel on` at the machine, or Settings › Connection in the app (`PUT /v1/tunnel`, which a
paired device needs `pairing.configure` and a passkey confirmation for — see
[grants.md](grants.md#turning-the-tunnel-on-or-off)). Either writes
`{ "kind": "tunnel", "source": "discovery", "enabled": true }` into the machine's `config/daemon.json`
and applies it at once, without a restart. `fy daemon tunnel off` writes `"enabled": false`, stops the
connector and **releases the tunnel back to this pool immediately** (the signed
`POST /v1/tunnel/release`). `fy daemon tunnel status` and `fy daemon status` say which.

A daemon whose document names no tunnel runs none. So the pool's size is the number of machines whose
owners chose a tunnel, not the number of installs.

**Migration.** Daemons released before the tunnel became opt-in asked for one whenever `cloudflared`
was present. Once updated, a daemon with no explicit tunnel entry **releases the tunnel it holds on its
first boot** and says ``tunnel carrier off (opt-in) — released <url>; turn on with `fy daemon tunnel on` ``.
Expect the pool to shrink after a release; a machine whose owner wants its tunnel back runs
`fy daemon tunnel on` and is given a new one. A daemon that cannot reach the service keeps its record
and asks again on its next boot; one that never comes back is reclaimed below.

## What one pool entry is

Each entry is one Cloudflare account **and one zone in that same account**. The pairing is not a
convenience: Cloudflare only routes a tunnel's public hostname when the DNS record is in the same
account as the tunnel ("The `cfargotunnel.com` subdomain only proxies traffic for DNS records in the
same Cloudflare account"). A zone in account B cannot carry a tunnel created in account A.

| Field        | What it is                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `name`       | Your label for the entry: lowercase letters, digits and `-`, up to 32 characters. Unique.           |
| `accountId`  | The account's 32-hex id (dashboard › any zone › Overview, right column).                            |
| `apiToken`   | An API token from that account — see the permissions below. **A secret.**                           |
| `zoneId`     | The zone's 32-hex id, from the same Overview panel.                                                 |
| `zone`       | The zone's name, lowercase, e.g. `fy-tunnels-1.example`. Tunnel hostnames are `<random>.<zone>`.    |
| `maxTunnels` | Optional. Defaults to **1,000**, Cloudflare's per-account tunnel limit; may be lower, never higher. |
| `accepting`  | Optional, default `true`. `false` **drains** the account: no new tunnels, existing ones kept.       |

Hostnames are one label deep (`<label>.<zone>`), which is what the zone's free Universal SSL
certificate covers. Use a zone you dedicate to this — every tunnel adds one proxied `CNAME` to it.

### The API token

Create it in the account it belongs to (My Profile › API Tokens › Create Token › Custom token):

- **Account › Cloudflare Tunnel › Edit** — create, configure, clean up and delete tunnels;
- **Zone › DNS › Edit**, scoped to **that one zone** — create and delete the `CNAME` records;
- **Zone › Zone › Read**, scoped to the same zone — the service checks the zone belongs to the account
  before it places a tunnel there.

Nothing else. The token never leaves the Worker: a daemon only ever receives its own tunnel's
**connector token**.

## Adding an account

The pool's source of truth is the GitHub Actions secret **`HOSTED_TUNNEL_ACCOUNTS`**, a JSON array of
the entries above. The Worker reads it as its own secret `TUNNEL_ACCOUNTS`.

1. Write the whole pool to a file outside any repository, with every entry you want — the secret is
   replaced, not merged:

   ```json
   [
     {
       "name": "pool-1",
       "accountId": "0123456789abcdef0123456789abcdef",
       "apiToken": "…",
       "zoneId": "fedcba9876543210fedcba9876543210",
       "zone": "fy-tunnels-1.example"
     },
     {
       "name": "pool-2",
       "accountId": "…",
       "apiToken": "…",
       "zoneId": "…",
       "zone": "fy-tunnels-2.example",
       "maxTunnels": 500
     }
   ]
   ```

2. Store it **minified to one line**, then delete the file. GitHub masks a secret in logs line by
   line, so a pretty-printed pool would be masked a fragment at a time:

   ```bash
   jq -c . pool.json | gh secret set HOSTED_TUNNEL_ACCOUNTS --repo kirinnee/ferretry
   rm pool.json
   ```

3. Install it into the Worker without a deploy: run **Actions › Deploy Hosted Relay › Run workflow**
   with `operation: tunnel-accounts` (a `deploy` that publishes installs it too). It refuses a value
   that is not a JSON array before writing anything. **Installing a secret publishes a new Worker
   version, which drops every live session** exactly as a deploy does — do it on purpose, not
   routinely. A deploy never removes the pool: its secrets are additive, so leaving
   `HOSTED_TUNNEL_ACCOUNTS` unset keeps whatever the Worker holds.

4. Check it: run the workflow with `operation: tunnels`, or `GET /v1/operator/tunnels` with the
   operator bearer (see [`relay-protocol.md` §13](relay-protocol.md#runtime-default-and-kill-switch)
   for the bearer). It lists every account with its live count and its **zone check** — `passed`,
   `failed` (the zone is not in that account, or the token cannot read it: the account is never used),
   or `unchecked` (nobody has been placed on it yet; the first placement checks it). It also says
   whether the pool parsed (`pool`, and `poolProblem` when it did not). Then `GET /v1/tunnel-service`
   should answer `"available": true`.

A pool that does not parse is treated as **no pool**: the service advertises `available: false`
and the Worker logs the reason (never the value). Fix the JSON and rerun step 3.

## Order, capacity and draining

- A new tunnel goes to the **first accepting account in the array's order that has room**. Put the
  account you want filled first, first.
- When every accepting account is at `maxTunnels`, daemons are refused `tunnel_capacity` and fall
  back to their other carriers; add an account.
- To retire an account, set `"accepting": false` and reinstall. It keeps renewing and reclaiming its
  tunnels; once `GET /v1/operator/tunnels` shows it at zero, remove it from the array. **Do not remove
  an account that still holds tunnels**: its token is the only thing that can delete them, so they
  would be stranded (delete them in that account's dashboard if it happens).

## Reclaiming

A daemon renews its tunnel every day it runs. A tunnel nobody renewed for **30 days** is deleted by
the control object's daily alarm, its DNS record included. A daemon that returns later simply gets a
new hostname. A tunnel whose creation never finished (Cloudflare failed halfway and the daemon never
retried) is deleted after one day.

Change the window with the workflow's `tunnels` operation and `reclaim_after_days` (1–365), or:

```bash
curl --request PUT --header "Authorization: Bearer $OPERATOR_BEARER" \
  --header 'Content-Type: application/json' --data '{"reclaimAfterDays": 14}' \
  "$HOSTED_RELAY_ORIGIN/v1/operator/tunnels"
```

A deletion step Cloudflare refuses is retried on the next alarm; the tunnel stays counted against its
account (and in `pendingDeletions`) until every step has succeeded. A pass deletes at most 8 tunnels
and comes back a minute later for the rest. The Worker logs every failed step — what Cloudflare said,
never a token — under the Worker's observability logs.

## Orphaned tunnels

If an account is removed from the pool while it still holds tunnels, the status lists them under
`orphaned`. The service never touches them again (it has no token for that account), and a daemon
whose tunnel was there is given a new one on another account at its next renewal. Either put the
account back — with `"accepting": false` — so they are reclaimed normally, or delete them by hand in
that account's dashboard. The same reasoning keeps every row safe while the pool does not parse: a
broken secret orphans rows, it never deletes them.

## What is proved, and what is not

The provisioner is tested against a fake Cloudflare that models the per-account tunnel limit, zone
ownership, error 1022 (a tunnel with live connections refuses deletion) and the CNAME a deleted
tunnel leaves behind. That proves the service's half. It does not prove Cloudflare behaves like the
fake: the first real account in the pool is that test, and `operation: tunnels` is how you read it.

## Turning it off

Set every account `"accepting": false` to stop new tunnels, or install an empty array (`[]`) to make
the service advertise `available: false`. Existing connector tokens keep working until their
tunnels are reclaimed or deleted; to cut them at once, delete the tunnels in each account's
dashboard (Zero Trust › Networks › Tunnels).

## Rotating an account's API token

Create the new token, replace `apiToken` in the pool, reinstall (step 2–3 above), then revoke the
old token. Tunnels and their connector tokens are unaffected.
