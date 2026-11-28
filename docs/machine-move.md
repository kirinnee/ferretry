# Move a ferret to another machine

A ferret can move from one machine you have paired to another: **Actions › Move to another machine…** on its page. This page is
the contract of that move: what crosses, what never does, who carries it, who may do it, and what each machine keeps.
The code is `packages/plugins/relocate` (`contract/wire.ts` holds the table below as data); the acceptance that proves it
against two real daemons is `packages/plugins/relocate/tests/sit/two-daemons.sit.test.ts`.

## 1. Who talks to whom

**No machine talks to another machine.** The app holds a session on both and carries sealed bytes between them, over sessions it
already has (the same precedent as the secrets clone, [cross-daemon.md](cross-daemon.md) §4). Nothing is paired by a move
([pairing.md](pairing.md) is untouched), no peer credential exists, and no bearer value is made.

| Step | Machine | Route                                              | What it does                                                                                                    |
| ---- | ------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1    | target  | `POST /v1/relocate/offers`                         | Opens a one-time X25519 key, signed with the target's daemon identity, good for five minutes, in memory only.   |
| 2    | source  | `POST /v1/relocate/:ferretId/preflight`            | Says what would move, what stays, what the target must have, and why a move cannot start.                       |
| 2    | target  | `POST /v1/relocate/offers/:offerId/preflight`      | Says whether it has the project, a login for the harness and the secret **names** the ferret needs.             |
| 3    | source  | `POST /v1/relocate/:ferretId/export`               | Stops the ferret politely at its prompt, snapshots it and seals it to the target's offer.                       |
| 3    | source  | `GET /v1/relocate/exports/:exportId/chunks/:index` | One sealed chunk (ciphertext).                                                                                  |
| 3    | target  | `PUT /v1/relocate/offers/:offerId/chunks/:index`   | Receives the same chunk, in memory only.                                                                        |
| 4    | target  | `POST /v1/relocate/offers/:offerId/import`         | Verifies every hash, builds the working tree and restores a stopped ferret.                                     |
| 5    | source  | `POST /v1/relocate/exports/:exportId/complete`     | Durably fences the source read-only and records where the ferret went.                                          |
| 6    | target  | `POST /v1/relocate/imports/:ferretId/start`        | Resumes the imported ferret on its own login, only after the app confirms step 5.                               |
| —    | source  | `POST /v1/relocate/exports/release`                | Person-initiated reconciliation: confirms the named source is stopped or fenced, then discards its held export. |
| —    | source  | `GET /v1/relocate/moved`                           | The stub ledger (ids and instants), so the fleet list can say "Moved to <machine>".                             |

The app's own flow is `app/lib/move.ts` (`review`, then `carry`); the dialog (`app/features/move-machine.tsx`) only draws it. The
SIT drives the same two functions against two real daemons.

## 2. What moves, and what does not

| Moves (hashed per file, sealed)                                                                             | Does not move                                                          | Why not                                                                      |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Its name, role, harness, runtime **name**, model, effort                                                    | `environment.json`, `tokens.json`, the ferret's session credential     | credentials: the target mints its own                                        |
| Its **turns**, queued messages and **attachments**, byte for byte, into the new ferret's own session folder | `auth.json`, `session-env`, `paste-cache`, `shell-snapshots`           | secret-bearing                                                               |
| Its conversation, in its own harness's format, re-keyed to the target's working tree                        | Ignored files (`node_modules`, `.env`, build output)                   | `.env` is a secret and the rest is rebuilt; the preflight lists them by name |
| Its branch as a git bundle, uncommitted tracked changes as a binary patch, new files git does not ignore    | New files **named like a secret** (`.env.local`, `*.pem`, `id_*`)      | a name that says secret never travels, even when git does not ignore it      |
| The `${secret:NAME}` **names** its launch refers to                                                         | Any secret value, any runtime login                                    | no secret crosses; the target uses its own login and its own secrets by name |
| —                                                                                                           | Browser pages, identities, cookies                                     | logins are per machine                                                       |
| —                                                                                                           | Background jobs, terminals                                             | a move refuses while one is running                                          |
| —                                                                                                           | Conversation's delivery record, agenda items, board tasks, the journal | they stay on the source with the stub; the conversation carries the words    |

A bundle over **500 MB** is refused at preflight, naming what is large.
A move also refuses if another ferret shares its folder; put the ferret in a separate folder first.

## 3. What a person is asked

1. **Pick** a usable paired machine. Offline machines and machines without the required authority are omitted.
2. **Review**: both machines' answers as one table: what moves, what stays, what is left behind by name, and every refusal with the
   machine that said it. A missing secret is named, never shown. Nothing has been sent yet.
