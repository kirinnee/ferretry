# Keeping existing conversations as ferrets

An owner who used Claude Code or Codex before Ferretry already has conversations on the machine. They
can keep any of them "on" as a ferret from the import picker (onboarding's Claude Code / Codex steps, and
Settings › Runtimes › Import conversations…). The CLI equivalent is `fy import conversations`.

New session › Continue a conversation picks up earlier work (`fy new --continue` searches the second source), from
one of two sources:

- **Ferretry sessions** — every stopped ferret on the machine, resumed in place with its conversation
  intact through the session's own resume.
- **All conversations** — Ferretry's shared history (`ferretry`) and, while **Keep in sync** is on,
  the conversations in the computer's own Claude Code and Codex homes (`computer`) — one list, asked for
  with `source=synced`. A row kept only in the computer's home is marked **On this computer**
  (`keptIn: 'computer'`) and has its own filter chip. A conversation a stopped ferret keeps resumes that
  ferret; one a running ferret keeps opens it; any other is **adopted on the spot** (hard-linked into
  the runtime's history, never copied or moved) and started with the CLI's own resume.

### Keep in sync

Settings › Machine › Conversations › **Keep in sync** is `machine.conversations.listComputer` in
`machine.yaml`, **on by default**. It governs LISTING only:

- On: a `source=synced` listing also reads the computer's homes. They are read when the list is opened
  (and on `fy import conversations` / `fy new --continue`); there is no timer, so a conversation begun in
  the owner's own terminal a minute ago is simply there the next time the list opens. Read-only: the
  daemon never writes a computer home, and nothing is imported until the owner continues one.
- Off: a `synced` listing reads Ferretry's history only and says `computerListed: false`, so the
  Continue list can say why nothing from the computer is shown. Continuing a conversation the owner names
  (`adopt`) still reads the computer's home; so does `source=computer` and a listing with no `source`
  (onboarding's import picker and `fy import conversations` ask for both homes whatever the switch says).
- Read fresh for every listing, so flipping it applies to the next open with no restart. Switching it on
  is not a "loosening" edit: it widens no agent's authority, only what the owner's own browser lists.
- Deduped: an adopted conversation is one file under two names, so it is listed once, as Ferretry's
  (`keptIn: 'ferretry'`), and a conversation a session already keeps is never offered as new.
- Per machine: every daemon lists its own computer's homes, so in the all-machines view each machine's rows
  are its own and carry that machine's switch.

Tapping a row shows its last few exchanges (`GET /v1/imports/conversations/:harness/:id/preview`, four
exchanges, each message cut to 280 characters) before the button that continues it.

The wire contract is `packages/protocol/src/lib/conversation-import.ts`; the daemon side is
`packages/daemon/src/lib/imports/conversations.ts` (discovery, search, adoption rules) and
`createConversationAdopter` in `packages/daemon/bin/fyd.ts` (the session it creates).

## What is read

- **Where:** Ferretry's shared history pool (`<FY_HOME>/fleet/shared/<harness>`, `source=ferretry`)
  first, then the CLI's own home as the daemon inherited it (an absolute `CLAUDE_CONFIG_DIR`, else
  `~/.claude`; an absolute `CODEX_HOME`, else `~/.codex`; `source=computer`; the same on macOS and
  Linux, only the user's home differs). A RELATIVE variable is never guessed at: Claude falls back to
  `~/.claude`, Codex reads nothing from the computer. A listing with no `source` reads both;
  `source=synced` is both unless Keep in sync is off.
  Claude: `projects/<folder>/<id>.jsonl` (a conversation's sub-agent files are not listed). Codex:
  `sessions/YYYY/MM/DD/rollout-*.jsonl`. Links are never followed.
- **Name:** every row leads with its NAME when the CLI gave one (`name`, 120 characters); the first
  message is then the secondary line, and an unnamed conversation is headed by the first message. Claude
  Code: the transcript's `custom-title` / `agent-name` records (what `/rename` writes) outrank its
  generated `ai-title` / `summary` records, the latest of each winning. Codex: the thread name from
  `<home>/session_index.jsonl` (its last 1 MiB, the latest line per id), else the rollout's
  `thread_name_updated` event. A Ferretry session's row is headed by the ferret's own name, with the
  conversation's name under it. Search matches names too (`lib/imports/conversation-name.ts`).
- **What:** metadata only, through the same parsers managed sessions use: the project folder, the first
  and latest thing the owner typed (each cut to 120 characters), the last activity, the turn count, the
  model, and which session already keeps it. A message is what the owner SAID: a turn-file pointer
  ("Read the file …/turns/turn-NNN.md now, …", written by Ferretry or by kteam) is replaced by the task in
  that file, read at most 64 KiB and only from a session's own folder or `~/.kteam`; a pointer whose file
  is gone says nothing, so the next real message describes the conversation. Reminder blocks, the
  delivered-files list, interruption markers and text the CLI injected (anything opening with a tag) are
  dropped the same way (`lib/imports/conversation-text.ts`). Search (`q`, `harness`, `since`, `limit`) runs on the daemon over that index, which is
  re-parsed only when a file's size or time changes.
- **How much:** never a whole large file. A transcript of up to 8 MiB is read whole; a larger one only
  its first and last 4 MiB, cut to whole records (`CONVERSATION_HEAD_READ_MAX_BYTES` /
  `CONVERSATION_TAIL_READ_MAX_BYTES`). Everything a row says lives at one end — the folder and first
  message at the start, the latest message, model and last activity at the end — except the turn
  count, which then counts only the messages read and is marked `turnsAtLeast` (shown as "N+ turns").
  The preview reads the same way. An adopted conversation is one file with two names, listed from both
  homes, so this bound is what keeps a 200 MB one from being held in memory twice per listing.
- **Who may:** every route is `fleet.configure`. A caller off the host needs the passkey step-up. The
  answers carry no whole transcript and no file path, only to the owner's own devices.

## What adoption does

Adopting is a **person's** act (`caller: 'person'`): an adopted conversation is a new top-level ferret, and a
ferret starts sessions only as its own children, so a ferret's own credential is refused `403 owner_only`. A
ferret may still list and preview ([agent-tools.md](agent-tools.md#who-a-ferret-may-be-every-route-says)).

1. Re-discovers the conversation by its CLI id (a client never names a path).
2. Refuses it if a session already keeps it (`already_adopted`), or if the runtime drives the other CLI
   (`harness_mismatch`).
3. Makes the file visible in the runtime's history at the same relative path with a **hard link**: one
   file, two names. Never a copy (two files would each look like the conversation), never a symbolic
   link (the state home refuses links that leave it). The owner's file is not changed by Ferretry.
4. Creates the session through the start pipeline (account, canonical folder, spawn stamp, auto name,
   plan) with `--resume <id>` (Claude) or `resume <id>` (Codex) on the argv, and a transcript record of
   identity `adopted` naming the runtime's view of the same file, so Chat shows the history at once.
5. Leaves it **stopped** unless the owner switched "Start now" on. At most 10 may start in one request.
   A stopped ferret resumes the same conversation when started, because a revive re-runs that argv.

## Declared GAPs

- **Same disk only.** A hard link cannot cross filesystems; a CLI home on another disk from `FY_HOME`
  is refused with that sentence rather than copied.
- **Resuming appends to the owner's file.** That is the point (one conversation, one file), but it means
  the owner's own `claude --resume` in a terminal sees the ferret's turns too, and the one-live-writer
  lease only knows writers Ferretry launched.
- **Codex resume by id** relies on Codex finding the rollout under `CODEX_HOME/sessions`, which the link
  provides; a Codex build that resolves ids only from its own database would not find it.
