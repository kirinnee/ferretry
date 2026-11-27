# Harness dialogs

Claude Code and Codex stop on screens of their own as well as on tool permissions
([permission-prompts.md](permission-prompts.md)): Codex's "Hooks need review", its update prompt and its
sign-in screen; Claude's "New MCP server found in this project" and "Settings Error". Nothing moves until
somebody answers, and before this nothing outside the Console said so — an agent session just sat there.
Ferretry now reads such a dialog off the agent's pane, shows it as a box in Chat with the harness's own
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
the dialog is shown to them as a box instead. Not used, on purpose:

- **`codex --bypass-hook-trust`** runs every enabled hook untrusted — it would silently trust the person's
  hooks for every agent.
- **Copying the person's `hooks.state`** into the runtime under the new path would be the same thing done
  quietly; the box asks instead. If Ferretry ever adds a hook of its own, it must write its own
  `hooks.state` entry beside it, recomputed whenever the hook changes.

## What is recognised

Read off real panes captured from Codex 0.145.0, 0.156.1, 0.163.0, 0.164.0 and 0.170.0 and Claude Code 2.1.220, 2.1.281 and
2.1.327 in throwaway homes with no network (a synthetic home, a fake key, nothing signed in). The captures are the fixtures in
`packages/plugins/claude-code/tests/fixtures/harness-dialogs/` and `codex-harness-dialogs/` (the runner's reader, Terminals, keeps the
same frames in `packages/plugins/terminals/tests/fixtures/harness-dialogs/`).

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
| Either  | Do you trust this folder?            | `directory-trust` | the "Yes" rows (2.1.327 draws it with no digits and the cursor on "No, exit")           |
| Claude  | Detected a custom API key            | `other`           | — ("Yes" uses the key; no rule picks either row)                                        |
| Claude  | WARNING: Bypass Permissions mode     | `other`           | — (a home key skips it; "Yes, I accept" is never pressed)                               |
| Claude  | Claude in Chrome (`--chrome`)        | `other`           | — (no rows: Enter continues, Esc closes; see the rules below)                           |
| Codex   | Folder access: Trust this folder?    | `directory-trust` | Trust and continue                                                                      |
| Codex   | Folder access: Open restricted       | `directory-trust` | — (opening changes no saved trust)                                                      |
| Codex   | Model migration ("Meet GPT-6 Sol")   | `other`           | — (0.164 asks it when the model has a successor; the generic reading carries it)        |

A Claude notice with **no rows** — a title and paragraphs under the full-width rule, and the footer "Enter to continue · Esc
to close" — is read as `other` with no options and no selected row; Esc is its only answer. It is read by its **signature**,
not its shape: the notice's own title ("Claude in Chrome" is the one known) and that footer, the whole line,
under the rule, and no cursor row, numbered row or composer glyph — a bare `❯` included — between them.
An editor or help frame that borrows the footer, a list, the idle composer or a bare footer is never one. A new notice is
added by its own title, never by the shape.

