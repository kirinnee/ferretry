# Secrets

A daemon-scoped store for credentials, and a way for an agent to **use** one without ever holding
it.

Read the [threat model](#threat-model) before you trust it with anything. The useful property here
is real, and it is narrower than people assume.

## Where it is on screen

Settings › this machine has three tabs, one per kind of credential; they share no data and no route:

- **Secrets** — env vars for the programs ferrets run (this page), and "Copy to another machine…".
- **Accounts** — who ferrets sign in as: username, password and 2FA keys, per site (the former "Saved logins").
  See [input requests](input-requests.md#saved-logins).
- **Secure copy** — values moved without a ferret seeing them, and "Pastes approved in advance"
  ([secure copy](secure-copy.md)).

The Claude, Codex and API-key logins with spend budgets are **AI logins** on screen (Warden, config files, Fleet);
their files stay `config/logins/*.yaml`.

## The shape

```bash
# Store a value. It comes in on stdin — never as an argument.
printf %s "$ANTHROPIC_API_KEY" | fy secret set ANTHROPIC_API_KEY

# See what exists. Names and instants; there is no value to show.
fy secret ls

# Use one. The value goes into the CHILD ferretry spawns, not into you.
fy secret use --with ANTHROPIC_API_KEY -- \
  curl -sS -H "x-api-key: $ANTHROPIC_API_KEY" https://api.anthropic.com/v1/models

fy secret rm ANTHROPIC_API_KEY
```

The same store is managed from the PWA under **Settings → this daemon → Secrets**: create, replace,
delete, and see _that_ a secret exists with its name and when it last changed.

## Why `use` instead of injecting into the agent

The obvious design puts the secret in the agent's own environment. That is honest but weak: a
process that has a value in its environment **can read it**, so "the agent cannot see it" would
simply be false, and only redaction would keep the transcript clean.

`fy secret use` moves the value out of the agent entirely. The agent writes the **name**; the daemon
resolves it and spawns a child with the value in _that child's_ environment; only the child's output
comes back, scrubbed. There is nothing in the agent's own process to echo into its conversation.

**There is no route, command or API that returns a secret value.** Not to an agent, not to `fy`, not
to the browser, not to a debug endpoint. This is enforced by the types rather than by a check: the
route table is handed a `SecretDirectory`, which has no method that opens ciphertext. Only six
things hold a `SecretVault` — the redactor, the use executor, the fleet launch environment that
resolves a runtime's credential and profile into the pane being started, the [MCP sign-in](mcp-oauth.md)
service, which opens an access token only to revoke it at sign-out (and alone holds a second vault over
its own sealed document of refresh tokens and client secrets), the
[outbound provider authorizer](#speed-up-keys-the-fifth-holder), and the
[secret export](#copying-secrets-to-another-machine), which answers only ciphertext that another machine
alone can open — and none of them returns what it read.
A getter added "just for testing" would delete the whole property.

[Accounts](#accounts-and-sign-ins-the-store) (the former saved logins) — the input bridge's password manager — follow the
same rule over a **separate** sealed document (`login-secrets.json`, under the same key). The route table is
handed an `AccountDirectory` (and the saved-login `LoginDirectory` built over it), which seals and never opens;
only two things hold the `AccountVault` that opens it: the redactor (saved values are masked as
`[redacted:login:<ID>:password]`) and the input-request service, which types one into the target the owner tapped
"Use" for and answers only what happened. Two narrow parts of it are handed out, and neither answers a value: the
directory holds its **seal port** (a merge moves a sealed value to the kept account inside the vault, and asks
whether two values are the same), and the look-alike route holds its **look-alike answer** (handles only). Both are fresh closures (`narrowAccountVault`), never the vault itself, so nothing that holds one can reach a value. `use`
cannot spend an account and `${secret:…}` cannot name one. The agent tool `account_hint` (`login_hint` still works) is
handed the account directory (and `GET /v1/accounts/hint` and `GET /v1/secrets/logins/hint` the same store): it
answers sign-in ids, labels, methods, places and usernames, never a value nor which fields exist.

## Redaction

Because the daemon knows the values, it removes them from text before that text is stored or
rendered:

- the output of a `use` child, on both stdout and stderr;
- an operator read of a session's **screen**, its **transcript**, and its **journal**;
- what a **browser page** shows through the browser tools — a read, a snapshot, the page's address —
  to an agent and to a person ([agent-tools.md](agent-tools.md#what-is-enforced-and-where)); a screenshot
  is pixels and is not;
- a ferret's **Processes** tab: every command line and every byte of a process's output
  ([processes.md](processes.md#secrets) says what that cannot catch).

So `fy secret use --with TOKEN -- sh -c 'echo $TOKEN'` returns `[redacted:TOKEN]`. The child really
did hold the value; what came back is a mask.

A vault the daemon cannot open **refuses** those reads rather than serving unscrubbed text. Text it
cannot scrub is text it must not serve.

Each read opens the vault **once**: a whole page of a journal or a transcript is scrubbed under one
open (`SecretRedactor.batch`), and the opened values are let go when that read returns. Nothing
caches them between reads, so plaintext lives no longer than the read that needed it.

## Threat model

### What this protects against

- **Secrets in transcripts and history.** An agent writes `${secret:NAME}` or `--with NAME`; the
  value is never in its conversation. If a tool prints one anyway, redaction masks it.
- **A value read off a screen.** The PWA never receives one. Write-only in, masked forever after.
- **A secret in a configuration file, or copied along with one.** `config/daemon.json`, a fleet
  document and any copied configuration hold a **reference**, never a value.
- **An agent writing the store.** Every ferret can reach the host admin token, but the daemon tells a ferret
  (`peer:`, a warden) from the owner's own `fy` and from a paired device, and **refuses a ferret the
  routes that change the store**, before it reads a body: `POST /v1/secrets` (set or replace),
  `DELETE /v1/secrets/:name`, the saved-login writes (`PUT`, rename, `DELETE` under
  `/v1/secrets/logins`), opening or filing a copy-in (`POST /v1/secrets/imports[/:importId]`) and
  sealing values out (`POST /v1/secrets/exports/:importId`). So a confused or prompt-injected agent cannot
  swap `GITHUB_TOKEN` for a value it controls, or delete it. It can still list names and **use** a secret
  by name. A ferret gets a value into the store the way it gets any secret from the owner: an input
  request (the owner sees a card and types it) or a sealed copy pasted into the store ([secure
  copy](secure-copy.md)); both show the owner a card. The owner's `fy secret set` in a normal shell and
  the app's write-only form keep working. Every one of these is a `caller: 'person'` route, refused with
  `403 owner_only` at the authorization boundary to a ferret on its own session credential, to the admin
  token naming a ferret's session, and to a warden (`callerIsAgent`, [agent-tools.md](agent-tools.md#who-a-ferret-may-be-every-route-says)).
  It holds against an honest or confused client, and a prompt-injected one using its tools and `fy`, not
  one that reads the admin token off the disk and leaves its session out.
- **A credential in shell history or in `/proc`.** `fy secret set` takes no value argument, so it
  cannot be typed onto a command line.
- **One file travelling without the other.** The vault at `<FY_HOME>/state/secrets.json` is
  AES-256-GCM ciphertext; the key is in `<FY_HOME>/state/secrets.key`. Both are `0600`. The most
  common way a secret escapes a machine is one file moving somewhere it should not — a backup, a
  tarball for a bug report, a synced directory, a paste into a chat — and every one of those fails
  safe now.

### What this does NOT protect against

- **An agent that is actively trying to exfiltrate a secret it is allowed to use.** Redaction finds
  the literal value. `echo $KEY | base64`, reversing it, printing it one character per line — none
  of those share a substring with the secret, and nothing can recognise an encoding it was not told
  about. **This is the same boundary `sudo` has.** It stops accidents and casual reading; it is not
  a sandbox.
- **Anyone who can read both files.** The key sits beside the ciphertext, so any process running as
  your user — or a backup that took the whole directory — has everything. This is encryption at rest
  against _accidents_, not against local access. A passphrase-derived key or an OS keychain would be
  a stronger claim; this is not that.
- **Anyone who already has your user account on that machine.**
- **A ferret that drops its identity, or reads the vault directly.** The refusal above is an
  **honest-client guard**, like the other owner-only rules (updating the daemon, confirming a configuration
  change). A ferret's own session credential is always refused it — the daemon reads who is asking from the
  credential, never from a header, and a ferret's `fy` and MCP server present that credential rather than
  the admin token ([below](#what-a-ferrets-fy-presents)). But the admin token is readable to the same user, so
  an agent can read it, or run `fy --as-owner`, and look like the owner's shell. The real limit is the one
  this whole section states: **agents run as the same user, with the admin token in reach.** Such an agent
  can also read `secrets.json` and `secrets.key` straight off the disk. The guard stops a confused or
  prompt-injected agent from using the obvious route; it does not stop one that is working around it.
  Only keeping ferrets out of the state home would.
- **Two writers that are not the store's own routes.** Importing your harness setup
  (`fy`'s setup import and clone, through `/v1/fleet/proposals/:id/apply`) adds secrets read from this
  machine's harness files, and only under names the store does not hold, so it cannot replace one. An
  MCP sign-in stores the token its authorization server answered, after a browser consent. Neither takes a
  value the agent chose; both are listed so they are decisions, not oversights.
- **A paired device, once it unlocks.** The secret routes sit on the seventh capability, `secrets`:
  `use` lists them and runs a command with one in its environment through `POST /v1/secrets/use`,
  which is code execution on this machine, and `configure` sets and deletes them. A device proves
  itself only inside a session its non-extractable device key signed, and does nothing until it unlocks
  the machine with a passkey ([design/zero-trust.md](design/zero-trust.md) A, B1). A new device holds
  `secrets` behind that unlock unless its code was minted `fy pair --limited`, and **inside an unlock it
  may use every secret with no further prompt** unless the owner turned on a per-act step-up. Treat an
  unlocked device as holding the vault's `use`.

Say the narrow version wherever this is described. Someone who believes the wide one will hand an
untrusted agent a production credential.

### What the state-home fence refuses

Two routes let a ferret read a file **with its own session credential**, no token stolen, and both used to reach
into the state home. They are closed by one rule, the state-home fence (`StateHomeFence` in `@ferretry/fleet`):
nothing the daemon reads, copies or starts for a ferret has a real path inside `FY_HOME` or the daemon's state and
config directories, wherever those are configured. Every check is made on the real path — and, where a file is
read, on the descriptor that was opened — so a symlink, a `..` or a folder that holds the home does not get past.
Each surface has exactly one opening, the one place it has a reason to read inside the home.

| Surface                                                                                        | What a ferret could do                                                                                                                                                                                         | What is refused now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The opening                                          |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Fleet component sources (`config.write`, the `settings` control)                               | `file: ~/.ferretry/api-token` copied the admin token into a runtime's `CLAUDE.md` — the model's context; `directory: ~/.ferretry` copied `secrets.key`                                                         | an **error** in the configuration check (never in effect; an older accepted version is retired), and refused again by the provisioner on every link hop and the real path at apply time                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | the fleet asset tree, `<fleet>/assets`, by real path |
| Fleet component destinations (every apply, and the shared-history migration)                   | swap `<runtime>/skills` for a link to `~/.ferretry/state` after its check: the sweep moved `secrets.key` aside as a "stale skill" and deleted it at commit                                                     | every folder below a runtime is reached through a checked descriptor, never by path (Linux `/proc`; macOS `fchdir` descriptor calls, proved on every step); a link below the home refuses the apply, and a backup is deleted only from the folder it was moved aside in. Where descriptor reach cannot be loaded, nothing outside the daemon's own folders is moved aside or removed — those operations, and the shared-history migration as a whole, are skipped and named in the result ([agent-tools.md](agent-tools.md#component-destinations))                                                                                                                                                                                                                                                                                                             | none                                                 |
| Conversation leases (`fleet/shared/<harness>/.leases`, every launch that names a conversation) | swap `.leases` (or the pool) for a link to `~/.ferretry`, then launch with `--resume api-token`: the lease JSON was renamed over the admin token, a later release deleted it, and `~/.ferretry/.lock` was made | the daemon's claim and the wrapper's `fy history claim` resolve one fence (`stateHomeFence`, owned by the fleet package: the homes and their pinned key files); the conversation id is parsed as one plain name at every boundary (letters, digits, `-`, `_`; a leading letter or digit; at most 128); `.leases` is opened through the guard — walked from the home without following a link, refused where it is a home or a key file by identity — and the lock, every lease read (a regular file only, never blocking, at most 64 KiB — a larger file is no lease; only `ENOENT` is none), write (a temporary made exclusively, renamed in the same held folder) and unlink reach their entry through that folder. Where descriptor reach or the lock's C call cannot be loaded, the lease is refused and the launch that named it says why; nothing else is | none                                                 |
| Session files (`/v1/sessions/:id/fs/*`)                                                        | read any session's tree, and `~/.ferretry/*` through a session started in `~`                                                                                                                                  | another session (only its own and its sub-ferrets'), every path inside the home, and a hard-linked file, for an **agent**; a person is unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | that session's media folder (`scope=media`)          |
| Starting a session (`POST /v1/sessions`, `fy new --cwd`)                                       | start a child whose working folder is `~/.ferretry`                                                                                                                                                            | a `cwd` inside the home, named or through a link, for an agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | none                                                 |

**What it does not change.** It is the daemon's fence, not the disk's: a ferret's own shell runs as the same user and
can still open `~/.ferretry` directly, which is the limit stated [above](#what-this-does-not-protect-against). What the
fence closes is the route where Ferretry itself does the reading — copying, linking, serving or starting — on a
ferret's word. **Hard links** are refused as a component source (another name of the file could be the admin token)
except inside the Nix store, which is root-owned and immutable and hard-links identical files by design. A home the
daemon cannot resolve refuses rather than guesses. The rules for each surface are in
[agent-tools.md](agent-tools.md#the-state-home); the agent file tools (`browser_upload` and friends) apply the
same guard ([agent-tools.md](agent-tools.md#files)).

### What a ferret's `fy` presents

A ferret's `fy` and its MCP server (`fy mcp serve`) present the **ferret's own credential**, not the host
admin token. In order:

1. **`FY_TOKEN` is set** → that, as always: the owner's scripts, a daemon on another machine.
2. **`FY_SESSION_TOKEN`** (or the older `FY_SESSION_BOARD_CAPABILITY`) **holds a `fys_` value** → `fy` asks
   the daemon's public `GET /v1/health` once per daemon per process. If it lists `session.credential.1`,
   every request carries `Authorization: Bearer fys_…` and `~/.ferretry/api-token` is **never opened**. This
   holds with or without `FY_SESSION_ID`: a ferret that drops its session id is still itself.
3. **Otherwise** → the admin token from `api-token`, plus `x-ferretry-session-id` inside a pane, as before.

- **A refusal is the answer.** Against a daemon that offers the credential, `403 owner_only`, `404` and `5xx`
  are reported as they are; `fy` never tries again with the admin token. A `401` earns one fresh health
  read, and only if that daemon no longer lists the feature (it restarted onto a wildcard or LAN bind, or was
  downgraded) is the request sent once more with the admin token, with a one-line note on stderr. Anything
  else, the read failing included, reports the `401`.
- **An older daemon**, or one reached on a bind where no session bearer resolves, does not list the feature, so
  it gets the admin token as before and its ferrets keep `fy send`. A long-lived process left on the admin
  token this way (`fy mcp serve`) reads the daemon's health again at most every 30 s, and moves to its own
  credential as soon as the daemon offers it or another daemon instance (a new pid) answers at that address.
- **A pane from before the `fys_` prefix** holds an unprefixed value. It is never sent as a bearer — only on
  the agent tools' own `x-fy-session-capability` header, as before — and that pane's `fy` uses the admin token
  until the pane restarts.
- **Never off this machine.** Neither credential goes to a non-loopback `FY_URL` (that needs `FY_TOKEN`), and
  each goes only to a listener this user owns.
- **`fy --as-owner …`** skips step 2. It is for a person who attached to a ferret's pane and wants their own
  rights there. **It is not a permission.** Any process that can read `api-token` can pass it, so a ferret can
  too, and a prompt injection that says "run `fy --as-owner …`" gets past these refusals exactly as one that
  says "read `~/.ferretry/api-token`" does — until the sandbox that denies ferrets that file, when the flag
  fails because the file cannot be read. The daemon cannot tell its calls from the owner's shell; the only
  trace is the command line and one stderr line, which lands in the ferret's own tool output:
  `fy: --as-owner: acting with the host admin token, not this ferret’s credential`. Inside a pane, the board, agenda,
  notify, session, work-search and `--session` terminal and browser commands still send `x-ferretry-session-id`
  under it, so those acts stay the ferret's (`peer:<id>`) and are still refused on person routes; only
  commands that send no session header (config, secrets, the daemon group, …) act as the owner.
- **`FY_TOKEN` in a pane wins.** Step 1 comes first, so a shell rc that exports `FY_TOKEN` puts every ferret
  whose shell reads it on the admin token, silently. `fy doctor` inside a pane warns about it, and about a
  pane whose credential is from before the prefix.
- **Codex shells.** Codex's `shell_environment_policy` default excludes, when a config turns them on
  (`ignore_default_excludes = false`), strip every variable whose name contains `TOKEN`, `KEY` or `SECRET`
  from the shell its commands run in — `FY_SESSION_TOKEN` included. Ferretry does not override that choice.
  `FY_SESSION_BOARD_CAPABILITY`, which `fy` reads too, survives it, so a Codex ferret's `fy` still finds its
  credential (measured on Codex 0.156.1, whose default strips neither); that name stays while Codex runs ferrets.
- **Restart ferrets to wall them.** A running ferret's `fy` presents its credential at once, because its pane
  already carries one. Its MCP server is the `fy` it started with and keeps the admin token until the pane
  restarts (`fy restart --all`), and a pane launched before the prefix needs the same restart.

What this makes a wall: every `caller: 'person'` refusal now holds against a ferret that uses its tools and
`fy` as shipped, including one prompt-injected through page text that drives them. What it does not: a
ferret that reads `api-token`, `secrets.key` or the sealed files through its own shell is still the owner to
this daemon. That needs keeping ferrets out of the state home, which a later change adds where the agent's
sandbox can enforce it.

## References in configuration

One grammar, everywhere: `${secret:NAME}`.

`config/daemon.json` may carry a `secretEnvironment` block of reusable recipes:

```json
{
  "secretEnvironment": {
    "AUTH_HEADER": "Bearer ${secret:ANTHROPIC_API_KEY}"
  }
}
```

A recipe is injected into a use child **only when every secret it names is one the caller explicitly
asked for**. Without that rule an operator's convenience would silently widen a request — a child
that asked for a staging key would be handed a header built from the production one.

**A missing referenced secret refuses at launch.** Never an empty string: a blank credential produces
a 401 twenty minutes later with nothing to point at. The management surface lists every configured
reference and whether the store holds it, so a broken one is visible before anything runs.

A **credential with `store: environment`** (and a **settings component**) is the other place a reference
comes from: its `env` may bind a variable to `${secret:NAME}`, which is how a runtime authenticates with
no login at all. Same grammar, same store, same refusal — see [the account model](./account-model.md).

**The refusal is judged against a published fleet, never the middle of an apply.** An apply moves the
manifest aside before linking its replacement in, and a launch that read the gap would find no account,
so no binding, so nothing to refuse. Every apply the daemon makes is exclusive, and every read of the
published fleet — a start's account, the launch's bindings, the runtime names — waits for one in flight
(`packages/daemon/src/lib/fleet/publication.ts`). A second apply landing between the judgment and the
pane's exec is still fail-closed: the new wrapper carries its own guard for every secret-backed variable.

## Accounts and sign-ins: the store

The saved logins became **accounts** (one identity: label, plain username, password, 2FA keys) and
**sign-ins** (how one account signs in at one place, a website or a terminal tool). The model, and how a saved
login maps onto it, is in [input requests](input-requests.md#accounts-and-sign-ins-data-model); this is the store.
The code is `packages/daemon/src/lib/secrets/accounts.ts`.

| File (`state/`, all `0600`) | Holds                                                                       | Written by                      |
| --------------------------- | --------------------------------------------------------------------------- | ------------------------------- |
| `login-entries.json`        | the index, `v: 2`: accounts by handle, sign-ins by id. Nothing secret.      | every change (the commit point) |
| `login-secrets.json`        | the secret fields, sealed under the vault's key, filed under account keys   | a change that seals a value     |
| `login-entries.v1.json`     | the saved-login index exactly as it was before the migration (`v: 1` bytes) | the migration, once, if absent  |

**The migration runs once, at boot, before any route mounts**, under the store's one lock:

1. Read the index. Absent: nothing to do. It parses as neither version: **damaged** — nothing is migrated,
   written or swept ([damaged is not empty](#damaged-is-not-empty)). Already `v: 2`: nothing to migrate.
2. A `v: 1` index: read the sealed document. Every sealed name the saved logins point at must be in it, and the
   accounts must point at every one of them. Otherwise **damaged**: nothing is migrated, nothing swept.
3. Keep the `v: 1` bytes as `login-entries.v1.json`, **only if no such file exists**.
4. Write the `v: 2` index. **This is the one commit point.**
5. **The sealed document is not written at all.** An account keeps its saved login's key, so every sealed name is
   the one it always was; only the index moves where it names a value from. The sweep then runs against `v: 2`.

A stop before 4 leaves `v: 1` in place, and the next boot does the same again, to the same ids. A stop after 4 is
committed. A reader before the commit migrates `v: 1` in memory with the same pure function, so it sees exactly
what the commit will write; a change made before the commit (there is none at boot, but the rule holds) keeps the
`v: 1` copy first and checks the sealed document the same way.

**The sweep keeps every seal an account points at: its password AND each 2FA key's seed.** The list it keeps is
built from one function in the protocol (`sealedNamesOf`); a sweep that walked only the password would delete
every saved 2FA seed at the next boot, and a test fails if it does.

**The migration is one kept `security.changed` record** (`kind: accounts-migrated`), in counts only: saved
logins, accounts, sign-ins, facts dropped (seen at a place that is none of the login's), places dropped, via
links dropped, 2FA seeds moved, and providers left without a link. The boot log names those providers: a login
went **via** them (Sign in with Google), the provider signs in on no site, so the link was dropped and nothing
ties them to that site's page any more. Give such an account its site in Settings › Accounts.

### Going back to an older daemon

An older daemon reads `login-entries.json` with its `v: 1` schema, so a `v: 2` index is **damaged** to it, never
empty: its list says so, every change to a saved login refuses, its boot sweep keeps everything, saved values stay
masked, and no card offers a saved login. To go back:

1. Stop the daemon.
2. `mv ~/.ferretry/state/login-entries.v1.json ~/.ferretry/state/login-entries.json`
3. Start the older daemon.

Every change made to accounts after the upgrade is lost: the older daemon sees the saved logins as they were. A
value sealed after the upgrade stays in `login-secrets.json`, masked, until the older daemon's sweep removes it.

**A password or seed you changed or deleted after the upgrade is gone from the restored index too.** The new daemon
swept the old value once nothing pointed at it, but the restored `v: 1` index still names it. Both daemons then read
the store as **damaged** — it fails closed, never empty:

- the older daemon types nothing for that login ("lost its password") and its boot sweep keeps everything;
- upgrading again, the migration finds a saved login naming a value that is not there, so it migrates nothing and
  **every change refuses**, including the delete that would fix it.

To repair it, in the **older** daemon, before upgrading again:

1. Find the login the older daemon says has lost its password or 2FA seed.
2. Type its password (or seed) again, or delete that login: `fy account edit <NAME> --password` (or `--totp` in
   that older `fy`), or `fy account rm <NAME>`; Settings › Accounts does the same.
3. Upgrade. The index now names only values that are there, so it migrates.

### Routes

All under the `secrets` capability (`use` to read, `configure` to change); every change is a kept
`secrets.changed` record, by handle or sign-in id only. **Every write is the owner's**: a ferret is refused before
its body is read, exactly as for the vault (honest-client until a ferret has its own credential).

| Route                                                     | Does                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /v1/accounts`                                        | owner only: accounts and sign-ins; recipes masked; damaged says so     |
| `GET /v1/accounts/hint?site=`                             | one hint per sign-in for the site, and the providers it leads to       |
| `GET /v1/accounts/look-alike`                             | owner only: groups of accounts with the same username AND password     |
| `PUT /v1/accounts/:id`                                    | create or change an account: label, username, password                 |
| `POST /v1/accounts/:id/rename`, `DELETE /v1/accounts/:id` | rename (`[[ID]]` in recipes follows); delete (its sign-ins go with it) |
| `POST /v1/accounts/:id/sign-ins`                          | add a sign-in `{ place, method?, recipe?, autoApplyRecipe? }`          |
| `PUT` / `DELETE /v1/accounts/sign-ins/:si`                | change or remove one sign-in                                           |
| `POST /v1/accounts/sign-ins/:si/recipe/proposals/:pid`    | the owner approves or declines a ferret's recipe                       |
| `POST /v1/accounts/:id/merge {from}`, `…/apart {from}`    | "these look like one account": merge, or keep apart                    |
| `PUT /v1/accounts/defaults`                               | owner only: the default account for a place (below)                    |

2FA keys have routes of their own: see [2FA keys](#2fa-keys).

**The default account per place** is `config/account-defaults.yaml`, not a part of the account store: its lines hold
**handles only**, never a value, and every change to it is held for the owner when anyone else makes it
([Default accounts](config-files.md#default-accounts)). `PUT /v1/accounts/defaults { scope, within?, key, account }`
is the owner's own write of one line (`account: null` clears it): a ferret is refused before its body is read, a
paired device needs the passkey step-up for loosening a configuration file, and the line is in effect at once (it is refused with `409 no_sign_in_here` for an account with no sign-in on that key). The card and `account_hint` read the file ([which account is first](input-requests.md#which-account-is-first-and-why)). The
account acts keep the lines true in the same act: a rename moves them, a delete drops them, a merge points them at the
account that kept the sign-ins, and a handle that is created (or renamed to) never inherits a line left for an old
account of the same name. If that rewrite fails the account act stands and the leftover line, which names no account,
is ignored with a warning on `GET /v1/config/status`.

**Honest limit of the project default.** The project that picks a default is the board's stamp on the session. An
Unfiled ferret can influence that stamp (a `.git` written in its own folder lets `fy task create` adopt a registered
project), so "Default for <project>" is only as trustworthy as the board stamp. It can only reorder sign-ins the daemon
matched, and the owner's tap is still the permission. Closing the adoption path is a follow-up. _RF-2: this route becomes `caller: 'person'`._

**"These look like one account" is offered, never automatic, and never stored.** It is computed on demand inside
the vault: same username (trimmed, case-folded) and same password, compared in constant time. The answer is
**handles only**, and no group ever holds a pair the owner kept apart: a set of look-alikes with such a pair inside is answered two by two, so "merge this group" can never fold that pair together through a third account. Writing it into the index would let anyone who can read
that file learn which accounts share a password. **Merge** moves the other account's sign-ins to the one kept,
takes its password and seeds only when the kept one has none (resealed under the kept account's key, inside the
vault), and is refused, with nothing changed, when both keep a different password or a different seed (the one not kept would be swept and lost), when both sign in at one place, or
when a via link would point an account at itself; via links and `[[FROM]]` in recipes follow to the kept account.

**The saved-login routes keep working for one release, as a projection.** `GET /v1/secrets/logins` (and its hint)
answer one saved login per account: `match` is every place it signs in, `domains` its websites' login domains,
and method, recipe and auto-apply its primary sign-in's (its website, else its first terminal). A change to the
account (label, username, password, removing its seed, rename, delete) always works; a seed is saved only with a
passkey ([2FA keys](#2fa-keys)), so a `totp` seed sent there is `403 add_2fa_key_needs_passkey`. A change to **where or how** it
signs in (`match`, `domains`, `method`, `recipe`, `autoApplyRecipe`) maps 1:1 onto the account's one sign-in,
and for an account that signs in at several places it is `409 account_has_sign_ins`: an older app's or CLI's body
cannot say which sign-in it means, and guessing would be a lossy write. A fact the daemon sees is filed on the
sign-in it was typed at (`AccountDirectory.observeSignIn`, the input service's only writer), and only at one of
that sign-in's own places; anything else is not kept.

**Advertised.** The card is sign-in aware on the daemon's side ([one tap](input-requests.md#the-next-time-one-tap)):
its offers name the sign-in, and a deliver's `signIn` must be one of the account's. The daemon reports
`accounts.signins.1` and `accounts.2fa-keys.1` now that the app draws the [Accounts screen](#the-accounts-screen); an
older daemon, which reports neither, keeps today's saved-logins surface.

### 2FA keys

An account keeps a list of **2FA keys** (at most 8): an authenticator app (`totp`), a phone number that gets SMS
codes (`sms`, its last digits only), an inbox that gets email codes (`email`), a push app (`push`) or a security key.
Only a `totp` key can hold a value — its **seed** — and then Ferretry makes that account's codes ("automatic codes").
At most 4 seeds per account (a backup app, a re-enrolled authenticator). Every other kind is a label and a few plain
facts, so a card can say where a code went. The seed rests in `login-secrets.json` like the password; the index
names its seal, never the value. The code is `packages/daemon/src/lib/secrets/two-factor-seeds.ts`.

**A seed is saved only with a passkey, every time, from every caller — the machine itself included.** A saved seed
means the password and the code then come from this one machine, and every ferret holds the admin token. So the
save is two steps, and the passkey binds to the one save:

1. **Stage.** The owner pastes the key (base32, or an `otpauth://totp/…` link) with the warning ticked. The daemon
   parses it again, checks it is for this account, seals it into **memory only** for two minutes, and masks it at
   once. The answer says what it read (issuer, account name, digits, period, algorithm), never the seed.
2. **Passkey.** The step-up options name the stage (`act: add-2fa-key`, `subject: st_…`). The challenge — and so the
   proof — is bound to `sha256("ferretry.add-2fa-key.v1\0" + account key + "\0" + stage)`.
3. **Commit.** Only a fresh proof for `add-2fa-key` bound to exactly that stage saves it, once, within two minutes.
   The seed is sealed under a fresh `…_TOTP_…` name and the index names it: one all-or-nothing change.

What does **not** stand in for that proof: the admin token on loopback (it is not a paired device, so it holds no
proof at all), an unlock, a step-up window, `stepUpOnActions` off, a proof for any other act, or a proof for another
stage. And the other way round: a proof for a seed opens no step-up window and is not the fresh proof that minting a
pairing code, widening a device or any other act takes. Both directions are tested.

- **No passkey on any device: refused** — "add a passkey in Settings › Security first" (`409 passkey_required`).
  Seeds saved before this release keep working; they are not asked again.
- **A key that says it is for another account** (its issuer or account name does not fit) is refused
  (`409 factor_mismatch`) unless the owner ticked "save it here anyway". The warning is advice: the passkey is the act.
- **Set up from a code card** (`request`): it saves only to the account the daemon matched for that card
  (`409 not_this_cards_account`), so a ferret cannot steer which account a card's key lands on. Staged from a paired
  device, the save then types the new key's first code into that card ("use it now", `typed` on the answer, `submit`
  on the stage), under every check a "Use code from Ferretry" tap gets
  ([input requests](input-requests.md#codes-ferretry-makes)); staged from the machine, it types nothing.
- **At most 4 seeds wait at once on the whole daemon, 2 per caller, and callers that are not a paired device share
  only 3** (`429`), so nobody fills its memory by staging and a ferret holding junk stages never keeps the owner's
  app from staging. **Only the caller that staged a seed, or a paired device, may read, drop or card it** (another
  caller is told it is not waiting): the stage id is on the agenda card, so knowing it proves nothing.
  Every stage route is `caller: 'person'`, so a ferret on its own session credential (or naming its session) is
  refused all of them before the body is read, and a session credential is keyed as its own caller even so.
  **What is still honest-client:** a ferret that reads the admin token and sends no session at all counts as the
  SAME caller as your own shell's `fy` (`admin-cli`), so it can use up or drop the stages `fy` made — never save a
  seed (that still takes your passkey). A paired device always keeps its own slot, so the app can always stage.
- **The old seed path is refused in the store itself** (`applySeed`), not only at its route: no caller, now or later,
  writes a seed except through the passkey-bound save.
- **Write-only.** No route, command, log, agenda item or push answers a seed or a code made from it. After the save
  the owner sees "Automatic codes: on".
- **Removing a key never asks for a passkey**: it only narrows what this machine can do. Its seed is swept with it.

**From the command line**, `fy account factor add <ACCOUNT> --totp` shows the warning, takes the key at a hidden
prompt (a base32 key or an `otpauth://totp` link), stages it and puts a card on the agenda — "Save automatic codes to
GitHub · kirinnee? Asked by fy on kirin-box at 14:02 UTC" — then waits. Allow it in the app with your passkey and it
prints "Saved"; Deny, or two minutes, and nothing is saved. `--session <id>` names the board for the card (the
current session's by default). The CLI has no way to save a seed itself.

The rest of `fy account` is in [input requests](input-requests.md#managing-them): accounts, sign-ins (`site`), recipes,
defaults, and 2FA keys that hold no value (`factor add --authenticator|--sms|--email|--push|--security-key`). Each write
is a person route; a ferret's call is refused by the daemon and `fy` reports that rather than retrying. **The old path is closed:**
`PUT /v1/secrets/logins/:id` with a `totp` seed — today's app form and `fy account edit --totp` — answers
`403 add_2fa_key_needs_passkey` with where to go instead; `totp: null` (remove the seed) still works there.

The card is answered by its Allow (the passkey ceremony, then the commit) or Deny (drop the stage). An agenda answer
saves nothing, so an app from before these cards shows the daemon's words and cannot save.

**The app draws this card itself** (`TwoFactorSeedHost`, in the Inbox and the agenda panel, wherever an item carries the
daemon's `twoFactorSeed` reference; a ferret's words that merely copy the title draw nothing). Every sentence is the
daemon's (subject, why, context); the app adds the one-factor warning with its tick, an amber box and a second tick when
the stage was staged with "save it here anyway" (the daemon marks that with `TWO_FACTOR_SEED_CARD_MISMATCH_LINE`, one
shared constant), **Allow** and **Deny**. Allow is the same shared flow as the "Set up automatic codes" panel: the
`add-2fa-key` passkey bound to THAT stage (`useAddKeyStepUp`), then the commit with no body. A dismissed passkey leaves
the stage waiting (it expires in two minutes), so the owner can try again or Deny; Deny drops the stage with no passkey. The
card reads only where the stage stands (`GET …/seed/:stage`) and the account's name; it never holds the key.

| Route (owner only, `secrets`/`configure`)                  | Does                                                                                | Passkey                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------- |
| `POST /v1/accounts/:id/factors`                            | add a key with no value (`sms`, `email`, `push`, `security-key`, a `totp` you hold) | no                         |
| `PATCH` / `DELETE /v1/accounts/:id/factors/:tf`            | relabel; remove (its seed swept)                                                    | never                      |
| `POST /v1/accounts/:id/factors/seed`                       | stage a seed (memory, two minutes); answers what was read                           | no (it saves nothing)      |
| `GET` / `DELETE /v1/accounts/:id/factors/seed/:stage`      | where a stage stands; drop it                                                       | no                         |
| `POST /v1/accounts/:id/factors/seed/:stage/commit`         | save it                                                                             | **yes, bound to `:stage`** |
| `POST /v1/accounts/:id/factors/seed/:stage/confirm-in-app` | put it on the agenda `{ session }` so the owner confirms it                         | no (it saves nothing)      |

Each is a kept `secrets.changed` record by account and key id (`factor-added`, `factor-relabelled`,
`factor-removed`, `factor-seed-staged`, …); a seed's save records `proof: passkey`. None records a value.

## Standing sign-in rules

A standing rule is **one owner-signed permission for Ferretry to fill one sign-in, for any ferret** (unless the
owner narrowed its scope to one board project or one session): **a page sign-in for up to 90 days, or sudo, su or doas
in a terminal for up to 7** ([below](#terminal-rules-sudo-su-or-doas)). Rules are owner state on disk,
`<state>/accounts/sign-in-rules.json` (directory 0700, file 0600, written atomically). Task-plan grants stay in memory.

> This stops a ferret putting the password anywhere else, or granting itself a rule, through Ferretry. It can't stop
> a ferret that reads Ferretry's own files, and any ferret may use this sign-in while the rule lasts.

**No rule fills until the app ships.** The service, the file, the routes, suspension, history and the fills through the
shared matcher ([input requests › Standing rule fills](input-requests.md#standing-rule-fills-a-sign-in-the-owner-approved-for-any-ferret))
are built; `sign-in-rules.1` stays unadvertised until the app draws the rule sheet and its cards, and until then every
sign-in a rule would cover is a normal card.

### Only the owner, a fresh passkey every time, bound to the bytes

Creating, resuming, renewing or widening a rule is a **stage** and a **commit**.

- **Stage** (`POST /v1/sign-in-rules/stages`). The owner ticks the username and password, and optionally the 2FA code.
  The code needs the red one-factor acknowledgement. The daemon then builds the rule's body itself:
  - It finds the sign-in and checks that it can have a rule. Its `surface` is the sign-in's own (a site is `page`,
    sudo, su or doas is `terminal`), never the caller's word.
  - It snapshots every pin (below).
  - It fixes `createdAt` and `expiresAt`: a page rule 30 days by default, 1 hour to 90 days; a terminal rule 1 day by
    default, 1 hour to 7 days.
  - It draws a 32-byte nonce.

  The stage waits two minutes, one per sign-in. Nothing is approved yet.

- **Passkey.** The `approve-sign-in-rule` challenge is _derived_ from the body:
  `signInRuleChallenge(nonce, signInRuleSubject(stage, canonical))`. `canonical` is the body's RFC 8785 bytes, and the
  body names the approving device. The challenge is answered only to the paired device the stage waits on:
  - A stage made in the app waits on the device that made it.
  - A stage made at the machine (`fy rules add`) waits in the app after `confirm-in-app`. A paired device then
    _takes_ it (`POST …/stages/:stage/bind`). That needs the same grants as the commit and a passkey on that device,
    and only then does the body name the device. Asking for passkey options binds nothing, so a device that could not
    commit can't take the stage from the owner's phone.

  The step-up service keeps the verified assertion
  ([zero-trust.md](design/zero-trust.md#stored-passkey-proofs)).

- **Commit** (`POST /v1/sign-in-rules/stages/:stage/commit`), in this order:
  1. It derives the challenge again from the body it is about to write.
  2. It claims the kept assertion with that challenge (`claimStoredProof`). The claim hands it over only if it is the
     challenge the live ceremony verified.
  3. In the service's one-at-a-time queue, it re-reads the accounts and snapshots the pins again. If they differ from
     the staged ones, the answer is `409 conflict` and no rule is made. A resume, renew or widen is also refused
     (`409`, with the reason) when the rule it replaces was suspended after the stage, so no suspension is ever cleared
     by a passkey the owner gave without seeing why.
  4. Still in the queue, right before the write, it checks the proof: the device is still paired and holds the
     passkey, and the assertion verifies over those bytes. A revocation or a passkey removal that lands during the
     commit is queued behind the write, so it sees the new rule and suspends it.
  5. It writes the file, then memory.
  6. It audits the rule.

  A refusal before the claim spends nothing. After it, the stage is spent. The machine's admin token holds no passkey,
  so it can never commit.

- **Narrow** (drop the code, end earlier, lower the cap) and **revoke** (one rule, or every rule of an account) need no
  passkey: they only take away. There is no PUT or PATCH on a rule. Anything wider is a new stage.

### What can have a rule

A rule can only be made for a **password sign-in the owner signed in to by hand from a paired device, at least twice
in a row**: on a page, with the page moving on; in a terminal, into sudo, su or doas the kernel proved. Otherwise the
stage answers `409` with the reason:

| Reason             | When                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `tool_not_covered` | A terminal sign-in for any program but sudo, su or doas (ssh, npm, …): no rule ever covers it. |
| `via_provider`     | The sign-in goes through another account ("via Google").                                       |
| `not_password`     | The sign-in does not use a password.                                                           |
| `no_history`       | "Sign in yourself twice from the app first".                                                   |
| `passkey_required` | No passkey has been added on a paired device yet.                                              |
| `no_code_key`      | The code was ticked, but no 2FA key on the account has a seed Ferretry holds.                  |

A terminal rule types the password only: a username or a code ticked for one, or a lifetime over 7 days, is `400`.

History is the observed fact `tapped`. The login observer writes it only for a fill by the owner's own **device**
(`observerByOf`, exhaustive), and only if the ferret had not steered the target. On a page it is written at the
moment the page moved on. In a terminal it is written at the write itself: `true` only when the password went, with
echo off in line mode, into sudo, su or doas the KERNEL proved every process of the foreground group runs setuid root
(`rootPromptProved`), and `false` (the count starts again) into anything else. A terminal is not asked to "move on":
the ferret can steer what the screen shows, and the setuid proof is the gate. These never count:

- task-plan fills;
- rule fills;
- the admin token's deliveries (`host`: the owner at the machine, or a ferret that read `api-token`).

`tapped` is the owner's alone. It is stripped from `account_hint` and the login hint, so a ferret can't learn which
sign-ins qualify. A rule that types the code pins the account's **newest** 2FA key that has a seed, chosen by when it was
added. It is never chosen by whether a code worked: a ferret can steer that.

### Pinned facts suspend, never silently

The body pins:

- the account's immutable key, its handle and its username;
- the sign-in's login domains (or a terminal rule's one `sudo@host`, `su@host` or `doas@host`) and its recipe
  version;
- the field identities the owner's taps have history with;
- a fingerprint of the account's 2FA keys (id, kind, whether Ferretry holds the seed; never `verified`, the label or
  when it was added).

A rule is **suspended**, and stays suspended until a new passkey approves it again (`revision` + 1), in these cases:

- **After every committed account change:** `AccountDirectory.followRulesWith`, under the same lock.
  - The sign-in or its account is removed: `sign-in-gone`. The rule can't be resumed, only removed, and it goes at its
    end.
  - A rename, a merge or a username change: `account-changed`. So is a sign-in that stops typing a password of its
    own (another method, or "via" a provider); switching it back does not resume the rule.
  - A domains edit, or a terminal sign-in moved to another tool or host, or to a site: `place-changed`.
  - A recipe change by the owner, an approved proposal or an auto-applied one: `recipe-changed`.
  - Any 2FA key added, removed, changed in kind, or given or stripped of its seed: `factor-changed`.
  - A new form at a pinned place: `form-changed`.
- **When a passkey or device goes:** every proof is checked again (`passkey-removed` or `proof-invalid`). A revoked
  device suspends every rule it approved, even if the passkey purge after it fails ([pairing.md](pairing.md#revoking)).
- **At load:**
  - A body created in the future, or a proof that does not verify against the bytes on disk: `proof-invalid`.
  - Any drift: suspended with that reason.
  - The list answers `503` until every record has been checked, so it never shows a rule as active before then.
  - If the accounts or the passkeys can't be read, no rule is verified, so none fills. The list marks each one
    `unverified`, and the daemon's sweep checks again every 15 seconds until it can.
- **A page script on a pinned host:** `scripted-origin`, for a page rule. A script whose page could not be read
  suspends every page rule; a terminal rule is not a page's, and no page script reaches it. Fills will also suspend
  for their own reasons.

A label, a password change, `verified`, a pending proposal and a default suspend nothing. Changing a fact back resumes
nothing. Every suspension is persisted, audited (`sign-in-rule-suspended` with its reason) and shown in the owner's
list. No card is raised in a ferret's session for it, so a ferret learns nothing about rules.

If the file can't be written, the rule stays suspended in memory as `store-write-failed`, and so does a use that
couldn't be counted. Every later write carries it, the sweep retries the write, and the daemon tries once more when it
stops.

### Terminal rules: sudo, su or doas

The owner may also make a rule for **sudo, su or doas on this machine** (owner decision !A197): the sign-in's one
`tool@host` key (`sudo@kirin-box`), the password only, **1 day by default and 7 at most**, made with the same passkey,
pinned and suspended by the same triggers as a page rule. The staged rule and the owner's view carry `root: true` /
the `root` flag, and the app draws a red line from that field, never from the summary's words; the summary says it
second, before the account: "into sudo: root on kirin-box for every ferret it covers".

It fills only where every check of a terminal plan line holds ([input requests › Standing rule
fills](input-requests.md#standing-rule-fills-a-sign-in-the-owner-approved-for-any-ferret)): the program **proved by
the kernel**, never by its name (a shell that renamed itself `sudo` has no key, so no rule is even tried and the card is
a plain one); every process of its foreground group setuid root; echo off; line mode; the proved tool and this machine
exactly the pinned key; one password field; the form the owner's taps have history with. A miss types nothing,
suspends nothing and tells the ferret nothing it would not be told with no rule. The rule is asked once more inside the
terminal's own turn, right before the guarded tmux write (`proceed()`), so a revoke that lands then types nothing.

Every terminal rule card, sheet and Settings row carries two more lines beside the honest-client one, verbatim:

> This gives every ferret on this machine root whenever it asks, while the rule lasts. (`SIGN_IN_RULE_ROOT_WARNING`)

> Ferretry types it only where the kernel proves sudo, su or doas is reading the terminal as root, never on a name a
> process gave itself. A ferret starts that program, so it could start another program root installed under the name
> sudo.
> (`SIGN_IN_RULE_TERMINAL_HONEST_LIMIT`)

So, said plainly: **a sudo rule gives every ferret root on demand while it lasts**, and **the program is proved by the
kernel, not by its name**: what reads the password is a setuid program root installed, but the ferret chooses which one
it starts as `sudo` (`passwd` started under that name would get it). With full sudo that gives nothing beyond the rule
itself; under a restricted sudoers it could set a password the ferret then knows.

**Off until it is reported.** Terminal rules are their own feature, `sign-in-rules-terminal.1`, a compile-time name in
the protocol's daemon features that this build does not report, even once `sign-in-rules.1` is. Nothing reads it from
config, the environment, a route or a file. Until a build reports it, staging a sudo, su or doas rule answers `409
tool_not_covered`, the eligibility says the same, and the fills offer no terminal rule to the matcher, so a terminal rule
already in the file never fills.

**The race that remains, said exactly** (secrev-1301 M1). Between the daemon's last kernel look and tmux's guarded
write, the reader is checked only by facts a process of this account can reproduce: the pane, the name of its
foreground command and the cursor row. **A program swapped in between the last kernel check and the typing can still
read the password once.** Holding Enter back does not stop that: a reader that takes the bytes as they arrive has them
before anything is checked again. What a rule adds is that the swap is SEEN and the rule then stops:

1. it types the password **without Enter**, then has the kernel prove again that the **same setuid process still leads
   the foreground group** (same pid and group, still sudo, su or doas setuid root, echo off, line mode) before it sends
   Enter; if it does not, the line is erased, the request ends and the rule is suspended;
2. a write **tmux's guard refused**, after a look that matched the card, types nothing and suspends the rule too. A
   screen that merely changed before the write still just redraws the card.

Both suspend with `program-changed` ("the program reading the terminal changed while Ferretry was typing"), sticky,
audited and shown to the owner only, so the rule **cannot be retried under that approval**. Nothing more is claimed.

### Strict, and fails closed

The whole file is parsed strictly: `v: 1`, no unknown key, one rule per id and per sign-in. A file that is unreadable,
truncated or does not parse means:

- **zero rules**, with `health: damaged` in the list, so every sign-in asks;
- a line on stderr and an audited `sign-in-rules-damaged`.

The owner's next write copies the damaged file aside to `sign-in-rules.json.damaged-<stamp>` and starts fresh. That can
only drop approvals, and nothing is deleted. The overlay beside the signed body (suspension, narrowing, usage) is
unsigned. A same-user edit can clear it, but never widen the body: the schema refuses an overlay that would. A
rolled-back file can bring a revoked rule back until its signed end, at most 90 days after it was created (7 for a
terminal rule).

Two more limits are declared:

- **A crash before an owed write lands.** A suspension or a use that only memory holds is lost if the daemon crashes
  before any write succeeds. The rule's drift, its proof and its expiry are found again at load; a suspension caused
  by an event (a page script, a page that did not move on, a failed write) is not.
- **Timing.** A raise a rule was tried on answers later than one no rule is about, even when the rule misses without
  being suspended (out of scope, say): the accounts are read, the miss is audited and the card is made to buzz. A
  ferret that measures its raises could so learn that some rule is about a sign-in, without spending it. Likewise an
  account change that suspends a rule takes one rules-file write and an audit record longer than one that does not.
  What a ferret reads (its view, its words, its agenda card) stays byte-identical either way, save a refusal in the last
  milliseconds before typing, which can leave its page held for that moment (input-requests.md, "Standing rule
  fills"). This is accepted.

### Routes

Every route is `caller: 'person'` ([grants.md](grants.md)).

| Route                                                 | Does                                                              | Grant                               |
| ----------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------- |
| `GET /v1/sign-in-rules[?signIn=]`                     | every rule (or one sign-in's), machine stages waiting, the health | `secrets.use`                       |
| `GET /v1/sign-in-rules/eligibility?signIn=`           | whether a rule can be made, and why not                           | `secrets.use`                       |
| `POST /v1/sign-in-rules/stages`                       | stage a rule                                                      | `secrets.configure` + `browser.use` |
| `GET` / `DELETE /v1/sign-in-rules/stages/:stage`      | where a stage stands; drop it                                     | `secrets.use`                       |
| `POST /v1/sign-in-rules/stages/:stage/confirm-in-app` | show a machine stage in the app                                   | `secrets.configure` + `browser.use` |
| `POST /v1/sign-in-rules/stages/:stage/bind`           | a paired device with a passkey takes a machine stage              | `secrets.configure` + `browser.use` |
| `POST /v1/sign-in-rules/stages/:stage/commit`         | commit, **with the kept `approve-sign-in-rule` proof**            | `secrets.configure` + `browser.use` |
| `POST /v1/sign-in-rules/:id/narrow`                   | drop the code, end earlier, lower the cap                         | `secrets.use`                       |
| `DELETE /v1/sign-in-rules/:id`                        | revoke one rule                                                   | `secrets.use`                       |
| `POST /v1/accounts/:id/sign-in-rules/revoke`          | revoke every rule of an account                                   | `secrets.use`                       |

Each change is a kept `security.changed` record ([audit.md](audit.md)). None holds a username or a value.

## The Accounts screen

Settings › Accounts is gated on the daemon's health: a machine that reports `accounts.signins.1` gets the screen below,
any other (older, silent, or one whose health read failed) keeps the saved-logins surface above, unchanged. It reports
`accounts.2fa-keys.1` separately: without it the 2FA keys tab is not offered and no seed can be saved from here.

- **List** — accounts grouped by the site they sign in at (the first host a place names; `ssh@host` for a terminal),
  each row naming the account, which fields EXIST ("password ✓", never a value) and its 2FA keys. Accounts with no
  sign-in sit under "No site yet". A damaged store is said to be damaged, never drawn as an empty list.
- **Account** — _Details_ (name, username, a write-only password: the box is empty every time and the page only says
  one is saved), _2FA keys_ and _Sites_.
- **2FA keys** — each key by its label and plain facts with a usage record: _Last code worked on <date>_,
  _Not used yet_ or _Last code did not work on <date>_ (red, the only one drawn as a warning). It is a record of what the
  daemon saw, which a ferret can steer, and not a check that the key belongs to the account, so it is never drawn as a
  check mark and never gates a pre-approval. Adding an SMS, email, push or security key sends no value. Automatic codes
  (a seed) go through the SAME panel the code card uses ([Set up automatic codes](input-requests.md#2fa-seeds-opt-in-per-entry)):
  stage, the two ticks, then the `add-2fa-key` passkey bound to that stage. There is no second path: a seed is never
  sent to `POST …/factors`.
- **Site (a sign-in)** — _Method_, _Recipe_ (plain text, never Markdown; a ferret's recipe is labelled as unreviewed, and
  its proposals are shown as a diff to approve or decline), _What Ferretry saw_ (facts, never values) and _Defaults_.
- **Defaults** — a default only decides which account a card lists first; the tap is still the permission. It is
  `config/account-defaults.yaml`, set per host with `PUT /v1/accounts/defaults`. A default may be set on any host the
  sign-in NAMES, a site's `match` hosts included (the daemon checks `placeHosts`, and so does the screen). A file that
  does not parse is shown as unreadable, never as "no defaults".
- **Look-alikes** — when `GET /v1/accounts/look-alike` (owner only, handles only) reports accounts that share a username
  and password, a banner offers _Merge_ (pick the one to keep; the others' sites and keys move onto it) or _Keep apart_.
  A daemon without the route simply shows no banner.

Every write is a person route (`secrets` configure, operator minimum) so a ferret cannot make it; no response and no
screen holds a password, a seed or a code. The one-tap on a card comes only from the daemon's `primary` offer.

## Damaged is not empty

A vault whose document will not parse, or whose key has gone while ciphertext remains, reports
`health: "damaged"` with a diagnosis. It never reports an empty store. A person told "no secrets"
over a vault that is merely unreadable will recreate every one of them on top of entries that are
still there.

## What is not built yet

- **`fy secret clone --from <machine>` — GAP.** Copying is browser-only for now. The command line
  holds one credential, this host's admin token, and has no way to reach a second daemon; giving it one
  is a design of its own (it would need to be paired, like a browser). Copy from the PWA.
- **Per-session scoping — GAP.** Every secret is available to any caller holding the daemon's admin
  token, which is every agent it runs. Scoping _which_ session may use _which_ secret is a design in
  its own right: it needs a durable grant per session, a way to issue one at start, and a surface to
  review them. Named here so its absence is a decision rather than an oversight.

## Copying secrets to another machine

Setting up a new machine no longer means pasting every key again. On the new machine, **Copy settings
from another machine** offers **Copy secrets from <machine>…**; on any machine, **Settings → Secrets →
Copy to another machine…** does the same from the other end. Either way a person picks the secrets by
name — each row says where that machine's configuration uses it, and whether the receiving machine
already holds one (it is replaced) — and the sending machine asks for a **passkey for that copy**.
Secrets never travel as a side effect of copying configuration. The one exception is the keys of the **API-key
logins** being cloned, which are named in the preview and follow in the same sealed copy — see
[Sign-ins are not copied; API keys are](#sign-ins-are-not-copied-api-keys-are).

### Sign-ins are not copied; API keys are

**Owner decision, 2026-10-20: "don't copy sign-in, copy env var credentials only".** Cloning a machine
brings across everything that makes a runtime work by key, and nothing that makes it work by a signed-in
account.

| What                                                                                                  | Clone does                                                                                                         |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| An **API-key (environment) login** — GLM, DeepSeek, MiniMax, OpenRouter, a Bedrock key, a LiteLLM key | The login copies as its file (plain variables, `${secret:NAME}` names) and its **keys follow, sealed**, below.     |
| A key a copied setting spends — the Warden's Jev key, the Groq or Cerebras clean-up key               | The same sealed copy: the preview lists it under the keys that travel.                                             |
| A **sign-in** — Claude Code's login, Codex's ChatGPT login, a keychain item, `auth.json`              | **Never.** It arrives as an empty slot marked **Sign in on _machine_**, with a Sign in button for each login.      |
| An MCP server's OAuth access token (`MCP_…_ACCESS`), the one sign-in the vault itself holds           | **Never.** The copy panel lists it and does not let it be ticked; sign in to that server again on the new machine. |

**Why a sign-in is excluded.** A sign-in is a refresh token, and a provider that rotates refresh tokens
(Anthropic and OpenAI both do) invalidates the old one the first time the new one is used. A login copied to
a second machine would therefore sign the _first_ machine out the next time either one refreshed — a copy that
looks like it worked and breaks the original. An API key has no such state: the same key is valid on both
machines, which is also why a key being on two machines is an ordinary thing to do and is the owner's call.

**It is a type, not a check.** A secret copy is built from `CloneableSecretName`
(`packages/protocol/src/lib/secret-clone.ts`), a branded name that cannot be made from an MCP sign-in token's
name. The export request, the bundle's authenticated names, its sealed plaintext and the target's filing are
all typed to it, so no code path can put a sign-in in a bundle by forgetting a check. Claude Code and Codex
logins are files in a credential store, not vault entries, so there is no name to put in a bundle at all.
A bundle that arrives carrying a sign-in token's name anyway — from a daemon that was modified — is refused
whole by the receiving machine (`bundle_invalid`), and nothing is filed.

**What the person sees.** The Clone preview (Settings › a machine › Setup, and New machine setup's _Start
from_ step) has a **Logins and keys** section: each API-key login reads _Copies with its key_; each sign-in
reads _Sign in on *machine*_ with the reason; one box, ticked, reads _Copy *n* API keys with the logins_. Pressing
Copy applies the clone and then runs ONE sealed copy for those keys — **one passkey on the sending machine for
all of them** — so the cloned runtime works on arrival. Unticking the box copies the login without its key; the
preview's needs list still offers a field for each. If the passkey is declined the clone is kept, the Done page
says the keys were not copied, and the _Copy secrets from…_ list offers them again. Only keys the sending machine
actually holds and the receiving one does not are asked for; a key already on the receiving machine is never
replaced by Clone.

### How it works

The browser holds a session to both machines, so it carries messages between them — and it is
structurally unable to read what it carries.

1. **The receiving machine opens an import** (`POST /v1/secrets/imports`): a one-time X25519 key pair,
   an id and a five-minute expiry. It signs the public half with its own **daemon identity** — the
   Ed25519 key whose fingerprint IS its daemon id, the one every paired browser pins. The private half
   stays in that daemon's memory and nowhere else; a restart forgets it.
2. **The sending machine seals the chosen values** (`POST /v1/secrets/exports/:importId`). It checks the
   offer's signature, that the key hashes to the daemon id the offer names, the expiry, and that it is
   not being asked to copy to itself. Then X25519 with a one-time key of its own → HKDF-SHA256 (salted
   with the import id) → AES-256-GCM, with both daemon ids, the import id, the expiry and the names as
   authenticated data. It answers that bundle and nothing else.
3. **The receiving machine opens it once** (`POST /v1/secrets/imports/:importId`) and files the values in
   its own store. The import is spent by the first attempt, success or not, so a replayed, tampered,
   re-pointed or late bundle is refused and no bundle can be tried twice against the same key. It checks
   that every value fits before writing any: a half-copied set is worse than none.

Both ends write the **same import id** to their security log — `secrets.used` (`clone-export`) on the
sending machine and `secrets.changed` (`clone-import`) on the receiving one — with the names, never a
value. The three wire shapes are `packages/protocol/src/lib/secret-clone.ts`; the two halves are
`SecretImportService` and `SecretExportService` in `packages/daemon/src/lib/secrets/clone.ts`.

**The export is the sixth vault holder**, and it keeps the rule the other five keep: it returns nothing
a caller of that daemon can open. A sealed bundle is not a secret value in this document's sense — no
route, command or API still returns one, and `SecretDirectory` still has no getter.

### Who may do it

All three routes are `secrets` / `configure` ([grants.md](grants.md)), so a device switched off on that
axis can do none of them. On top of that, **sealing for another machine wants a passkey proved for that
act alone, every time** — an unlocked device is asked again, whatever `stepUpOnActions` says, exactly
like adding a device (`clone-secrets` in `STEP_UP_ACTS`; owner decision 2026-10-20: "require the passkey
again"). The owner at the machine — `fy` with the host's admin token — is not asked, as everywhere.

### What it protects against, and what it does not

- **A value in the browser, a relay, a log or a screen.** The browser carries ciphertext under a key it
  never sees; a relay in the path sees less than that.
- **A bundle used twice, used late, or used somewhere else.** Single use, five minutes, and bound to one
  import on one machine.
- **A copy nobody meant.** A passkey on the sending machine for each copy, and a record on both ends.

It does NOT protect against:

- **A compromised sending daemon.** It holds the values; it can send them anywhere. That was already
  game over.
- **A device that may confirm the copy, choosing where it goes.** The sending machine proves only that
  whoever holds the identity key the offer's daemon id fingerprints asked for these values — not that
  the identity is a machine **you** own. A device that can pass this passkey could hand the sender an
  offer from an identity of its own. That device already holds `secrets` on the sending machine and could
  run `fy secret use --with KEY -- sh -c 'echo $KEY'`, so this opens no new door; the receiving daemon id is in
  the bundle and the import id in both security logs.
- **The receiving machine.** Once copied, a secret is that machine's, under that machine's threat model.

## Speed-up keys: the fifth holder

Settings › This machine › **Speed-ups** takes three optional keys, stored here like any other secret:
`JEV_API_KEY` (the Warden's triage guard), and `GROQ_API_KEY` or `CEREBRAS_API_KEY` (cleaning up a
dictated transcript after it has been recognised — the provider gets text, never audio; see
[`docs/voice.md`](voice.md) for where the audio itself goes). The daemon
spends them itself, on the operator's account, through ONE holder:
`OutboundProviderAuthorizer.send(secretName, hostAllowlist, request)` in `lib/speedups/authorizer.ts`.

- It puts the ONE named secret on ONE outbound request as a header (`authorization: Bearer …` unless a
  provider says otherwise) and answers only what came back: a status, a parsed reply, or a refusal.
  No branch returns the request it built.
- The URL must be `https:` (or `http:` to this machine) and its host must be one the caller listed for that secret, compared exactly,
  or **nothing is sent** — a Groq key can only ever reach `api.groq.com`. Each provider's hosts are
  written in `lib/speedups/catalog.ts`, so a new destination is a reviewed edit, not a URL in a config file.
- A request that already carries the credential header is refused, so the only credential on the wire
  is the one the holder placed.
- A reply that contains the key (a debugging proxy echoing headers, say) is reported as unreadable rather
  than handed to a caller that may render it.
- A damaged vault is reported as damaged, never as "no key".

The dictation clean-up (`POST /v1/stt/enhance`), the Jev guard, the Speed-ups **Test**
(`POST /v1/speedups/:provider/test`) and an environment login's **Test**
(`POST /v1/fleet/credentials/:id/test`, [provider-presets.md](provider-presets.md)) and an environment login's
**provider quota read** ([provider-quotas.md](provider-quotas.md)) all go through it; none of them is handed
a value. A quota read sends the login's key only to its own provider's quota endpoint, fixed in code. A login Test may reach only a host the login itself sends that key to,
or one a built-in preset names, and plain `http:` only to this machine (a LiteLLM proxy on localhost). The status read,
`GET /v1/speedups`, says whether each key is **set** from the store's listing of names — it never opens
the vault. Both routes are governed as `secrets.use`, and a Test is in the security log as
`secrets.used` with the secret's name.

What it does NOT protect against: the provider. A key you hand Groq is a key Groq can bill, and the text
the daemon sends (a transcript, or the Warden's redacted snapshot) is text that provider receives — the
Speed-ups screen says what leaves the machine for each one.

## Device-held speed-up keys

Settings › This device › **Speed-up keys** takes a Groq and/or a Cerebras key that lives in **one
browser** and is spent **by that browser**. With one saved, dictation clean-up goes straight from the
page to `api.groq.com` or `api.cerebras.ai` — no daemon on the path, because one more round trip
through a machine made clean-up slow (owner decision). **This is not the secret store above, and it
does not reach it.**

- **It never reaches a daemon or an agent.** The key is not sent to any machine, not synced, not copied
  by Copy settings, and not in any request a daemon sees. Agents run on daemons, so no agent can name
  it, `use` it or read it — `${secret:…}` and `fy secret use` know nothing about it.
- **Write-only in the page, too.** `lib/stt/speedup-keys.ts` has no getter: after Save the screen can
  say only "saved · ends with ••ab". The one place the value is decrypted is `send`, which puts it on
  ONE request whose URL the vault picks from the shared provider table
  (`@ferretry/protocol` `stt-cleanup.ts`), so a Groq key can only ever go to `api.groq.com`. That
  request carries no cookie, no referrer and no cache entry, and nothing logs it.
- **Encrypted at rest.** Each key is AES-GCM ciphertext under a wrapping key minted **non-extractable**
  and kept in IndexedDB as a `CryptoKey` object (like the [pairing key](pairing.md)). A copy of the
  profile's files, a backup, or the database restored into another browser yields ciphertext and a key
  reference nothing can open. The provider id is bound in as additional data, so a record moved into
  the other provider's slot fails to open.
- **The page's policy names the two hosts.** `connect-src` in `packages/pwa/public/_headers` lists
  exactly `https://api.groq.com` and `https://api.cerebras.ai`, and `scripts/validate/pages-config.sh`
  fails if that list and the provider table disagree.
- **The same decisions as the daemon.** The prompt, its fixed guard, how much conversation goes along
  (the machine's `voice.yaml` still decides), reasoning stripping and the kept-raw check are the
  shared `stt-cleanup` code both paths run ([voice.md](voice.md)).
- **Without one**, clean-up asks the daemon, which spends its own [speed-up key](#speed-up-keys-the-fifth-holder)
  if it has one; with neither, the raw words are kept and the review box says where to add a key.

What it does NOT protect against:

- **Code running in this page.** An XSS or a malicious deploy can spend the key while the tab is open
  — it cannot carry the wrapping key away, but it can call `send`. Same limit as the pairing key.
- **Anyone using this browser profile.** Whoever can open Ferretry in it can dictate on your key. A
  device you hand to somebody else should have its keys removed first (Remove on each card).
- **The provider.** As with the daemon's keys: Groq or Cerebras receives the recognised text, your word
  list and the conversation `voice.yaml` allows, and can bill the key. Never audio.
- **A browser that clears site data.** Clearing it deletes the key; the screen then says it is not
  saved, and you paste it again.

## Secrets the daemon files itself

A [remote MCP server signed in to from the PWA](mcp-oauth.md) leaves its tokens here, under names
derived from the component and its server (`MCP_<NAME>_<HASH>_ACCESS`). The ACCESS token is an ordinary
secret — listed by name, redacted, never returned — and, like every value a runtime is launched with,
readable by that runtime's agent. The refresh token and any client secret are NOT in this store: they
rest in a separate sealed document only the sign-in service reads, so `use` and `${secret:…}` cannot
reach them. **Sign out** deletes all of them.

## Sign-in tokens the usage read sends

A Claude Code or Codex sign-in is not a vault secret: it is the harness's own credential file or macOS
keychain item, which Ferretry reads and never copies. The daemon reads one for a single purpose — the free
usage read (`GET /api/oauth/usage`, `GET /backend-api/wham/usage`), which carries the login's bearer token —
and it does that on its **housekeeping worker** ([housekeeping-worker.md](design/housekeeping-worker.md) §2.4):
the store is read, its token is sent as one `Authorization` header and dropped, all inside one job. What
crosses back to the main thread is facts — presence, expiry, a truncated digest, the usage windows — and the
protocol between the two has no field a token could travel in (a type test holds that). A job that fails is
answered with a fixed word, never with the error it caught, and the worker holds no `SecretVault`: the
build fails if the worker's bundle carries the vault, its store or the redactor (a diet test), so it can never
become a seventh holder. `housekeeping.enabled: false` in `daemon.json` runs the same job code on the main
thread, as before the worker existed. The token reaches its provider or — for the idle bench and the CI budget,
through `FY_USAGE_PROBE_ORIGIN` — a server on this machine; any other origin is refused.
