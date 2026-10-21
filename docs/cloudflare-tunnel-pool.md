# Operating the hosted tunnel pool

This is the operator runbook for the **hosted tunnel carrier**: the Cloudflare accounts Ferretry's
hosted service provisions one tunnel per daemon on. The wire contract is
[`relay-protocol.md` §15](relay-protocol.md#15-the-tunnel-carrier-and-the-carrier-choice); this page is
only how to run it.

**Nobody using Ferretry needs this page.** A daemon finds the service by itself and a device chooses
a tunnel in Settings. This page is for whoever operates the hosted Worker
(`ferretry-hosted-relay`, `.github/workflows/relay-hosted.yaml`).

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

2. Store it, then delete the file:

   ```bash
   gh secret set HOSTED_TUNNEL_ACCOUNTS --repo kirinnee/ferretry < pool.json
   rm pool.json
   ```

3. Install it into the Worker without a deploy: run **Actions › Hosted relay › Run workflow** with
   `operation: tunnel-accounts` (a `deploy` installs it too).

4. Check it: `GET /v1/operator/tunnels` with the operator bearer (see
   [`relay-protocol.md` §13](relay-protocol.md#runtime-default-and-kill-switch) for the bearer) lists
   every account with its live count and whether its **zone check** passed. An entry whose zone is
   not in its account is reported `misconfigured` and is never used. Then
   `GET /v1/tunnel-service` should answer `"available": true`.

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
the control object's daily alarm, its DNS record included; the window is the `reclaimAfterDays`
setting in the operator configuration. A daemon that returns later simply gets a new hostname.

## Turning it off

Set every account `"accepting": false` to stop new tunnels, or install an empty array (`[]`) to make
the service advertise `available: false`. Existing connector tokens keep working until their
tunnels are reclaimed or deleted; to cut them at once, delete the tunnels in each account's
dashboard (Zero Trust › Networks › Tunnels).

## Rotating an account's API token

Create the new token, replace `apiToken` in the pool, reinstall (step 2–3 above), then revoke the
old token. Tunnels and their connector tokens are unaffected.
