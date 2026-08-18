# Shared fleet assets

One default set of instructions, skills and base settings that every account uses — and a per-account
switch between that shared document and the account's own copy.

This document owns the subject. `packages/fleet/src/lib/sharing.ts` implements it,
`packages/protocol/src/lib/fleet-changes.ts` states the wire, and
`packages/daemon/src/lib/fleet/sharing.ts` is the daemon half. Read this before describing what
sharing does, because it is narrower and more boring than the phrase suggests — deliberately.

## The model

A fleet asset is a document in the fleet's **asset tree** (`<FY_HOME>/fleet/assets`). An account uses
one by referencing it somewhere in its composition chain, and `fy fleet apply` **copies** the
referenced source into that account's home.

Sharing is therefore already what happens when two accounts reference one path. The starter
configuration does exactly this: `profiles.base.memory: ./CLAUDE.md` points every account at one
document, which Claude receives as `CLAUDE.md` and Codex receives as `AGENTS.md`.

What was missing was any way to **say so**. Nothing declared which paths were the shared ones, nothing
reported per account whether its instructions were the shared document or its own, and there was no
operation for moving an account between the two. So a surface had to infer sharing from string
equality across a composition chain it could not see, which is to say it could not.

Three things close that, and nothing else changes:

1. **A registry.** `config.shared` gives names to shared documents, per asset field.
2. **A report.** `GET /v1/fleet/sharing` says, per account and per field, whether the effective value
   is a declared shared document or the account's own, which slot supplied it, and how many accounts
   resolve to the same path.
3. **Two operations.** `link-shared-asset` and `unlink-shared-asset`, as reviewed mutations like any
   other change to the fleet.

### The registry

```yaml
shared:
  memory:
    default: ./CLAUDE.md
    terse: ./memory/terse.md
  skills:
    default: ./skills
  settings:
    claude: ./templates/claude/settings.json
    codex: ./templates/codex/config.toml
```

**Declaring a path confers nothing.** It does not link any account to it and it does not create,
move or copy a file. It gives the path a name so that a surface can offer it, count who uses it, and
switch one account between it and a private copy. What makes a shared document the _default_ for
every account is still the `base` profile, which is applied before every account's own slots.

More than one name per field is the point: two shared instruction documents, each account using
whichever it references. Names are per field, so `settings` carries one entry per harness — a Claude
`settings.json` and a Codex `config.toml` are two documents and two names, never one shared file both
harnesses would fight over.

Two names for one document are refused by the configuration schema. "Which shared document is this
account linked to" has to have one answer, and paths are compared canonically, so `./CLAUDE.md` and
`CLAUDE.md` are caught as the one document they are.

### The report

Per account, each linkable field is one of three states:

| state    | meaning                                                            |
| -------- | ------------------------------------------------------------------ |
| `shared` | the effective path is a declared shared document; carries its name |
| `local`  | the effective path is not declared shared                          |
| `absent` | this account declares no such asset at all                         |

Every non-absent state also carries `referrers` — how many accounts resolve that field to that same
path — and `origin`, the composition slot that supplied it (`base-profile`, `agent-profile`,
`variant-profile`, `variant`, `agent`, `account`).

`local` with more than one referrer is worth reading twice: it is a document the fleet **is already
sharing without having said so**. That is a state to offer to fix, not one to hide.

`linkable` per account excludes any field its harness has no destination for, so a surface never
offers a control whose apply would be refused — `mcp` on Codex, `hooks` on Claude.

## What is shared, and what can never be

Everything shareable is a field of `Profile`: `settings`, `memory`, `skills`, `hooks`, `hooksDir`,
`mcp`, plus `env` and `flags`, which are values rather than documents.

**Identity and auth are never shared, and the schema is what enforces it.** An account's id, wrapper,
home, lane, mode, display name, default model, model list and availability are `AccountRoute` fields;
its provider login and the identity it shares are `Agent` fields. No profile, variant or overlay can
express any of them — `ProfileSchema` is strict, so a configuration that tried would fail to parse.
`PER_ACCOUNT_FIELDS` names them so the fact has an owner and a test rather than only this paragraph.

