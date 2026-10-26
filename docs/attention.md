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
| Raise         | the ferret: `fy attention add "<summary>"`      | One push to every enrolled device, titled with the conversation, saying what is needed (see below). The session's row turns **unread**.         |
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

## What an item says

The owner reads an item cold, often on a phone, often days later. So an item is **structured**, and every
part is written for a reader who has not been following. The wire shape is `AttentionBriefShape` in
`packages/protocol/src/lib/attention.ts`. Every part is optional except the summary, so an item raised
before the structure existed still reads.

| Part             | Field                        | What it holds                                                                    |
| ---------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| Summary          | `subject`                    | One line: what is needed. Drawn bold, once — never repeated as a title or `why`. |
| Context          | `context`                    | What is happening and why it matters, in a few sentences. Markdown.              |
| Terms            | `terms[]` `{term, meaning}`  | Every codename or term of art the item uses, spelled out. At most 12.            |
| Questions        | `questions[]`                | One per decision: `question`, optional `options`, `recommended` and `why`. ≤ 6.  |
| Recommendation   | `recommendation`             | The overall suggested decision `{decision, why?}`.                               |
| Impact / urgency | `impact`, `urgency`          | What happens if nobody answers, and by when, in words.                           |
| Links            | `links[]` `{label?, target}` | PRs, files and references (`#F12`, `@file`, a URL). At most 10.                  |

- **A question's `recommended`** names one of its options when it has options (the schema refuses
  anything else), and is the suggested answer in words when it has none.
- **The ask follows the questions.** `fy attention add` makes exactly one question with options a
  `multiple-choice` ask between them, and several questions an `open-question`. So only a single-question
  item has options the swipe deck can map. Several questions are answered one by one, and the board sends
  them as ONE open answer, numbered by question.
- **Where it is drawn.** The inbox card, the in-ferret panel and the item page title an item with its
  **conversation's name** (the session's task title). The ferret and the machine are the subtitle. Then
  comes the summary in bold, and collapsible Context · Terms · Questions · Recommendation · Impact · Links.
  The recommended option is marked "Recommended".
- **Raising one.** It can be raised from flags (`--context`, `--term "X=meaning"`, `--question`,
  `--option`, `--recommend`, `--recommend-why`, `--impact`, `--urgency`, `--link`) or from a JSON body
  (`--json-file <path>`, `-` for stdin), where a flag wins over the same field. `fy attention add --help`
  prints the JSON shape. Every length is checked before anything is sent, and a refusal names the field.

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

Every push names a page, and the worker opens a page even when one does not:

- **`fy attention notify`** opens the conversation it came from: `/session/<id>`
  (`sessionNotificationPath`).
- **A push that names no page it may open** opens the conversation its `sessionId` names, on its
  machine. A daemon older than #768 sent every push with `url: '/'`, an ask included. A push about no
  conversation (a new device, enrolment, a passkey) opens that machine's sessions.
- **Which window.** An app window wins over the landing page, which has no router. Among app windows,
  the one the reader is looking at wins.
- **How the window gets there.** The worker brings the window forward and asks the app to route there
  in place (`packages/pwa/src/lib/notification-open.ts`). The app's entry point listens before React
  mounts, so a tap that lands while the app is still starting is routed once it is up. It moves the app
  to the tapped machine, and the conversation opens at the item, again on every new tap.
- **A window that never answers** (an app too old for the message) cannot be navigated by a machine's
  worker, which controls no page. So the worker opens the conversation in a window of its own.
- **Old workers.** The browser never re-checks a machine's push worker on its own, because no page loads
  under `/push/<daemonId>/`. So the app asks for each machine's worker update at every start
  (`containerPushEnrolment.reconcile`). Without that, a phone enrolled before a fix kept the old tap.

`packages/pwa/tests/integration/notification-open.test.ts` proves each case in Chromium, through the
built worker.

Every notification carries the Ferretry mark: `icons/icon-192.png` as its icon, and `icons/badge-96.png`
as its badge. The badge is the mono logomark on transparent, because Android paints a badge from its
alpha alone. iOS has no badge and ignores it. The manifest also names the badge as its `monochrome`
icon, and its home-screen icons are maskable (the art carries its own safe zone).

**What an Attention push says.** The title is the conversation's name, quoted, then the ferret:
`“OCI work login” · Olivier`. It is just `“Olivier”` when the session has no name of its own. The body
says what the issue is, one line each:

1. the summary — or the first question, when the summary only repeats the title;
2. `Recommended: <option or decision>`, when the ferret recommended one;
3. the other choices: `Or: A · B`, or `Options: A · B` when nothing is recommended.

The title always starts with a quote mark. A session's name is an agent's own words, so it can never
open with the daemon's new-device alert title.

### Edge on Android shows Edge's icon, and we cannot change that

On Android, only **Chrome (on devices with Google Play services) and Samsung Internet** install a PWA
as a real app, a **WebAPK**. Every other browser, Edge included, adds a browser-badged home-screen
shortcut ([MDN, "Making PWAs installable"](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)).
A push is then posted by the browser's own Android app. So the status bar's small icon and the app
name on the notification are **Edge's**, whatever `badge`, `icon` or manifest icons the page names.
Edge does not paint our `badge` into the status bar as Chrome does. Our `icon` still shows as the
notification's large image where Android draws one.

Everything a page controls is set: the `badge`, the `icon`, the `monochrome` manifest icon and the
maskable icons. **The remedy is the browser**: install Ferretry from Chrome on Android. A WebAPK posts
notifications as Ferretry, with the mono mark in the status bar.

## Every automatic push, and why it stays or goes

| Path                                           | Where                                    | Decision                                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An Attention item is created                   | daemon `NotificationService`             | **The** notification. Once per item (the key is session + item).                                                                                                 |
| `fy attention notify` (push without an item)   | daemon `POST …/notify`                   | Kept for compatibility. It is explicit and audited, and the prompt does not advertise it. A tap opens the conversation it came from.                             |
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
