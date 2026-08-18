# Harness discovery: what the account form knows before anybody types

The fleet's **New account** form used to make a person type things this daemon already knew: which
harness to use, the models that account can serve, which of them is the default, the path of an
instructions asset, and the entire contents of that document. All five were available on the host and
none of them was offered.

This document is the contract for the read that fixed that. Implement against this document.

- **Wire shape** — `packages/protocol/src/lib/harness-discovery.ts`
- **Decision** — `packages/daemon/src/lib/fleet/harness-discovery.ts`
- **Host layout and the read itself** — `packages/daemon/src/adapters/core/harness-home-documents.ts`
- **Route** — `GET /v1/fleet/harnesses`, capability `fleet` / axis `use`, `no-store`
- **The form** — `packages/pwa/src/features/fleet/fleet-change-model.ts` and `fleet-change-forms.tsx`

## The detection is not new

`readHarnessPreflight` has resolved `claude` and `codex` against the host's `PATH` since the first boot
milestone, and says so in the startup warning — "claude and codex are on this host's PATH, but the fleet
manifest publishes no account for either". What it never did was OFFER that answer to anything a person
types into. The discovery read uses the **same** `ExecutableResolverPort` instance the preflight and the
doctor report use, because two resolvers would be two answers to "is Claude Code installed here", and
the form's answer is the one somebody would then act on.

## Four rules

1. **Nothing is launched.** Every answer is a `PATH` lookup and at most two file reads. It therefore
   cannot prove a harness is signed in, in credit, or able to reach its provider, and the report carries
   that limit as its own `limitation` text rather than trusting a surface to remember it.
2. **A detected value names the file it came from.** `models.source` is an absolute path when
   `origin: 'detected'`. A prefilled box a person cannot trace forces them to re-check every field,
   which is the work the prefill was supposed to remove.
3. **A fallback says it is one.** `origin: 'fallback'` carries the reason the harness said nothing —
   no settings file, an unparseable one, or one that declares no `model`. The identifier itself is
   `FLEET_STARTER_MODELS` from `@ferretry/fleet`, the same value `fy fleet init --first-account` writes,
   so a form can never offer a model no scaffold produces. **Nothing here invents a model name.**
4. **Absence is stated, never blank.** "There is no such file", "it is too large to import", "it would
   not parse" and "we could not read it" are four different sentences, because they send a reader to
   four different places.

## What is read, per harness

| Harness | Settings                         | Instructions          |
| ------- | -------------------------------- | --------------------- |
| Claude  | `~/.claude/settings.json` (JSON) | `~/.claude/CLAUDE.md` |
| Codex   | `~/.codex/config.toml` (TOML)    | `~/.codex/AGENTS.md`  |

Both harnesses spell the model key `model`; the FORMAT differs, so the format is a layout fact and the
key is not. Parsing goes through `parseSettings` from `@ferretry/fleet` — the same function the
provisioner writes settings with — rather than a second, laxer reader.

Only the top-level `model` is read. A Codex `[profiles.x] model` is deliberately not consulted: an
account form has no way to know which profile a person meant, and picking one would be a guess wearing
a detection's clothes.

**The layout is injected.** Where each harness keeps its files is a fact about a real machine, so it
arrives as a value from the adapter — the same shape `foreignHistoryRoots` uses for the same reason. No
test ever reads a developer's own home, and the decision module has no opinion about where anybody
keeps their files.

**The read leaves the state home, deliberately.** `StateFileSystem` refuses every path outside
`FY_HOME`, which is right for it and useless here: a harness home is somebody's `~`. So this is a
separate, read-only port. It follows symlinks — keeping `~/.claude/CLAUDE.md` as a link into a dotfiles
repository is ordinary, nothing is written, and the caller already governs the file.

**The size bound is checked before the bytes are taken.** A document over the one-asset ceiling
(`MAX_ASSET_FILE_BYTES`) is reported as `too-large` WITH its size and never read. Importing the first
64 KiB of somebody's instructions and writing that back over the whole document is the failure nobody
would catch.

## In the form: prefilled, visible, overridable

`FleetAccountDraft.prefilled` records, per field, the sentence naming where the value came from. A key
present means "this is still what detection put here"; a key absent means the person owns that field
now. That single record does two jobs: it is the provenance the screen renders under each field, and it
is the permission to refill.

- **Harness.** Preselected from `PATH`, and the sentence names what was found. When BOTH are installed
  the rule is the fleet package's own `defaultFleetHarness` (prefer Claude) and both are named, so a
  choice is never made quietly. When NEITHER is installed nothing is preselected and the form says so
  in an `alert` — a **warning, never a refusal**, because installing a harness minutes later is
  ordinary and the daemon re-reads the manifest on every session start.
- **Models and default model.** From what the harness reports, labelled detected or fallback.
- **Instructions path.** Derived as `instructions/<wrapper>.md` from the account being created, and
  empty until the account has a name — `instructions/claude-.md` would be a fabricated path. It keeps
  up with the name, the lane and the harness until the person types their own; clearing the box gets
  the derived default back.
- **Instructions contents.** Pre-loaded from the host's own document, marked as imported with its
  source path and size, and editable. **Nothing is written until the existing review-and-authorize step
  runs**, which is what makes a pre-load an offer rather than an adoption.

Editing a field drops its provenance note. Changing the harness refills the fields the OLD harness was
speaking for — but only those the person does not already own, read from the draft as it was BEFORE the
change: switching harness is not consent to discard a model list somebody just typed.

## More than one instructions document

A fleet keeps as many instructions documents as it likes and an account CHOOSES one. The picker offers a
new document for this account (imported or empty) plus every document already in the asset tree that is
not inside a skills directory the configuration declares — asked of the configuration rather than
guessed from a naming convention.

Choosing an existing document **reads it first**. Until its text arrives the draft holds an empty string
for a path the daemon has listed, and `unseenAssets` blocks staging on exactly those terms, so a change
can never replace a shared document with nothing. A refused read is kept as the daemon's own sentence
and keeps blocking until the draft stops naming that path.

## Doctor

`GET /v1/doctor` now reports `claude` and `codex` as their own checks, with the **resolved absolute
path** in the summary, and every other program's check names its path too. Which `claude` was found is
the fact a person acts on when a shim, a version manager or a stale copy in `/usr/local/bin` is
shadowing the one they installed. Both are `alternative`, not `required`: a host with one harness
installed is a working host.

These checks are deliberately separate from the `claude or codex` line above them. That one is about the
MANIFEST — whether a published wrapper is launchable. These are about the MACHINE. Collapsing them is
how somebody installs Claude Code, is told no harness is ready, and is right to object.

## Declared GAPs

- **A model list is one model long when detected.** Neither harness declares a SET of models it can
  serve, only the one it defaults to, so `ids` holds that one and the box stays editable. Adding the
  others is typing — less typing than before, and still typing.
- **Nothing checks that a detected model is a model the provider will serve.** The report says what the
  settings file says. A wrong model in a settings file becomes a wrong model on the account.
- **The authorize step is untouched.** Everything here happens before submit; the change is still
  derived, previewed and authorized by whatever authority the fleet panel has at the time. The form
  hands off at one call and knows nothing about proposals, approval codes or expiry, so replacing that
  flow does not reach any of this.
- **A per-profile Codex model is not read** (above).
- **`fy` has no command that prints this report.** It is a route and a browser surface; a terminal
  reader gets the harness paths from `fy doctor` and the models from the harness's own config file.
