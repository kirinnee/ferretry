# Attention

**Notifications are Attention.** A ferret that needs the owner to decide or do something raises an
Attention item. That one act notifies the owner. The item then stays until it is answered, done or
dismissed. A ferret that is only waiting, or has just finished, pushes nothing.

This document is the contract for that loop. The board's own rules are in
`packages/daemon/src/lib/attention/state-machine.ts`, and the wire shapes are in
`packages/protocol/src/lib/attention.ts`.

## The loop

| Step            | Who                                                                                 | What happens                                                                                                                                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raise           | the ferret: `fy attention add "<summary>"`                                          | One push to every enrolled device, titled with the conversation, saying what is needed (see below). The session's row turns **unread**.                                                                                                                                                                                           |
| Answer          | the owner: the board, the inbox or a push tap                                       | The item resolves. A few seconds later the ferret receives `[answer to !A3 «<ask>»] <answer>`, in one message with any other answers given meanwhile.                                                                                                                                                                             |
| Reply in chat   | the owner writes `!A3 …` in that ferret's chat                                      | That message is the answer: it is delivered prefixed `[answer to !A3 «<ask>»]`, and once it is accepted the item resolves in the owner's name.                                                                                                                                                                                    |
| Plain chat      | the owner writes without referencing an item                                        | Nothing resolves. The message ends with one line naming the open items, so the ferret can resolve one itself if the message settled it.                                                                                                                                                                                           |
| Done            | the ferret: `fy attention done A3 [--answer …]`                                     | The ferret closes its own item once it is no longer needed. Nothing is echoed back to it.                                                                                                                                                                                                                                         |
| Done (owner)    | the owner: the board, or `fy attention done` at their own shell                     | The ferret receives `[done !A3 «<ask>»] The owner marked this done.`, or `[answer to !A3 «<ask>»] <note>` when the owner wrote one.                                                                                                                                                                                               |
| Dismiss         | the owner, or the ferret for its own items                                          | Closed without an answer. When the owner dismisses, the ferret receives `[dismissed !A3 «<ask>»]` with the owner's note, or "The owner dismissed this without an answer."                                                                                                                                                         |
| Progress        | the owner, or the ferret on its own item                                            | `{action:'progress', id, step, done}` ticks or unticks one step. The item stays open; nothing is pushed and the ferret is told nothing. Lists re-read (a `progressed` board change).                                                                                                                                              |
| Need more info  | the owner: the board, or `fy attention needs-info A3 [--note …]` at their own shell | Owner only, on an open item a ferret raised. The item **stays open** and is marked `waitingOn: 'ferret'` (`askedAt`), so the app shows "waiting on the ferret". The ferret receives `[needs more info !A3 «<ask>»] <note>` ("The owner needs more information." with no note), batched like an answer. It never pushes the owner. |
| More info added | the ferret: `fy attention edit A3 …` on that item                                   | The mark clears, the history gains an `updated` entry and the owner gets **one** push, "Updated: more info added — <summary>", titled and opened like the first. Only an edit that answers an open request pushes; an ordinary edit never does. `fy attention done` also ends the wait.                                           |
| Harness prompt  | the daemon, when a ferret's harness parks on a prompt it owns                       | One `question` item per wait (see below), pushed once. Answering it on the board types the answer into the form. It clears itself when the wait ends.                                                                                                                                                                             |

- **Need more info is exactly once per request.** Each request bumps the item's `infoRequests`. The
  delivery is keyed `A3~<n>` in the reply outbox (answers keep the plain `A3`), so a replay re-sends
  nothing and a second request after the ferret replied is a new delivery. Asking again while the ferret
  has not answered is the same request. The push for the edit is keyed `attention:<session>:A3:info-<n>`,
  and the state machine clears the mark in the same commit, so a retried edit is no change and pushes
  nothing. `history` keeps the last 20 `{at, kind: 'needs-info'|'updated', note?}` entries, oldest dropped,
  so the app can say "You asked for more info 10:42 · updated 10:44". Closing the item drops the mark.
- **Raising takes the explicit `add` verb.** `fy attention` has no default command: a first word that is
  not a verb (`fy attention show A6`, a typo, a bare sentence) is refused with "unknown command" and the
  verbs on offer, and exits non-zero. A raise pushes to the owner's phone, so a mistyped read must never
  become one. `fy attention show <id>` prints one item, open or resolved, read-only.