Any other screen of the same shape — a header, a list with a cursor on one row, and a key-hint footer that
names Enter or Esc ("enter confirm · esc skip", "Press enter to continue", "Enter to confirm · Esc to
cancel") as the last line of the frame — is read as `other`, so an unknown dialog is still surfaced rather
than left silent. A row is marked `grantsTrust` when it says it trusts and not that it does not. A tool
permission prompt is never read as a dialog: it has its own box.

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

`POST /v1/ferrets/:ferretId/dialog` with `{ kind: 'choice', dialogId, number }` or
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
- **Claude "WARNING: Loading development channels" → "I am using this for local development".** Every launch with
  `--dangerously-load-development-channels` shows it, and the Claude Code launch adds that flag for Ferretry's own channel
  (see [launch-settings.md](launch-settings.md#the-claude-channel)). Only the ACTIVE bottom dialog is answered: the exact
  title line "WARNING: Loading development channels" inside the bottom window, exactly the two rows `1. I am using this for
local development` and `2. Exit` with nothing else numbered, and the selection on row 1 alone — a quoted copy above
  another dialog, or a cursor resting on Exit, is not answered. Enter takes it, and **Exit is never chosen** (a daemon that left it would stop every ferret it launched). The answer repeats the decision
  the flag already made, so it grants nothing new.
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

## Pre-answered in the ferret's own home (5.0, O11)

Nothing should wait on a screen a key can answer. Every key below is written into **the ferret's own generated home**
(the fixed layer; never the owner's `~/.claude` or `~/.codex`) and is part of the launch-settings fingerprint, so a
change marks a running ferret Restart.

| Harness | Screen                                                                       | Key                                                                                                                                                                                                                    | What it allows                                                                                                           |
| ------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Claude  | Trust this folder                                                            | `.claude.json` `projects[<cwd>].hasTrustDialogAccepted`                                                                                                                                                                | the ferret's OWN working folder only (not a parent, not all): its settings and hooks run                                 |
| Claude  | New MCP server found in this project                                         | none: NOT pre-answered                                                                                                                                                                                                 | nothing: the owner chooses in the ferret’s terminal (the one notice below)                                               |
| Claude  | Bypass-mode / auto-mode warning                                              | `skipDangerousModePermissionPrompt` (bypass) / `skipAutoPermissionPrompt` (auto), settings                                                                                                                             | shows no warning; the mode itself is the owner's `permissionMode`, held when loosened                                    |
| Claude  | Onboarding, theme, Chrome, nudges                                            | `hasCompletedOnboarding`, `hasCompletedClaudeInChromeOnboarding`, `hasSeen…Nudge`                                                                                                                                      | nothing: they are seen screens                                                                                           |
| Claude  | Update notice / self-update                                                  | `DISABLE_AUTOUPDATER=1` in the launch's process environment (v4's probe sets the same)                                                                                                                                 | nothing is installed by Claude; Ferretry applies updates                                                                 |
| Claude  | Plugin / LSP recommendation                                                  | `.claude.json` `lspRecommendationDisabled` and `claudeCodeHints.disabled`, written only where absent                                                                                                                   | nothing: both screens are suggestions; a value the owner set to another one stays                                        |
| Claude  | What's new after an upgrade                                                  | `.claude.json` `lastReleaseNotesSeen` = the installed version, re-seeded on every launch (skipped when the version is unknown)                                                                                         | nothing: it is bookkeeping                                                                                               |
| Claude  | Feedback survey                                                              | `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1` in the launch environment                                                                                                                                                      | nothing                                                                                                                  |
| Claude  | (the rm waivers' precondition)                                               | `env -u CLAUDE_CODE_CHILD_SESSION`                                                                                                                                                                                     | a ferret started from a Claude Bash shell inherits it, and it voids the waivers                                          |
| Claude  | Full dangerous-`rm` waiver: the check is skipped, never answered             | `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1`, `CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT=1`, `CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT=1`, all three only with `dangerousRmWaiver: true` AND bypass mode | **off by default**; without it a dangerous `rm` is always denied. Turning it on is held for the owner like any loosening |
| Codex   | Update available                                                             | `config.toml` `check_for_update_on_startup = false`, unless a settings item sets it                                                                                                                                    | nothing is installed; Ferretry applies updates                                                                           |
| Codex   | Trust this folder                                                            | `-c projects={"<cwd>"={trust_level="trusted"}}`                                                                                                                                                                        | the ferret's OWN working folder only; it also lets that folder's `.codex/config.toml` load                               |
| Codex   | Approvals and sandbox                                                        | `-c approval_policy` / `sandbox_mode` (`never` + `danger-full-access` when bypassing)                                                                                                                                  | bypass mode never asks; auto mode asks on request                                                                        |
| Codex   | Full-access / world-writable warnings, rate-limit and model-migration nudges | `-c notice={hide_…=true}`                                                                                                                                                                                              | nothing: they are notices                                                                                                |

The Claude and Codex rows from `.claude.json` `lspRecommendationDisabled` down to `check_for_update_on_startup` (O11b) were read
off the **Claude Code 2.1.317 / Codex 0.166.0 binary strings** (the harness's own text, no network). They are outside the
launch-settings fingerprint — none changes what an agent may do, so a ferret already running never reads as outdated — and
they land at the ferret's next launch. A key is written only where it is absent (a value the owner set to another one
stays, a nested object keeps its other keys); `lastReleaseNotesSeen` is the exception, as it is bookkeeping and not a choice.
Claude has the one rm sentence in its fixed instructions (`packages/plugins/claude-code/instructions/rm.md`): write rm
targets as explicit absolute paths, never `"$VAR"`, a `$(cmd)`-derived variable, or `rm` inside `bash -c`, so the guard does
not stop it. Codex has no such guard. **A ferret home never gets a Bash deny/ask permission rule or a `PermissionRequest`
hook from the fixed layer** — either silently voids the waivers — and a unit test fails if one appears. (A `PreToolUse` hook
is allowed: the rm guard's own may add one.)

**The project-MCP approval has no safe key.** `enableAllProjectMcpServers` approves EVERY server a folder's
`.mcp.json` ever declares, and 5.0 has no owner-approved per-server list to write instead; v4 never wrote it. So a
ferret launched in a folder with a new MCP server stops at that screen, and the owner is told once (below). An
`enableAllProjectMcpServers` the owner (or Claude, on their answer) already put in the home is never touched.

What no key answers is **told to the owner once** (`packages/plugins/warden/daemon/lib/dialog-watch.ts`): the Warden
reads each ferret's recorded `harnessDialog` or `permissionRequest` every 10 s and raises ONE plain notice on that
ferret's agenda per dialog **episode** — the same dialog on the same ferret is one episode, however many looks see it
and however often the owner closes the notice; a look that misses it twice in a row ends the episode, and a different
dialog starts a new one. The usage-limit dialog is the auto-move's, not this notice's. The Warden picks a row only through
a rule, below, and a rule never picks a row that trusts, approves or allows anything.

## Cleared at once by a rule (5.0, O14)

A screen a key can **dismiss or decline** should not wait for a person (a dangerous `rm` sat on its prompt for 1.5 minutes
before anyone noticed). In the same look that reads a ferret's dialog, the Warden checks it against a table of rules and,
for a match, presses the way out through the ferret's own terminal (Ferrets' form seam: the runner masks every read and
holds every key under `kernel.act(<pane>, 'keys')`, so a Vault hold presses nothing). A rule is
(harness, dialog kind, a FIXED title pattern, and for a harness phrase printed only on the frame, one fixed line) → **Esc**
or **the row whose label is exactly this**. Free pane text never picks a rule.

| Harness | Screen (`kind`)                                  | Rule id                     | Keys                                                        |
| ------- | ------------------------------------------------ | --------------------------- | ----------------------------------------------------------- |
| Claude  | "Dangerous rm operation detected" (`permission`) | `claude-dangerous-rm`       | Esc (the deny; see below)                                   |
| Claude  | New MCP server found (`mcp-servers`)             | `claude-mcp-servers`        | ↓/↑ to "Continue without using this MCP server", Enter      |
| Claude  | Settings Error (`settings-error`)                | `claude-settings-error`     | ↓/↑ to "Continue without these settings", Enter             |
| Claude  | LSP plugin recommendation (`other`)              | `claude-lsp-recommendation` | ↓/↑ to "No, not now", Enter                                 |
| Claude  | Claude in Chrome notice (`other`)                | `claude-chrome-notice`      | Esc (closes it; nothing is turned on; see below)            |
| Codex   | Hooks need review (`hooks-review`)               | `codex-hooks-review`        | ↓/↑ to "Continue without trusting (hooks won't run)", Enter |
| Codex   | The hook list (`hooks-list`)                     | `codex-hooks-list`          | Esc                                                         |
| Codex   | Update available (`update`)                      | `codex-update`              | ↓/↑ to "Skip", Enter                                        |
| Codex   | "Meet GPT-6 Sol" model successor (`other`)       | `codex-model-successor`     | ↓/↑ to "Use existing model", Enter                          |

What has **no** rule, and stays a notice: folder trust (its only ways out trust the folder or exit the ferret), the
sign-in screen, Codex's folder-access screens, the usage-limit screen (the auto-move's), a tool prompt that is not a
dangerous `rm`, and any screen this build has no name for.

**Never a grant.** A `choose` row must not read as granting (`yes`, `allow`, `always`, `approve`, `trust`, `use this…`, `don't ask
again`, `install`, `update now`…, unless it says _without_ / _not_), and the planner also refuses any row the harness marked
`grantsTrust`. That is checked three times: the rules file's schema, the table's own test (over every known screen), and the
planner at the moment of pressing. A screen whose only way out grants something has no plan and stays a notice.

**The Claude in Chrome notice has no rows**, so its rule is named three ways at once: the title `Claude in Chrome`, **no rows**
(`rows: none`: a screen that only shares the title, with rows to choose, is not it) and its own footer line "Enter to
continue · Esc to close" on the live frame. Anything less could press Esc on a Claude composer, where Esc interrupts work.
The same three are read from the **fresh frame itself** at the write, not only from the earlier record — and by the
terminal plugin's own dialog reader, not by a second parse in the Warden: the runner attaches what it read of that very frame
(title, row count, footer) to the capture, and the Warden presses only if the title and the exact footer match and the reader
counts zero rows. A fresh frame with the footer but another title, or with rows (a separator inside a row's details included,
which a line scan would lose), presses nothing and the owner is told.

**What a press looks like.** (1) The live frame is read and must still show the screen — the recorded dialog can lag, and Esc
on a pane that moved on would interrupt a turn — and the runner's own reader must say the KIND the rule presses on blocks it (a dialog for a row to choose, a permission prompt for Esc on one). (2) Arrows
move the cursor; the frame is read again and Enter is pressed only when the cursor is positively on the chosen row. **Every key is guarded where it is written:** the key port re-reads the pane immediately before it types and sends the key only if
that fresh frame still passes the same test as (1) (and, for the Enter that confirms a row, still has the cursor on it); a
frame that is unreadable or has moved on presses nothing and leaves the dialog to the notice. A **declared gap** remains: the
read and the key are two steps through the runner, so a pane that changes in the few milliseconds between them is not seen — the
guard narrows that window, it does not close it. (3) ONE
journal line: `fleet.warden_dialog_autocleared` (ferret, harness, kind, rule id) — no agenda item, no pane text. The same
dialog on the same ferret is never keyed twice; if the next look still sees it on screen the keys failed (or a hold refused
them) and the owner is told once, as before (`fleet.warden_dialog_clear_failed`). The look runs every 10 s.

**Dangerous `rm`: Esc, then a nudge — no hook.** Claude 2.1.317's prompt comes from a shell _parser_ inside the binary with
a dozen branches (an `rm` on a possibly-empty variable path, on a command substitution's output, in a `bash -c` script, an
`eval` trap, a parse it could not finish) — read off its strings, never by running it — so nothing here tries to predict it.
The Esc rule above declines it at once. Right after that Esc the Warden types ONE fixed message to the ferret (its own next
message; a queue if the pane is busy — never a hook, and never pane text) saying why the `rm` was denied: _use explicit
absolute rm paths; never "$VAR", a $(cmd) variable or rm inside bash -c_, so it retries with a path. The nudge is fire and
forget: a failed one changes nothing. The launch instruction `claude-code/instructions/rm.md` says the same up front.
`dangerousRmWaiver` stays off.

**Teaching Ferretry an unknown screen.** The notice for a screen no rule knows says how: leave the ferret on it, then
`fy warden dialog learn <ferret>` (or Settings › Warden › Screens Ferretry clears › "Look at its screen"). That reads the
ferret's current frame, MASKS it (the secret masker plus a shape pass) and keeps it in the Warden's own `0600` state
(`dialog-frames/<ferret>`, declared private) — never in the agenda, a log or a notice — and PROPOSES a rule from the screen's
own title and its decline or dismiss row (`--row N` picks another; a row that grants is held and can never be saved). Nothing is
saved until the owner says yes: `fy warden dialog learn <ferret> --confirm` or the app's "Save this rule". The rule is
written to `config/warden-dialogs.yaml` (`personOnly`, so no agent edits it; every added rule is a loosening, so an edit by
anyone but the owner is held for the owner, as every held config edit is) and the next appearance is cleared. A tool
permission prompt and the usage-limit screen are never taught.

**The notice carries no pane text.** A dialog's title, body and row labels, and a tool prompt's command, path or URL
(a `curl` with a bearer token, say), are served only to a caller holding `terminal.use`; the agenda carries no
capability and keeps every ask version. So the notice says only fixed words: "<ferret> is waiting on a <kind> prompt in
<harness>; open its terminal to read and choose", sits on that ferret's own board (the link to the ferret and its
terminal), and names no row. What the screen says is read in the terminal.

## Declared gaps

- **Survey and feedback (Claude).** "How is Claude doing this session? (optional)" with `1: Bad  2: Fine  3: Good  0: Dismiss`, and its
  follow-up "Can Anthropic look at your session transcript…", are strips under the composer, not modal dialogs: the composer stays
  live and there is no list to read. They need a live API session, so no pane could be captured offline; the text is from the
  2.1.327 binary's strings. `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1` in the launch environment (pinned by the fixed-layer test)
  keeps them away, which is the only answer Ferretry gives. No Codex survey was observed offline (Codex 0.170).
- **Launch screens that could not be captured offline.** Claude 2.1.327 checks api.anthropic.com before it draws its first-run
  theme picker, login-method screen and security notes, so none could be read; they remain covered by the home keys above and the
  startup answers. The "Resume session" picker (`claude --resume` with no id, which Ferretry never passes — it always names the
  session) has a list footer this reader does not name, so it is not read. Codex 0.170 draws its update as a banner above the
  composer, not a dialog, when it cannot self-update.

- **Codex hooks review picks the refusing row.** The rule `codex-hooks-review` presses "Continue without trusting (hooks won't
  run)" — the row that **refuses** trust, never "Trust all and continue" — so a ferret launched on a changed hook goes on
  without that hook rather than the hook being trusted for it. It is kept deliberately (accepted 2026-11-27): the alternative
  is a ferret parked on a screen nobody is watching. The consequence is that the hook does not run; the owner who wants it
  trusts it in the terminal. It never grants trust, and the planner would refuse a granting row anyway.
- **Esc guard window.** See "Every key is guarded where it is written" above: a pane that changes between the guard's read and
  the key's arrival at the terminal is not seen.
- **Which hooks.** The hook review says how many hooks are new, not which; the box shows what the pane
  shows. "Review hooks" opens Codex's own list, which the box can only close (Esc).
- **Signing in** from the box picks a sign-in method; finishing it (a browser, a device code) happens in
  the Console or on the machine.
- **Model-migration notices** could not be raised offline (they depend on the remote model list), so there
  is no fixture. The fixed layer hides the ones Codex 0.156.1 names (`[notice]`), and any other one is read
  as `other`.
- **Claude Code login expiry** is not a modal in 2.1.220 or 2.1.281: it prints in the conversation and the
  composer stays live, so it is not a dialog here.
