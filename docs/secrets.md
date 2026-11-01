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
- **An agent writing the store.** Every ferret holds the host admin token, but the daemon tells a ferret
  (`peer:`, a warden) from the owner's own `fy` and from a paired device, and **refuses a ferret the
  routes that change the store**, before it reads a body: `POST /v1/secrets` (set or replace),
  `DELETE /v1/secrets/:name`, the saved-login writes (`PUT`, rename, `DELETE` under
  `/v1/secrets/logins`), opening or filing a copy-in (`POST /v1/secrets/imports[/:importId]`) and
  sealing values out (`POST /v1/secrets/exports/:importId`). So a confused or prompt-injected agent cannot
  swap `GITHUB_TOKEN` for a value it controls, or delete it. It can still list names and **use** a secret
  by name. A ferret gets a value into the store the way it gets any secret from the owner: an input
  request (the owner sees a card and types it) or a sealed copy pasted into the store ([secure
  copy](secure-copy.md)); both show the owner a card. The owner's `fy secret set` in a normal shell and
  the app's write-only form keep working. This is an honest-client guard (`isHumanAdminActor`): it holds
  against an honest or confused client, not one that forges its own identity header.
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
  change). It reads who is asking from the session id that `fy` sends from inside a ferret. An agent holds
  the same admin token, so it can send raw HTTP without that header and look like the owner's shell. The
  real limit is the one this whole section states: **agents run as the same user, with the admin token.**
  Such an agent can also read `secrets.json` and `secrets.key` straight off the disk. The guard stops a
  confused or prompt-injected agent from using the obvious route; it does not stop one that is working
  around it. A per-session credential would, and is not built.
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
paired device needs the passkey step-up for loosening a configuration file, and the line is in effect at once (it is refused with `409 no_sign_in_here` for an account with no sign-in on that key). The card does not read the file until R1-5. The
account acts keep the lines true in the same act: a rename moves them, a delete drops them, a merge points them at the
account that kept the sign-ins, and a handle that is created (or renamed to) never inherits a line left for an old
account of the same name. If that rewrite fails the account act stands and the leftover line, which names no account,
is ignored with a warning on `GET /v1/config/status`. _RF-2: this route becomes `caller: 'person'`._

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

**Not advertised yet.** The card is sign-in aware on the daemon's side ([one tap](input-requests.md#the-next-time-one-tap)):
its offers name the sign-in, and a deliver's `signIn` must be one of the account's. The daemon still does not
report `accounts.signins.1`, because the app ships first: until the Accounts screen lands, an app keeps today's
surface.

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
  (`409 not_this_cards_account`), so a ferret cannot steer which account a card's key lands on.
- **At most 4 seeds wait at once on the whole daemon, 2 per caller, and callers that are not a paired device share
  only 3** (`429`), so nobody fills its memory by staging and a ferret holding junk stages never keeps the owner's
  app from staging. **Only the caller that staged a seed, or a paired device, may read, drop or card it** (another
  caller is told it is not waiting): the stage id is on the agenda card, so knowing it proves nothing.
  **Until ferrets have their own credentials (RF-2/RF-3), "caller" is honest-client:** a ferret that uses the admin
  token without its session header counts as the SAME caller as your own shell's `fy` (`admin-cli`), so it can use up
  or drop the stages `fy` made — never save a seed (that still takes your passkey). A paired device always keeps its
  own slot, so the app can always stage.
- **The old seed path is refused in the store itself** (`applySeed`), not only at its route: no caller, now or later,
  writes a seed except through the passkey-bound save.
- **Write-only.** No route, command, log, agenda item or push answers a seed or a code made from it. After the save
  the owner sees "Automatic codes: on".
- **Removing a key never asks for a passkey**: it only narrows what this machine can do. Its seed is swept with it.

**From the command line**, `fy account factor add <ACCOUNT> --totp` shows the warning, takes the key at a hidden
prompt (a base32 key or an `otpauth://totp` link), stages it and puts a card on the agenda — "Save automatic codes to
GitHub · kirinnee? Asked by `fy` on kirin-box at 14:02 UTC" — then waits. Allow it in the app with your passkey and it
prints "Saved"; Deny, or two minutes, and nothing is saved. `--session <id>` names the board for the card (the
current session's by default). The CLI has no way to save a seed itself. **The old path is closed:**
`PUT /v1/secrets/logins/:id` with a `totp` seed — today's app form and `fy account edit --totp` — answers
`403 add_2fa_key_needs_passkey` with where to go instead; `totp: null` (remove the seed) still works there.

The card is answered by its Allow (the passkey ceremony, then the commit) or Deny (drop the stage). An agenda answer
saves nothing, so an app from before these cards shows the daemon's words and cannot save. **The app's half — the
"Set up automatic codes" panel and the Allow on this card — ships in the next release (R2-5); until then a seed
cannot be saved at all**, and the ones already saved keep working.

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
