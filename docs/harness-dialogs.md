# Harness dialogs

Claude Code and Codex stop on screens of their own as well as on tool permissions
([permission-prompts.md](permission-prompts.md)): Codex's "Hooks need review", its update prompt and its
sign-in screen; Claude's "New MCP server found in this project" and "Settings Error". Nothing moves until
somebody answers, and before this nothing outside the Console said so — an agent session just sat there.
Ferretry now reads such a dialog off the agent's pane, shows it as a card in Chat with the harness's own
choices, marks the session as needing you, and types the person's answer back into the pane.

## Why Codex asked "Hooks need review"

Codex 0.145+ refuses to run a hook it has not been told to trust. Its trust record is a `[hooks.state]`
table in `config.toml`, keyed by **where the hook is declared** and holding a hash of what it does:

```toml
[hooks.state."/home/dev/.codex/hooks.json:stop:0:0"]
trusted_hash = "sha256:a4f86b6f…"
```

The key is `<path of hooks.json or config.toml>:<event>:<group index>:<handler index>`; the hash is SHA-256
over the hook's normalised definition (event, matcher, command, timeout…), read off Codex's source
(`codex-rs/hooks/src/engine/discovery.rs`, `config/src/fingerprint.rs`) at `rust-v0.145.0` and
`rust-v0.156.1`; the key and the table are what pressing "Trust all and continue" wrote in a throwaway home.

**Ferretry's fixed layer writes no hooks** (`packages/fleet/src/lib/account/fixed-layer.ts`: permission
mode, trust, notices, the tools server, the instruction — no `hooks` key, no `hooks.json`). The hook a
Ferretry Codex runtime asks about is a **person's** hooks component — typically imported from a
`~/.codex-<name>` home — which materialisation links into the runtime as `<runtime>/hooks.json`. The person
may have trusted that very hook in their own home, but that trust is keyed by the OLD path, so in the
runtime it is "new". Codex writes the answer into the runtime's `config.toml`, which every re-apply keeps
(`preserveExisting`), so it is asked once per runtime and again only when the hook changes.

So there is nothing of Ferretry's own to pre-trust, and imported hooks are **not** trusted for the person:
the dialog is shown to them as a card instead. Not used, on purpose:

- **`codex --bypass-hook-trust`** runs every enabled hook untrusted — it would silently trust the person's
  hooks for every agent.
- **Copying the person's `hooks.state`** into the runtime under the new path would be the same thing done
  quietly; the card asks instead. If Ferretry ever adds a hook of its own, it must write its own
  `hooks.state` entry beside it, recomputed whenever the hook changes.

## What is recognised

Read off real panes captured from Codex 0.145.0, 0.156.1, 0.163.0 and 0.164.0 and Claude Code 2.1.220 and 2.1.281 in throwaway
homes with no network. The captures are the fixtures in `packages/daemon/tests/fixtures/harness-dialogs/`.

| Harness | Dialog                               | `kind`            | Options that grant trust                                                                |
| ------- | ------------------------------------ | ----------------- | --------------------------------------------------------------------------------------- |
| Codex   | Hooks need review                    | `hooks-review`    | Trust all and continue                                                                  |
| Codex   | The hook list "Review hooks" opens   | `hooks-list`      | — (no rows; Esc closes it)                                                              |
| Codex   | Update available                     | `update`          | —                                                                                       |
| Codex   | Welcome to Codex (sign-in)           | `sign-in`         | —                                                                                       |
| Claude  | New MCP server found in this project | `mcp-servers`     | Use this MCP server, Use this and all …                                                 |
| Claude  | Settings Error                       | `settings-error`  | —                                                                                       |
| Claude  | What do you want to do? (limit hit)  | `usage-limit`     | — (the session is recorded `rate_limited`; no row is ever picked for you)               |
| Codex   | Usage limit reached                  | `usage-limit`     | — (the session is recorded `rate_limited`; the "Increase limits" rows are never picked) |
| Either  | Do you trust this folder?            | `directory-trust` | the "Yes" rows                                                                          |
| Codex   | Folder access: Trust this folder?    | `directory-trust` | Trust and continue                                                                      |
| Codex   | Folder access: Open restricted       | `directory-trust` | — (opening changes no saved trust)                                                      |
| Codex   | Model migration ("Meet GPT-6 Sol")   | `other`           | — (0.164 asks it when the model has a successor; the generic reading carries it)        |

