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

**There is no route, command or API that returns a secret value** (one named, narrow exception: [a running ferret gets its own renewed MCP token](#the-one-exception-a-running-ferret-gets-its-own-renewed-mcp-token)). Not to an agent, not to `fy`, not
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

### A file or diff that holds a value: refused to an agent, masked for a person

`GET /v1/ferrets/:id/fs/file` and `fs/diff` mask every vault value found **whole** in the text (or, for a file that
is not text, in its bytes), one `*` per character, as Terminals does. In a diff the section heading git prints after a
hunk header's closing `@@` is read as the line before the hunk's first line, and the hunks of a file are looked at
together when the next one has a heading, so a value split between the previous hunk's trailing context, that heading
and the leading context is found whole and masked in every place. The heading stays in the header, masked where covered. An **agent** is refused instead: a masked copy
looks like ordinary content and could be written back over the real file, so the answer is a 403 with the code
`holds_secret` and one sentence that names the path only, whatever the count of values. A **person** keeps the masked
text, and the file answer says `redacted: true`; the app says "private values masked — this is not the file" and offers
no download or open of the masked bytes. Matching is whole-value only, never a prefix or a piece — with one fail-safe
exception: because the heading's place in the file is not known, the joined look of a hunk can also match a value whose
lines are all shown but are not next to each other in the file; that text is then masked, and an agent is refused
(`holds_secret`) a diff that holds no value. It over-masks, and never under-masks.

- **The whole-value oracle — GAP.** The refusal and the mask both tell a caller "this file contains a vault value", so an
  agent that writes a guess into its own worktree can confirm a WHOLE-value guess. That is negligible for a
  high-entropy secret and real for a short one (a PIN). Not closed: closing it would mean not saying so.
- **A diff for an agent also asks the two sides.** `fs/diff` runs the file check over the HEAD bytes and the working
  bytes the service has already read (no further read) and refuses with `holds_secret` if either holds a vault value,
  whatever part of it the diff shows. A person's diff is masked, never refused.
- Not found, so not masked: a value inside compressed bytes, in a UTF-16 file, or a non-ASCII value in bytes that are
  not valid UTF-8 (valid UTF-8 is masked as text even when it holds a NUL), and, in a person's diff, a value the diff
  shows only in part (a file, or one side of a diff, that holds only part of a value is shown as it is, even when the
  other side holds it whole — apart from an identical line, which takes the other side's mask). A section heading that
  git does not pick (a line that starts with a digit or a symbol is skipped) is not part of the diff, so a value
  split across it is the same partial.
  Git also cuts a section heading to 80 bytes and drops its trailing spaces and tabs, so a value whose line in the
  heading (its first, middle or last) is longer than that, or ends in whitespace, is shown only in part (the same
  partial; an agent is still refused by the two-sides check above).
  A value is found in a CRLF file whether it was stored with `\r` (a CRLF key file, `token\r`) or without (LF), and a CRLF-stored value in an LF file: all
  three looks are made and the coverage is their union; the `\r` and the line breaks are kept in the output, so a masked
  multi-line value keeps one mask per line. Positions are
  UTF-16 units, as Vault's own starring counts them.

### Text a component shows: recognised by shape

A component's text on the fleet view (a settings file, an instructions file, a server's command) was
never put in the store, so the daemon does not know its values. `redactText` finds them by **shape** and
replaces each with `‹hidden›`:

- a value beside a name that announces a secret (`API_KEY=…`, `password: …`, `"token": "…"`), on the
  same line or the next, or the block under `password: |`;
- a **well-known token** (`ghp_…`, `sk-…`, `AKIA…`, `xox…-`, `github_pat_…`) and a **private-key
  block**, wherever they stand. A token is cut only when no letter or digit stands right before it and
  its body holds a digit, so `task-plan-ended` and `vosk-model-small-en-us-0` are left alone (they hold
  `sk-plan-ended` and `sk-model-small-en-us-0`);
- the default of `${NAME-default}` (also `:-` `=` `:=` `+` `:+` `?` `:?`), read as NAME's value.

A **pointer** is only `$NAME`, `${NAME}` or `${secret:NAME}`; it holds no secret and is left as it is.

Every rule is **linear**: a name is found where a run of name characters starts, a value is looked at
through a capped look-ahead and consumed once it is hidden, and no pattern backtracks, so a long run of
one character costs one pass, not one per character. The rule is held to what it replaced by a
differential test (`redact-differential.test.ts`) that generates text and fails if a value the old rule
hid survives the new one; CI runs 20 000 cases per shape, and a review can run more:
`REDACT_FUZZ_SEED=7 REDACT_FUZZ_CASES=100000 bun test redact-differential --timeout 1800000`.

Known gaps, the same as before this rule: a name `looksSecret` does not list (`pass: x`, so a value under
`db:⏎  pass: x` stays), the items of a list under a secret key (`secrets:⏎  - x`), and a secret in prose with
no name and no well-known shape. A token glued to the end of a longer word (`mask-sk-…`) is a word, not a
token, by the rule above. Shape is a floor, not a guarantee: the store is the only place a secret is safe.

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
  request (the owner sees an input and types it) or a sealed copy pasted into the store ([secure
  copy](secure-copy.md)); both show the owner an input. The owner's `fy secret set` in a normal shell and
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
| Session files (`/v1/ferrets/:ferretId/fs/*`)                                                   | read any session's tree, and `~/.ferretry/*` through a session started in `~`                                                                                                                                  | another session (only its own and its sub-ferrets'), every path inside the home, and a hard-linked file, for an **agent**; a person is unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | that session's media folder (`scope=media`)          |
| Starting a session (`POST /v1/ferrets`, `fy new --cwd`)                                        | start a child whose working folder is `~/.ferretry`                                                                                                                                                            | a `cwd` inside the home, named or through a link, for an agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | none                                                 |

**What it does not change.** It is the daemon's fence, not the disk's: a ferret's own shell runs as the same user and
can still open `~/.ferretry` directly, which is the limit stated [above](#what-this-does-not-protect-against). What the
fence closes is the route where Ferretry itself does the reading — copying, linking, serving or starting — on a
ferret's word. **Hard links** are refused as a component source (another name of the file could be the admin token)
except inside the Nix store, which is root-owned and immutable and hard-links identical files by design. A home the
daemon cannot resolve refuses rather than guesses. The rules for each surface are in
[agent-tools.md](agent-tools.md#the-state-home); the agent file tools (`browser_upload` and friends) apply the
same guard ([agent-tools.md](agent-tools.md#files)).

### Launch safety is a kernel fact: the directory chain and the bound launch folder

Two checks every launch needs are not a plugin's to write, because a plugin cannot do them without a filesystem of its own.
The kernel owns both, on the same roots every plugin already holds; there is no plugin filesystem exemption.

**The directory chain (`RootHandle.checkPrivateChain`).** Before a credential-bearing file is written under a ferret's home —
and again right before it is used — the kernel looks at EVERY folder from `FY_HOME` down to the target, each by its own
`lstat`. A folder that is missing, is not a plain directory, is a **symbolic link**, is **owned by another user** than the
daemon's, or is **writable by its group or by everyone** refuses the write with a sentence naming that folder (its path
relative to the home, never a file's content). A healthy `0700` or `0755` chain passes. It never changes a mode: narrowing an
open ancestor would hide that it was open. This is v4's launch-overlay rule (`FileLaunchOverlayFiles#ensureDirectory`), kept
at the kernel. The home's own spelling may be a link (every internal root already anchors on its real path); what it reaches is
judged like the rest. A root outside the home answers `outside_home`: it has no chain to judge.

- **GAP — a check is not a lock.** The chain is judged, then the file is written. The write itself reaches its folder through
  no-follow descriptors (`publish`), so a link swapped in after the check reaches nothing; but another user who becomes able to write a
  folder, or the owner changing a mode, between the check and the write is seen only by the next check. Ask again right before use.
- **GAP — folders above the home are not judged.** The chain starts at `FY_HOME`; `/home/<user>` and its parents are the machine's.

**The bound launch folder (`kernel.paths.bindDirectory`).** `checkDirectory` answers a folder once, and a folder is a name: it
can be renamed away and replaced by a link into the state home a moment after the answer. `bindDirectory` remembers the answer
— the folder's real path, the device and inode of the directory it resolved to, and the state-home fence's answer (inside the
home by name, by identity up every folder, or through a link that lives in the home) — and `verify()` looks again immediately
before the process is started. Any difference is `changed` and the start is held; anything the kernel cannot read, including a
fence it cannot compute, is `unresolved` and also held. `insideStateHome` is the fence's answer at the check: an agent is
refused there by the caller, a person is not. A symlinked project root that stays outside the state home binds and verifies.

- **GAP — the instant between `verify()` and the child's `chdir`.** The runner still starts the child by path. Every swap made
  before `verify()` is held; one made inside that instant is not. Closing it takes a directory the
  runner can start the child in by descriptor: on Linux a held descriptor's `/proc/<daemon pid>/fd/<n>` is accepted by `tmux
new-session -c` and the pane then starts in that directory (measured; the session's recorded path stays the `/proc` spelling and
  goes stale when the descriptor closes). macOS has no such path, so the kernel's `kernel.spawn` pin (`RootHandle.pin`: a held directory the child starts inside, installed for
  the instant of the spawn) is the existing way. Neither is wired into the runner here; this is declared, not scheduled.

**Where both are wired (the one launch path).**

- **The chain** is checked by the Claude Code harness (`ClaudeHarness`) on every credential-bearing launch — a start, a stop/resume
  and an adoption (a move launches nothing yet) — twice: right after it makes the ferret's home and before it writes any file of it
  (`launch-settings.json` among them), and again immediately before the runner is asked to start the process. An unsafe folder anywhere
  from `FY_HOME` down refuses the launch with the kernel's sentence (`the ferret was not started: state is writable by its group or
by everyone …`), nothing is written or narrowed, and the runner is not called. The harness raises that as a `LaunchRefusal`, the
  only harness error whose text Ferrets shows; any other failure there is still the generic "could not prepare this ferret's home".
- **The folder** is bound by Ferrets where it first checks it (`startNamed` and `resume`, before `start.decide` is asked), carried
  to `launchAttempt`, and `verify()`-ed as the LAST step before the harness is asked to start (after the home is prepared and
  the child environment is resolved). A change refuses the launch (`409 refused`, "no longer what was checked") and nothing is spawned.
  An **agent's** start of a folder inside the state home is refused `403 state_home` at the route (`stateHomeReach` now answers from
  `bindDirectory`, so an ordinary agent start in a project works, and a fence the kernel cannot compute is `503 state_home_unresolved`)
  and again by the service. **Every entry that can launch a process takes the launch's ORIGIN**, a required parameter with no default
  (`LaunchOrigin`: `person`, `daemon` or `agent`), derived only from the admitted credential and never from an attribution field
  (`actor`, `requestedBy`, `movedBy`, `by`), so a caller that forgets to say who it acts for does not compile: start, resume,
  an immediate or a queued restart, the consumer port the Warden and the Conversation use, an adoption and a move's relaunch.
  The folder the launch binds NOW is judged by the same state-home policy for every **agent** origin (a ferret's token, the admin
  token with a ferret behind it, the Warden), so a project swapped for a link into the state home before the relaunch is refused
  (`refused`, zero runner starts) and `verify()` is not the only defence. A queued restart keeps its origin in the queue, and an
  item queued without one drains as an agent's (fails closed). The Warden's own sweep and auto-revive have no person behind
  them and run as an agent's. **A ferret first started by an agent is fenced on EVERY relaunch, whoever triggers it** (a person,
  the boot auto-resume, the Warden, a restart or its drain, a move, a send that revives): its record keeps the BIRTH origin
  (`birth`: `person`, `daemon` or `agent`) stamped once when it is created and carried unchanged by every later launch, and a
  launch is fenced when the call's origin is an agent OR the stored birth is `agent` OR the birth is missing (a doubt fences,
  with a sentence naming the reason and the remedy: move it to a project folder). Only an owner-born or a daemon-born ferret
  (Packs' clean-up, the Lessons miner, in Ferretry's own folders) relaunches unfenced. The v4 → v5 conversion sets the birth from
  v4 data: a ferret with a lead, or one v4 stamped as created by another session or a warden, is `agent`; the rest are `person`.
  An attach (an adoption of a live pane) launches nothing and takes the caller's origin, required, but may only **tighten** the
  birth, never loosen it: a record that has a birth keeps it whoever attaches; a record with none is stamped `agent` when an
  agent attaches it, and stays without one (so stays fenced) when a person or the daemon does. A port
  caller whose origin is missing or not a `LaunchOrigin` is refused before anything is asked. A **move**'s route is mounted but
  its relaunch dependencies are unbound on this base (503 `plugin_unavailable`); its relaunch binding already requires the
  route's origin and refuses to launch without one, so enabling its dependencies cannot open a gap.
- **Tests:** the launch-wiring table drives each of those through the real Ferrets, Runtimes and Claude Code halves for a start, a
  stop/resume and an adoption (four ancestors at `0777`, a foreign owner, a link, and three kinds of folder swap), and removing the
  `verify()` or either chain check turns them red.

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
- **The owner-only verbs refuse in a pane whatever `--as-owner` says.** `fy rules`, `fy plan` (and its alias
  `fy copy plan`), `fy copy` and `fy input` refuse inside a ferret's pane before they ask the daemon anything,
  read or change alike, on the environment alone (`FY_SESSION_ID`, or an agent credential in the pane): "this is
  the owner's command; a ferret's pane can't run it". `--as-owner` changes which credential is presented, not
  where the command runs, so it does not lift this; run them from your own shell. The daemon refuses a ferret on
  these routes again (`403 owner_only`). `fy account` asks the daemon instead, and a refusal there says "this is
  the owner's command, and it ran with a ferret's credential", for a read like `fy account ls` as for a change.
- **`FY_TOKEN` in a pane wins.** Step 1 comes first, so a shell rc that exports `FY_TOKEN` puts every ferret
  whose shell reads it on the admin token, silently. `fy doctor` inside a pane warns about it, and about a
  pane whose credential is from before the prefix.
- **Codex shells.** Codex's `shell_environment_policy` default excludes, when a config turns them on
  (`ignore_default_excludes = false`), strip every variable whose name contains `TOKEN`, `KEY` or `SECRET`
  from the shell its commands run in — `FY_SESSION_TOKEN` included. Ferretry does not override that choice.
  `FY_SESSION_BOARD_CAPABILITY`, which `fy` reads too, survives it, so a Codex ferret's `fy` still finds its
  credential (measured on Codex 0.156.1, whose default strips neither); that name stays while Codex runs ferrets.
- **The yaml log switches are cleared, and the daemon's workers are told so.** The `yaml` library prints every token it
  parses when `LOG_TOKENS` or `LOG_STREAM` is set, and a config text can hold a credential, so `fy`, `fyd` and the
  converter delete both first. That deletion does not reach a `new Worker(url)` given no options object or a
  default-env `Bun.spawn` child: those get the original native environment. So the daemon always starts its workers
  with an options object (which carries the cleared environment). The shipped model catalogs and endpoint presets are
  parsed when Logins' `built-ins.json` is written, never in a running daemon, and the script that writes it clears the
  switches itself (Bun macros, which also ran in an environment of their own, are refused by `no-macros`).
- **Restart ferrets to wall them.** A running ferret's `fy` presents its credential at once, because its pane
  already carries one. Its MCP server is the `fy` it started with and keeps the admin token until the pane
  restarts (`fy restart --all`), and a pane launched before the prefix needs the same restart.

What this makes a wall: every `caller: 'person'` refusal now holds against a ferret that uses its tools and
`fy` as shipped, including one prompt-injected through page text that drives them. What it does not: a
ferret that reads `api-token`, `secrets.key` or the sealed files through its own shell is still the owner to
this daemon. That needs keeping ferrets out of the state home, which a later change adds where the agent's
sandbox can enforce it.

A `git` or `gh` child the daemon starts gets a short allow-list of non-secret names (`XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, `GH_CONFIG_DIR`, `SSH_AUTH_SOCK` and the proxy variables) and never `GH_TOKEN` or `GITHUB_TOKEN`. A `systemctl`, `systemd-run` or `tmux` child gets only `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`, the two names a user manager is found by (a ferret pane's limits wrapper is `systemd-run --user`, and a pane sees what its tmux server holds). The proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, in both cases) pass through unchanged, and a proxy address may carry credentials (`user:pass@host`), so a credential written there reaches those children.

## References in configuration

One grammar, everywhere: `${secret:NAME}`.

There is one narrow exception, for a ferret's launch environment only. A variable whose **whole** value is
`${secret?:NAME}` is set to the secret when the store holds it, and **left unset** when it does not.
`${secret:NAME}` refuses the launch instead. MCP uses it for its sign-in variables, so a sign-out that
lands while a ferret is starting does not stop that ferret. It names nothing a plain reference could not.
Anywhere else, or inside a longer value, it is plain text.

A second narrow reach, for `fy mcp check` only: a plugin whose manifest declares `permissions.profileSecrets` (MCP) may put into the ONE command it starts for a runtime, besides the secrets its own server entries name, exactly the names that runtime's profile references (Runtimes answers which, afresh each call; `VaultApi.childEnvironmentForRuntime`). The runtime's own launch already puts those secrets into the same server. It returns a sealed handle the kernel opens at exec time, never a value; any other name is refused by name, and nothing is kept after the call.

### A login's variables and a repository's own Claude settings

**A project's own `.claude` settings win over a login's environment** (as in v4 before 4.291.9; owner decision, !A500). Claude Code
ranks a repository's `.claude/settings*.json` `env` above the process environment, and a `--settings` file above the repository, so the
only way a login's value could beat a repository's is by being written into a `--settings` file. Ferretry never does that:

- A login's variables (`env`, `claude.env`, the catalog's `ANTHROPIC_DEFAULT_*_MODEL` tier slots) are **process environment only**. A
  runtime's wrapper exports them; a ferret the daemon starts gets them in its child environment (below). Nothing of them goes into
  `fixed.json`, into the `launch-settings.json` of a ferret's home, or into an argv.
- `<home>/.fy/fixed.json` is the **fixed layer** and nothing else: for an agent runtime, the permission mode and the prompts it skips,
  the hooks and the like (`plugins/runtimes/daemon/lib/account/fixed-layer.ts`). It has no `env`. An interactive Claude runtime gets no
  `--settings` from Ferretry at all, so its profile may pass its own.
- A start is **never refused over a key a folder sets**, a `${secret:…}` key and a bare `$OTHER` key included. Nothing reads a
  launch folder's settings or its repository layout. The price is the plain one: a repository that sets or blanks a provider variable
  in its own `.claude/settings*.json` replaces the login's value in that folder, and a ferret started there can sit on "Not logged in"
  until the repository's entry is removed. That is what the owner chose.
- A manifest an earlier version wrote may still carry `referencedEnv` (v4 4.291.9 to 4.291.11 published it for the refusal this
  version no longer has); it is read and ignored, never written.

**A value that names `${secret:…}` (or the optional `${secret?:…}`) is never written into a settings file or a command line.** It stays
process environment, which the wrapper (or, for a ferret, the Vault's `childEnvironment`) resolves into one child when it execs.

**A literal credential never reaches an argv, and there is ONE launch path.** A ferret the daemon starts, restarts, revives, moves or
adopts is launched by exactly one thing, `FerretsService.launchAttempt` → the harness → the runner. For a Claude ferret:

- **The Runtimes launch gate.** Runtimes takes `start.decide` and `launch.parts` (`plugins/runtimes/daemon/lib/launch-gate.ts`,
  `LaunchGate`). It is about **compaction only**: `start.decide` judges a start's own `compactAt` against its model's window and reads the
  published manifest ONCE (one publication read), and `launch.parts` contributes the login's compaction trigger from exactly that
  snapshot, reading nothing again. It reads no `fixed.json`, no folder and no login environment. The source is **required**
  (`LaunchPartSource.required`): if a launch reaches it with no checked snapshot, or it fails for any reason, Ferrets refuses the launch with
  nothing started rather than skipping it (a source that is only an addition, such as lessons, is still skipped when it fails). Published
  runtimes that cannot be read refuse the start of a Claude ferret that names one.
- **Fast mode and compaction ride the harness's private settings file.** A start that names `fast` writes `fastMode` into `launch-settings.json`
  (the start's options are kept, so a stop/resume writes it again), and the compaction trigger reaches it as `autoCompactWindow` through a
  `compact` launch part, on a start, a resume and an adoption alike. Neither is ever in an argv. The trigger is v4's `resolveCompactAt`,
  decided once in the Runtimes launch gate from the checked snapshot: **a ferret's own value** (its session config's `compactAt`, else the
  `compactAt` its start asked for, kept in its details) **overrides the login's default**, and an own `auto` suppresses a numeric
  default; **a login default, or a value on a LATER launch, larger than the model's context window falls back to Auto** (nothing is written, and
  an oversized own value is dropped to Auto, not to the login's default). A start's OWN number larger than its model's window is
  not that: it is **refused before anything is written** with v4's sentence (`200k is larger than this model's 128k window, so it
could never trigger. Pick 128k or less.`) by the Runtimes launch gate on `start.decide`, for every harness; an unstated window is
  judged against the 200k default. The window is v4's: a `[1m]` selector states 1M, else the model's declared `context`
  in the published manifest, else 200k; the model is the one the launch names, else the login's default model. A session config that is
  unreadable or holds a value outside the floor says "none recorded".
- **The credential is never in an argv.** The command is `env CLAUDE_CONFIG_DIR=<home> … claude --settings <home>/launch-settings.json …`:
  it names a path, never a value, so `ps`, the pane's command line and the session document's recorded `command` hold none. The file
  is written through the kernel's `agent-homes` root: `0600`, inside the ferret's `0700` home, and a link or a file the root refuses fails the launch
  (the same checks as every other file of the home). It is rewritten by every launch and holds no login environment; it lives and goes with
  the ferret's home, which is why there is no sweep of launch files and no live-session guard for one.
- **No inline overlay anywhere.** v4's fast-mode and compaction `--settings '<json>'` overlay, its per-launch file adapter, its argv
  builder and its launch service were deleted: nothing in 5.0 builds a second argv. **A move launches nothing yet:** its
  route is still a 503 skeleton on this base (`moves-deps.ts`). With a request id and a record that has a complete legacy lifecycle it answers
  `503 plugin_unavailable` at the unbound account resolution; a freshly started record has no lifecycle command and answers
  `409 session_unusable` first; without a request id it is `400 missing_request_id`. The launch-wiring table pins each answer and zero launches,
  so the day the route is bound its relaunch must go through `launchAttempt` and the same checks.
- A **literal** credential written in a login's YAML (an internal gateway's `ANTHROPIC_AUTH_TOKEN`) is plain text in the
  configuration already; a real key belongs in the secret store.
- **Tests that prove the rule:** `account-materialise.test.ts` (no `env` in `fixed.json`, no `--settings` for an interactive runtime, tier
  slots and a `${secret:}` key left to the process environment), `launch-gate.test.ts` and `host-assembly.test.ts` (the gate reads no
  folder and no `fixed.json`), `login-env-not-pinned.test.ts` and `claude-harness.test.ts` (the harness's file holds no `env`), and the
  launch-wiring table (a folder that sets a store-held key, a symlinked `.git` or an unprovable worktree is not refused).
- **GAP — the harness does not resolve a login's bare `$OTHER` variables.** A launched ferret gets the login's literals and `${secret:…}`
  references resolved into its child environment, but a bare `$OTHER` reference is not yet resolved by Ferrets (`ports-pending.json`, the
  `cross: ferrets` line).

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

### A ferret's launch carries its login's environment

A ferret started on a login launches with that login's environment, and an agent still never holds a credential:

- **Where it comes from.** Ferrets asks the `logins:<kind>` provider that holds the login (`LoginKind.holds`) for the
  login file's `env` (`LoginKind.env`). Literal settings stay literal and a `${secret:NAME}` stays a **reference** until
  the Vault's `childEnvironment` resolves it into that one child; a secret the Vault does not hold refuses the start
  (`login_unavailable`). `LoginKind.env` already drops a value that looks like a raw secret.
- **What it never sets.** `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `FY_*` are dropped from a login's env. Its values go in
  **before** the launch parts, so MCP, shell and profile env, and the `FY_*` switches, keep precedence.
- **The Claude sign-in.** A Ferretry-kept `anthropic` login also gets exactly one variable Ferretry sets itself
  (`LoginKind.launchEnvironment`, not the login file's `env`): `CLAUDE_SECURESTORAGE_CONFIG_DIR=<state/logins/credentials/<id>>`.
  It goes in **after** the parts, so nothing overrides it, and the real `HOME` is kept (macOS finds the login keychain
  through it; there the variable selects a keychain item hashed from the same directory, on Linux a file). A login with
  no usable sign-in refuses the start instead of launching a signed-out pane. "Usable" is judged from a fresh look at the
  local store (the file is there, is readable through the owned store, and parses as the JSON object Claude keeps), never
  from the status the app displays, which keeps its last-known state when material cannot be read. A malformed, unreadable or
  linked file is refused with one fixed sentence that names the login and quotes nothing. A **host-kept** Claude login gets
  `CLAUDE_SECURESTORAGE_CONFIG_DIR=""` (the empty value, as v4 did) with the real `HOME` kept, so Claude selects the
  person's own default store; this build has no authority over that store, so it is **admitted without being read** (as in
  v4), and a host login that is not actually signed in shows up as a signed-out pane, not a refusal. Codex's `auth.json` is a
  link in its home, not a variable, and is not done here (v4 linked the host's `auth.json` into the runtime home; that
  needs a kernel- or Logins-owned credential-link operation and stays a declared gap).
- **Not pinned in a file.** A project's own `.claude` settings win over the login's environment (see "A login's variables and a
  repository's own Claude settings"): the login's values are in the child's environment only, and the `launch-settings.json` the harness
  writes into the agent home carries no `env`.
- **An import puts the host's own `env` here, as references.** The setup import moves a secret-looking value of a harness's own
  `env` into the Vault (create-only, "A key an import files"); Logins then adds the variable to the login that apply selected
  or created, as `${secret:NAME}`, through its own config write (`daemon/features/host-import`), so a `${secret:}` is resolved at
  launch instead of landing literally in a Codex settings item. The door is narrow on purpose:
  - **Only Runtimes' apply may use it.** The port is handed to Runtimes alone (any other plugin gets one that refuses), it takes
    the caller, and it asks that caller's live `fleet.configure` at the write, plus `secrets.configure` when a Vault reference is
    bound; activating a new reference keeps Gate's `fleet.use` and owner/step-up policy (held for anyone but the owner).
  - **Two lists, so a reference has a source.** `plain` is host text; any `${secret…}` in it (the optional form too) is refused with a
    sentence. `minted` is `{ name, secretName }` built only from this import's own successful create-only puts: the apply's, or
    a key an earlier run of the same import filed that the Vault confirmed (`filedSame`) still holds this value. Logins writes
    the reference text itself.
  - **It only adds, and never replaces.** The file's etag is read before the version in effect and the write is pinned to it
    (`ifMatch`); a login with an edit held for the owner, or one that moved meanwhile, is refused rather than rewritten, so a
    held-only key is never dropped. A variable the login already has is kept.
  - **Names that look like a key are not repeated** in a skipped or refused sentence.
  - **It runs once per harness.** Runtimes' setup apply calls it after the secrets are filed and the login is in effect, with the
    names of the keys that apply filed; "Import again" of a harness an earlier import already brought in adds no variables and
    files no key for them. The person's ticked GitHub-token names (`tickedEnv`) travel as `ticked`; a GitHub token that is not ticked (or when none are) is left out BEFORE any secret is filed, so it reaches neither the Vault nor a component nor the login.
    A reserved variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, …) is skipped, and `GH_TOKEN`, `GITHUB_TOKEN` and
    `GH_ENTERPRISE_TOKEN` come in only when the person ticks them: a token in a login's environment can be read by every ferret on
    that login.
- **A `${secret:NAME}` in a Claude settings item, MCP config or instruction** reaches its file in the agent home as that literal reference,
  which nothing resolves (the Vault resolves a reference only into a child's environment): a reference is a name, not a value.

### The stored-login rule is a declared heuristic

A login's `env` (a `logins/<id>.yaml` file, a `login.add` or `login.env` change, the paste screen) is judged by ONE
rule, `plainPaste` in `packages/plugins/logins/contract/secret-shape.ts`. It is a **heuristic, not a proof**: a
person who means to hide a key from it can. It is built to stop an accident (a key pasted into a plain field) and a
casual agent edit. `config_read` withholds the text of ANY login file (or MCP server file: the kernel rule is for every
config def marked `credentialRecords`) that fails its check, whatever the reason, with its located issues kept: one that
does not parse as YAML, one with a key outside `env` or a mistyped one, one whose `env` is not a map of NAME: value
strings, and one with a refusal of this rule. The cost: a file whose only fault is a typo key (`labl: x`) is withheld
too. A def without the flag shows a failing file's text.

- **Under a credential-named variable** (a credential word anywhere, a last word `KEY` or `KEYS`, or one glued word
  such as `GATEWAYTOKEN`) a value must be exactly one allowed shape: a placeholder under 8 characters with no `$`; one
  or more `${secret:NAME}`; a scheme word (letters and `-`, at most 16, no digit: `Bearer`, `Api-Token`, `ApiKey`) and references; a header name, `:` or `=` and either of those; `$NAME` or
  `${NAME}`; a number or flag word; one `http`, `https`, `ws`, `wss`, `socks5` or `socks5h` address with no user key,
  password, fragment or bare query, only short query values, and no key-like run; or an absolute or `~/` path with no
  key-like run. A **key-like run** is 24 or more letters, digits and `_` with a digit in them and entropy of at least
  3.5 bits per character, read on the text split at every character other than a letter, a digit and `_`; in the
  path shape alone `+` and `=` also stay in a run, so a standard base64 key is one run.
- **Under any name** a token shape (a provider prefix, a JWT, a PEM private-key header), a credential-named header or
  JSON member (`x-api-key: …`, `"api_key":"…"`) with a literal value, and an address carrying a password, a user key or
  a credential-named query value are refused. In a variable that IS a header list (`…HEADERS`), a header with no
  credential name is refused when its value holds a token shape or a key-like run (`x-honeycomb-team=…`).
- **A value over 4096 characters is refused and not scanned**, and so is a variable NAME over 128 characters.
  Whatever else is wrong with a file, ONE failing check keeps `config_read` from showing the file's text (the kernel's
  `credentialRecords`): a refusal of this rule, an `env` (or `claude.env` / `codex.env`) that is not a map, a value
  under it that is not a string, a key outside `env`, a file that does not parse as YAML.

Named residual heuristic GAPs (declared, not scheduled):

- **GAP: a `$NAME` or `${NAME}` that is an all-upper-case base32 key** is read as a variable reference.
- **GAP: a key cut into 7-character comma chunks** in a header value (`x-api-key: abcdefg,hijklmn,…`).
- **GAP: a key shorter than 24 characters** in a path segment, host label or query value, and a key-like run with no
  digit, are not seen by the run test.
- **GAP: a header name with up to three words** may carry a key in a name word shorter than 17 characters.
- **GAP: a header whose name has no credential word** (`x-honeycomb-team=…`) is judged by its value only in a variable
  named `…HEADER` or `…HEADERS`; in any other variable it is not judged, so the Cloudflare AI Gateway's
  `ANTHROPIC_BASE_URL` keeps working.
- **GAP: a header name in the header shape** may carry key material in words of up to 16 characters: up to three words
  when the name has no credential word, and up to 64 characters in all when it has one (`x-auth-…-token`).
- **GAP: a variable whose name has no credential word** (`…_PASS`, `…_PWD`, `…_CRED`, a glued `…KEY`, `…_BEARER`) is
  judged only by token shape and by entropy, and a value with whitespace in it (`Bearer <key>`) passes.
- **GAP: an armored PGP private key** (`-----BEGIN PGP PRIVATE KEY BLOCK-----`) is not a token shape.
- **GAP: a key cut by `-`, `.`, `&` or `/`** into pieces that are each shorter than 24 characters (or, for a query
  value, shorter than 8), in an address or a path, is not seen; it extends the "shorter than 24" GAP above.
- **GAP: whitespace other than tab, CR and LF inside an address** (a vertical tab, a no-break space) splits it for the
  rule, so the part after it is not read as a password.
- **GAP: only a login's `env` is judged by this rule.** Fields the owner fills in on purpose, such as
  `codexProvider.baseUrl` and `queryParams`, are checked by the kernel's raw-secret scan only. A variable that slipped
  out of `env` is not such a field: any login file that fails its check is withheld whole (see above).
- **GAP (D11): `defaultsOf` is an unguarded `safeParse({})` on the reload path** (evaluate.ts, reached when a file that
  was in effect is deleted; also check-config.ts). A schema that throws on `{}` would still stop a reload. No current
  schema does.
- **GAP (D12): the withheld summary always says the file "holds a raw secret, which the owner must move into the secret
  store".** It says so too for a YAML-broken login or MCP file with no key in it, a blank `env:`, and an unquoted number
  such as `API_TIMEOUT_MS: 600000` (refused as v4's string-only value was). The issues list carries the real cause, but an
  agent may relay the wrong instruction to the owner.
- **GAP (D13): a login's `label`** (or any other free-text field) holding `Bearer <key>` checks as `ok` and is shown.
  An owner does not paste a key into a label by accident.
- **GAP (D14): a variable named `__proto__` under `env`** is dropped by the parser, so the rule never sees it and the
  file checks as `ok` with its text shown. The variable is also never exported. This is contrived.
- **GAP (D15): the scheme word may carry up to 16 letters** (no digit) of key material before a reference
  (`GATEWAY_TOKEN=XqvTmLpRzWkNcHbJ ${secret:K}` is accepted). It extends the header-name GAP: a scheme word up to 16
  letters.
- **GAP (D16): `credentialRecords` also withholds a failing MCP server file.** A broken or failing `mcp/<name>.yaml` is
  withheld whole by `config_read`, as a login file is; it is documented here and in `define.ts`.
- **Known refusals** (not GAPs, and they may surprise an owner): under a credential-named variable a query value of 8 or
  more characters (`?api-version=2024-10-21`) is refused; in a header list a long hex id (`x-trace: <64 hex>`) is
  refused; in any value a JSON member whose name ends in `tokens` with a value of 8 or more characters
  (`"budget_tokens":1024000`) is read as a credential.

**This is the last round of widening.** From here, a further finding is either a regression, a leak through
`config_read`, `config_validate`, `config_write`, a log or a response body, or a false refusal of a real owner setting, and is fixed; anything else (a new way to hide a key from a
heuristic) is recorded here as a named GAP and is not another round.

## Secret-shaped values in a file's text

A configuration file's text is read by every `fleet.use` caller and every ferret, so what a read shows and what a
write may add are one pair of rules in the kernel (`host/config/`), and the pair is
[config-files.md](config-files.md#what-a-read-shows)'s subject too. Plain words: the read hides what looks like a
credential, and a write may not ADD one.

**The read mask.** `GET /v1/config/file` and `config_read` cut each credential-shaped value in a launch flag, an MCP
argument or a nested value to `‹hidden›`, for every caller, the owner's paired device and the host admin included
(the owner at the machine edits the file itself). The cutter and the write rule are ONE implementation in
`@ferretry/std/credential-words` (with the `${secret:NAME}` grammar in `@ferretry/std/secret-reference`), imported by the
kernel's read mask and by Runtimes' views; there is no second copy to keep equal, and `HIDDEN_WORD_TEXT` is std's
`HIDDEN_VALUE_TEXT`. The std corpus test (`credential-words-corpus.test.ts`) holds the cutter to every name the write
rule's own tail test refuses, so a name only the write rule knows is in it. `std` also owns the cutter's two tests as an
injected pair (`CutterTests`, `shownWordWith`; `shownWord` is `shownWordWith(SHOWN_TESTS)`), and a catalog's publish rule
(`@ferretry/core-vault/contract`) is that same cutter with a pair of its own, never a second copy: it refuses everything
the write rule refuses and everything std's secret-name words and token shapes catch, plus the names KEY, PASS, PWD,
BEARER and BASIC with a value of 16 or more. The one thing the display hides that a catalog accepts: a plain value under a
name that only ends in key, token, secret or password (`--sort-key modified_time`); this is v4 parity, not a gap, and a
real token shape under such a name is refused by its shape.

**The mask and W read a name the same way.** One name test, in the kernel, decides whether a flag or a key is a
credential's for both: its name ENDS in `key`, `token`, `secret`, `password`, `passwd` (plural too) or
`credential(s)`, dashes ignored (`--key`, `--tokens`, `--apitoken`, `--ssh-key`, `-e SIGNING_KEY=v`); the mask also
keeps its older words (`AUTH`, `COOKIE`, a pair such as `API_KEY`). Runtimes imports the same test. A text that glues raw text to a `${secret:…}` pointer (`API_KEY=prefix${secret:X}`,
`--token prefix${secret:X}`, `API_KEY=${secret:X}?model=short`, `Authorization: Bearer v${secret:X}`) has the whole
value cut, from the start of the value to the end of the word with the pointer; one pointer alone stays shown. And a
net sits under the mask: when the text the mask leaves still holds a raw flag secret by W's rule, the file is
withheld (`unmaskable`) rather than shown.

**The write rule (W): new only.** A write that gives a raw secret to a flag (`--token v`, `API_KEY=v`,
`Authorization: Bearer v`, a URL password of 8 or more characters) that the file on disk does not already hold is
refused as `raw_secret`; the issue names the path to the value, never the value. "Already hold" is by a digest of the
flag's name and value, so the same value in the same file stays, a patch of another key is applied, and the same
value moved to another file, or a changed one, is refused. W runs at the four places a text becomes a file: a single
write, a held-file patch against the version in effect, the same patch against the held version, and `writeAll`'s
per-document plan (one refused document writes nothing of the set).

**Declared limits.**

- **`MIN_CUT_WORD` is 7.** A word shorter than 7 characters is never searched for a cut (`a://:p@h` is the shortest
  that holds a password); a value under a secret name is cut from 8 characters, and a URL's password at any length.
  The entropy gate decides, on write and read alike: a 16-character value of entropy under 3.5 (`abababab12121212`) is
  no credential to the write rule, so the mask and the net leave it shown, and 57 such lines of the 85,848-line review
  corpus are listed and pinned (`net-low-entropy-pin.test.ts`): 0 shown that W refuses on the masked text; 57 listed
  low-entropy values that W accepts bare.
- **Residuals in a broken file.** A file that does not parse cannot be rebuilt around its cuts: it is withheld
  (`unparsed`) when its raw text holds a word the cutter would cut, and shown as it is when none does. What neither
  check recognises is shown.
- **A JSON document inside a word is read key by key, and `-p<password>` is a password.** A word that starts with `{`
  or `[` (`--settings '{"env":{"API_KEY":"v"}}'`, also glued with `=` or inside one pair of quotes) has each string under a
  secret-named key cut, wherever it sits, the nearest key above it naming it; the read is lexical, so a document that does not
  parse is read as far as it goes, and it is also cut from the value of its first secret-named key (quoted with `"`, `'` or
  `\"`, or bare, and also with its `\uXXXX` escapes decoded) to its end. A one-letter flag whose letter means "password" (`-p`, mysql's) is read under that
  name when the value is stuck to it (`-pHunter2Hunter2` is `-p‹hidden›`; a value under 8 characters is no credential, as
  everywhere); a longer flag glued to its value (`-password=$X`) is that flag's, and a `=` or blank inside a stuck value
  (`-pabc=def12345`) is still shown: a counted gap.
- **Not cut:** the other cases named in the header of `packages/std/src/credential-words/words.ts`. (A value glued to a
  pointer is cut, see above.)
- **A flag's value in a file it was already in.** W is new-only, so a file that already holds such a value keeps
  working and is shown masked on every read; nothing removes it.
- **E3: a `--token-file` path is cut on read.** The read mask reads `--token-file` as a secret-named flag, so the path
  after it is shown as `‹hidden›` (checked: `--token-file` then `/home/me/.config/tool/token`), though W accepts a path
  there. A person sees `‹hidden›` where a path stood, and a text saved back with it is refused until the real text is
  typed at the machine. Runtimes' MCP `command` shows such a path (`srv --token-file ~/.config/tool/token`, `srv --key
/home/u/.ssh/id_ed25519`): a part the cutter cut that is no value, as W reads it: the word right after a flag word, a real
  multi-segment path (`~/…`, `./…`, `../…`, `/a/b…`, never a bare `/x` or `~x`) with no `$ { } # ? @ : =` in it and no
  segment the token test refuses alone, which the cutter shows whole when read alone. A URL is never one, and nothing
  after `KEY=` or `Header:` is.
- **W and the mask agree by construction.** The cutter and W are one implementation, and each consumer runs W on what
  its cutter shows and withholds what W still refuses: the kernel doors withhold the file (`unmaskable`), and
  Runtimes' views withhold the item in words (the Resolved view's server line or flag, a component's whole args or flags
  list, the runtime list's overridden flag; an edit that keeps a word of a withheld list is refused, "retype the whole
  list"). A credential value that holds a pointer and that W refuses whole is cut whole, value start to word end
  (`--key a,v,${secret:X}`, `--key ${secret:X},b=v`); the pointer in it is cut with the rest. The families F1-F7 (a
  look-alike of a pointer, a blank and a token shape, a pointer in a URL's user part, a value starting `.`, a pointer never
  closed, past W's 4096-character window, one item holding blanks) are held by the net, not by the cutter
  (`kernel-cutter-f1-f7-pin.test.ts`). **Every value Runtimes shows is netted**, place by place (one rule for a value of any shape beside its name,
  `valueWithheld` / `valueSaid` in `command-line.ts`, judging the PARSED value under the name the document holds it by, the last
  path segment, never the quoted display key):
  - **Arguments and launch flags**, in the detail, the Resolved view and the runtime list's overridden flags: each list is
    cut, then judged by W's flag rule AND its raw-secret rule (a token shape in a word withholds the list); a refused word
    withholds the whole list in words.
  - **An MCP server's `command`**, by ONE rule (`commandWithheld`) in the detail, the Resolved MCP line and the "command not found"
    warning: withheld whole when W refuses it (as one string or as the words it splits into, so `srv --token` beside the
    argument `v` is one pair) or when the word cutter, run on it as one string or word by word, cuts a VALUE
    (`curl -H "Authorization: Bearer v"`, `srv -H Cookie: session=v`). A part the cutter cuts that is a pointer (`$X`,
    `${X}`, `${secret:X}`), quoted or not, is no value: `env API_KEY="$API_KEY" npx -y @scope/pkg` is shown as written, and so is
    a path (above). A **`url`** (`writtenWithheld`) is withheld
    whole when W refuses it or the cutter would cut any part of it (a `?token=v` query is W-accepted but real); a Resolved url
    whose path W refuses (`/mcp --token v`, shown %-encoded) is withheld as the detail's is: the path is judged with its
    %-escapes read run by run, so a malformed one beside it (`https://h/%zz/mcp%20--token%20v`) does not keep the valid ones from being read.
  - **An environment or settings value shown under its name** (hidden when W refuses it, as when the name or shape says
    credential), including a list or a nested table (`{x: ['--token', v]}`, `{servers: [{token: v}]}`), in the detail and in the
    Resolved rows, and the Resolved model row.
  - **A conflict sentence** (`GET /v1/runtimes/profiles`, the preview, `GET /v1/runtimes`, `fy profile` and `fy runtime` "Overrides:"): a
    value W refuses, the winner or a beaten one, is replaced by "(a value that is not shown)" and the sentence stays readable.
  - **A fixed-layer overridden setting row** (`GET /v1/runtimes`): the same rule on its value.
  - **The text of an instructions or hooks file**: cut by its own line rule (`redactText`), pinned equal to v4 outside its
    tightened lines, and then netted line by line: a line W's text test still refuses after that cut (a long bare value
    under a plain key) is withheld, replaced by one plain sentence (`WITHHELD_LINE`) while every other line and the line
    count stay. v4 showed those lines; the S26 pin exempts exactly the lines it replaces. W's text rule judges a
    value under a credential key by the entropy of the whole value, so a long value that is mostly one repeated character is
    accepted at any length; the 4,096-character window only bounds each pattern's cost. Netted by W's VALUE rule too:
    instruction lines (an instruction Runtimes writes keeps its text in the component YAML, where a string with blanks is
    read as words; a flag at the end of one line pairs with the value starting the next non-blank line: blank and spaces-only
    lines between them do not break the pairing, as W reads the string), and hooks by the parsed document
    (the lines of each path W refuses are withheld; a refused list item withholds its whole list, because `--token` and its
    value are two lines; a text that does not parse as JSON is netted by the lines alone, and a document nested past 200
    levels is withheld whole, however deep the parser reads it: W's walkers are iterative).
  - **The "command not found" warning** names the command only when the detail shows it.

  The fields shown as written without a net are names and paths, not values: a component's `file` and `directory`, a skill's items,
  a model set's models and default (the Resolved model row and a conflict sentence are netted), a profile, runtime or login
  label, and the home-directory path a component points at (`checkPath`). W refuses one only when a credential is
  typed AS that name or path, which v4 showed the same way, and none of them can hold a flag secret, a URL's user or a
  token in a query by design. Measured over the 85,848-line review corpus (69,474 refused by W): 0 shown that W
  refuses on the masked text; 57 listed low-entropy values that W accepts bare (see `MIN_CUT_WORD` above). The
  price is over-redaction: the mask cuts every value under a name W reads as a credential, a path after `--token-file`
  (E3) and the whole value of a word that glues text to a pointer. A word of blanks that does not start with a flag
  (`srv --token v`) is no gap: the read splits it into words and cuts `v`.

- **The etag is keyed, not a digest oracle.** A file's etag goes to every `fleet.use` reader (`GET /v1/config/file`, the
  `kernel.config-changed` frame, `GET /v1/config/status`). It is an HMAC-SHA256 of the disk text under a key derived
  from the daemon's identity (an Ed25519 signature of a fixed purpose label, hashed: the same after every restart,
  held by no file of its own), so a reader cannot test a guess at a short hidden value offline, as a plain sha256 let
  them when the rest of the file was known. The stored accepted record's etag is recomputed on read, never trusted.
  What stays: two etags still show that a file changed, and a reader who holds the identity's private key (the host
  owner) can compute any etag, which gives them nothing the file does not.
- **The route descriptor sentence is exact.** The descriptor of `GET /v1/config/file` says a raw secret is refused on
  write and that a file written before the flag rule can still hold one under a flag name, shown masked on every read.

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
masked, and no input offers a saved login. To go back:

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
| `POST /v1/accounts/sign-ins/:si/recipe/proposals/:pid`    | the owner approves or declines a ferret's recipe; `{decision, pin?}`   |
| `POST /v1/accounts/:id/merge {from}`, `…/apart {from}`    | "these look like one account": merge, or keep apart                    |
| `PUT /v1/accounts/defaults`                               | owner only: the default account for a place (below)                    |

2FA keys have routes of their own: see [2FA keys](#2fa-keys).

**The default account per place** is `config/account-defaults.yaml`, not a part of the account store: its lines hold
**handles only**, never a value, and every change to it is held for the owner when anyone else makes it, a ferret's removal included; the OWNER's own write
that only REMOVES lines needs no passkey (an edit made on the disk is held even then: Ferretry can't tell who edited the file, so it waits for you; owner decision !A243; [Default accounts](config-files.md#default-accounts)). `PUT /v1/accounts/defaults { scope, within?, key, account }`
is the owner's own write of one line (`account: null` clears it): a ferret is refused before its body is read, a
paired device needs the passkey step-up for loosening a configuration file, and the line is in effect at once (it is refused with `409 no_sign_in_here` for an account with no sign-in on that key). The input and `account_hint` read the file ([which account is first](input-requests.md#which-account-is-first-and-why)). The
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

**Advertised.** The input is sign-in aware on the daemon's side ([one tap](input-requests.md#the-next-time-one-tap)):
its offers name the sign-in, and a deliver's `signIn` must be one of the account's. The daemon reports
`accounts.signins.1` and `accounts.2fa-keys.1` now that the app draws the [Accounts screen](#the-accounts-screen); an
older daemon, which reports neither, keeps today's saved-logins surface.

### 2FA keys

An account keeps a list of **2FA keys** (at most 8): an authenticator app (`totp`), a phone number that gets SMS
codes (`sms`, its last digits only), an inbox that gets email codes (`email`), a push app (`push`) or a security key.
Only a `totp` key can hold a value — its **seed** — and then Ferretry makes that account's codes ("automatic codes").
At most 4 seeds per account (a backup app, a re-enrolled authenticator). Every other kind is a label and a few plain
facts, so an input can say where a code went. The seed rests in `login-secrets.json` like the password; the index
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
- **Set up from a code input** (`request`): it saves only to the account the daemon matched for that input
  (`409 not_this_cards_account`), so a ferret cannot steer which account an input's key lands on. Staged from a paired
  device, the save then types the new key's first code into that input ("use it now", `typed` on the answer, `submit`
  on the stage), under every check a "Use code from Ferretry" tap gets
  ([input requests](input-requests.md#codes-ferretry-makes)); staged from the machine, it types nothing.
- **At most 4 seeds wait at once on the whole daemon, 2 per caller, and callers that are not a paired device share
  only 3** (`429`), so nobody fills its memory by staging and a ferret holding junk stages never keeps the owner's
  app from staging. **Only the caller that staged a seed, or a paired device, may read, drop or commit it** (another
  caller is told it is not waiting): the stage id is on the agenda item, so knowing it proves nothing.
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
prompt (a base32 key or an `otpauth://totp` link), stages it and puts an item in the app's Inbox — "Save automatic codes to
your account on github.com? Asked by fy on kirin-box at 14:02 UTC" — then waits. The item's words name the place only
(agenda text is every ferret's to read); the app's item names the account and what the key says it is for, read from
the stage on a route that reads the accounts. Allow it in the app with your passkey and it
prints "Saved"; Deny, or two minutes, and nothing is saved. It first asks the daemon whether it reports
`accounts.2fa-keys.1`, and on one that does not (v4.190 to v4.196 list accounts but have no 2FA key routes) says
"this machine's daemon is too old for 2FA keys: update it (fy daemon update), then run this again" before anything is
typed. Every Inbox item belongs to a session. Run from the owner's own terminal, where no session is current, the daemon puts
the item under the most recently active live session, so the item still reaches the owner's Inbox and `--session <id>`
is not needed (it still works, and names the session when you want a particular one). Where no session is running at
all the daemon answers `409 no_session` and says so. A ferret's pane is refused as before. When
the app's address is known (`FY_APP_URL`, or the hosted default) it prints the item's link,
`<app>/#agenda/<id>?session=<sid>&machine=<this daemon's id>`, as `fy plan approve` does. The CLI has no way to save a seed itself.

The rest of `fy account` is in [input requests](input-requests.md#managing-them): accounts, sign-ins (`site`), recipes,
defaults, and 2FA keys that hold no value (`factor add --authenticator|--sms|--email|--push|--security-key`). Each write
is a person route; a ferret's call is refused by the daemon and `fy` reports that rather than retrying. **The old path is closed:**
`PUT /v1/secrets/logins/:id` with a `totp` seed — today's app form and `fy account edit --totp` — answers
`403 add_2fa_key_needs_passkey` with where to go instead; `totp: null` (remove the seed) still works there.

The item is answered by its Allow (the passkey ceremony, then the commit) or Deny (drop the stage). An agenda answer
saves nothing, so an app from before these items shows the daemon's words and cannot save.

**The app draws this item itself** (`TwoFactorSeedHost`, in the Inbox and the agenda panel, wherever an item carries the
daemon's `twoFactorSeed` reference; a ferret's words that merely copy the title draw nothing). The reference names the
stage alone: an account's handle is often its label and username, and every ferret and any device reads the agenda, so
the app reads the stage, and the account it is for, by the stage id (`GET /v1/accounts/seed-stages/:stage`). An older
daemon's reference also names the account, and the app then reads the stage there. Every sentence is the
daemon's (subject, why, context); the app adds the one-factor warning with its tick, an amber box and a second tick when
the stage was staged with "save it here anyway" (the daemon marks that with `TWO_FACTOR_SEED_CARD_MISMATCH_LINE`, one
shared constant), **Allow** and **Deny**. Allow is the same shared flow as the "Set up automatic codes" panel: the
`add-2fa-key` passkey bound to THAT stage (`useAddKeyStepUp`), then the commit with no body. A dismissed passkey leaves
the stage waiting (it expires in two minutes), so the owner can try again or Deny; Deny drops the stage with no passkey. The
item reads only where the stage stands (`GET /v1/accounts/seed-stages/:stage`) and the account's name; it never holds
the key.

| Route (owner only, `secrets`/`configure`)                  | Does                                                                                | Passkey                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------- |
| `POST /v1/accounts/:id/factors`                            | add a key with no value (`sms`, `email`, `push`, `security-key`, a `totp` you hold) | no                         |
| `PATCH` / `DELETE /v1/accounts/:id/factors/:tf`            | relabel; remove (its seed swept)                                                    | never                      |
| `POST /v1/accounts/:id/factors/seed`                       | stage a seed (memory, two minutes); answers what was read                           | no (it saves nothing)      |
| `GET /v1/accounts/seed-stages/:stage`                      | where a stage stands, and its account, by the stage id alone (the item's read)      | no                         |
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

**The app draws rules, and the daemon reports `sign-in-rules.1`.** The service, the file, the routes, suspension,
history and the fills through the shared matcher ([input requests › Standing rule fills](input-requests.md#standing-rule-fills-a-sign-in-the-owner-approved-for-any-ferret))
are matched by the screens in the app: the sheet (Accounts › a sign-in › Standing rule, and "Don’t ask again for this
sign-in…" on an input the owner just filled by hand), the rule item (narrow, revoke, resume, approve again), a
ferret's suggestion, and Settings › Secure copy › Standing sign-in rules, where a rule staged on the machine with
`fy rules add` waits for this device's passkey. Every warning (root, one factor, the automatic recipe) is drawn from the
rule's structured flags, never from its words. Each is one protocol constant, said the same in the app and `fy rules`:

- One factor (`SIGN_IN_RULE_TOTP_WARNING`, the same `AUTOMATED_CODE_WARNING` a plan line's code tick says): "Ferretry
  types the password and the 2FA code, so a ferret it fills for has both factors." Its tick needs
  `AUTOMATED_CODE_ACK_WORDS`: "I understand this makes the sign-in one factor, with no one to approve a code."
- The automatic recipe (`SIGN_IN_RULE_AUTO_RECIPE_WARNING`, amber): "This sign-in applies its recipe by itself, so the
  form it fills is one a ferret may have written."
- "You'll still be asked" (`stillAskedFor('rule')`, one list with the plan item's): push approvals, security keys and
  passkeys, captchas, a sign-in whose form changed since you approved it, ssh, scp, npm or docker login, gh and any
  program but `sudo`, `su` and `doas`, and SMS and email codes or a code you did not tick. Every rule item has ONE shape: a plain `does` line, label/value `rows`
  (the protocol's `SignInRuleRowLabelSchema`: Machine or Site, Account, Types, Who, Until, Uses, and Code key on a rule
  that types the code), a Note line under the rows where one applies (the history, or the rule it replaces), ONE red
  block, and "How it's
  checked" for the proof, all built by the protocol's `signInRuleWords`. Editing a sign-in's method or recipe says how many rules that
  suspends, and revoking a device says how many its passkey approved. Names come only from secrets-gated routes: a
  device that may not use secrets sees one sentence and the app stops asking.

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
     (`409 not_this_rule`, with the reason) when the rule it replaces was suspended, narrowed, revoked or approved
     again after the stage, so no suspension is ever cleared by a passkey the owner gave without seeing why.
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
| `terminal_off`     | sudo, su or doas, on a machine that does not offer terminal rules.                             |

**One rule per sign-in, and each refusal its own code.** A sign-in has at most one rule. A new approval for a sign-in
that already has one (active, suspended, expired, or scoped to someone else) must name it with `replaces`, as that
rule's renewal, resume or change; the stage answers `409` with a code that says which next step it is, and each code
has one sentence in protocol (`SIGN_IN_RULE_REFUSAL_WORDS`) that the daemon, the app and `fy rules` all use:

| Code               | When                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `rule_exists`      | The sign-in already has a rule and the approval did not name it: renew, resume or change it. |
| `not_this_rule`    | The approval named a rule that is not, or is no longer, the sign-in's rule as staged.        |
| `clock_moved_back` | This machine's clock moved back between the stage and the commit: start again.               |
| `conflict`         | The sign-in, its account or a pinned fact changed between the stage and the commit.          |

The app opens a sign-in that has a rule as that rule's renewal or change, never as a second rule, so the owner never
meets `rule_exists` from a ferret's suggestion or the "Don't ask again" offer.

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
list. No input is raised in a ferret's session for it, so a ferret learns nothing about rules.

If the file can't be written, the rule stays suspended in memory as `store-write-failed`, and so does a use that
couldn't be counted. Every later write carries it, the sweep retries the write, and the daemon tries once more when it
stops.

### Terminal rules: sudo, su or doas

The owner may also make a rule for **sudo, su or doas on this machine** (owner decision !A197): the sign-in's one
`tool@host` key (`sudo@kirin-box`), the password only, **1 day by default and 7 at most**, made with the same passkey,
pinned and suspended by the same triggers as a page rule. The staged rule and the owner's view carry `root: true` /
the `root` flag. The summary carries no warnings at all: the red block (`SIGN_IN_RULE_ROOT_WARNING`, then
`SIGN_IN_RULE_TERMINAL_RESIDUAL`) is drawn from the structured `root` flag, on the sheet, the machine view, the
passkey dialog, Settings and `fy rules`, never from the summary's words.

It fills only where every check of a terminal plan line holds ([input requests › Standing rule
fills](input-requests.md#standing-rule-fills-a-sign-in-the-owner-approved-for-any-ferret)): the program **proved by
the kernel**, never by its name (a shell that renamed itself `sudo` has no key, so no rule is even tried and the input is
a plain one); every process of its foreground group setuid root; echo off; line mode; the proved tool and this machine
exactly the pinned key; one password field; the form the owner's taps have history with. A miss types nothing,
suspends nothing and tells the ferret nothing it would not be told with no rule. The rule is asked once more inside the
terminal's own turn, right before the guarded tmux write (`proceed()`), so a revoke that lands then types nothing.

Every terminal rule item, sheet and Settings row carries two more lines beside the honest-client one, verbatim. The first
is the red block, with the accepted race (`SIGN_IN_RULE_TERMINAL_RESIDUAL`) as its second sentence; the second is under "How
it's checked":

> Any ferret on this machine gets root while this rule lasts. (`SIGN_IN_RULE_ROOT_WARNING`)

> Ferretry types it only where the kernel proves sudo, su or doas is reading the terminal as root, never on a name a
> process gave itself. A ferret starts that program, so it could start another program root installed under the name
> sudo.
> (`SIGN_IN_RULE_TERMINAL_HONEST_LIMIT`)

So, said plainly: **a sudo rule gives every ferret root on demand while it lasts**, and **the program is proved by the
kernel, not by its name**: what reads the password is a setuid program root installed, but the ferret chooses which one
it starts as `sudo` (`passwd` started under that name would get it). With full sudo that gives nothing beyond the rule
itself; under a restricted sudoers it could set a password the ferret then knows.

**Its own feature, now reported.** Terminal rules are their own feature, `sign-in-rules-terminal.1`, a compile-time
name in the protocol's daemon features. Nothing reads it from config, the environment, a route or a file. This build
reports it (owner decision !A226, with the risk below accepted), and a terminal rule still fills only beside
`sign-in-rules.1`, which this build also reports: a daemon that did not would leave every sign-in a plain input. A build that does not report it refuses
to stage a sudo, su or doas rule (`409 terminal_off`), says the same in the eligibility, and offers no terminal
rule to the matcher, so a terminal rule already in the file never fills there.

**The race that remains, said exactly** (secrev-1301 M1). Between the daemon's last kernel look and tmux's guarded
write, the reader is checked only by facts a process of this account can reproduce: the pane, the name of its
foreground command and the cursor row. **A program swapped in between the last kernel check and the typing can still
read the password once.** Holding Enter back does not stop that: a reader that takes the bytes as they arrive has them
before anything is checked again. What a rule adds is that a swap is SEEN, when it is still there to see, and the rule then stops:

1. it types the password **without Enter**, then has the kernel prove again that the **same setuid process still leads
   the foreground group** (same pid and group, still sudo, su or doas setuid root, echo off, line mode) before it sends
   Enter; if it does not, the line is erased, the request ends and the rule is suspended;
2. a write **tmux's guard refused**, after a look that matched the input, types nothing and suspends the rule too. A
   screen that merely changed before the write still just redraws the input.

Both suspend with `program-changed` ("the program reading the terminal changed while Ferretry was typing"), sticky,
audited and shown to the owner only, so the rule **cannot be retried under that approval**.

**A swap that puts everything back is not seen.** A program that takes the place of sudo, reads the password the moment it
is typed, and then puts the real sudo back before the second kernel check has nothing left for that check to find, so
the rule carries on as if nothing happened. That is why the rule says it stops "if it notices", never "then". Nothing
more is claimed.

**Accepted risk (owner, 2026-11-01, re-confirmed 2026-11-02 (!A239) knowing a swap that puts everything back before the re-check may go UNDETECTED; `SIGN_IN_RULE_TERMINAL_RESIDUAL`, the second sentence of the one red block, drawn from the structured root flag on the sheet, the machine view, the passkey dialog and Settings, and printed by `fy rules`: "In the split second before typing, a ferret could swap in another program and read the password once. Ferretry stops the rule if it notices.").** The owner switched sudo rules on knowing this: in the split second between
Ferretry's last check of who is reading the terminal and the moment it types, a ferret could swap in its own program,
and that program could read the password once. If Ferretry notices, it stops the rule and tells the owner, so the same
approval can never be used to try again; a swap that is put back before the check is not noticed. A sudo rule also means every ferret can get root on this machine while the rule
lasts, which is why it is red, lasts one day unless the owner picks longer, and never more than seven.

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
  being suspended (out of scope, say): the accounts are read, the miss is audited and the input is made to buzz. A
  ferret that measures its raises could so learn that some rule is about a sign-in, without spending it. Likewise an
  account change that suspends a rule takes one rules-file write and an audit record longer than one that does not.
  What a ferret reads (its view, its words, its agenda item) stays byte-identical either way, save a refusal in the last
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
| `GET /v1/sign-in-rules/suggestions`                   | the rules ferrets suggested, still waiting (memory only)          | `secrets.use`                       |
| `DELETE /v1/sign-in-rules/suggestions/:sid`           | turn a suggestion down, on the owner's side only: its item stays  | `secrets.use`                       |

Each change is a kept `security.changed` record ([audit.md](audit.md)). None holds a username or a value.

A ferret's suggestion of a rule (`account_propose` with `preapprove`) raises an item and a line in memory and nothing
else: [agent tools › Suggesting a standing rule](agent-tools.md#suggesting-a-standing-rule).

### The owner's command: `fy rules`

`fy rules ls|add|resume|renew|narrow|rm` (`rm --account <ACCOUNT>` ends every rule of one account) is the owner's, and refused inside a ferret's pane. `add`, `resume` and `renew`
only **stage** (and `confirm-in-app`): the command prints the `<app>/#rules/<stage>` link (`--open` opens it in this
machine's browser), then polls the stage for up to 125 seconds and prints Approved, Denied or Timed out. **The command has
no way to commit**: the passkey is the app's. `--totp` needs `--i-understand-one-factor`. A terminal rule prints the red
root warning and the residual sentence from the daemon's structured `root` flag, and exists only while the daemon
reports `sign-in-rules-terminal.1`. `narrow` and `rm` need no passkey. A paste rule is not one of these:
`fy copy rules`.

## The Accounts screen

Settings › Accounts is gated on the daemon's health: a machine that reports `accounts.signins.1` gets the screen below,
any other (older, silent, or one whose health read failed) keeps the saved-logins surface above, unchanged. It reports
`accounts.2fa-keys.1` separately: without it the 2FA keys tab is not offered and no seed can be saved from here.

- **List** — accounts grouped by the site they sign in at (the first host a place names; `ssh@host` for a terminal),
  each row naming the account, which fields EXIST ("password ✓", never a value) and its 2FA keys. Accounts with no
  sign-in sit under "No site yet". A damaged store is said to be damaged, never drawn as an empty list.
- **Account** — _Details_ (name, username, a write-only password: the box is empty every time and the page only says
  one is saved), _2FA keys_ and _Sites_. Under its name it shows its **name in the terminal** (its handle,
  `GOOGLE_A`): the name `fy account` uses. It has the shape of a secret name for history's sake, but it is **not an
  environment variable** and `${secret:…}` cannot reach it; the app never calls it a handle.
- **An input's "Save to Accounts"** keeps an account as a username and a password together: a **new** account named
  "Google · a@gmail.com" by default, or an explicit **Update** of the same person's account, never one with another
  username ([Save as](input-requests.md#the-first-time-save-as)). The username kept is the one the owner confirmed on the
  input, so the Accounts list shows it.
- **2FA keys** — each key by its label and plain facts with a usage record: _Last code worked on <date>_,
  _Not used yet_ or _Last code did not work on <date>_ (red, the only one drawn as a warning). It is a record of what the
  daemon saw, which a ferret can steer, and not a check that the key belongs to the account, so it is never drawn as a
  check mark and never gates a pre-approval. Adding an SMS, email, push or security key sends no value. Automatic codes
  (a seed) go through the SAME panel the code input uses ([Set up automatic codes](input-requests.md#2fa-seeds-opt-in-per-entry)):
  stage, the two ticks, then the `add-2fa-key` passkey bound to that stage. There is no second path: a seed is never
  sent to `POST …/factors`.
- **Site (a sign-in)** — _Method_, _Recipe_ (plain text, never Markdown; a ferret's recipe is labelled as unreviewed, and
  its proposals are shown as a diff to approve or decline), _What Ferretry saw_ (facts, never values) and _Defaults_.
- **Defaults** — a default only decides which account an input lists first; the tap is still the permission. It is
  `config/account-defaults.yaml`, set per host with `PUT /v1/accounts/defaults`. A default may be set on any host the
  sign-in NAMES, a site's `match` hosts included (the daemon checks `placeHosts`, and so does the screen). A file that
  does not parse is shown as unreadable, never as "no defaults".
- **Look-alikes** — when `GET /v1/accounts/look-alike` (owner only, handles only) reports accounts that share a username
  and password, a banner offers _Merge_ (pick the one to keep; the others' sites and keys move onto it) or _Keep apart_.
  A daemon without the route simply shows no banner.

Every write is a person route (`secrets` configure, operator minimum) so a ferret cannot make it; no response and no
screen holds a password, a seed or a code. The one-tap on an input comes only from the daemon's `primary` offer.

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
already holds one (it is **kept**: a copy only adds, never replaces) — and the sending machine asks for a
**passkey for that copy**.
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
actually holds and the receiving one does not are asked for. **A key already on the receiving machine is never
written by Clone, in any mode, for any reason** — when the source has a newer one, Clone only says so — below.

**5.0 state (declared GAP, parity rows S-0057 and S-0495).** The Clone preview in 5.0 does not run the sealed copy
above or report its keys to `POST /v1/runtimes/clone/keys`: a key the source holds and this machine does not is **named**
(_Add these API keys here_, with each name) and **never carried**, so the person adds each with `fy secret set NAME`. Read
"copies with its key", "the same sealed copy" and "copied with its login" in this section as the design of that copy, which
is not built.

#### A key that is newer on the source (reported, never copied)

**Owner decision (Option A, design §14.4): a copy never writes or overwrites a secret-store entry or a
`${secret:NAME}` value, in Update, Add alongside, Start over (`--replace`), linking old copies or "Gone from the other
machine".** A key this machine already holds is reused as it is. When the source has changed that key since the last
copy, Clone **reports** it and tells the person how to take the newer one by hand: **`fy secret set NAME`** on the
receiving machine. There is no ticked row, no replacement, no second passkey, and nothing in any request that could
ask for one.

A copy from a machine you copied from before reports a key again only when the sending machine has changed it since.
Each key a copy filed is remembered by two instants in the receiving machine's `clone-base.json` (the record of what
was last copied, `docs/design/account-model.md` §3.8): when the **source** last changed it (its secrets list's
`updatedAt`) and the instant **this** machine's copy filed it. A later review compares those two with what each list
says now:

| The source…                     | This machine…            | Outcome   | In the Clone preview                                                                         |
| ------------------------------- | ------------------------ | --------- | -------------------------------------------------------------------------------------------- |
| holds it, this machine does not | —                        | `missing` | Named, never carried: _Add these API keys here_; run `fy secret set X` (GAP: S-0057, S-0495) |
| changed it since the copy       | has not changed it since | `newer`   | **A newer `X` exists on _source_.** Clone does not replace it: run `fy secret set X` here    |
| changed it since the copy       | changed it too           | `both`    | The same, plus _You changed it on this machine too_                                          |
| has not changed it              | (anything)               | `same`    | Nothing is said                                                                              |

A key both machines hold that no earlier copy recorded is `same`: nothing says the source moved on.

**Metadata only.** The comparison is of timestamps. **No value, and no digest of a value, is ever compared, stored or
returned** — not by the review route (`POST /v1/fleet/clone/review`, which answers key _names_ and an outcome), not by the
record, not in a log. The browser sends the sending machine's list of names and instants and nothing else; the receiving
machine reads its own list for its half. A browser that lied about an instant could only make a key look `same` (nothing
said) or `newer` (said, and still needing the person to act by hand): it cannot make a value move.

**The import can only add.** `POST /v1/secrets/imports/:importId` takes `{ bundle }` and nothing else — a `replace` list
(or any other field) is refused when the request is parsed. The receiving machine files the bundle with one
**atomic, add-only write** (`SecretDirectory.putMissing`): in a single turn of the store's writer and a single document
write it stores every name that is missing and leaves every name it already holds exactly as it is — value, `createdAt`
and `updatedAt` untouched. Because the check and the write are one step, a name that is created between the start of the
copy and its filing (another tab, `fy secret set`, a paste, a second import) is **kept**, never overwritten, and is
reported in `kept`, not `imported`. If the names that are missing would take the store past its limit the whole batch
is refused and nothing is written. Filing is still the `configure` axis of the `secrets` capability, so a governed
device without it is refused, and one with it steps up (`docs/grants.md`). A saved login's stored credential, the account
defaults and the 2FA factors live in other stores a bundle cannot name, and a login's own configuration (including which
`${secret:NAME}` it references) is never touched by a key copy.

**Remembering what was filed.** After the sealed copy lands, the browser reports the keys the import `imported`
(`POST /v1/fleet/clone/keys`, `fleet.configure`) with the sending machine's instant for each and `filedAt`, the instant
the import answered it filed them. The receiving machine records `filedAt` as the baseline for a key **only if its own
store entry was created at that instant** — the one thing that proves it is the entry that copy made. A key deleted and
made again since is left unrecorded; a key the person edited after the copy is still recorded at the copy's instant, so
the next review says `both`. The update of `clone-base.json` takes the same exclusive claim a fleet apply holds (the lock
beside the manifest), reads the record and writes it while holding it, so an apply can never publish between the two:
it either finishes first, and the update is made from what it left, or waits and its own revision check refuses a
plan older than the update. A report that writes nothing answers `recorded: 0`.

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
   that every value fits before writing any: a half-copied set is worse than none. **A copy only adds**: a name it
   already holds is never written, and the answer says which names were `imported` (new here, filed at `filedAt`) and
   which were `kept`.

Both ends write the **same import id** to their security log — `secrets.used` (`clone-export`) on the
sending machine and `secrets.changed` (`clone-import`) on the receiving one — with the names, never a
value. The receiving one records the names it actually `imported`, not the ones it kept. The three wire shapes are `packages/protocol/src/lib/secret-clone.ts`; the two halves are
`SecretImportService` and `SecretExportService` in `packages/daemon/src/lib/secrets/clone.ts`.

**The export is the sixth vault holder**, and it keeps the rule the other five keep: it returns nothing
a caller of that daemon can open. A sealed bundle is not a secret value in this document's sense — no
route, command or API still returns one, and `SecretDirectory` still has no getter.

**The download-link key file is the seventh vault holder.** `link-keys.json` seals each public link's key
(AES-256-GCM under the vault's own `FileSecretKey`, AAD `catalog-link:<linkId>`) so the owner can Copy the link
again ([catalogs.md](catalogs.md#the-daemon-3f-4)). It keeps the rule: it is not a secret _value_ of the vault, no
route returns a key but the owner's own Copy answer for their own public link, a one-time link's key is never
written, and the file is 0600. A ferret is refused Copy. `links.json`, the audit and every list answer hold no key,
URL or fetch token. `links.json` DOES hold each link's bundle id (the store names a link by it, so a link cannot be
turned off without it): it is an address, not a secret, and opens nothing without the key `k`. The audit and the list
answers carry no bundle id. A lost vault key (`secrets.key`), or an entry that does not authenticate under it, makes
Copy answer `500 links_store_damaged`; an entry that was never kept answers `link_not_live`. Either way the link itself
still works for anyone who holds the URL.

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

Settings › This machine › **Speed-ups** takes four optional keys, stored here like any other secret:
`JEV_API_KEY` (the Warden's triage guard), `GROQ_API_KEY` or `CEREBRAS_API_KEY` (cleaning up a
dictated transcript after it has been recognised — the provider gets text, never audio; see
[`docs/voice.md`](voice.md) for where the audio itself goes), and `ELEVENLABS_API_KEY` (an optional reply voice: it
receives the text of a ferret's spoken lines, placed as `xi-api-key`, and its JSON-only answer carries the audio as base64 so the
holder is not widened for raw audio; [voice.md](voice.md#elevenlabs-as-the-reply-voice-unit-10)). Create shares the same key name
for its voiceovers. The daemon
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

## A plugin's own key, placed by the kernel

In 5.0 a plugin that only ever spends a key on an HTTP request asks the kernel to place it:
`kernel.secrets.send(name, request, placement?)` (`packages/core/kernel/host/secrets.ts`). The Warden's Jev guard is
the first caller. It is the holder above with the same rules, held by the kernel. The plugin never holds the value.

- **The name passes `kernel.secrets.resolve`'s rule, in that order.** It is in the plugin's manifest `secrets`. The
  plugin's OWN configuration in effect names it as `${secret:NAME}`. The Vault knows it. A plugin can never put another
  plugin's secret on a request, because its config would have to name it, and adding a reference is held for the owner.
- **Only to an exactly declared host.** The URL must be `https:`, or `http:` to this machine. Its host must be a plain
  host entry of the plugin's `permissions.network`. A wildcard, `'*'`, an installed-item entry or a resolver entry lets
  no key out. The request goes through the plugin's own `kernel.fetch` guard, so a redirect is answered, never followed.
- **Read once.** The request and the placement are parsed once into plain data, and only that copy is checked and
  sent. A getter cannot show the check one host and the send another.
- **The plugin cannot place a credential itself.** A request that already carries the placement header is refused.
- **Facts only come back.** The answer is a 2xx reply's parsed JSON, a status, `timeout`, `network`, `too_large`,
  `unreadable`, `vault_damaged` or a refusal. A reply that echoes the value is `unreadable`. A thrown error becomes a
  kind, so its message never leaves. The Vault is asked last, after every other check.
- **Logged by name and host only.** The plugin's own log says so, and so does the security log: a `secrets.used`
  entry names the secret, the plugin, the host and the outcome's kind, never a value ([audit.md](audit.md)).

The Warden names its key in `warden.yaml`, as the owner writes it:

```yaml
jev:
  key: ${secret:JEV_API_KEY}
```

`jev.key` takes only that one reference. An agent's write that adds it is held for the owner, like any new secret
reference. Without it the guard answers `not_set` and nothing leaves the machine. It is not a setting: a settings
save never writes it and keeps the line as it is.

The settings panel says which of these a key is in. **Key set** means it is stored and `warden.yaml` names it. **Key not
named** means it is stored but `warden.yaml` has no `jev.key` line, so nothing is sent; the panel offers **Use stored
key**, which writes that one reference (`POST /v1/warden/jev-key`, no body, no value) as the caller's own act: in effect
when the caller is the owner, otherwise held for the owner and shown as "Waiting for your approval". The settings read
says only `jevKey: named | not_named`.

## A secret a plugin minted, placed on its request by the Vault

A plugin that FILES a secret itself (MCP's sign-in access tokens, `permissions.mintedSecrets`) has no configuration that
names it, so `kernel.secrets.resolve` and `send` refuse it as they refuse anything undeclared, and **no pattern of
names turns a plugin into a reader**. What the plugin gets instead is a Vault operation:
`vault.fetchMinted(name, request, placement?)` (non-core needers only). The Vault puts the value on ONE request and
answers a SANITIZED reply, so the plugin never holds it.

- **Only a value the plugin wrote.** The Vault's own mint ledger (`state/vault/mints.json`, ids and a per-write nonce,
  never a value) records the plugin and the identity of its write whenever a plugin `put`s. A secret the owner put under a
  matching name, one the owner replaced afterwards, one another plugin minted, and one a manifest only declares are all
  refused and nothing is sent. A ledger that cannot be read refuses. **Authorization and value are one entry**: the Vault
  opens the ciphertext entry ONCE (`SecretVault.openEntry`), checks THAT entry's write identity against the ledger and
  sends exactly that entry's value. What a write that lands between the steps does: **it can never make the call send
  the replacement.** A write by the owner or by another plugin made BEFORE the Vault opens the entry refuses the call
  (the ledger no longer names that write); one that lands AFTER the open cannot change what is sent, and the call may
  still send the value the plugin itself minted (the previous snapshot), which is not a replacement and not a leak. This is
  snapshot semantics, not immediate revocation of an exchange already started.
- **Only to a host the plugin's own `network` allows**, `https:` or `http:` to this machine, no userinfo. A request that
  already carries the placement header, or a `Host` header, is refused (as `kernel.secrets.send`). A redirect is
  answered, never followed. The request asks for an unencoded reply (`accept-encoding: identity`).
- **The reply is built inside the Vault**, the holder of what was sent, never a raw `Response`: the status, a
  `statusText`, an ALLOWLIST of headers (`content-type`, `mcp-session-id`, `mcp-protocol-version`, `www-authenticate`,
  `retry-after`; everything else stays in the Vault) and a body. **The Vault does not list spellings; it decodes, checks
  and drops** (`contract/echo-mask.ts`), against the value AS SENT (and the whole header value it travelled in):
  1. **Only a body the Vault can parse is returned**: JSON (`application/json`, `+json`, UTF-8), or an event stream whose
     `data` is parsed the same way. HTML, XML, plain text, NDJSON, binary and compressed bodies are DROPPED with
     "The server’s answer is not JSON, so the Vault could not check it for the sign-in and kept it." (or the compressed /
     not-valid-text / not-valid-JSON sentence). The body is read whole and parsed whole, so a value split across network
     chunks is found.
  2. **Every string is walked, keys and values, and each is read in every form the Vault can decode**: as it is, repeatedly
     URI-decoded (partial and mixed-case `%xX` too, `+` as a space), HTML-entity decoded (`&#x..;`, `&#..;`, the named ASCII
     ones), backslash-unescaped, hex runs decoded (either case), base64 / base64url runs decoded with whitespace folded
     away (at every alignment), and NFKC-folded; the forms are decoded further, to a bound. Each form is compared
     lower-cased with whitespace removed. If ANY form holds the value, the WHOLE string is replaced by `[redacted]`. A JSON
     number is checked as its digits.
  3. **`statusText` and every kept header value get the same check**, a string at a time (a string the check cannot
     finish is replaced). An event's `event` and `id` are checked the same way, `retry` is kept only as digits, and a
     comment or any other field is dropped. A `data` that is not JSON (an older transport's endpoint path) is checked as one
     string.
  4. **It fails closed**: a body that is not parseable, or past a bound (`maxBodyBytes`, 1 MiB by default, 4 MiB at most;
     200 000 values; 64 levels of nesting; 1 024 decoded forms and 64 MiB of decoding work for one string) is dropped
     with a sentence saying so, never clipped. The check uses the value AS SENT, so an owner replacing the secret while
     the reply is in flight changes nothing. The reply is still a stranger's text: a caller scrubs it with the redactor
     like any server's words before it keeps or shows it (a second layer, not the first).
- **Declared GAP: a check's `PATH` and stored-secret variables.** A check fills `${VAR}` from the runtime's PLAIN launch
  variables and the machine's home; `PATH` is not among them (the kernel offers no plugin the daemon's `PATH`, by design),
  and a variable held in a stored secret is named, not filled. Closing it takes (1) a kernel `paths` offer that answers a
  `which`-permitted plugin the inherited `PATH` (a doctrine decision, since it widens what plugins read), and (2) a
  Vault operation that fills such a template INSIDE the Vault for one check child's argv, URL or header (the child
  environment already takes `${secret:NAME}`; argv, URL and header do not), with the runtime publishing the variable to
  secret-name mapping. Neither is a small additive offer, so neither is built here.
- **Declared GAPs.** The check is "decode and look", not a proof. **A value split across TWO JSON strings** (or two
  events) is not found, because no one string holds it. A cipher, a reversal, a hash, or any form none of the decoders
  above produces is not found. A value shorter than four characters is searched for only as it is, never in a decoded form.
  A string that reads as the value is replaced whole, so an ordinary field that happens to contain it is lost too (a
  server that reflects the token into its own name has that name replaced, and a check says so). A large binary blob
  inside JSON can pass a bound and drop the whole body. The Vault keeps the status and the allowlisted headers of a
  dropped body.

## The one exception: a running ferret gets its own renewed MCP token

"No route returns a secret value" has **exactly one** exception, and it is narrow in four ways at once:
`POST /v1/ferrets/:ferretId/mcp/token` (MCP, [mcp-oauth.md](mcp-oauth.md#a-ferret-that-outlives-its-token)) hands a RUNNING
Claude ferret the renewed access token of an MCP server its own launch already holds, so Claude's `headersHelper`
(`fy mcp token <VARIABLE>`) can keep a ferret that outlives a twelve-hour token working.

- **Self only.** The handler requires the caller's credential to be the SESSION credential of the ferret the path names.
  The admin token (with or without a session header), a paired device, the warden and every other ferret get 403
  `not_this_ferret`; the route is also governed as `secrets.use` and `secrets` is a capability a narrowed caller may lack.
- **Only what its own launch holds.** The variable must match `^FY_MCP_[A-Z0-9_]+_TOKEN$` (a variable NAME, never a secret
  name) and be one this ferret's launch binds now (its runtime's profile and its folder's project): otherwise 404
  `not_this_ferrets_server`. The route cannot be pointed at a secret the launch did not already put in the ferret's environment, so
  it adds nothing beyond the documented GAP ([mcp-oauth.md](mcp-oauth.md#what-this-does-not-protect-against): an agent
  can read its own environment). It extends that boundary in time (the renewed token), not in kind.
- **One Vault operation, for what the caller itself wrote.** The Vault has no general getter and none may be added.
  `MintedValueReader.mintedValue(name)` is the single exception: it is not a member of `VaultApi` at all
  (read through `mintedValueOf`) and exists only for a plugin whose manifest declares
  `permissions.revealMinted`, which only MCP may declare. The kernel enforces that at boot, from the manifest alone and before
  the plugin builds, so it holds whether the other plugin needs the Vault, only uses it (optional) or names no Vault at all:
  any such plugin is marked failed, naming the permission (the Vault builds a port only for a plugin that asks for one, so
  it could not be the place that refuses the optional and absent cases). The getter itself reads only what MCP's own ledger entries say MCP wrote. It answers only a secret the Vault's own mint ledger says THAT plugin wrote the
  current value of (the same word `fetchMinted` takes, [above](#a-secret-a-plugin-minted-placed-on-its-request-by-the-vault)).
  An owner's value, another plugin's, one replaced since and a name merely declared answer nothing; a plugin without the
  permission, and the core, are handed no such method. It gives MCP back a token MCP itself received from the provider and
  put, so it reveals nothing MCP did not hold when it minted it.
- **`noStore`, audited by name.** The answer is never cached; the security log records `secrets.used` `mcp-token` with the
  ferret and the variable NAME, never the token. Tests:
  `packages/core/vault/tests/unit/daemon/minted-value.test.ts` (the getter's reach), `packages/core/kernel/tests/integration/host/reveal-minted.test.ts` (a real `bootHost`: refused with the Vault required, optional and absent), `packages/plugins/mcp/tests/unit/ferret-token.test.ts`
  and `packages/plugins/mcp/tests/integration/ferret-token-e2e.test.ts` (the real `claude` runs the helper and the server sees a fresh
  token after each rotation; another ferret, the owner and a ferret without the server get nothing).

Declared GAP: **Codex has no helper hook**, so a Codex ferret's token is its launch-time one.

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
  device you hand to somebody else should have its keys removed first (Remove on each key).
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

## A harness sign-in file in a ferret's home

A Codex OAuth (or key) sign-in is not a vault secret either. Logins keeps the harness's own `auth.json` in its private
`credentials` root; when a ferret starts on that login, Logins mints a one-file _shared credential_ bound to Codex and
the kernel makes ONE symlink to it at `<the ferret's Codex home>/auth.json` (and Codex is launched with
`cli_auth_credentials_store="file"`). No plugin and not the daemon reads the file through that link: the child process
Codex reads it, and refreshes it in place, so the link keeps pointing at the one file. A login with no usable sign-in
refuses the start with one sentence, before any pane exists. The residual is the same-user one: the agent runs as the
same user and Codex's sandbox reads anywhere, so an agent's shell command can `cat` that file, exactly as in the old
account model. Codex takes the link back out of the ferret's home when the ferret stops or goes away, and out of every home
it linked when its login is removed, signed out or switched off (it also removes a file Codex wrote in the link's place,
which is a copy of the same sign-in). That ends the link; it does not hide it, because while the link is there the agent can
read it, and a copy an agent made for itself is not Codex's to find. Two declared gaps remain. Which ferret holds which login
is kept in memory, so after a daemon restart a revoked login clears nothing until each of its ferrets stops or is launched
again (a stop clears the link whether or not this daemon placed it). And two ferrets refreshing one login in the same
instant can race on its single-use refresh token.

Every ferret on a login shares that ONE `auth.json`, and each runs as the same user, so **any ferret on a login can
rewrite the shared file** and so change the account for every other ferret on it (or hard-link it, which makes the next
start on that login refuse until the extra link is removed or the login is signed out and in again). This is the same-user
residual above, not a new reach. The kernel hands the credential over once (it is single-use, and only the harness is
given it), and it refuses to move the placed link, or a folder holding it, out of the ferret home it was linked into (`link_escape`; removing it stays allowed), but it cannot stop the agent that then holds the file. When the kernel refuses the link at the last step, the
start fails with the general "could not prepare this ferret's home" sentence (`failed`), not `login_unavailable`.

Two more rules keep that one link the only door, both enforced identically on the real roots port and the testing host:

- **No other link reaches a credential home.** `linkTo` and `copyTree` in link mode refuse (`link_escape`, nothing written)
  any link whose own place OR whose source is inside a credential home, which is the whole `agent-homes` root (every
  ferret's Codex home, the folder that holds a placed credential, the folders above it and the ones about to) and the whole
  `credentials` root (every login's store). So a folder alias of a ferret home (`f2` linked to `f1`) cannot give a second
  ferret the credential, and neither can a link made before the credential is placed. The one rule is
  `credentialHomeLinkVerdict` in `packages/core/kernel/host/shared-credentials.ts`. `linkCredential` is unaffected. This is
  NOT the whole "any login's store" rule: the fleet folder and the host harness homes are not credential homes to it (see
  **Declared exception** below), so the rule covers `agent-homes` and `credentials` only.
  A refusal writes nothing, not even the scoped agent home a link was to land in: the verdict is judged before anything is
  resolved for creation, on the real roots port and the testing host.
- **The move check is armed against a swap.** The device and inode recorded when the link was placed are kept through the
  whole move decision and asked again at the held-source look, for the link and for any folder that holds it, so a writer on
  the same filesystem who swaps the link for a file across the first look and puts it back at the next call does not get it
  moved. **Declared GAP:** after that last look the move is a plain `rename(2)`, which cannot be made conditional on what
  the look saw (no compare-and-rename in the standard library), so a same-user writer who restores the link inside that
  single window is not stopped. It needs a concurrent writer already holding the same user's filesystem, which is the
  same-user residual above.

**Declared exception: Runtimes' fleet credential store and the host harness homes (not implemented, pinned).** The
credential-home rule above does not reach the `fleet` root (the fleet credential store, `fleet/credentials/<id>`, and
Runtimes' runtime homes) or the `harness-home` root (the host's own Claude Code and Codex homes). Generic `linkTo` and
`copyTree` link mode from and into them remain allowed, within the root-specific refusals that still apply (a `harness-home`
is a read-only destination, and `copyTree` link mode FROM `harness-home` is `not_declared`; the host reach this exception
accepts is `linkTo` FROM `harness-home` INTO `fleet`), for **Runtimes' provisioning only** (`FleetDisk` in
`fleet-disk.ts` and `FileFleetProvisioner` in `file-provisioner.ts`), because Runtimes provisions fleet homes, host sources
and not-yet-existing sign-in slots, none of which the dedicated `linkCredential` (scoped `agent-homes` only) can place. So a
Runtimes link can reach a real fleet or host sign-in outside `linkCredential`: a link in the fleet assets to a login in
`fleet/credentials`, or to a host `auth.json`, succeeds on the real port and the testing host. The review also observed that
the kernel does not constrain `harness-home` to an actual harness folder: Runtimes can scope it to an arbitrary absolute folder
and link an ordinary file from it into the fleet credential store. Reach is limited to the trusted provisioner: only Runtimes may
hold either root (the kernel's ownership rule), a project file is never a link source, an `agent-homes` link is refused, no
route or tool lets a ferret choose the operation, and a shell already running as the user can use the filesystem directly (the
same-user residual above). The exception is pinned by a fitness test, `scripts/gen/tests/fleet-link-callers.test.ts`, which
asks the **TypeScript type checker** (TypeScript 7's native checker, over every production module; the repo's tsconfig projects)
and not the spelling, in two layers. **(1) No read:** it fails if any production module other than `fleet-disk.ts` reads,
aliases or destructures `linkTo` or `copyTree` off a value the checker types as the kernel `RootHandle` (an alias of it, a
union or intersection containing it, an interface extending it, a `Pick`/`Readonly`/spread/rest of it), whatever the key is
spelled through: a constant, an imported dispatch table, a reassigned or shadowed key, a parameter typed `'linkTo'`. A key the
checker cannot narrow to string literals, on a handle (or on an `any` a handle was put into), fails closed. A cast does not hide
the handle (`(fleet as never as Record<string, Function>)[name]`). **The disk is held to the same rule by TYPE**: every member of
`FleetDisk` that reaches a `RootHandle` link operation, directly or through another member or helper of `fleet-disk.ts`
(today `linkTo` and `copyInto`), is a link operation, and a read of one off any value the checker types as `FleetDisk` —
`host.disk.linkTo` through `Pick<AdapterHost, 'disk'>`, a wrapper's parameter, an alias, a destructuring, an element access, a
class field — fails outside `fleet-disk.ts` and `file-provisioner.ts`, the one module that drives it. The test also fails if
either allowed module stops reading (a stale allowance). **(2) The authority surface is pinned** in
`scripts/gen/tests/fleet-link-callers.snapshot.json` — whole surfaces, not spellings: the exported names, kinds and class members of
`fleet-disk.ts` and `file-provisioner.ts`; every module importing either, directly or through a re-export; the link-capable
members of `FleetDisk` and every module that holds a value the checker types as `FleetDisk` (declares a field, parameter,
variable or return of that type, or reads one: found from the class's references and every identifier named like such a carrier,
verified by type); every module that asks the kernel for a `fleet` / `harness-home` handle — a `RootsPort.root` call is found by
what it **resolves** to, so a destructuring, a rename, an element access, `.bind`/`.call`, or passing `roots.root` as a value
is followed to the calls it ends in, and a root name the checker cannot narrow counts as a fleet root; every module that handle is
then passed to (variables, assignments, call arguments, returns, object-literal properties and class fields); and **the complete
member list (name and kind) of the `RootHandle` interface and of every object literal or class that implements it**, so a new,
removed or renamed handle operation — whatever it is called — fails with a message saying a reviewer must approve it **and decide
its guard**, because no scan can infer link semantics from an unlisted name. Every change fails naming &F3537 and saying a
reviewer must approve the snapshot change (`FLEET_LINK_SNAPSHOT_UPDATE=1` rewrites it). That is what closes a helper exported from
an allowed module, re-exported by a barrel and called by a new module — no read-based scan can see that. The test also fails if
either root is ever held by a plugin other than Runtimes, so a future caller cannot slip in before the move. No directory is exempt:
a new kernel module (a host helper, a worker-grants write handler) that calls `fleet.linkTo` fails like any other, and the kernel's
own definitions pass because a definition is not a read. **Not caught (declared):** reflection (`Reflect.get`,
`Object.entries`, `Object.getOwnPropertyDescriptor`, any call that names the operation only as data), and a handle put into an
`any` by a route the check does not follow (a property, a return, a container) then indexed by a key that is not a string literal
— an `any` nothing demonstrably handed a handle to is ordinary JSON indexing and is deliberately left alone. A handle or a disk in
a container is not followed by the receiver and holder lists, but layer 1 reads the TYPE at every use, so any link read of it is
still caught wherever it ends up. It costs about 27 s of the quick test tier (it opens the type checker once, reads every
production module and derives the surface; measured 2026-11-12, Linux x64). It is to be **removed by the after-merge move** (&F3537,
"Dedicated credential link operation"): Runtimes onto a dedicated credential operation, the fleet store becoming a credential home,
and ordinary asset links that land in a runtime credential home becoming copies. The ruling that scopes it, quoted exactly:

> "if the re-review proves only Runtimes' provisioning (fleet-disk.ts, file-provisioner.ts) reaches fleet.linkTo on the fleet root, ALSO add a fitness test that fails if any other module calls it there, so a future caller can't slip in before the after-merge move. Then fix4 is fine for merge; the last-look-to-rename race stays a declared GAP."

## A harness's history pool in every ferret's home

Each ferret has its own harness home (`state/<plugin>/agent-homes/<ferret>`, used as `CLAUDE_CONFIG_DIR` / `CODEX_HOME`),
and the kernel refuses every link inside `agent-homes` except `linkCredential`. That left no plugin able to pool history,
so a ferret resumed on a conversation another ferret started began a new one. The **history-pool door** is the one narrow
link that lets a harness plugin pool, and it is built so it can share history and nothing else.

**What it adds, said plainly.** Any ferret on a harness can read and continue any other ferret's conversations on that
harness. That is the owner's ask and v4's behaviour (v4 linked each login home's history entries to `fleet/shared/<harness>`).
A conversation can hold anything its ferret saw or typed: a pasted token, a file's text, a command's output. Pooling makes
those transcripts readable by every ferret on the harness, exactly as v4 did; it does not make them readable to anyone else.
Claude's pooled list also includes `session-env`, `shell-snapshots` and `paste-cache`. These can contain environment
values or pasted secrets. They stay pooled for v4 parity: **any ferret on that harness can read them**, just as it can
read the transcripts.

**The door.** `RootHandle.linkHistory(home, entry)` on an `agent-homes` handle makes `<home>/<entry>` a symlink to the REAL
path of `<pool>/<entry>`, where the pool is the caller's own `state/<plugin>/<folder>/` (outside the ferret-home tree, so never a
credential home). It is on `RootHandle`, beside `linkCredential` and `copyShared`, because it writes into the handle's root
through the same checked, no-follow folder descriptors, and the handle already knows its plugin. A plugin declares it in its
manifest and can use nothing else of it:

```ts
permissions: {
  roots: ['agent-homes'],
  historyPool: {
    state: 'history-pool',            // the NAME of its own opaque `history-pool/*` state def
    entries: [{ name: 'projects', kind: 'folder' }, { name: 'history.jsonl', kind: 'file' } /* … */],
  },
},
```

The kernel names the target from the declaration; the caller passes a home and an entry name, never a path. Each refusal
below is made BEFORE anything is written, with a closed reason (`HistoryPoolError.refusal`, or a `RootError` for a disk
fact), identically on the real roots port and the testing host (`tests/unit/testing/history-pool-parity.test.ts`):

| Refusal                   | When                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `not_internal`            | the handle is not an `agent-homes` handle                                                                                                                                                                                                                                                                                                                                                                    |
| `not_permitted`           | the manifest lacks `permissions.historyPool`                                                                                                                                                                                                                                                                                                                                                                 |
| `denied`                  | the entry is on the fixed deny list, whatever the manifest says: `.credentials.json`, `.claude.json`, any `settings*.json`, `auth.json`, `config.toml`, `CLAUDE.md`, `AGENTS.md`, `skills`, `plugins`, any name starting with `.`, a `/` or `\`, NUL, `..`, any name that looks like a credential (`credential`, `secret`, `token`, `oauth`, `passw`); compared case-insensitively, because macOS folds case |
| `not_listed`              | a legal name that the manifest's closed list does not name (exact, case-sensitive)                                                                                                                                                                                                                                                                                                                           |
| `not_own`                 | the pool is not the caller's own opaque `<one folder>/*` state tree, sits in a root the kernel makes (`agent-homes`, `credentials`, …), or holds a private place of the plugin                                                                                                                                                                                                                               |
| `not_home`                | `home` is not exactly one ferret home folder at the top of `agent-homes` (the root itself, a folder two deep, and a scoped handle that is not one home)                                                                                                                                                                                                                                                      |
| `exists`                  | anything (a folder, a file, a link) is already at `<home>/<entry>`: never an overwrite. A caller with a real folder moves it aside with `rename` first                                                                                                                                                                                                                                                       |
| `outside` / `link_escape` | the home is missing (this call never makes one) or is, or sits behind, a link; or the pool folder, or the entry in it, is a link (nothing is followed, nothing is made behind it)                                                                                                                                                                                                                            |
| `changed` / `hard_link`   | the pool already holds the wrong kind at the entry (or a file where the pool folder belongs), or a file with a second name; or the link made did not land on the pool entry's real path, or the pool entry is no longer the one proved when it was made (a different inode, kind or link count, found again after the link is published): the link THIS call made is taken back                              |
| `no_descriptor_reach`     | a host that reaches an open folder by no descriptor path (macOS today): the link is never made by a path a swapped parent could redirect                                                                                                                                                                                                                                                                     |

The pool base is made `0700` at boot; the entry in it is made on first use by the kernel. What is already in the pool is kept as it is.
The pool is reached by ONE descent (`reachHistoryEntry` in `host/roots.ts`): the plugin's state folder is checked once and is
the anchor; the pool folder and then the entry are opened from their parent's descriptor with `O_DIRECTORY | O_NOFOLLOW`
(a `0700` folder, or an empty `0600` file made exclusively), and every component that is already there is judged by name
first and must be the very folder opened (same device and inode). An EXISTING pool folder swapped for a link, or for
another directory of the plugin's state (an agent home), after the check is refused (`link_escape` / `changed`) before
anything is made in it; a pool folder that did not exist yet is the "pool absent when first made" gap below. After the link is published the kernel proves it as `linkCredential` proves its source: the link lands on the pool
entry's real path, and the entry is reached AGAIN from the anchor (no link on the way, the declared kind, the hard-link
count, the private-place fence) and is the same file or folder it held when it made the link; otherwise it takes back the
link it made and refuses.

**Reading, writing and moving into the pool (PR 3).** `RootsPort.historyPool(): RootHandle` synchronously returns a
writable internal view of only the caller's own declared opaque, non-private pool tree. The kernel makes its base
`0700` at boot, before plugin code runs. Permission (`not_permitted`), ownership/private-place (`not_own`), then the
declared `agent-homes` root (`not_declared`) are checked in that order. The view uses the regular RootHandle machinery:
whole or windowed reads, `openBytes`, listing, writes and copies, fenced to that pool with the same immutable/private
guards. Every held read or write starts with the same `reachHistoryEntry` proof from the checked plugin state folder,
then descends from that held pool descriptor. A link at any level is
never followed, including a link pointing elsewhere inside the pool. A hard-linked file is not read. The view cannot
reach homes, credentials, another plugin's state, or other state of its own plugin. It has no `linkHistory` or
`moveToHistoryPool` door (`not_internal`). It is never either end of `linkTo` or link-mode `copyTree`, nor the place of
`linkCredential` or link-mode `copyShared` (`link_escape`); copying bytes into it remains allowed.

`RootHandle.moveToHistoryPool(from, pool, to): Promise<void>` moves ONE regular-file leaf by atomic no-replace rename from a ferret's home to
that plugin's minted pool view (a forged view or another plugin's is `not_own`). The source is
`<agent-homes>/<ferret>/<listed entry>/...`, or the listed entry itself; a home/root name is `not_home`, and the same
fixed deny list and closed entry list still apply (`denied`, `not_listed`). The target is `<same entry>/...` or
`.conflicts/<same ferret>/<same entry>/...`; other shapes are `denied`, and `.conflicts` is special only in that first
position. Parents are made `0700` only inside the pool. Both parents are held through the no-follow descriptor walk,
then Linux `renameat2(RENAME_NOREPLACE)` moves between those held parent descriptors. An existing target is
`HistoryPoolError('exists')`, including one created concurrently: the source stays in place and the target is never replaced.
Only regular-file leaves move; a folder, link or other kind is `not_file`, and a source file with another hard link is
`hard_link`. A placed credential is refused by the same placed/private guards. A folder cannot carry an unchecked descendant
through this door.
Private-place guards hold at both ends; the pool end reuses `reachHistoryEntry` and its held base, including the
device/inode check that refuses a real agent home swapped into the pool's place DURING this call. It does not establish
where an already-planted real folder came from. Another device is `changed`, with no copy fallback. A host without
atomic descriptor-relative no-replace rename (including macOS today) refuses `no_descriptor_reach`; there is no plain-rename
fallback. Refusals before the syscall move no file; empty target-parent folders already made may remain. A failed
post-move proof attempts atomic no-replace restoration; if the source name was taken meanwhile, the file can remain
in the pool. For a proven hard-linked inode, the kernel instead drops its pool name when restoration fails (another
name retains the bytes); the identity/link-count look and unlink have the same-user leaf-swap window described below. The harness then keeps its pending marker and refuses this launch rather than resuming from incomplete history.

**Existing homes and interrupted merges.** Before moving any leaf of an entry, the shared harness helper preflights
all names, kinds, link counts, depth and move count, and performs zero-byte reads through the kernel's private-place guards.
A preflight refusal moves nothing in that entry and the launch continues on its own history with one sentence. Empty folders
are recreated in the pool and removed only when empty from the source. Concurrent target creation is a conflict: the leaf
is kept at `history-pool/.conflicts/<ferret>/<entry>/...` (with a numbered suffix if necessary), never overwritten.
A pre-pool home's `history.jsonl` is kept WHOLE in `.conflicts`, never concatenated with the pool's history.
An unexpected failure after a leaf moves refuses the launch with a clear retry sentence, so it cannot silently start a new
conversation from a half-moved home. A per-entry `.history-pool-pending-<entry>` marker in that home preserves that refusal
across failed retries; a successful retry finishes the remaining leaves, links the entry, and clears the marker.
A pre-pool Codex ferret's own SQLite index is no longer used on its first pooled launch: `CODEX_SQLITE_HOME` selects the
pool's index, which Codex builds from rollouts. A pooled sessions home refuses its launch if the shared SQLite folder cannot be prepared; it never falls back to a stale local database. The v4 migrator likewise omits `fleet/shared/codex/sqlite/` (including its
WAL/SHM files), whose absolute rollout paths still name v4; it never imports that database into the v5 pool.

**What it does not touch.** `credentialHomeLinkVerdict` is unchanged: `linkTo` and `copyTree` link mode still refuse every
link into or out of `agent-homes` and `credentials`, the pool link included. The pool is not a credential's place or source:
`linkCredential` links `<home>/<file>` one level only (so never into a pooled folder) and also refuses, defence in depth,
any place or source at or under the plugin's pool (`poolCredentialVerdict`). A sign-in file, a settings file, an instruction
file, a skill or a plugin folder is never a pooled entry, so a ferret's login, credentials and settings stay its own. The
kernel's own reads and writes never follow a pool link out of the root (`link_escape`); only the harness child does.

**Declared gaps.**

- **The source leaf can change after its check.** The history move uses atomic no-replace rename, so the former
  target-absence look-then-rename gap is closed for this door. A same-user writer can still swap a source leaf or add a
  hard link between its last proof and the move; a post-move identity/link-count proof attempts a no-replace restoration
  on mismatch. Descriptor-held parents prevent a swapped ancestor from redirecting the operation, but the syscall is not
  conditional on the source inode. When a hard-linked target cannot be restored, its pool name is removed only after
  checking it still names that inode with another link; a same-user writer can replace it between this look and unlink.
  Generic `RootHandle.rename` retains its separately declared look-then-rename gap.

- **Same-user reach.** The agent runs as the same user, so a ferret on a harness can read, rewrite or delete any pooled
  transcript, and so can poison what another ferret resumes (a rewritten history is read as that ferret's own past). The
  kernel cannot stop the child that holds the link; the door only guarantees it is a link to the harness's own pool.
- **A link outlives a revocation.** Removing `permissions.historyPool` stops new links only; a link made stays until its
  holder removes it (`unlink`).
- **macOS.** There is no descriptor-relative `symlinkat` in the held-folder steps yet, so on a host with no
  `/proc/self/fd` the door refuses `no_descriptor_reach` rather than link by a path. Pooling on macOS waits for that step.
- **Pool entry swapped by a ferret.** A ferret can replace a pool entry with a link (it writes the pool through its own
  link). The next `linkHistory` for that entry refuses (`link_escape`) and links nothing; a link already made then points at
  the replacement. The kernel does not repair the pool.
- **A race can leave the pool folder.** The pool folder and entry are made after every other check; a name that appears
  in the home in that instant is refused `exists`, and a pool entry replaced after the link is published is refused
  `changed` (its link taken back). In both the pool folder and entry made are left (empty or as found, and owner-only): the
  refusal writes nothing in the home or outside the pool, but "nothing is made" is true of the checks that come first.
- **Pool absent when first made.** When the pool folder (or an entry) does not exist yet, a same-user actor that renames
  a real folder into its name in the instant before the kernel makes it has that folder adopted as the pool (the make
  finds it, opens it without following a link, and uses it), whatever it already holds. This adds nothing the same actor
  could not do with no race at all, by planting the folder before the first link: an existing pool is kept as it is found,
  and a link still only ever names a declared entry. The kernel does not judge an adopted pool's owner, mode or contents.
- **The take-back is by name.** When the proof after publishing fails, the name at the link's place is unlinked through
  the held home folder without re-checking it is still this call's link; it only ever removes one name in that ferret's
  own home.
- **A link made later is not re-proved.** The proof is made when this call makes the link; a pool entry replaced afterwards is
  the "pool entry swapped by a ferret" gap above.
- **The testing host has no identities.** A name in a home that is an alias of a private place (`fenced` in production) is
  `exists` on the testing host, as for `linkCredential`; every other refusal here is mirrored (`history-pool-parity.test.ts`).
- **Fitness test.** `linkHistory` and the new `moveToHistoryPool` extend the `RootHandle` authority surface and are recorded in
  `scripts/gen/tests/fleet-link-callers.snapshot.json` with its guard: the `agent-homes` handle only, the plugin's own pool
  only, and no other root. The move is separately guarded to regular history leaves and atomic no-replace moves into the
  minted pool; it does not relax the generic credential-home link rule. Its snapshot addition was independently reviewed
  against these guards.

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

## A key an import files, create-only (`VaultApi.putNew`)

The setup's import (Runtimes) finds API keys in a machine's own Claude Code and Codex settings and files them in the Vault
as `${secret:NAME}` references. Until r9 the write was refused (`refusing.secrets.put`), so an import that found a key
could not apply. The write it gets is **create-only**, and nothing wider:

- **`vault.putNew(name, value)` answers `stored` or `exists`, never a value.** It checks and writes in ONE turn
  (`SecretDirectory.putNewIdentified`), so a name that arrives between the plan and the write is kept, not overwritten. A
  held name keeps its value, `createdAt`, `updatedAt` and mint record exactly as they were. A store that cannot be read, or
  is full, raises and writes nothing.
- **Handed only to a core caller and to a non-core plugin whose manifest declares `permissions.createSecrets`** (Runtimes).
  Every other needer has no `putNew`. The permission does not widen `put` or `remove`, which stay the names a plugin MINTS
  (`mintedSecrets`); Runtimes declares none, so it can add a key and never replace, remove or read one.
- **The write is recorded as the caller's** in the mint ledger (as any plugin's `put`), with ids and a write nonce, never a
  value. Runtimes declares no `network`, so a name it created is not placeable on any request; an owner's later replacement
  is another write and is not its mint either.
- **Values never come from the app.** The daemon re-reads the host file at APPLY time (the plan is composed again, as for
  every import) and hands the value to `putNew`; the proposal, the route and the screen carry names only. A name already
  held is not overwritten: the planner picks the next free name (`ANTHROPIC_API_KEY_2`) from the Vault's NAME listing (unless the held one is this import's own earlier filing with the same value, below), and
  a race that still lands on a held name is refused in a sentence naming the secret, with nothing changed.
- **A retry reuses what it already filed (`VaultApi.filedSame`).** When an import fails AFTER it filed keys, the keys stay, and the
  retry would otherwise file `NAME_2`, `NAME_3`. The planner instead asks the Vault, per held name in the key's own family
  (`NAME`, `NAME_2`, …), whether it holds exactly the value the host file still has. The comparison is made INSIDE the Vault
  (both sides reduced to a SHA-256 digest and compared in constant time; the digests live for the call, are never returned or
  logged) and the answer is one boolean. It is true only when the entry's current write is this caller's own create-only write
  in the mint ledger, so it is not a way to test a guess at the owner's secret or another plugin's: a name the owner wrote, a
  value the owner replaced since (even with the same text) and a name another plugin filed all answer `false`. A different
  value still gets the next free name. Handed only with `putNew`, to a plugin that declares `permissions.createSecrets`; a store
  that cannot be read raises and the import then files under the next free name. The answer names the keys it reused and the
  keys it filed ("Reused from an earlier import: …", "Filed in the secret store: …"); a reused key is not written again (so a
  retry that needs to file nothing needs no `secrets.configure` either) but is bound to the login's environment like a filed one; the
  keys of accepted updates and a long name (shortened before `_2`) are asked about the same way, by the planner's own naming rule.
- **Who may import keys.** The apply asks the CALLER for `secrets.configure` BEFORE the first write (the route's `fleet.configure`
  does not stand in for it, and a caller with no standing fails closed): a paired device the owner denied the Vault cannot create
  entries by importing. A passkey still to prove is asked at the apply, not at the preview. The refusal names no secret and
  changes nothing.
- **One create per name, and an honest failure.** A key shared by several parts (or by a new part and an accepted update) is
  filed once. If a later create fails, the answer lists exactly the names already added (they stay) and says nothing else was
  changed.
- **The create is in the security log.** Each create-only write leaves a `secrets.changed` record (`detail.action:
import-create`, `detail.plugin`, the secret's NAME as the subject; `refused` when the name was held), so what the import
  added is not only in the generic fleet-apply record. It carries no value, digest or write identity; a log that cannot be
  written does not undo the create.
- **A broken host file reports where, not what.** A scan problem for a settings file that does not parse names the file and,
  for TOML, the line and column. The parser's own message quotes the host's line, which may be a key, so it is never shown.

## A Git account's token (B1: `git-accounts`)

A person connects a GitHub account to the machine with GitHub's **device flow** (Settings › GitHub accounts, or
`fy git account add`): the screen shows a short code, the person types it at `github.com/login/device`, and the daemon
polls GitHub until it is authorized. **There is no client secret anywhere**: the OAuth app's _client id_ (public) is
a constant in the plugin's contract, overridable in `config/git-accounts.yaml` (`github.clientId`; changing it is held
for the owner, because it names a different app to authorize).

**This is a named holder, and it is deliberately NOT the shared secret list.** Every agent can `fy secret use` any shared
secret ("Per-session scoping" above), and a GitHub token is too strong for that. So:

- The token is sealed in the plugin's **own sealed document** (`state/git-accounts/tokens.json`, `0600`, the vault's
  key), a document no route, `use` or `${secret:NAME}` reaches and a ferret's folder never holds (`privacy.private`).
- Only the plugin's **daemon half** opens it, in `AccountBook.token`, and only to place it on a request to
  `api.github.com` or in the environment of the one `gh` child described below (`permissions.network` names `github.com` and `api.github.com`, nothing else). The
  port's `api` call forwards **any REST path** for `GET`, `POST` and `PATCH` and the one `/graphql` endpoint for `POST`
  (`GITHUB_API_RULES`; no `..`, no `//`, a plain query string only); a `DELETE` is refused unless it is
  `/user/keys/<id>` or `/user/ssh_signing_keys/<id>`, so nothing here deletes a repository or a branch. Whoever holds the seam
  acts with the token's scopes on the GitHub API, `repo` among them.
- **No route, CLI verb or port method returns the token**, and no wire shape has a field that could (every shape is strict;
  a contract test reads each against `NO_SECRET_FIELDS`). The GitHub `device_code` is a bearer for the token too, so it
  stays in the daemon: the page gets only OUR flow id and the user code.
- The scopes are one constant (`GITHUB_SCOPES`): `read:user user:email write:public_key write:ssh_signing_key repo read:org`
  (the owner's answer; no `workflow`). **`repo` is strong**: the token can read and write every repository the account
  can reach, private ones included, so the consent text (`GITHUB_CONSENT`) says exactly that before anyone connects.
  That is why the token lives in the sealed document and why nothing can read it.
- **Use, never read, for a child.** Another plugin that needs `gh` as the account calls `GitAccountsApi.run`: the daemon
  half starts `gh` (the one declared program) with `GH_TOKEN` in that child's own, sealed environment and returns its
  output with the token masked. There is no getter. **The token in the child's environment is the design; what that
  child can be asked to do is narrowed to GitHub API work.** Anything that starts `git` or reads or writes a local
  file is out of the seam: ferrets clone and push with `git` and the account's SSH key, never through `gh`.
  - the argv must pass a strict **allow-list of subcommand + flags**, not a deny-list: - `api` (REST or GraphQL on `api.github.com` only; one endpoint) takes only `-X/--method`, `-H/--header`,
    `-f/--raw-field key=value` and `--paginate`. `-F/--field`, `--input`, any argument starting with `@` or
    containing `=@`, and an endpoint that is not an `api.github.com` path are refused; - `pr` (`list view diff checks comment review create edit close reopen merge`), `issue` (`list view create comment edit
close reopen`), `run` (`list view watch cancel rerun`), `workflow` (`list view`), `repo view`, `release`
    (`list view`) and `search` (`repos issues prs code commits`) take no flag that names a file or directory
    (`--body-file`, `-F`, `--notes-file`, `--input`) and no `--hostname`;
  - **`--jq`, `-q`, `-t` and `--template` (`-T`) are refused on every command, in every spelling** (`--jq=x`, `-qx`):
    gh's jq is gojq with the environment loader and Go templates are run by gh itself, so either can print the child's
    environment (`env.GH_TOKEN`, `$ENV`) past the scrub. A caller post-processes the scrubbed `--json` output itself;
  - **a repository is named `OWNER/REPO` or `github.com/OWNER/REPO` and nothing else** (`-R`/`--repo` and any repository
    argument of `repo`; characters `A-Za-z0-9._-`): no `@`, no `:`, no SSH form, no other host. `github.localhost` and
    `*.ghe.com` are refused anywhere in the argv, because gh sends `GH_TOKEN` to them (over plain http for the first); - `--` anywhere, any short-flag cluster (`-dF`, `-iFquery=@f`: a short flag is one letter, on its own), and any argument
    that looks like a local path (`/…`, `~…`, `./…`, `../…`, `…/..`) are refused. The only values exempt from the path rule
    are those of `-H` and `-f` (text, not files), and the `api` endpoint (an API path, checked as one); - everything else is refused because it is not named: `pr checkout`, `issue develop`, `repo clone|create|fork|sync|edit`,
    `release upload|create|download`, `workflow run`, `run download`, `gist`, `extension`, `codespace`, `ssh-key`,
    `gpg-key`, `secret`, `variable`, `auth`, `config`, `alias`, and any command a later `gh` adds;
  - the child runs in an **empty private folder** that is also its `HOME`, `XDG_*` and `GH_CONFIG_DIR` (no host aliases,
    extensions or config), removed after the run, with no prompt, pager, editor, askpass or browser (each is a binary that
    exits 1) and no update check;
  - both streams are scrubbed of the exact token **and** of anything shaped like a GitHub token (`gh[opsur]_…`,
    `github_pat_…`).
- **A provider's answer is sanitized.** A request that carried the token has its reply passed through the Vault's
  outbound-reply check (`@ferretry/core-vault/contract` `echo-mask.ts`, moved there from the Vault daemon so a plugin may use it): only JSON is kept, every string (keys too) is decoded and checked,
  a string holding the bearer in any form is replaced whole, the headers kept are checked the same way, and a reply too
  complex to check is refused, never passed on.
- **The device code lives only while a flow can use it**: it is dropped the moment a flow is done, denied or expired (a
  timer at the expiry, and a check on every read), not at the next start.
- **A connect that cannot write its record leaves nothing behind**: the sealed entry is rolled back (an old token is put
  back), and removing an account also removes a sealed token that has no record.
- Connect and remove are `secrets.configure` (passkey step-up from a paired device) and are audited (`git-account.added`,
  `git-account.removed`: the account id only). The list is `secrets.use` and answers logins and key titles.
- **Removing an account** deletes the keys this machine registered on it through the API (with the token) first, then the
  sealed token, then the record; a key GitHub will not delete is named for the person to remove at
  `github.com/settings/keys`. **Revoking the OAuth app's grant** needs the client secret, which Ferretry deliberately does
  not have, so the person does that at `github.com/settings/applications`; the answer says so.

**GAP.** An agent that can read the daemon's own memory or its state folder as the same OS user can reach the token, as
for every secret here ([threat model](#threat-model)). The sealed document narrows who is _handed_ it; it is not a
sandbox against a process running as the owner.

**GAP — what `gh` can still do with the token.** The `gh` seam is GitHub API work only, and there is **no `git` child that can run a repository's hooks or config** (any `gh` command may start `git`, not only `pr merge --delete-branch`, and it runs in the empty scratch folder with an empty `HOME`: no hooks, no config, no repository; `GIT_CEILING_DIRECTORIES` is that folder's parent, so `git` never looks above the scratch folder for one), so a repository's own hooks or `.git/config` can never run with the token (the old `repo clone` and `pr checkout`
route is gone). What an allowed command can still do is everything the token's scopes allow on the GitHub API: with `repo`
that is reading and writing every repository the account can reach (opening, merging or closing pull requests, commenting,
creating or editing issues, re-running workflows) and, through `api`, any REST or GraphQL call. The scrub catches the token
only where it is printed back exactly or in a GitHub token's usual shape, not an encoded or split copy. Use an account only
with agents and projects you would trust with those scopes.

## A Git account's SSH key (B3: `git-accounts`)

Each connected account can have **one SSH key that Ferretry makes**, registered on GitHub as an _authentication_ key
(push and pull over SSH), a _signing_ key (signed commits), or both: one key, two registrations. A ferret may **use** it
and can never **read** it.

- **Made in the daemon.** `node:crypto` makes an ed25519 key pair; the private half is written as an unencrypted
  `openssh-key-v1` file and **sealed** in the plugin's own document `state/git-accounts/keys.json` (`0600`, the vault's
  key; one entry per account id). It is listed under the plugin's `privacy.private`, so no root reaches it, and it is no
  more a `fy secret` than the token is: `use` and `${secret:}` never touch it.
- **Only the public half leaves.** The key is registered by `POST /user/keys` and `POST /user/ssh_signing_keys`
  (titled `Ferretry <machine name>`) through the account's API seam. Every answer, the account list and the audit line
  (`git-account.key-added` / `git-account.key-removed`: the account id) hold the public key, its fingerprint and which
  registrations exist. A request body is never quoted back, because a person may have pasted a private key into it.
- **Used through an ssh-agent, one per account.** The daemon starts `ssh-agent -D -a <socket>` on the first ask for an
  account's socket (`GitAccountsApi.agentSocket`; the launch of a ferret that needs it asks), then feeds the key with
  `ssh-add -` **on stdin**. The key is never an argument, an environment variable or a file; the children run
  `sealed` (only the nine inherited names plus `SSH_AUTH_SOCK`). The sockets, the pinned `known_hosts` and the public key
  files live in one private folder at a **stable path**: the plugin's own kernel-made `downloads` folder
  (`<home>/state/git-accounts/downloads`, checked private before each use and refused if its path is too long for a
  unix socket, about 104 bytes). The same path on every run is the point: a ferret started before a daemon restart or
  update keeps `SSH_AUTH_SOCK` and `UserKnownHostsFile` in its environment, and they must still mean the same thing.
  The socket is `<account id>.sock`, `0600`; a stale file left by an agent that died unclean is removed before the
  next binds, and an agent that is still stopping is waited for first (it removes its own socket path as it exits). At
  boot the daemon brings back the agent of every account that has a key Ferretry made, so a surviving ferret finds its
  socket where it left it. The wait for an agent to listen is bounded to about five seconds. An agent stops when the
  account is removed, when its last registration is removed, and when the daemon stops.
- **A key the person already has** (`POST …/keys` with a `publicKey`): GitHub must list that exact key on the account;
  Ferretry records the public key, asks for no private half, and never deletes it from GitHub. `agentSocket` answers
  `undefined`, so the host's own `SSH_AUTH_SOCK` is used. A private key is never imported from `~/.ssh`.
- **Pinned host keys.** `known_hosts` for `github.com` is compiled from GitHub's published keys
  (`contract/known-hosts.ts`, with the update path in its header and a test that compares them with GitHub's published
  SHA256 fingerprints); `GitAccountsApi.knownHostsFile` writes it beside the sockets (and it stays there across a restart).
  Use it with `StrictHostKeyChecking=yes`.
- **Removing** a registration deletes it at GitHub first (a refusal keeps it recorded, so it can be retried); removing
  the last one, or the account, stops the agent and deletes the sealed private key.
- Add and remove are `secrets.configure` from a person (passkey step-up from a paired device).

**GAP — use is real.** Any process that can open an account's agent socket (every process of a ferret that was given it,
and any other process of the same OS user) can push and sign as that account while the agent runs, and a GitHub SSH key
opens every repository the account can reach, not one. That is the point of "use". It cannot extract the key through the
socket, but a process running as the owner that can read the daemon's memory or its state folder can reach the sealed
key, as for every secret here ([threat model](#threat-model)).

**An unclean daemon death, and the boot sweep.** The agent is a child of the daemon. After a `SIGKILL` nothing stops it: it
keeps the key in its memory, behind a `0600` socket in a `0700` folder of this user. The next boot ends it, before any new
agent starts: it lists the machine's processes once and sends `SIGTERM`, by pid, to each process that is **all of**
`ssh-agent -D -a <this plugin's own folder>/gha_<digits>.sock` (the exact command line the daemon starts, in its own
folder, so another install's agents, the person's login agent and any other `ssh-agent` have other paths), owned by the
daemon's own uid, and not the daemon itself; it waits for each to exit, then removes its socket. A list that cannot be
read ends the sweep with a warning (nothing is guessed). **The process table is never read through a program found on
`PATH`.** A `ps` planted earlier on the daemon's `PATH` (a shim folder, another install's shims) could name any same-user pid
as "ours" and have it signalled. On Linux the sweep reads `/proc/<pid>/cmdline` and `/proc/<pid>/status` directly and runs
nothing; elsewhere (macOS) it runs only the absolute system `ps` (`/bin/ps`, then `/usr/bin/ps`), sealed, and with neither
present the sweep does nothing. The pid is **read again just before the signal** and is signalled only while its command line
is still word for word the same and its owner is still this uid. **GAP — pid reuse:** between that second read and the
`SIGTERM` there is still a window of microseconds in which an exited agent's pid could be handed to another process of the
same user; the re-check shrinks it from "however long the listing took" to that instant and cannot close it (a signal by
pid has no handle to hold). **GAP:** the sweep cannot tell a leftover from the live agent of a
second daemon sharing the same state home, which cannot work anyway (one socket per account); and a power loss takes the
agents with the machine. **`ssh-agent` and `ssh-add` are found like `gh`** (below): the `PATH` folders inside the state home
are dropped, the kernel resolves the name in what is left, an answer still inside the state home is refused, and the
program is run by that absolute path. `ssh-add -` receives the account's PRIVATE KEY on stdin, so a planted `ssh-add` would
read it; with no trusted `ssh-agent` or `ssh-add` found no agent starts, the key is sent nowhere and the ask answers 503. A clean stop ends every agent; the folder stays (a surviving ferret's paths must keep their meaning), holding no key.

**GAP — a predictable socket name.** The socket is `<state>/git-accounts/downloads/gha_<id>.sock`: any process of the
same OS user can connect to it (the folder is `0700` and the socket `0600`, so no other user can). That is "use", above.

**GAP — SAML single sign-on.** An organisation that enforces SSO needs the key authorised once on GitHub before a push
to its repositories works; Ferretry cannot do that for the person.

## A Git account's GPG signing key (G8: `git-accounts`)

An account can sign its commits with **a GPG key instead of an SSH one** (an account signs with exactly one key; GitHub's
"Verified" badge accepts either). `POST /v1/git-accounts/:id/keys` takes `{purpose: "signing", format: "gpg"}` (Ferretry makes
an ed25519 key) or adds `keyBlock` (an armored OpenPGP secret key the person hands over, one key, no passphrase). The answer is
`{format, publicKey, fingerprint, registered, source}`: the PUBLIC armored block, never the secret one. `DELETE
…/keys/signing` stops local signing first and then removes its registration at GitHub (`DELETE /user/gpg_keys/<id>`).
The Git accounts page offers **SSH or GPG** before consent, and offers creating or changing the connected account's signing
key. SSH consent asks for no GPG permission. GPG consent adds `admin:gpg_key`, because GitHub requires that scope to delete
a GPG key (a write-only token can only add one). The consent says this permits managing all GPG keys on the account;
Ferretry only deletes its own registrations. An SSH-only connection must reconnect with GPG consent to create a GPG key.

- **No key at rest outside the sealed vault.** The private packets are generated, imported and used by OpenPGP.js in daemon
  memory. The only persistent private copy is ciphertext in `keys.json`, under `<account id>:gpg`, with the same vault
  boundary as SSH. No unsealed private key is written anywhere, including during generation or import. No route, port,
  log, audit row or environment variable carries it. A refused request never quotes the pasted key. The vault's existing
  same-user limitation still applies: someone who can read both its ciphertext and its encryption key can decrypt it.
- **An account socket and a public-only keyring.** A launch receives `gpg.format=openpgp`, `gpg.program` pointing to a tiny
  signing shim, `user.signingkey` (the public fingerprint), `commit.gpgsign` and `tag.gpgsign`. The shim forwards Git's
  payload over `<state>/git-accounts/downloads/gha_<id>.gpg.sock` to the in-memory signer and returns only its detached
  signature and Git's status line. The socket lives in the same private `0700` parent as SSH's sockets. It exposes signing,
  never export, and bounds request bytes, time and concurrency. A same-user caller who can open it can ask it to sign,
  just as with SSH; it is not a per-process sandbox. `GNUPGHOME` names `gha_<id>.gpg-public`, which contains public keys only;
  `git verify-commit` delegates to the real GnuPG with that keyring. GnuPG never imports a private key or starts a private
  key agent. The person's keyring is not used.
- **The key's user id is the account's noreply address** (`<id>+<login>@users.noreply.github.com`, which is also `user.email`):
  that is how GitHub decides a commit is Verified. A key handed over that lacks the address gains it before it is registered.
  A key that needs a passphrase, or cannot sign, is refused in words and nothing is registered or kept.
- **`gpg` and `curl` are found like `ssh-add`**: real programs outside the state home, by absolute path; without them the
  signer refuses to start. GnuPG sees public packets, curl sees signing payloads and signatures. A key already on the
  account at GitHub is recorded without its GitHub id, so
  removing it here never deletes what was not ours.
- A recorded key that cannot be served at launch switches signing off for that ferret and says so, never falling back to the
  machine's own signing key (the same rule as the SSH key).

- **Revocation survives failure and restart.** The account records removal intent before deleting its sealed entry; startup
  refuses to reload a key marked for removal. Remote failures retain the public registration id for retry, and public-file
  cleanup failures are reported. Disconnect stops local capability before contacting GitHub and names remote keys the owner
  must remove manually when remote cleanup fails. Connect, create, format selection, launch and disconnect share one account
  lock; an SSH-only reconnect cannot replace the GPG grant while its key still needs revocation. An upload is preceded by a
  non-signing registration intent: a final-record failure rolls back its known remote id, or retains that id for cleanup.
  An upload with an unknown outcome is never deleted by fingerprint alone: the app asks the owner to check the key on
  GitHub and establish ownership first. Disconnect lists those public fingerprints separately from confirmed keys that
  need removal; an uncertain upload title is never an instruction to delete a key.
  The narrowed `gh` seam refuses account-key endpoints and raw GraphQL mutations; ferrets cannot use the admin scope to
  delete other account keys. A clean daemon stop closes the sockets, drops the memory keys and removes public signer files.

The earlier GNUPGHOME design was never merged or installed; no migration needed.

## A ferret pushes and signs as the Git account its project is linked to (B4: `git-accounts`)

A ferret whose work folder is inside a project linked to a Git account (Projects keeps the link) is started with that
account's **agent socket and git settings**, and only then. One resolver decides which account
(`git-accounts/daemon/lib/account-for-folder.ts`): the folder's project, then the repository the folder is in and that
repository's own account, else the project's first account. A link to an account that no longer exists gives **nothing**
(never another account). A folder outside every project, or an account with no key Ferretry made, changes nothing.

- **What the pane gets** (a `pane-env` launch part, `core/ferrets`' seam; plain names and paths, never a value read
  from anywhere): `SSH_AUTH_SOCK`, and `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` for `user.name`,
  `user.email` (`<id>+<login>@users.noreply.github.com`, an address GitHub counts as verified), and, for what is
  registered: `gpg.format=ssh`, `user.signingkey=<public key file>`, `commit.gpgsign`, `tag.gpgsign`, and
  `core.sshCommand=ssh -F none -o IdentitiesOnly=yes -o IdentityFile=<public key file> -o IdentityAgent=<socket> -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<pinned> -o GlobalKnownHostsFile=none`
  with `url.git@github.com:.insteadOf=https://github.com/`. `-F none` means the person's `~/.ssh/config` (a
  `ProxyCommand`, an `IdentityFile`, `ForwardAgent`, a host alias) is never read, and `IdentitiesOnly` with that one
  public `IdentityFile` offers exactly this account's key from the agent and no key from the host.
- **No secret is in the environment.** The socket path and the public key file are not secrets; the agent signs and
  authenticates and cannot hand the key over. A `pane-env` part may not name `PATH`, `HOME`, a harness home, any
  `FY_*`, `GH_TOKEN`, `GITHUB_TOKEN` or `GH_ENTERPRISE_TOKEN`, nor carry a `${secret…}` value; the launch is refused
  naming the plugin and the variable.
- **Signing shows "Verified"** because the key is registered as a GitHub _signing_ key and the committer address is the
  account's noreply address; a test proves the rule against a fake GitHub with real `git` and `ssh-keygen`
  (`unsigned`, `unknown_key`, `bad_email` are the failures). The real GitHub is owner step 5.

**GAP — a process of that ferret can push and sign as the account while it runs.** That is "use". Every ferret that
shares the project is given the same account's socket, and the key opens every repository the account can reach.

**GAP — unlinking a project does not cut a running ferret.** The agent socket is at a stable path on purpose (a ferret
that outlives a daemon restart must keep its `SSH_AUTH_SOCK`), so removing a project's link to the account does not stop
a ferret that already holds the socket: it can push and sign until it ends or the agent stops. Linking the account
again hands the same socket to older ferrets too. The socket is not rotated. What DOES cut it: removing the account's
**last** key registration (the agent is stopped and the private key forgotten) or removing the account itself.

**A key that cannot be started is said in the pane, and the pane is given no identity.** When the account has a key
Ferretry made (a push key or a signing-only one) but its agent cannot be served for a launch (the agent fails to start,
or the recorded key's sealed entry is gone), the ferret still starts, with one instruction sentence that its Git account
key is unavailable; no error text is put in it. The pane's environment is then given the no-identity ssh command (no
agent, no default key file, no password) as `GIT_SSH_COMMAND` AND as `core.sshCommand`, and `https://github.com/` is
rewritten to ssh so a host credential helper is not used; signing is switched off: every Git setting that makes Git
sign by default (`commit.gpgsign`, `tag.gpgsign`, `tag.forceSignAnnotated` and `push.gpgSign`, the four git-config(1)
names that do so) is `false`, as settings and as the END of `GIT_CONFIG_PARAMETERS`, which Ferrets appends to a login's
own value and Git applies last, so a login's parameters cannot keep any of them on. Git reads `GIT_SSH_COMMAND` before
`core.sshCommand` before `GIT_SSH`, and the part is merged AFTER the login's environment, so a login's own
`GIT_SSH_COMMAND` or `GIT_SSH` does not win. A `git push` run with that environment over ssh therefore fails
instead of succeeding as this machine's own ssh identity. What this is not: it is the environment the pane is _given_,
not a sandbox. A process of the ferret can set its own environment or pass its own `git -c` or `ssh` options, and
an ssh agent socket a login set stays in the environment (ignored by `IdentityAgent=none`, not removed). A slot that
holds the person's OWN key is not blocked: it was never Ferretry's. An account with no key Ferretry made (none, or the
person's own) is launched exactly as before and gets no sentence. Only the unavailable-key case changes the
environment; a served key is unchanged, so a login's own `GIT_SSH_COMMAND` can still outrank the account's
`core.sshCommand` there (a declared GAP).

**GAP — the folder is judged by its spelling.** The resolver compares paths as written; a folder reached through a link
is not matched to a project registered under the link's target.

**GAP — the host's own key.** An account whose key the person already had is not given to a ferret at all (the host's
agent is not inherited by a pane); such a ferret pushes with no key.

## Ferretry's `gh`: the connected account, used never read (B9: `git-accounts`)

A ferret's `gh` is a shim (B10, below) that asks the daemon to run the real `gh`. B9 is the daemon half:
`POST /v1/git-accounts/gh/run` `{argv, cwd, account?}` answers `{exitCode, stdout, stderr}` (both streams masked) or
`{refused: "<one sentence>"}`. The daemon starts `gh` with the account's token in **that child's** environment only, in
an empty private folder, with an empty `gh` config, through `GitAccountsApi.run` (the seam described under "A Git
account's token"). The token is never in the ferret's environment, never in a response, a log or the audit.

**Which account, which repository.**

- The account is B4's one resolver (`accountForFolder`) on the `cwd`: folder → project → the repository's own account →
  the project's first account. Outside a project linked to an account the call is refused with "This folder is in no
  project linked to a GitHub account… Link one on the project page." **The host's own `gh` is never a fallback.**
- **A ferret may only name its own folder (or one below it)**, checked against the folder Ferrets recorded for that
  ferret (its real path), so it cannot pick a neighbouring project's account by naming that path (but see the GAP below on a broad folder). The account is also resolved from the ferret's OWN folder, and a `cwd` that resolves to a different project or account (a project nested below the ferret's folder) is refused, so a nested project cannot lend a ferret another account. A ferret may not
  pass `account`; the owner's own shell may (by login or id).
- **The repository is the project's record** (`repos[].remote`, written by Projects' scan, `github.com` only), passed as
  `-R OWNER/NAME` unless the argv already names one, and filled into a `gh api` endpoint's `{owner}`/`{repo}`. **No file
  in an agent's folder is opened**: not `.git/config`, not `.git/HEAD`. So a repository's own git config (`core.fsmonitor`,
  `core.sshCommand`, filters) and hooks can never run with the token, and a remote an agent edited changes nothing. A
  consequence: `gh pr create` needs `--head <branch>` (the client fills it), and a folder the project has not scanned
  needs `-R`.

**The policy** (`gh-policy.ts`, pure) is an allow-list of commands and subcommands in front of the seam, and it says what
to do instead:

| Form                                                                                                                                                                      | Answer points to                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `auth` (anything but `auth status`), `auth status -t/--show-token`                                                                                                        | "Ferretry's gh never shows its token"                                |
| `auth status`                                                                                                                                                             | answered by the daemon from the account record; no run               |
| `config` (any)                                                                                                                                                            | nothing to configure                                                 |
| `extension`/`ext`, `alias`, `codespace`/`cs`, an unknown top-level name                                                                                                   | not available                                                        |
| `pr checkout`/`co`, `repo clone`/`sync`, `repo fork --clone`, `repo create --source/--push`, `gist clone`, `issue develop --checkout`, `run download`, `release download` | "use git: `git fetch origin pull/12/head:pr-12 && git switch pr-12`" |
| `--hostname` (any)                                                                                                                                                        | github.com only                                                      |
| `--body-file`, `-F`, `--notes-file`, `--input`                                                                                                                            | pass the text itself                                                 |
| `--jq`/`-q`, `--template`/`-T` (they can read the environment)                                                                                                            | filter `--json` yourself                                             |
| `pr create` without `--head`, or with `--fill`                                                                                                                            | give `--head`, `--title`, `--body`                                   |

**The seam stays the authority.** `GitAccountsApi.run` (B1) has its own, narrower allow-list, reviewed on its own, and
every call that passes here must pass there too, so **the effective surface is the intersection**. Its sentence is passed
on when it refuses. B9 widens nothing under it; widening it needs a lead decision and a security review of its own.

Bounds: 120 s per run (a followed run, `run watch` or `pr checks --watch`, the seam's 300 s ceiling); at most 4 runs at
once per ferret; **4 MiB per stream, enforced where the output is read**: the seam runs `gh` through the kernel's
capped reader (`spawn.runBytes`, 4 MiB each for stdout and stderr), so a huge `run view --log`, `pr diff` or
`api --paginate` never sits whole in the daemon's memory. A stream that was cut ends with `[output cut]`, and the scrub
runs on the kept text AND drops any tail that could be the start of a token (the account's own, or a `gh?_…` /
`github_pat_…` shape the cut left too short to match), so a token split at the cut never reaches the caller. Governance: a ferret on its own session credential, or a paired device with
`secrets.use`. **Audit** `git-account.gh.run` (also for a refusal): the account id, the command as two plain words, the
repository, the exit code and the ferret id; no other argument, no body.
Each paired device has its own allowance of four concurrent runs, shared by its sessions. A ferret has its own four,
and the owner's CLI has a separate four, so one busy device cannot use up another caller's allowance.

**What it protects against:** a ferret printing, copying or keeping the token (`gh auth token`, `gh auth status -t`,
`gh config get oauth_token`, `hosts.yml`: the child's config folder is empty and removed); a token in a transcript; the
host's own `gh` sign-in being used by ferrets; a repository's own git config or hooks running with the token.

**What it does NOT protect against:**

- **Use.** Any ferret in a linked project can do whatever the `repo` scope allows through the commands that pass both
  lists, as the person: read every private repository, comment, merge, close, re-run. That is the feature. A
  prompt-injected ferret can use it the same way.
- **A child can still see its own environment.** The `gh` child holds the token, and so does anything `gh` starts. The
  known ways are closed (no extensions, aliases, editor, browser or pager; no `git` in the agent's folder; the daemon's
  `PATH`), but `gh` is a large program and a new flag on an allowed command is not checked here.
- **An agent reading the state home.** Like every holder here: a ferret's own shell runs as the same user.
- **GAP: the scope is the whole account.** OAuth apps cannot narrow `repo` to some repositories. So `-R OWNER/NAME`, and
  a `gh api repos/x/y/…` endpoint, reach **any repository the account can see**, not only the project's: the project's
  repository is only the default, never a fence.
- **GAP: a folder decides the account, and a ferret's folder can be broad.** A ferret may name only its own work folder
  or one below it, and `gh` runs as the account of the ferret's **own** work folder (the first account the resolver
  finds for it), the same as B4's SSH. A ferret whose work folder is a **parent of several projects** cannot select a
  nested project's account by naming that project's folder: when the named folder resolves to a different project or
  account than its own folder does, the run is refused. A child ferret **started in another project's folder** still
  gets that project's account for its own folder. Ferretry does not claim a ferret cannot use another project's
  account: it claims a ferret cannot pick one by naming a path other than its own work folder's.

**GAP — what the plan wanted and the seam still refuses.** No stdin and no file slots (`--body-file`, `-F`, `--input`,
`release upload`, `gist create` from files); no `repo create|edit|fork`, `secret`, `variable`, `label`, `cache`, `ruleset`,
`gist`, `project`, `org`, `browse`, `status`, `pr ready|status`, `workflow run|enable|disable`, `release create|edit|delete`,
`issue delete|lock|pin|transfer|develop`, `--jq`: they pass the policy above and are then refused by the seam with its
sentence. Followed runs are capped at the seam's 5 minutes, not 15. The repository comes from the last scan, so a folder
whose remote changed since reads the old one until Projects rescans.

## The `gh` on every ferret's `PATH` (B10: `git-accounts`)

B9 is the daemon half of Ferretry's `gh`; B10 is what makes a ferret reach it. **Every** ferret is started (in a linked
project or not, so the host's `gh` is ignored everywhere) with:

- **A shim first on its `PATH`.** `<state>/git-accounts/agent-homes/gh/shims/gh` (`0755`, in the plugin's own private
  folder; repaired at every daemon boot and before each ferret launch) executes the canonical installed client,
  followed by `gh -- "$@"`. System clients and every canonical ancestor must be root-owned
  and not writable by the daemon's user (ACLs included). The product client beside the running daemon's canonical
  executable is also trusted, supporting the installer's user-owned `~/.local/bin`; it is bound to its file identity.
  The real `gh` and its `git` dependency have the separate fixed package-manager exceptions described below.
  Group/world write is refused except on root-owned sticky
  directories such as the multi-user Nix store: those protect root-owned entries and must still be unwritable by
  the pane user. The canonical basename must retain the client name: a planted client-name link to a system shell
  or interpreter is refused too. An executable planted in a worktree, downloads, a state
  folder or `/tmp` is refused unless it is the running daemon's own install. A preview pane need not find that client on its own PATH. `fy gh` sends the argument list and the folder to
  `POST /v1/git-accounts/gh/run` on the ferret's own credential and prints the masked answer with `gh`'s exit code. It
  has **no policy of its own**: the daemon (B9, then the seam under it) decides, so nothing here can widen what runs.
  Outside a project linked to an account the shim answers with B9's sentence and starts nothing.
- **An empty `GH_CONFIG_DIR`** (`…/agent-homes/gh/pane-gh-config`: no file in it, mode `0500`, emptied again at every launch), so a
  _real_ `gh` reached by accident (a shell rc that rewrites `PATH`) finds no sign-in and has nowhere to save one, instead
  of reading the host's `~/.config/gh`.
- **It fails closed for linked projects.** Discovery or repair failure refuses a linked pane launch with **GitHub client unavailable**. This
  also covers an old shim already on the inherited PATH. An unlinked project launches normally without adding a shim.
  Each invocation checks the canonical client's device,
  inode, size, modification time, change time, owner and mode using an absolute, trusted system `stat` before exec;
  a mismatch, a missing client or a symlink replacement refuses with the same sentence and executes no client.
  The shim and config have separate exact managed directory scopes. Publication cannot follow a link into a sibling;
  **Known gap — cleanup races:** config cleanup validates a directory, lists it, and removes its entries with separate
  path resolution. It does not hold that directory's identity through removal; a same-user swap between validation and
  removal can redirect cleanup. On macOS `setMode` also has a path-based fallback. Closing these races requires the
  shared kernel identity-bound removal work (K1); the separate managed scopes alone do not close them.
- **One instruction**: `gh` here is Ferretry's; it acts as the linked account; it refuses `auth`, `config`, extensions,
  aliases, codespaces and commands that check out or clone; use `git`.

**The pane never holds a token.** The part sets no `GH_TOKEN`, `GITHUB_TOKEN` or `GH_ENTERPRISE_TOKEN`, and the launch
refuses any `pane-env` part that names one (or `PATH`, `HOME`, a harness home, any `FY_*`, a `${secret…}` value). The
only way a part changes `PATH` is `pathPrepend`: absolute folders put first, then the `PATH` the pane already has (its
login's or a shell part's, so a devshell's tools stay), else the daemon's own `PATH` (the system folders when it has none). A relative folder, a `:`, a control character or a `..` step refuses the launch naming the
plugin.

`fy gh` also names the ferret's branch for `gh pr create`: it reads `.git/HEAD` as _text_ from the ferret's own folder
(it runs as the ferret) and adds `--head <branch>`. In a linked **worktree** `.git` is a file; its `gitdir:` line is read
as text and the `HEAD` there is the worktree's own branch (never the main checkout's). Each of those files is `lstat`ed
first and read only when it is a regular file (a symbolic link counts when it points at one): opening a FIFO named
`.git/HEAD` would block the verb for good, so such a name adds nothing and the argv goes on unchanged. **GAP — `lstat` then
open:** the ferret can swap the file for a FIFO between the `lstat` and the `open`, and that one `fy gh` then blocks. It
is a self-denial of service (the ferret hangs its own verb, which runs as the ferret; the daemon and every other caller are
unaffected, and no data is read from anywhere the ferret could not already read), so it is declared rather than closed.
The daemon never opens a file in an agent's folder.

`fy gh` sends the daemon `gh`'s argv alone: its own `--account <login>` and the outer `--` are removed, and everything
after the first `--` is passed byte for byte. It waits for the daemon's own budget (5 minutes for a followed
`pr checks --watch`, plus a margin), not the CLI's default 60 s.

**Which `gh` gets a token.** The daemon never starts `gh` by bare name. Both `gh` and `git` are selected in fixed order:
`/opt/homebrew/bin`, `/usr/local/bin`, `/home/linuxbrew/.linuxbrew/bin`, the owner's `~/.nix-profile/bin`,
`/nix/var/nix/profiles/default/bin`, `/run/current-system/sw/bin`, sorted canonical Nix-store bin directories, then
`/usr/bin` and `/bin`. Arbitrary pane/daemon PATH entries do not enter that list. Canonical Homebrew/Linuxbrew targets
must stay in the fixed prefix's bin or the matching gh/git Cellar package; Nix profile links must resolve into the store.
Those package-manager installs may be user-owned. System installs otherwise require a root-owned, non-writable chain.
Links into worktrees, downloads, state, temporary or arbitrary project folders are refused. Immediately before exec it rechecks both programs'
device, inode, size, nanosecond modification/change times, owner, mode and
the canonical installation location (and the non-writable chain for ordinary system installs); a mismatch refuses
without starting a credential-bearing child. The reason: a ferret pane's `PATH` starts with the shim folder, a file the
ferret can rewrite, and `fy daemon start|restart|update` run from a pane would write that `PATH` into the service unit.
The CLI therefore also drops every state-home folder from the `PATH` it writes into the unit, plist or direct-start
environment. The `gh` child gets only the canonical bound `git` and `gh` directories, then `/usr/bin:/bin` (deduplicated).
The bound git directory comes first so a different git beside gh cannot shadow it. This supports separate Nix-store
packages and user-owned Homebrew locations without inheriting pane/profile directories. User-owned programs outside the
fixed package-manager locations are refused. The service-unit filtering and execution-time binding cover different starts.

**`fy gh-doctor`** (run in a pane) warns when `command -v gh` is not the shim (the first `gh` on `PATH` is somewhere
else: a shell rc moved `PATH`), when the pane was not started with the shim, or when a GitHub token variable is set in
the pane. It prints the variable's NAME and never a value.

**What it does NOT protect against:**

- **A ferret can run the real `gh` by absolute path** (or after rewriting `PATH`). It then has no sign-in (empty config)
  and no token, so it can do nothing as the account; it can still use the _host's_ `gh` sign-in if the host's `gh` reads
  a token from somewhere Ferretry does not set (`GH_TOKEN` exported by a login or a shell rc). Ferretry cannot stop a
  process of the same user from reading the user's own files; `fy gh-doctor` says when it happens.
- **GAP: no stdin and no files.** `fy gh` sends the argument list and the folder only. B9's seam refuses every flag that
  reads a local file, so there is nothing to send them to (`--body-file`, `-F`, `--input`, `-` for stdin): pass the text
  itself.
- **The client must be discoverable in a trusted install.** Discovery runs no client and excludes
  state-home folders. The installed client is pinned to its real path and rechecked before exec. A missing or
  untrusted client refuses linked launches; the next launch tries again. **GAP:** the shim itself remains a same-user file,
  so editing the shim after launch can affect already-running panes until the next launch or restart. Identity
  checks are a pre-exec check, not an open-descriptor exec; the root-owned, non-writable canonical chain prevents a
  pane from swapping a system client in that interval. The product's own install and the fixed package-manager
  exceptions may be user-writable: same-user edits before binding are trusted at those explicit install locations,
  and a same-user process can race the pre-exec check. These exceptions are identity-bound, not a filesystem sandbox.
  A privileged installer can still change a system client in that interval.
  System `stat` timestamps are second-resolution in this fingerprint. Same-user filesystem writes are not a sandbox.
- **GAP: the harness's own shell tool.** Whether Claude Code's and Codex's shell tools keep the shim first after they
  read the person's shell rc is **not measured here** (it needs a real signed-in harness; a test daemon refuses to start
  one). `fy gh-doctor` is the pane-side check, and the first real-machine check is owner step 5/6.
