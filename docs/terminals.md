# Terminals

A terminal — a `%terminal:<key>` tab, `terminal_open`, `fy terminal open` — is a real shell in a tmux
pane on the daemon's own private tmux socket, rooted in the session's folder.

## Which shell it runs

**Your own login shell, started as a login shell** (`<shell> -l`), so your rc files load: aliases,
history, completion and prompt. It is never hard-wired to `/bin/sh`.

The daemon picks the shell **once**, when the first terminal opens after it starts, from these in order:

1. `terminals.shell` in `config/daemon.json`, if you set one.
2. Your account's login shell: the passwd entry for the daemon's uid (`getent passwd <uid>`, then
   `/etc/passwd`); on macOS the directory service (`dscl . -read /Users/<you> UserShell`), because a
   launchd daemon often has no `$SHELL`.
3. `$SHELL` in the daemon's environment.
4. `/bin/sh`.

A candidate is used only if it is an **absolute path listed in `/etc/shells`** and an **executable
file** (`nologin`, `false` and `true` never count). A candidate that fails is skipped and the daemon
says why, once, on its log: `terminals: /opt/x from terminals.shell in config/daemon.json was not used
because it is not listed in /etc/shells; terminals open /usr/bin/zsh.` If nothing qualifies,
terminals open `/bin/sh` and the log says so. A change (to the setting, or to your login shell) applies
after a daemon restart; terminals already open keep the shell they started with.

## `terminals.shell`

```json
{ "terminals": { "shell": "/usr/bin/fish" } }
```

Omit it to follow your account. It is for a machine where you want a different shell for terminals than
the one your account records. It lives in `config/daemon.json` — a file on the host, edited at the host
— and it is **not** part of the remotely settable `grants` block, so no paired device can change it.
Even there it is held to the `/etc/shells` check above: it chooses between shells the machine already
vouches for, and cannot make the daemon run an arbitrary program for a terminal.

## A command passed to `terminal_open`

`terminal_open(name, folder?, command?)` does not hand the command to the shell as an argument: the
terminal opens, then the command is **typed into it with Enter**, as you would. So it runs the same in
zsh, bash and fish, sees your rc files' `PATH` and functions, and stays in the shell after it exits.
Write it in your shell's own syntax.

## How many, and who holds them

The daemon keeps at most 24 terminals open across every session (and a smaller number per session). A
terminal is a tmux session of its own, so it would outlive the ferret that opened it; the daemon closes
the ones whose owner is **finished** (`completed` or `stopped`) or **gone** (no longer in the session
store). It does so when it starts, whenever a session settles into one of those states, and on its
60-second sweep. A session in any other state, or one whose state cannot be read, is treated as live and
is never closed. A terminal opened on purpose on an already-finished session is closed by the next sweep.

Each close writes a `terminal.closed` audit line per owner (count, status, and whether it was the
`boot`, `sweep` or `owner` that asked). When the limit is hit anyway, the refusal names who holds the
slots, for example `24 terminals open: 6 by fitzgerald (stopped), …`.

To look and to clear by hand:

- `fy terminal slots` — who holds the slots.
- `fy terminal close --all-finished` — close every finished or gone owner's terminals now.
- Settings › Machine › Terminals — the same view with a close button.
- `GET /v1/terminals` and `POST /v1/terminals/close-finished` — the routes behind both (operator, capability `terminal` / use).