Any other screen of the same shape — a header, a list with a cursor on one row, and a key-hint footer that
names Enter or Esc ("enter confirm · esc skip", "Press enter to continue", "Enter to confirm · Esc to
cancel") as the last line of the frame — is read as `other`, so an unknown dialog is still surfaced rather
than left silent. A row is marked `grantsTrust` when it says it trusts and not that it does not. A tool
permission prompt is never read as a dialog: it has its own card.

The dialog (`HarnessDialog` in `packages/protocol/src/lib/session-dialog.ts`) carries every row in the
harness's own words, the description under a row when there is one, the row the cursor is on, and the
footer's word for Esc when it offers Esc. Its `id` is a digest of everything a person decides on — not of the
cursor — so a cursor moved at the terminal is the same dialog.

## How it travels

The turn watcher reads it with the rest of the turn evidence. While it is on screen the session's
`turnState` is `needs-input` and `state.harnessDialog` holds it; it rides the session journal
(`turn.state` / `turn.prompt`, field `harnessDialog`). A pane showing one is never ready, so a send names it
as the blocking prompt instead of typing into it — Codex's `› 1. Review hooks` row is shaped like a composer
line, and before this a launch brief was typed into the hook review.

## Answering

`POST /v1/sessions/:sessionId/dialog` with `{ kind: 'choice', dialogId, number }` or
`{ kind: 'escape', dialogId }`:

1. The pane is captured and parsed again. If it no longer shows `dialogId`, nothing is typed: `409
harness_dialog_gone`.
2. A choice is **arrows, then Enter** — never the digit. Measured: Codex's hook review moves the cursor on a
   digit and waits for Enter, its update prompt acts on the digit at once, and Claude 2.1.281 draws some
   lists without digits. The pane is read until the same dialog shows the cursor on the chosen row; only then
   is Enter pressed. A cursor that never arrives is `cleared: false` with no Enter; another screen coming up
   meanwhile is `harness_dialog_gone`.
3. Escape is the harness's own Esc, offered only when the footer names it.
4. The pane is read until the dialog is gone; `cleared: false` means it is still up. Never re-sent.

Governance is the Console's: `terminal` / `use`, audited as `terminal.input` with `detail.mode: 'dialog'`
([grants.md](grants.md)).

## Answered automatically, and why

Nothing that grants trust is ever answered by the daemon. The dialogs a launch clears by itself
(`packages/daemon/src/lib/tmux/startup.ts`) are the ones whose answer decides nothing for the person:

- **Codex "Update available" → Skip.** Skip installs nothing and records nothing (`version.json` keeps
  `dismissed_version` empty, measured on both versions), so the next launch asks again and a person at the
  terminal still sees it. "Update now" would run a package manager on the owner's machine and "Skip until
  next version" would record a choice, so neither is picked.
- Unchanged from before: Claude's theme picker, its "Make auto mode your default permission mode?" nudge
  (answered No, which keeps the owner's mode), the large-session resume menu, the custom-API-key
  confirmation the wrapper's own key raises, and the launch-folder trust dialogs — the folder the fixed
  layer already trusts (`projects.<cwd>`), so the answer repeats a decision Ferretry's design made, never a
  new one. Codex 0.156+ asks it on a "Folder access" screen ("Trust this folder?" · "Trust and continue"),
  answered the same way.
- **Not** Codex's trust question in a subdirectory of a Git repository. Its note ("Trusting will apply to the
  repository root") means yes trusts the whole repository, which is more than the launch folder the fixed
  layer trusts, so it waits for a person on 0.145.0 and 0.163.0 alike. Nor the restricted opening of a
  folder its config marks untrusted.

The rest — hooks, MCP servers, sign-in, settings errors, anything unrecognised — wait for a person.

## Declared gaps

- **Which hooks.** The hook review says how many hooks are new, not which; the card shows what the pane
  shows. "Review hooks" opens Codex's own list, which the card can only close (Esc).
- **Signing in** from the card picks a sign-in method; finishing it (a browser, a device code) happens in
  the Console or on the machine.
- **Model-migration notices** could not be raised offline (they depend on the remote model list), so there
  is no fixture. The fixed layer hides the ones Codex 0.156.1 names (`[notice]`), and any other one is read
  as `other`.
- **Claude Code login expiry** is not a modal in 2.1.220 or 2.1.281: it prints in the conversation and the
  composer stays live, so it is not a dialog here.
