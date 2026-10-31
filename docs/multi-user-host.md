# Several people on one Linux host

How to give two or three people their own Ferretry on one shared Linux machine (an EC2 box, say), so
each runs a separate daemon as a separate Linux user. Treat every other user, **and every agent they
run**, as untrusted: nothing one of them does may read or drive another's daemon, terminals, browser,
secrets, logins or files.

**Linux only.** A Mac is one person's machine in every setup this product supports. The checks that
keep users apart (for example `fy` refusing to send a credential to a port another uid holds) do not
run on macOS.

## What keeps two users apart

Each user's Ferretry lives entirely under their own `FY_HOME` (default `~/.ferretry`, kept `0700` on
every boot), with its own daemon, port, identity, tokens and tmux server. In detail:

| Thing                                                | Why another user cannot reach it                                                                                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin token, secrets vault, devices, daemon identity | `0600` files inside the `0700` state home, written atomically                                                                                                                                        |
| Daemon HTTP API                                      | Every route needs a credential except health, `/usage` and `/metrics`. Arriving from loopback grants no owner rights by itself                                                                       |
| Port                                                 | The first boot takes the first free port from 7431 to 7446 and records it, so the second user gets 7432 automatically. `fy` will not send its token to a port another uid holds                      |
| tmux                                                 | A private socket `<FY_HOME>/tmux.sock` (`srwx------`). Pane environment and typed keys go to tmux on stdin, never in a process's arguments                                                           |
| Agent browser                                        | Its own profile under `<FY_HOME>/browser`. Its X display (window mode, login window) needs a cookie only its owner holds. **Its debugging port is NOT protected yet** — see the first declared limit |
| Phone pairing and relay                              | Each daemon has its own identity. A code is minted only by its owner, lives 2 minutes, and never appears in a process's arguments                                                                    |
| `fy secret use`                                      | The value goes only into the child's environment. `/proc/<pid>/environ` is readable by the same uid only                                                                                             |

## Setting up a new user

Run steps 1–4 as an administrator (with `sudo`), and steps 5–7 as the new user. Replace `alice`.

1. **Create the user with a private group and home.** Don't add them to anyone else's group, and
   don't add them to `docker`: the docker group is root.

   ```bash
   sudo useradd --create-home --user-group --shell /bin/bash alice
   sudo chmod 700 /home/alice
   ls -ld /home/*        # every home: drwx------ (or drwxr-x--- with a group of one)
   ```

2. **Hide other users' processes** (recommended). This blocks every "read it from the process list"
   leak at once, including those this product has not yet found. `gid` names a group whose members
   still see every process; leave it out if nobody needs that.

   ```bash
   sudo groupadd -f procview
   sudo mount -o remount,hidepid=invisible,gid=procview /proc
   echo 'proc /proc proc defaults,hidepid=invisible,gid=procview 0 0' | sudo tee -a /etc/fstab
   ```

   If the host uses polkit (`pkexec`, some `systemctl` prompts), add its user to the group too
   (`sudo usermod -aG procview polkitd`), or it stops seeing the processes it authorizes.

3. **Keep their daemon running when they are logged out.** Without this a daemon stops when its owner
   logs out, and its recorded port is free for anybody to take.

   ```bash
   sudo loginctl enable-linger alice
   ```

4. **Cap what their fleet can use**, so one user's agents cannot starve the box. These are
   persistent drop-ins on the user's systemd slice; pick numbers for your machine.

   ```bash
   sudo systemctl set-property user-$(id -u alice).slice MemoryMax=12G TasksMax=4096 CPUWeight=100
   ```

5. **Install Nix tooling as the user.** The multi-user Nix daemon is shared and safe to share: users
   don't need to be in `trusted-users`. Ferretry writes nothing outside the user's home and the store.
   Either use Home Manager (see [INSTALLATION.md](../INSTALLATION.md#quick-start)) or a profile:

   ```bash
   nix profile install github:kirinnee/ferretry
   ```

6. **Set it up.** This installs the user's own systemd unit, starts the daemon on the first free port,
   records that port, and offers the phone QR.

   ```bash
   fy setup
   fy daemon status      # shows the address it took, e.g. http://127.0.0.1:7432
   ```

7. **Sign in to their own accounts** (Claude, Codex, MCP servers) from their own `fy` or app. Never
   copy another user's `~/.ferretry`, `~/.claude` or `~/.codex`.

Check it worked, as the new user:

```bash
ss -ltnp | grep -E '127.0.0.1:74(3[1-9]|4[0-6])'   # one line per user's daemon, each owned by its user
ps -eo args | grep -c 'FY_SESSION_BOARD_CAPABILITY=' # 1 (the grep itself) — no credential in any argv
```

## Declared limits

These are known and are not protected against today:

- **Another user can drive your agent browser.** Chrome is driven over a loopback debugging port that
  has no authentication, so any local user can take over the logged-in browser profile while it runs.
  A pipe transport with no port exists, but it is not on by default: Chrome then tells every site
  `navigator.webdriver === true`, which costs sign-ins and bot checks. Until the owner chooses how a
  shared machine turns it on, **don't sign the agent browser in to anything that matters on a shared
  host**, or keep the browser off for users who do not need it.
- **Administrators see everything.** Root, and anyone with `sudo` or in the `docker` group, can read
  every user's files and processes. Isolation is between ordinary users only.
- **A tmux server started before the stdin fix** keeps the first session's credential in its argv until
  that session stops. It is not restarted for you. Stop and start that session, or let it end. Each
  launch now gets a fresh credential, so a stale copy dies with its pane.
- **The Codex sign-in callback is one host-wide port** (`localhost:1455`, then 1457). Only one person on
  the box can be mid-Codex-sign-in at a time, and another user can block or intercept that redirect.
  PKCE means a caught code alone cannot be redeemed. MCP servers with a fixed, provider-registered
  callback port have the same limit.
- **An authenticated browser proxy** (docs/browser-proxy.md) is reached through an unauthenticated
  loopback relay while the browser runs, so another user could use the proxy's credentials. Don't
  configure one on a shared host.
- **`/usage` and `/metrics` are public on loopback.** Another user can read quota percentages and
  account labels.
- **Loopback callers are not rate-limited**, so another user can slow a daemon down. They still can't
  authenticate.
- **`fy daemon` lifecycle commands use a lock at a fixed name in `/tmp`.** Another user can make those
  commands wait about two minutes and then refuse (a nuisance, not a takeover).
- **Downloads and screenshots** are written with the user's umask into the working tree. Keep work
  under the user's `0700` home.
- **Chrome runs with `--no-sandbox` on Linux.** It is not a cross-user hole by itself, but a renderer
  exploit lands as the owner.

## Where this was decided

The audit behind this page (card &I28) and its fixes: the CLI's port-owner check, X display
authentication, the pairing link kept out of argv, private temporary paths, tmux payloads on stdin, a
fresh session credential per launch, and a selectable pipe transport for the agent browser (off by default).
