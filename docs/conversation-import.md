# Keeping existing conversations as ferrets

An owner who used Claude Code or Codex before Ferretry already has conversations on the machine. They
can keep any of them "on" as a ferret, either from the import picker (onboarding's Claude Code / Codex
steps, and Settings › Runtimes › Import conversations…) or from New session › Continue a conversation.
The CLI equivalents are `fy import conversations` and `fy new --continue`.

The wire contract is `packages/protocol/src/lib/conversation-import.ts`; the daemon side is
`packages/daemon/src/lib/imports/conversations.ts` (discovery, search, adoption rules) and
`createConversationAdopter` in `packages/daemon/bin/fyd.ts` (the session it creates).

## What is read

- **Where:** Ferretry's shared history pool (`<FY_HOME>/fleet/shared/<harness>`) first, then the CLI's
  own home as the daemon inherited it (`CLAUDE_CONFIG_DIR` or `~/.claude`; `CODEX_HOME` or `~/.codex`).
  Claude: `projects/<folder>/<id>.jsonl` (a conversation's sub-agent files are not listed). Codex:
  `sessions/YYYY/MM/DD/rollout-*.jsonl`. Links are never followed.
- **What:** metadata only, through the same parsers managed sessions use: the project folder, the first
  and latest thing the owner typed (each cut to 120 characters), the last activity, the turn count, the
  model, and which session already keeps it. Text the CLI injected (anything opening with a tag) is not
  a preview. Search (`q`, `harness`, `since`, `limit`) runs on the daemon over that index, which is
  re-parsed only when a file's size or time changes.
- **Who may:** both routes are `fleet.configure`. A caller off the host needs the passkey step-up. The
  answers carry no transcript and no file path, only to the owner's own devices.

## What adoption does

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
