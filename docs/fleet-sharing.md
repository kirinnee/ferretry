# Shared fleet assets

One default set of instructions, skills and base settings that every account uses — and a per-account
switch between that shared document and the account's own copy.

This document owns the subject. `packages/fleet/src/lib/sharing.ts` implements it,
`packages/protocol/src/lib/fleet-changes.ts` states the wire, and
`packages/daemon/src/lib/fleet/sharing.ts` is the daemon half. Read this before describing what
sharing does, because it is narrower and more boring than the phrase suggests — deliberately.

## The model

A fleet asset is a document in the fleet's **asset tree** (`<FY_HOME>/fleet/assets`). An account uses
one by referencing it somewhere in its composition chain, and `fy fleet apply` **links** the
referenced source into that account's home — a real symlink, so the file in the home and the shared
document are one file. Two accounts referencing one path do not have equal copies of it; they have it.
Editing it changes both, immediately, because there is nothing else to change.

Sharing is therefore already what happens when two accounts reference one path. The starter
configuration does exactly this: `profiles.base.claude.memory` and `profiles.base.codex.memory` point
every account of each harness at one document, which Claude receives as `CLAUDE.md` and Codex receives
as `AGENTS.md`. It is declared PER HARNESS rather than once, because a single shared source handed
Codex a document whose own first paragraph told it that it was Claude's; the `auto` variant overrides
it again, so an unattended lane reads guidance written for one that cannot stop and ask a question.

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
    claude: ./CLAUDE.md
    claude-auto: ./CLAUDE-auto.md
    codex: ./AGENTS.md
    codex-auto: ./AGENTS-auto.md
    terse: ./memory/terse.md
  skills:
    review: ./skills/review
    deploy: ./skills/deploy
    research: ./skills/research
  settings:
    claude: ./templates/claude/settings.json
    codex: ./templates/codex/config.toml
```

**Declaring a path confers nothing.** It does not link any account to it and it does not create,
move or copy a file. It gives the path a name so that a surface can offer it, count who uses it, and
switch one account between it and a private copy. What makes a shared document the _default_ for
every account is still the `base` profile, which is applied before every account's own slots.

**`skills` is registered per item, and selected per item.** The store holds one entry per skill rather
than one directory of them, and an account takes the subset it needs:

```yaml
profiles:
  base:
    skills: [./skills/review] # everybody gets the review skill
agents:
  - name: personal
    kind: claude
    routes:
      default:
        layer:
          skills: [./skills/review, ./skills/deploy] # this account adds one
