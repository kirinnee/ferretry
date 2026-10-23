# Attention

**Notifications are Attention.** A ferret that needs the owner to decide or do something raises an
Attention item. That one act notifies the owner. The item then stays until it is answered, done or
dismissed. A ferret that is only waiting, or has just finished, pushes nothing.

This document is the contract for that loop. The board's own rules are in
`packages/daemon/src/lib/attention/state-machine.ts`, and the wire shapes are in
`packages/protocol/src/lib/attention.ts`.

## The loop

| Step          | Who                                             | What happens                                                                                                                                    |
| ------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Raise         | the ferret: `fy attention add "<ask>"`          | One push to every enrolled device: `“<ferret>”: <ask>`, with the context and the options in the body. The session's row turns **unread**.       |
| Answer        | the owner: the board, the inbox or a push tap   | The ferret receives `[answer to !A3 «<ask>»] <answer>` as an ordinary message. The item resolves.                                               |
| Reply in chat | the owner writes `!A3 …` in that ferret's chat  | That message is the answer: it is delivered prefixed `[answer to !A3 «<ask>»]`, and once it is accepted the item resolves in the owner's name.  |
| Plain chat    | the owner writes without referencing an item    | Nothing resolves. The message ends with one line naming the open items, so the ferret can resolve one itself if the message settled it.         |
| Done          | the ferret: `fy attention done A3 [--answer …]` | The ferret closes its own item once it is no longer needed. Nothing is echoed back to it.                                                       |
| Dismiss       | the owner, or the ferret for its own items      | Closed without an answer. The ferret is told only when the owner wrote a note, so a bare dismissal never revives a finished ferret for nothing. |

- **An agent changes only its own session's board.** The resolution audit records who closed every
  item: `resolvedBy` is `human`, `agent` (with its session) or `daemon`.
- **Any item may be resolved without an answer.** A structured ask (a choice, a permission, a review)
  can be settled in words. The owner's note carries those words to the ferret. An answer, when given,
  must still match the ask.
- **A chat answer takes the strongest form its ask accepts.** An open question takes the words as its
  answer. A choice takes them only when they name one option exactly. Anything else resolves the item
  with the message as its note.
- **The delivery is detached and idempotent.** Each item's answer is sent under the send id
  `attention-<session>-<id>`, so a notice told twice is one message. The owner's answer never waits
  for a ferret's launch or revive.

## The unread signal

`SessionView.state.attention` is `{ open, first, ask, latestAt }` while anything is open, and absent
otherwise. Absent always means "nothing waits on the owner", never "unknown".

- The daemon rewrites it after every board change. It re-reads the board under one lock per session,
  so an out-of-order notice can never show an answered item as open.
- Every board change also journals `attention.changed`. The fleet feed watches that, so lists update
  without polling.
- On start, the daemon reconciles every session once, in the background. That covers boards that
  moved before summaries existed, or while it was down.
- It clears only when items resolve. Viewing a conversation does not clear it.

## Where a tap goes

The push's `url` is relative to the machine's own pages: `/session/<id>?attention=A3`
(`attentionNotificationPath`). The daemon never knows which name a browser files it under. The
browser's per-machine push worker places the path under that machine, so it opens
`/d/<daemonId>/session/<id>?attention=A3` (`packages/pwa/src/lib/push-scope.ts`). It reuses an open app
window when there is one, whichever worker controls it, and never a sign-in popup.

Every notification carries the Ferretry mark: `icons/icon-192.png` as its icon, and `icons/badge-96.png`
as its badge. The badge is the mono logomark on transparent, because Android paints a badge from its
alpha alone. iOS has no badge and ignores it.

The title always starts with the quoted ferret name. An ask is an agent's own words, so it can never
open with the daemon's new-device alert title.

## Every automatic push, and why it stays or goes

| Path                                           | Where                                    | Decision                                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An Attention item is created                   | daemon `NotificationService`             | **The** notification. Once per item (the key is session + item).                                                                                                 |
| `fy attention notify` (push without an item)   | daemon `POST …/notify`                   | Kept for compatibility. It is explicit and audited, and the prompt does not advertise it.                                                                        |
| Enrolment confirmation                         | daemon `PushService.register`            | Kept. One push, only to the browser that just enrolled.                                                                                                          |
| A new device was paired                        | daemon audit log                         | Kept. This is a security alert.                                                                                                                                  |
| A session starts, finishes or idles            | daemon                                   | Never pushed (unchanged).                                                                                                                                        |
| Your turn / `awaiting_user` (a ferret waiting) | PWA page watcher (`notification-ledger`) | **Removed.** Waiting is not an ask.                                                                                                                              |
| `completed` (a ferret finished)                | PWA page watcher                         | **Removed.** Finishing is not an ask.                                                                                                                            |
| `needs-input` / `awaiting_question`            | PWA page watcher                         | Kept. The harness is parked on a blocking prompt it owns (a permission prompt, a dialog, a structured question), and the ferret cannot raise an item from there. |
| `failed` / `stalled` / `kill_failed`           | PWA page watcher                         | Kept. A dead ferret cannot raise an item.                                                                                                                        |
| Notifications a device's own filter hides      | push worker                              | Kept as one quiet, silent line per machine (a push that shows nothing gets a subscription revoked). Now carries the mark.                                        |

## GAPs

- **Page-level notifications for a new item.** A device with no push enrolment learns about an item only
  from the unread mark while the app is open. The page watcher could announce `state.attention`
  increases too, but it would need the push worker's tag to avoid doubles.
- **A chat message that answers several items** gives each item the whole message (minus the references).
  It does not split the words per item.