- **Who raised it is decided by the pane, not the words.** `fy attention` sends the client header and,
  inside a ferret, that ferret's `FY_SESSION_ID` as `x-ferretry-session-id`. The daemon attributes the
  call to `peer:<session>`, so the item is `raisedBy: agent` with `raisedBySession` set, and the push
  ledger's attribution is `attention:agent:<session>`. At the owner's own shell no session header is
  sent, so the call is the human's. **Until this was fixed the CLI sent neither header**, so every ferret's raise
  was stored as the human's, and its answer was never delivered: the delivery tells only the ferret
  that asked, and the board said nobody had.
- **A harness prompt is an item too.** "Needs you" is exactly the set of sessions with open items, so
  a harness parked on its own prompt is raised as one, by the daemon (`raisedBy: daemon`, cause
  `harness-prompt`, `source: question`), from the state documents storage writes
  (`packages/daemon/src/lib/attention/harness-prompt.ts`):
  - **A structured question** (`state.pendingQuestion`) raises one item whose `sourceRef` is the
    question's tool id. Its summary is the first question, its `questions` are the form's. One
    single-choice question with valid options is a `multiple-choice` ask; anything else is an
    `open-question`, answered one by one in the board's numbered reply.
  - **Any other blocking prompt** (`turnState: needs-input`: a permission prompt, a dialog) raises one
    item with `sourceRef: prompt:<the prompt's id>` and no ask. It says to answer it in the Console.
  - **The wait ends, the item resolves**, in the daemon's name: the question is answered or replaced,
    the turn leaves `needs-input`, or the session ends. Start-up reconciles every session once.
  - **One item per wait, ever.** A wait whose item was answered or dismissed is never raised again,
    because the board's resolved history remembers it. A restart, a repeated state write or a
    dismissal never pushes twice.
  - **The owner's board answer is typed into the form** through the same answer path the Console
    uses (`SessionAnswerSubsystem` → `StructuredQuestionService`), detached from the answer itself.
    A chat reply (`!A3 …`) is not driven: its words already went to the ferret. A dismissal leaves the
    form parked. Nothing is sent to the ferret as a message, because the item is not agent-raised.
  - **An answer that does not reach the form** is journalled as `attention.harness_answer_failed`.
    While the form is still open, the question is raised again as a new item that says the answer did
    not go through. The answered item stays in the audit as the owner's answer.
- **An agent changes only its own session's board.** The resolution audit records who closed every
  item: `resolvedBy` is `human`, `agent` (with its session) or `daemon`.
- **Any item may be resolved without an answer.** A structured ask (a choice, a permission, a review)
  can be settled in words. The owner's note carries those words to the ferret. An answer, when given,
  must still match the ask.
- **A chat answer takes the strongest form its ask accepts.** An open question takes the words as its
  answer. A choice takes them only when they name one option exactly. Anything else resolves the item
  with the message as its note.
