# Secrets

A daemon-scoped store for credentials, and a way for an agent to **use** one without ever holding
it.

Read the [threat model](#threat-model) before you trust it with anything. The useful property here
is real, and it is narrower than people assume.

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

## Redaction

Because the daemon knows the values, it removes them from text before that text is stored or
rendered:

- the output of a `use` child, on both stdout and stderr;
- an operator read of a session's **screen**, its **transcript**, and its **journal**.

So `fy secret use --with TOKEN -- sh -c 'echo $TOKEN'` returns `[redacted:TOKEN]`. The child really
did hold the value; what came back is a mask.

A vault the daemon cannot open **refuses** those reads rather than serving unscrubbed text. Text it
cannot scrub is text it must not serve.

## Threat model

### What this protects against

- **Secrets in transcripts and history.** An agent writes `${secret:NAME}` or `--with NAME`; the
  value is never in its conversation. If a tool prints one anyway, redaction masks it.
- **A value read off a screen.** The PWA never receives one. Write-only in, masked forever after.
- **A secret in a configuration file, or copied along with one.** `config/daemon.json`, a fleet
  document and any copied configuration hold a **reference**, never a value.
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

## Damaged is not empty

A vault whose document will not parse, or whose key has gone while ciphertext remains, reports
`health: "damaged"` with a diagnosis. It never reports an empty store. A person told "no secrets"
over a vault that is merely unreadable will recreate every one of them on top of entries that are
still there.

## What is not built yet

- **Copying a sign-in (Claude / Codex login tokens) — GAP, undecided.** A copied refresh token would live
  on two machines, and a provider that rotates refresh tokens signs one of them out when the other
  refreshes. A secret copy carries stored secrets only; the extension point is marked on the bundle's
  plaintext schema in `packages/daemon/src/lib/secrets/clone.ts`.
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
Secrets still never travel as a side effect of copying configuration: only the names a person ticked.

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

## Secrets the daemon files itself

A [remote MCP server signed in to from the PWA](mcp-oauth.md) leaves its tokens here, under names
derived from the component and its server (`MCP_<NAME>_<HASH>_ACCESS`). The ACCESS token is an ordinary
secret — listed by name, redacted, never returned — and, like every value a runtime is launched with,
readable by that runtime's agent. The refresh token and any client secret are NOT in this store: they
rest in a separate sealed document only the sign-in service reads, so `use` and `${secret:…}` cannot
reach them. **Sign out** deletes all of them.