3. **Move**: progress through _stopping and sealing_, _carrying_ (chunk _n_ of _m_), _setting it up_ and _leaving a note_. A device
   that wants a passkey is asked **on each machine** (`press` on that machine's session): the move is a fleet write
   (`fleet.configure`) that also reads one working tree and writes another (`filesystem.use`) on **both** machines.
4. **Open on <machine>** when it is done.

## 4. Who may do it

Every relocate route is a person's (`caller: 'person'`) and needs `fleet.configure` and `filesystem.use` on **both** machines. A
governed device steps up with its passkey, as for any `fleet.configure` act. A limited device is refused on both. A ferret can
never move itself or another ([grants.md](grants.md)). Reading the stub ledger needs only `fleet.use`.

## 5. What is guaranteed

- **No secret value, key or plaintext crosses where the app can see it.** The app carries AES-256-GCM ciphertext sealed to the
  target's one-time key; the target's private key never leaves its memory. Before sealing, the source checks every byte against
  the daemon's known secret values and refuses the move naming only the secret's **name** and the file.
- **The sender is proved.** The target is told which machine the app chose as the source, and the sealed header is signed with the
  source's daemon identity; the two must agree before anything is written.
- **The target writes nothing until everything is proved**: the offer is open and spent on first use, every chunk authenticates, every
  hash holds, the harness, the login, the secret names and the project are all there. A project is cloned only from an approved
  `https` or `ssh` address, with git's filters, hooks and local config switched off, and the tree and patch are audited (no path
  outside the tree, no `.git/`, no escaping link, no submodule) **before** any persistent git write.
- **A failure takes back exactly what this import made and nothing else**; the moved working tree is written only through the
  kernel's `worktrees` root, which refuses a `..` or a link out.
- **The source keeps every original byte.** Completing a move permanently protects its stopped source copy. The daemon refuses
  mutations (including send, resume, rename, new starts in its folder or subfolders, terminal and shared-draft socket writes,
  worktree move/removal and runtime repoint) with
  “This ferret moved to <machine> and is read-only here.” This survives a daemon restart and turning Relocate off. The app hides
  mutation actions, the composer and terminal modes, and shows “Moved to <machine>” with “Open there”. The original worktree,
  transcript, turns and attachments remain untouched; a separate daemon-owned fence records the destination. There is no
  owner-remove exception or resume action for this stub.
- **At most one copy runs.** Import restores B without launching a process. A must confirm its durable read-only fence before
  the app starts B. If that confirmation is interrupted, B stays imported and stopped, and the app says “Moved, not started”,
  why it stopped, and to confirm A's fence before explicitly starting B. Once any ciphertext chunk is handed out, expiry never
  resumes A; it retains completion for retry. A lost completion reply can be retried with the same export id and destination,
  including after A restarts following durable completion. A different destination is refused. An unconfirmed receipt says
  A's current state is unknown, since a restart can forget a transfer before its fence was written.
  **Check for an interrupted move** explicitly asks A, including after reopening the dialog or choosing Start over; a required
  passkey or refusal is shown, and the check can be retried. No recovery check runs automatically. A's Actions entry remains
  available when B is offline, with recovery only. **Release this move** appears when A confirms a held export for this ferret
  (never another ferret's): it confirms A is stopped or fenced
  before freeing the export slot, never resumes A, and removes the completion retry for a released transfer. It does not
  cancel or delete a partial import on B; check both machines before deliberately resuming either copy.
  A lost start answer reports B's state as
  unknown and keeps A fenced. While moving, Escape, the backdrop and Close cannot dismiss the receipt.
- **A damaged fence refuses writes.** Fence loading or corruption returns `503 fence_unavailable` for mutations. Ferret,
  transcript and terminal reads, and other features, keep working. A missing fence is never inferred from a damaged file.
- **A partial import is a recovery receipt.** If turns/attachments or origin could not be recorded during import, B stays stopped; the app shows
  the recovery message, the target's actual running/stopped/unknown state, its ferret id and its folder, with an Open action.

## 6. Declared gaps

- **The journal** (`history.jsonl`) is sealed and verified but is not replayed into the new ferret's own journal: it stays with
  the stub on the source, and the conversation carries the words.
- **An interrupted move** restarts from the beginning; a chunked resume over the relay from a phone is a later unit.
- **Automatic Cancel across machines** is deferred: it would have to fence B before restoring A. Keep the receipt, confirm
  A's fence, then start B explicitly, or retry completion. If A restarts before completion, its in-memory export is lost and
  the stopped imports need explicit reconciliation; B is never started automatically without confirmation of A's fence.
- **Overlapping folders**: preflight refuses exact shared folders; nested source folders are not yet excluded.
- **Symlink twins**: folder comparisons normalize paths but do not resolve filesystem symlinks.
- **Audit naming**: the imported-start route retains the cosmetic `imported` audit label.
- **The fleet list's "Moved to" mark** is drawn only for a row that has a runtime, as every list-row mark is.
- **The real Claude or Codex resume on the target** is the owner's walk; the acceptance runs a scripted harness CLI.