- **Answers are batched per ferret.** The delivered message wakes the ferret: it starts the ferret's
  next turn. So answers to one ferret are held in its outbox (`attention-replies.json` beside the
  board) and delivered as **one message**. Inside it, each answer reads in the form above, a blank
  line apart (`AttentionReplyBatcher`).
  - **When.** 8 seconds after the last answer, and never more than 30 seconds after the first.
  - **Send now.** While answers are held, the board says so: `replies: {pending, dueAt}` on every
    `GET` and `POST` of `/v1/sessions/:id/attention`. The owner can skip the wait with
    `POST /v1/sessions/:id/attention/replies` (the app's "Send now", `fy attention send-now`).
  - **Exactly once per item.** An item held, sending or delivered is never queued again. A batch is
    sent under the send id `attention-<session>-<ids>` (`attention-<session>-A3` for one answer, as
    before), so a batch told twice is one message.
  - **Durable.** A batch is written down as sending before it is sent, so a restart re-sends it under
    the same id. Answers held across a restart are delivered once the daemon is back.
  - **A damaged outbox** is set aside as `attention-replies.json.damaged-<id>` and a fresh one starts,
    so it never stops later answers.
- **The delivery never blocks the owner.** The owner's answer never waits for a ferret's launch or
  revive. A batch goes through the ordinary send path, queued while the ferret is mid-turn, and it
  wakes an idle ferret. **Every closing the owner makes is told**, a bare done or dismiss included: a
  ferret told nothing waits on an item the owner already settled. A chat reply is the one exception,
  because the message itself already carried the owner's words.
- **A raise says when nobody was told.** The response to the raise that created an item carries
  `enrolled`, the number of devices enrolled for push on the machine. At zero, `fy attention add`
  prints `Warning: no device will be notified (0 enrolled)` under its confirmation. The item is on the
  board either way.

## What an item says

The owner reads an item cold, often on a phone, often days later. So an item is **structured**, and every
part is written for a reader who has not been following. The wire shape is `AttentionBriefShape` in
`packages/protocol/src/lib/attention.ts`. Every part is optional except the summary, so an item raised
before the structure existed still reads.

| Part             | Field                                               | What it holds                                                                                                                                                                   |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Summary          | `subject`                                           | One line: what is needed. Drawn bold, once — never repeated as a title or `why`.                                                                                                |
| Context          | `context`                                           | What is happening and why it matters, in a few sentences. Markdown.                                                                                                             |
| Terms            | `terms[]` `{term, meaning}`                         | Every codename or term of art the item uses, spelled out. At most 12.                                                                                                           |
| Questions        | `questions[]`                                       | One per decision: `question`, optional `options`, `recommended` and `why`. ≤ 6.                                                                                                 |
| Recommendation   | `recommendation`                                    | The overall suggested decision `{decision, why?}`.                                                                                                                              |
| Impact / urgency | `impact`, `urgency`                                 | What happens if nobody answers, and by when, in words.                                                                                                                          |
| Links            | `links[]` `{label?, target}`                        | PRs, files and references (`#F12`, `@file`, a URL). At most 10.                                                                                                                 |
| Steps            | `steps[]`                                           | What the owner must DO, one Markdown step each, in order. ≤ 20 steps, ≤ 2 000 chars each.                                                                                       |
| Body             | `body`                                              | One Markdown document for instructions that are not a list. ≤ 8 000 chars.                                                                                                      |
| Ask              | `ask`                                               | `task` is the to-do: the owner does something, nothing to choose. Its answers are exactly **Done** (resolve) and **Need more info**.                                            |
| Waiting          | `waitingOn`, `askedAt`, `infoRequests`, `history[]` | Daemon-written: set by Need more info, cleared by the ferret's edit. See "The loop".                                                                                            |
| Progress         | `stepsDone[]`                                       | Item only, never written by a raiser: the 0-based indices of ticked steps, sorted, unique, each below `steps.length`; absent when none. An edit that changes `steps` clears it. |

- **A question's `recommended`** names one of its options when it has options (the schema refuses
  anything else), and is the suggested answer in words when it has none.
- **A to-do is a `task` ask.** Steps with no question make one (`--task` forces it). Every action the
  human must take — a reply's "Next steps: You: …" included — is its OWN item with full `--step`s; the
  fixed-layer prompt says so, and never to leave an ask only in prose. On `[needs more info !A3 …]` the
  ferret expands that SAME item with `fy attention edit`, or says in the item why it cannot, and resolves
  its own item when it is no longer needed.
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

### Writing rules

An item must stand alone, be easy to scan and be short. The fixed-layer Attention section teaches every
ferret the same rules, with a good and a bad example:

- **Self-contained.** The reader has not followed the conversation. No ticket or PR ids, codenames,
  file paths or unexplained capitals. A needed term goes in `terms` with its meaning.
- **Point form.** One idea per bullet. The summary is one plain sentence under 90 characters, answer
  first. `context` and `impact` take a list (`-c` repeated, or a JSON array) and are stored as
  `- point` lines; the app draws them as a bullet list, collapsed as before.
- **Instructions in the item.** When the owner must DO something, give every step with `--step "<markdown>"`
  (repeat, in order; or `steps` in the JSON body), or one `--body-file <path|->` document: exact commands,
  where to click, what to paste where, never a secret value. Commands and paths inside `steps` and `body`
  are legitimate, so the writing check does not read them. The item alone must be enough to finish the task.
  `fy attention ls` prints them numbered, `✓` on done ones; `fy attention step <id> <n> [--undo]` ticks one.
- **Concrete questions.** Two to four short options, and a recommendation with its reason in one line.

The daemon checks this on every `fy attention add` and `fy attention edit`. It **warns, never refuses**:
the item is already on the board. The warnings come back on the response (`warnings` on the snapshot)
and the CLI prints them under the confirmation with the fix to run. It flags a summary over 90
characters, ticket-like ids (`ABC-123`, `#1234`), URLs, file paths, and ALL-CAPS words not defined in
`terms` (`packages/daemon/src/lib/attention/writing-lint.ts`).