```

Each selected item is materialized under its own name inside the harness's skills destination, so
`./skills/review` lands at `<home>/skills/review`. Two accounts selecting one item read one source, and
neither can see what the other also selected. The rules that follow from that are worth stating plainly:

- **A list, and a bare reference is the list of one.** `skills: ./skills/review` means the same as
  `skills: [./skills/review]`, exactly as a single settings layer means a stack of one.
- **A later slot replaces the whole list**, like every other non-settings field. That is what lets one
  account drop an item the `base` profile handed it; concatenation could add but never remove.
- **An empty list is a declared selection of nothing**, which is not the same as declaring no skills at
  all. The first empties the account's skills directory; the second leaves the field alone.
- **An item dropped from a selection is removed from the home** on the next apply. A skill executes
  code, so an account told to give one up must not keep it.
- **Two items whose last path segment is the same are refused while planning**, naming both sources:
  they would claim one destination, and a refusal naming only the collision would send somebody to
  correct the wrong one.

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

Every non-absent state also carries **`materialization`** — see the next section for what the three
values mean. It is absent for exactly the fields missing from `linkable`: a harness with no destination
for a field materializes nothing there, and naming a mechanism would describe a write that never
happens.

## How a value reaches a home

Three mechanisms, and **which one is in play is said wherever a person can see the field**, because the
three differ in the only way that matters to somebody editing a file: whether their edit survives, and
whether it reaches anybody else. `packages/fleet/src/lib/assets.ts` is the single owner —
`HARNESS_ASSETS` declares the ceiling per harness and field, and `resolveAssetMaterialization` is the
one function that resolves it, read by the plan builder AND by the sharing report so the two cannot
disagree.

| mechanism   | the destination is                           | an edit to the source              | an edit to the destination                      |
| ----------- | -------------------------------------------- | ---------------------------------- | ----------------------------------------------- |
| `link`      | the source. One inode, two names             | already every account's            | is an edit to the shared document               |
| `copy`      | the source's bytes as of the last apply      | reaches accounts on the next apply | replaced on the next apply                      |
| `generated` | a merge of a layer stack, composed in memory | reaches accounts on the next apply | folded in once, then replaced by the next merge |

**`link` is the default and every single-pick field has it**: `memory`, each selected `skills` item,
`hooks`, `hooksDir`, `mcp`. This is what "so they Actually are the same thing" means, and it is not a
figure of speech — `readlink` on an account's `CLAUDE.md` names the document in the asset tree.

**`generated` is `settings`, and only `settings`.** A stack of layers deep-merged left to right cannot
be a link to any one of them, so the merge is computed in memory and written as one file. There is a
second, independent reason it must be a real file: each harness rewrites its own settings while it runs
(`/effort` persists into Claude's `settings.json`), so the destination is also an input, which is what
`preserveExisting` folds back in. Both reasons point the same way, which is why there is no argument to
have about it.

**`copy` is the one downgrade, and it is a safety property rather than a preference.** A link inside an
account home may only ever resolve into the fleet's own asset tree, so a reference beginning `/`, `~` or
`$HOME` — or a relative one that climbs out with `..` — is copied instead. The predicate is
`isAssetTreeReference`, decided from the REFERENCE rather than from an expanded path, so a pure report
and a real host give the same answer and a surface can never promise a live link the apply then turns
into a copy.

### Why the symlink ban had to be extended, and how narrowly

`StateFileSystem` refuses to traverse a symlink component anywhere inside `FY_HOME`, so that no
operation can follow one out of the state home. Before this, the single exemption admitted a link under
`fleet/homes` whose whole chain resolved inside `fleet/shared` — the history pool. It now admits
`fleet/assets` as well, and nothing else:

- the **source** must be under `fleet/homes`;
- the resolved **target** must be inside `fleet/shared` or `fleet/assets`;
- the **complete chain** is resolved, so a planted intermediate link cannot use the exemption to escape
  either directory;
- anything dangling, cyclic or unreadable fails closed.

A link pointing anywhere else keeps the blanket refusal, including one pointing elsewhere inside the
state home. The two destinations are two different contracts and are worth keeping distinct: the pool is
state the harness owns and Ferretry never writes, while the asset tree is state Ferretry owns and every
apply writes. Extending the hole rather than widening the rule is what keeps that distinction legible.

**A credential is never linked, at any layer.** Auth is not an asset field, so no mechanism here can
reach one — and it could not work if it did: a harness rewrites its credential by temp-file-and-rename,
which replaces a link with a regular file, and on macOS Claude keys its keychain item to the home path.
`docs/fleet-defaults.md` owns that argument for the seeding path.

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

A host that already shares one `CLAUDE.md` — which is every host a starter configuration written
before the four per-harness documents made — migrates by **declaring the registry**. Every account that already references that path becomes
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

- **A directory asset cannot be privately materialized.** `hooksDir` is a directory, and the reviewed
  asset surface writes text documents — one path, one body, one expected digest. Unlink refuses it with
  the manual remedy. A plan operation that copied a directory into the asset tree on every apply would
  also have to decide what to do when the account has since edited its copy, which is a destructive
  question nobody has asked yet.
- **`skills` cannot be unlinked, because there is no one document to leave.** A selection is items, and
  each item is separately the store's or the account's own; "give this account its own copy" has no
  referent. Dropping an item is an edit to the list, which is the operation that means what it says.
- **Deleting a store item accounts still use is refused, naming them.** `orphanedSharedDocuments`
  compares the offers before a change against the offers after, so a change that stops offering
  something still in use is rejected with the account ids on it rather than leaving them pointing at a
  path the store no longer names. There is no verb that deletes a store item yet; the guard sits on the
  mutation path so the verb that does cannot arrive without it.
- **A write that REPLACES a linked document, rather than editing it, ends the sharing until the next
  apply — and is then discarded.** A save done as temp-file-and-rename, which is how most editors and
  Claude's `#` memory shortcut write, replaces the link with a regular file holding the new text: the
  shared document keeps its old bytes, that one account keeps the new ones, and nothing announces the
  split. The next apply puts the link back and removes the replacement, exactly as it previously
  overwrote an edited copy — so this is not a regression from copying, but it is not fixed by linking
  either. An in-place edit through the link is shared; a replace-by-rename is lost. This is precisely why
  `settings` is generated rather than linked (that file is _known_ to be rewritten at runtime, and the
  merge folds it back in) and why nothing here links a credential.
- **A source outside the asset tree is copied, not linked.** `~/dotfiles/CLAUDE.md` reaches an account on
  the next apply rather than immediately. The report says `copy` for it, so the difference is visible
  before somebody relies on the other behaviour, and the remedy is to keep the document in the asset
  tree.
- **A settings layer cannot be linked or unlinked**, for the reason above. It is reported.
- **Renaming a shared document does not follow.** Accounts reference the path, so changing
  `shared.memory.claude` to a different path leaves referrers on the old one, and the next apply fails
  loudly on a missing source. Editing the document in place is the supported operation.
- **Two references reaching one document by different roots are two documents.** `~/notes.md` and
  `/home/me/notes.md` may be the same file; nothing pure can know that. Declare shared documents as
  asset-relative paths, which is what the registry is for.
- **A shared document outside the asset tree cannot seed a private copy.** It can be linked and copied
  into homes by an apply, but its text cannot be read through the pinned asset store, so unlink refuses
  with that reason rather than failing later on a path the person did not name.
- **The report describes the configuration, not the disk.** It says what the _next_ apply will
  materialize, including which mechanism it will use. An account home whose entry was replaced by hand
  still reports as sharing the document it references, because that is what apply will put back.

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
