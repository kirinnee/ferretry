# Loopback firewall for shared Linux hosts

On a host with several users, the agent Chrome's DevTools port, the proxy sign-in relay and the
login window's VNC port are loopback ports any local user can reach. When `browserPorts` is
`per-user` or explicit, each user's ports are fixed and a **root-installed nftables rule** rejects
every other uid on them.

## What the host admin installs

Two files, shipped in `scripts/host/` and printed verbatim by the CLI for brew and nix installs:

```sh
fy browser firewall script | sudo tee /usr/local/sbin/ferretry-loopback-firewall >/dev/null
sudo chmod 0755 /usr/local/sbin/ferretry-loopback-firewall
fy browser firewall unit | sudo tee /etc/systemd/system/ferretry-loopback-firewall.service >/dev/null
sudo systemctl daemon-reload && sudo systemctl enable --now ferretry-loopback-firewall
```

After each conf edit: `sudo systemctl restart ferretry-loopback-firewall`. Stopping the unit
deletes `table inet ferretry` and the marker; Docker's tables are never touched.

## `/etc/ferretry/loopback-firewall.conf`

Root-owned, in a root-owned directory, not writable by group or others. `#` comments and blank
lines are ignored.

```text
base 20000                       # optional, once; default 20000
user 1001                        # ports derived from base
user 1002 21000 21001 21002      # explicit cdp relay vnc, for a user with explicit browserPorts
```

Derivation: `b = base + (uid - 1000) * 4`, so cdp is `b`, relay `b + 1` and vnc `b + 2`. Each
user runs `fy browser firewall entry` to print their exact line.

The script refuses the **whole** file, applies nothing and exits non-zero on: bad syntax, a uid
below 1000, a duplicate uid, a port claimed twice, a derived port above 32767, a base below 1024,
or a conf (or its directory) not owned by root or writable by group or others.

## The marker

After a successful apply the script writes `/run/ferretry/loopback-firewall.json` (directory 0755,
file 0644, written atomically; no secrets):

```json
{
  "version": 1,
  "appliedAt": "2026-01-01T00:00:00Z",
  "base": 20000,
  "entries": [{ "uid": 1001, "ports": [20004, 20005, 20006] }]
}
```

Daemons read it to report whether the firewall is applied, missing or stale.

## Tests only

`FERRETRY_FIREWALL_CONF`, `FERRETRY_FIREWALL_RUN_DIR` and `FERRETRY_NFT` redirect the conf, the run
directory and the nft binary for the integration tests, and the script **enforces** that they are
test-only: as root it refuses, applying nothing, when any of them is set, and it runs nft only from
`/usr/sbin/nft`, `/sbin/nft` or `/usr/bin/nft` (the first executable), never through `PATH`, refusing
when none exists. Without `FERRETRY_FIREWALL_RUN_DIR` it refuses to run as anyone but root.

`FERRETRY_FIREWALL_TEST_UID` is the seam that lets a non-root test stand in for root and reach those
checks. It is honoured only when the real uid is not root; real root refuses it like any other
override, so it cannot be used to weaken a root run.

The port arithmetic is pinned to `scripts/host/per-user-ports.fixtures.json` by a test on the bash
side and one on the TypeScript side (`perUserBrowserPorts` in `@ferretry/protocol`).