**`fy attention edit <id>`** rewords an open item the ferret raised: summary, context, terms, the
questions' words (same count and options, in order), recommendation, impact, urgency, links, steps and body. It
never changes the ask, who raised it or the question options, and it does not push again — except an
edit that answers an open Need more info request, which pushes once (see "The loop").

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

**What an Attention push says.** A concise summary, nothing else. The title is the conversation's
name, plain, trimmed to 40 characters at a word boundary: `OCI work login`. It is the ferret's
name when the session has no name of its own. The body is the item's **summary only**, at most 110
characters, trimmed at a word boundary with `…`. It never carries the context, the options or the
recommendation. When the summary is empty or only repeats the title, the first question stands in,
trimmed the same way.

A session's name is an agent's own words, so it must never read as the daemon's new-device alert
title. Titles used to be quoted always (`“Ferretry”`), which guarded one case by marking every push.
Now only a name that reads as that alert is labelled, as `Ferret “…”`. That covers any spelling, case
or punctuation, and Cyrillic, Greek and accented look-alikes (`attentionNotificationTitle`). Every
other title is the name as the owner typed it.

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

| Path                                              | Where                                      | Decision                                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An Attention item is created                      | daemon `NotificationService`               | **The** notification. Once per item (the key is session + item).                                                                                                             |
| A ferret adds the information the owner asked for | daemon `NotificationService.moreInfoAdded` | **One more push** for that request: same title and link, "Updated: more info added — <summary>". Once per item + request (key `…:info-<n>`); an ordinary edit never pushes.  |
| `fy attention notify` (push without an item)      | daemon `POST …/notify`                     | Kept for compatibility. It is explicit and audited, and the prompt does not advertise it. A tap opens the conversation it came from.                                         |
| Enrolment confirmation                            | daemon `PushService.register`              | Kept. One push, only to the browser that just enrolled.                                                                                                                      |
| A new device was paired                           | daemon audit log                           | Kept. This is a security alert.                                                                                                                                              |
| A harness parks on its own prompt                 | daemon `HarnessPromptAttention`            | **An item** like any other: one push per wait.                                                                                                                               |
| A session starts, finishes or idles               | daemon                                     | Never pushed (unchanged).                                                                                                                                                    |
| Your turn / `awaiting_user` (a ferret waiting)    | PWA page watcher (`notification-ledger`)   | **Removed.** Waiting is not an ask.                                                                                                                                          |
| `completed` (a ferret finished)                   | PWA page watcher                           | **Removed.** Finishing is not an ask.                                                                                                                                        |
| `needs-input` / `awaiting_question`               | PWA page watcher                           | **Now doubles the item above.** The daemon raises an item for this wait, and that item pushes. Removing the page-watcher notification is a follow-up for the app (see GAPs). |
| `failed` / `stalled` / `kill_failed`              | PWA page watcher                           | Kept. A dead ferret cannot raise an item.                                                                                                                                    |
| Notifications a device's own filter hides         | push worker                                | Kept as one quiet, silent line per machine (a push that shows nothing gets a subscription revoked). Now carries the mark.                                                    |

## GAPs

- **The page watcher still announces `needs-input` / `awaiting_question`.** The daemon now raises an
  item for that wait, which pushes, so a device with the app open is told twice. The app should drop
  that local notification.
- **A console prompt can only be answered in the Console.** Its item has no ask: answering a permission
  prompt or a dialog from the board is not driven yet.
- **A chat reply to a question item is not typed into the form.** The words reach the ferret as a
  message, and the form stays parked until it is answered in the Console or on the board.
- **An answer whose form was released** (the drive failed and the form was cancelled) is journalled
  but raises nothing: the session then waits for a reply in chat, which is not an item.
- **A board whose summary was missing at start** is reconciled only once its session writes state
  again: the start-up pass skips sessions with no wait and no open-Attention summary.

- **Page-level notifications for a new item.** A device with no push enrolment learns about an item only
  from the unread mark while the app is open. The page watcher could announce `state.attention`
  increases too, but it would need the push worker's tag to avoid doubles.
- **A chat message that answers several items** gives each item the whole message (minus the references).
  It does not split the words per item.