Credentials are not in the configuration at all. An environment value written as exactly `$NAME` stays
a reference, resolved from `secretsFile` when the wrapper runs, which is what lets a shared `env` layer
exist without a shared secret. `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `CODEX_SQLITE_HOME` are reserved,
so no layer — shared or not — can detach an account from the home the manifest publishes for it.

### Configuration is shared-default plus per-account override, not blunt sharing

`settings` is a **stack**, deep-merged left to right, and that is the whole answer to "shared config".
A shared base file is one layer; an account's own overrides are a later layer; the merged result is
written into a real file in the account's home, because each harness rewrites its own settings at
runtime (`/effort` persists into Claude's `settings.json`). Nothing about that is new.

It is also why `settings` is **reported but not linkable**. Every other field is a scalar the last slot
wins outright, so "use the shared one" has exactly one meaning. For a stack, `link` would have to
choose a position — and a shared layer inserted in the wrong place is silently overridden or silently
overriding. Changing the stack stays the ordinary overlay edit, where the order is written down and
reviewed.

## Linking and unlinking

Both are named intents on the existing proposal flow: composing one writes nothing, the person sees
every write first, and applying consumes exactly the artifact that produced the preview.

**`link-shared-asset { accountId, field, name }`** writes the shared document's path into that
account's own overlay. It names the shared document _by name_, never by path: a caller able to send a
path would be choosing which of the host's files the next approved change copies into a home, and the
one-line summary the host approves would not mention it.

Two details are load-bearing:

- Linking also clears that account's per-harness overlay entry for the field. Within one slot a
  `claude:` / `codex:` overlay is applied _after_ the flat fields, so an account carrying
  `claude: { memory: … }` would otherwise keep using it and the operation would report success having
  changed nothing.
- A write into `route.layer` takes effect because that is the **last** slot of the composition chain,
  which `compositionSlots` owns as one ordering rather than two readings of it. Both operations assert
  the account's _resolved_ state after the derivation, so an ordering change that broke the effect
  fails a test rather than silently reporting a switch that did not happen.

**`unlink-shared-asset { accountId, field }`** gives the account its own copy. It carries no content
and no destination; both are derived on the host — the text from the shared document as it is now, the
destination from the account's own wrapper name (`accounts/<wrapper>/<document>`), which the schema
already proves unique across the fleet. The copy is written as a reviewed text document inside the
provisioner's rollback boundary, in the same commit as the configuration that points at it, so the
account never references a path that does not exist.

**Unlinking never empties an account and never touches the shared document.** A destination that is
itself a declared shared document is refused — the file may not exist yet, so nothing later would catch
it, and seeding it would turn one account's private copy into what every account linking that name
receives. An existing file at the destination is likewise refused rather than overwritten — it is the account's own earlier copy or somebody's
work in progress, and replacing it with the shared text is not what "give this account its own copy"
asked for.

## Migration is a declaration

A host that already shares one `CLAUDE.md` — which is every host the starter configuration made —
migrates by **declaring the registry**. Every account that already references that path becomes
recognised as sharing it. Nothing is renamed, copied or moved.

An account that has diverged onto its own document migrates with one `link-shared-asset`, which is
opt-in per account, reviewed like any other change, and leaves the account's old document exactly
where it is. Content is preserved because nothing deletes it.

This is why there is no rename-safety argument to make here: there is no rename. The pooled-history
migration must refuse a rename that would cross a filesystem device, because a copy would hand every
reader a new inode. Shared assets already live in one place, and the only writes are the configuration
and a new private copy — both inside the boundary that already captures, verifies and restores.

## Why this is not the shared-history pool

`packages/fleet/src/lib/shared-history.ts` pools one harness-owned directory per account home and
replaces each with an absolute symlink into `<FY_HOME>/fleet/shared`. It has rename-based migration,
collision quarantine, a dry run, a journal and a rollback, and there is a deliberate exemption to this
repo's no-symlinks-in-`FY_HOME` rule for exactly those links. It is the closest thing in the
repository to what sharing assets looks like, and extending it was the obvious move.

It is the wrong home for an asset, for one specific reason: **every asset path is a destination the
fleet plan writes on every apply.** The pool's contract is the opposite — the harness owns that state
and Ferretry never writes it, which is what makes transcripts, prompt history and todos safe to pool.

Put an asset in the pool and one inode has two owners. The pool's rename-based migration would move
the fleet's own copy of an account's `CLAUDE.md` into the pool, where the next apply's copy operation
overwrites it: either one account's instructions silently become everyone's, or the shared default
silently becomes one account's. Both are silent, both are data loss, and no amount of care in the
migration prevents it, because the conflict is between two contracts rather than inside one of them.

There is a second, smaller reason. The asset editor reads and writes inside `fleet/assets` and refuses
to follow a link; the pool is `fleet/shared`. A shared document living in the pool would be one nobody
could edit in the Fleet tab, which is most of what the tab is for.

## Known limits

These are declared, not hidden. Each is a thing a reader might reasonably assume works.

- **A directory asset cannot be privately materialized.** `skills` and `hooksDir` are directories, and
  the reviewed asset surface writes text documents — one path, one body, one expected digest. Unlink
  refuses them with the manual remedy. A plan operation that copied a directory into the asset tree on
  every apply would also have to decide what to do when the account has since edited its copy, which
  is a destructive question nobody has asked yet.
- **A settings layer cannot be linked or unlinked**, for the reason above. It is reported.
- **Renaming a shared document does not follow.** Accounts reference the path, so changing
  `shared.memory.default` to a different path leaves referrers on the old one, and the next apply fails
  loudly on a missing source. Editing the document in place is the supported operation.
- **Two references reaching one document by different roots are two documents.** `~/notes.md` and
  `/home/me/notes.md` may be the same file; nothing pure can know that. Declare shared documents as
  asset-relative paths, which is what the registry is for.
- **A shared document outside the asset tree cannot seed a private copy.** It can be linked and copied
  into homes by an apply, but its text cannot be read through the pinned asset store, so unlink refuses
  with that reason rather than failing later on a path the person did not name.
- **The report describes the configuration, not the disk.** It says what the _next_ apply will
  materialize. An account home whose copy was edited by hand still reports as sharing the document it
  references, because that is what apply will put back.

## Surfaces

`GET /v1/fleet/sharing` — the whole report, `operator` minimum, `fleet`/`use` capability, no-store.

`fy fleet sharing` — the same report on the host, human or `--json`. It reads the daemon rather than
resolving the configuration locally, so the terminal and the browser cannot disagree about whether an
account is sharing something.

The two mutations travel on the existing `POST /v1/fleet/proposals`, and are approved and applied
exactly like `create-account` and `edit-account`.

## What the browser needs from this

Everything the Fleet tab needs to render "shared vs local" per asset is in the sharing report, and none
of it has to be inferred: `state`, `name`, `path`, `origin`, `referrers` and `linkable` per account,
plus `documents` for the offer list and its per-document account ids for "shared with these four".

The two controls are `link-shared-asset` (with a name from `documents`) and `unlink-shared-asset`, sent
as ordinary proposals. Refusals arrive as `fleet_proposal_refused` with a sentence naming what cannot
be done and why — a directory field, a name this fleet does not declare, a destination already
occupied — so the surface can show the reason rather than a generic failure.
