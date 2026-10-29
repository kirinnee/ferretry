# Attention

**Notifications are Attention.** A ferret that needs the owner to decide or do something raises an
Attention item. That one act notifies the owner. The item then stays until it is answered, done or
dismissed. A ferret that is only waiting, or has just finished, pushes nothing — and every notification a
ferret sends IS an Attention item: `fy attention notify` raises an `info` card too.

This document is the contract for that loop. The board's own rules are in
`packages/daemon/src/lib/attention/state-machine.ts`, and the wire shapes are in
`packages/protocol/src/lib/attention.ts`.

## The model: in discussion, surfaced, closed

An ask has three places to be:

1. **In discussion.** A ferret's ask is born here (`waitingOn: 'ferret'`, `waitingFor: 'discussion'`, `askedAt` = the raise time). It is on
   the ferret's board and the owner can read it, but it is not a card on their queue and it is not counted as
   needing them. Nothing is sent to the ferret (no `[discuss …]`), the `infoRequests` counter is not bumped
   (that counter belongs to the owner's requests) and no history entry is written: the item was never anywhere
   else. The owner and the ferret talk it through in the chat, referencing it as `!A3`.
2. **Surfaced.** The ferret (or the owner, or the timer) moves it onto the owner's queue with `fy attention
surface`. The wait fields clear, the history gains `surfaced`, and the owner is pushed for the card. A
   ferret that knows nobody is watching its chat raises straight here with `fy attention add --surface`.
3. **Resolved or dismissed.** As before.

Items that no ferret raised (a warden's, a source's, a harness prompt) have nobody to discuss with and start surfaced.
An `info` kind (`fy attention notify`) starts surfaced too: it asks for no discussion.

**What "in discussion" means.** The one predicate is `attentionInDiscussion` (`waitingFor === 'discussion'`). It reads
the same whether the item was born there or sent back by the legacy `discuss` action. `infoRequests` is absent
on an item that was born there, so a first owner request is still request 1.

**The resurface timer.** Off by default. `attention.resurfaceAfterMinutes` (1–10080) in `config/daemon.json` makes the
daemon sweep each minute and surface any item that has been in discussion longer than that, with the history note
"No reply in N minutes: surfaced by the timer." A ferret that forgets to `surface` cannot strand an ask.

**Grouped notifications.** A ferret turn that raises three asks pushes once. The daemon gathers one session's raises in
a 3 s window and sends "<ferret> needs 3 things" with the titles joined by " · " as the text; a tap opens the
first. The group is recorded under its first item's key, so a repeat is no second push. The window is in memory: a
daemon that stops inside it sends no push for that burst (the items are on the board either way). A surfaced card
pushes on its own, once.

**How the ferret closes a discussion.** After the owner replies, the ferret closes what they answered
(`fy attention done <id> "<what they said>"`) and surfaces what they did not (`fy attention surface <id>`). A chat
reply never resolves an item in discussion on its own.

**The card is a living summary.** Each time the ferret and the owner talk an ask through, the ferret rewrites the card
so it says where things stand: `--decided` (what is settled so far), `--still-open` (what remains, in point form, like
`decided`) and fresh `--option`s. `fy attention edit <id> --still-open "<point>"` (repeatable; also on `add`) does it,
and `ls` prints it under `decided:`. The owner opens the card later and reads the conclusion, not the thread.

- **Edits never notify an item in discussion.** An edit lands silently: no push, no change to what needs the owner,
  and it does NOT end the discussion. Only `surface` (or a new ask) moves a card onto the queue. An edit of a
  surfaced item behaves as it always did.
- **Revisions.** Every edit that changes a revisable field (title, subject, context, premise, decided, stillOpen,
  terms, questions, recommendation, impact, urgency, links, steps, body) appends ONE entry to `revisions`:
  `{ at, by, changed, previous }` — `by` is the actor's kind (human, agent, daemon), `changed` the fields whose value
  actually differs, `previous` their old values (a field absent from `previous` was absent before). An edit that
  changes nothing adds none. The list is oldest first and keeps the last 10 (`MAX_ATTENTION_REVISIONS`); the app
  can show what the card said before. A source refresh of a stable-sourceRef item (a Warden escalation, say)
  restates premise, decided and still-open from the new request but records no revision: it is the daemon
  restating a fact, not a conversation.
- **The nudge-once safety net.** See "The turn-end check": a ferret that discussed an ask and left its card
  alone is reminded once.

## The loop

| Step            | Who                                                                                      | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raise           | the ferret: `fy attention add --title "<what>" "<ask>"`                                  | A ferret ask starts **in discussion**, in that ferret's chat (see "The model" below): it is on the board but not on the owner's queue, and the ferret is sent nothing. The owner gets ONE push per ferret turn, "<ferret> needs 3 things: <t1> · <t2> · <t3>" (a lone ask pushes as itself); the card's title is the heading and its ask the text. `--surface` raises straight to the queue and pushes at once. Warden, system and harness-prompt items start surfaced. The session's row turns **unread**.                                                                                  |
| Answer          | the owner: the board, the inbox or a push tap                                            | The item resolves. After the quiet window (10 s after the last card action by default) the ferret receives `[answer to !A3 «<ask>»] <answer>` (the forms are in the "What the ferret reads" note below), in one message with any other answers given meanwhile. It counts as delivered only once the ferret's transcript shows it; otherwise the item comes back as a card ([Delivery](#delivery)).                                                                                                                                                                                          |
| Reply in chat   | the owner writes `!A3 …` in that ferret's chat                                           | The message is delivered prefixed by where the item is. An item **in discussion**: `[reply about !A3 «<ask>»] <text>` — a reply, nothing resolves, and the ferret closes (`done`) or surfaces it. A **surfaced** item: `[answer to !A3 «<ask>»] <text>` — the message IS the answer and, once accepted, the item resolves in the owner's name; for an ask with options whose words name no option the answer is an **other answer** (`Other answer (none of the options): <text>`), never a bare resolve.                                                                                    |
| Plain chat      | the owner writes without referencing an item                                             | Nothing resolves, and the message is delivered exactly as typed: no list of open items rides along (it would be re-read every later turn). The ferret sees its open items on demand with `fy attention ls`.                                                                                                                                                                                                                                                                                                                                                                                  |
| Surface         | the ferret on its own item, or the owner: `fy attention surface A3 [--why "<one line>"]` | Only an open item **in discussion**. Clears the wait, adds a `surfaced` history entry (with the why), refreshes the board and pushes the owner ONE card push (key `attention:<session>:A3:surfaced`, event `attention-surfaced:A3`). Idempotent on an item already surfaced; refused (`invalid`) on a wait for more information.                                                                                                                                                                                                                                                             |
| Done            | the ferret: `fy attention done A3 [--answer …]`                                          | The ferret closes its own item once it is no longer needed. Nothing is echoed back to it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Done (owner)    | the owner: the board, or `fy attention done` at their own shell                          | The ferret receives `[done !A3 «<ask>»] The owner marked this done.`, or `[answer to !A3 «<ask>»] Done · note: <note>` when the owner wrote one.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Dismiss         | the owner, or the ferret for its own items                                               | Closed without an answer: **not needed**, with an optional reason. When the owner dismisses, the ferret receives `[dismissed !A3 «<ask>»] Not needed: <reason>`, or "Not needed — the owner dismissed this without a reason."                                                                                                                                                                                                                                                                                                                                                                |
| Progress        | the owner, or the ferret on its own item                                                 | `{action:'progress', id, step, done}` ticks or unticks one step. The item stays open; nothing is pushed and the ferret is told nothing. Lists re-read (a `progressed` board change).                                                                                                                                                                                                                                                                                                                                                                                                         |
| Need more info  | the owner: the board, or `fy attention needs-info A3 [--note …]` at their own shell      | Owner only, on an open item a ferret raised. The item **stays open** and is marked `waitingOn: 'ferret'` (`askedAt`), so the app shows "waiting on the ferret". The ferret receives `[needs more info !A3 «<ask>»] <note>` ("The owner needs more information." with no note), batched like an answer. It never pushes the owner.                                                                                                                                                                                                                                                            |
| More info added | the ferret: `fy attention edit A3 …` on that item                                        | The mark clears, the history gains an `updated` entry and the owner gets **one** push, "Updated: more info added — <summary>", titled and opened like the first. Only an edit that answers an open request pushes; an ordinary edit never does. `fy attention done` also ends the wait.                                                                                                                                                                                                                                                                                                      |
| Discuss         | the owner: the board's Discuss button, or `fy attention discuss A3 [--note …]`           | Legacy, still accepted for old clients: owner only, on a surfaced item a ferret raised, it moves the item back **into discussion** (`waitingOn: 'ferret'`, `waitingFor: 'discussion'`) and the ferret receives `[discuss !A3 «<ask>»] The owner wants to talk this through before answering: <note>. …`, batched like an answer. The ferret then edits (`fy attention edit`, back on the queue as a fresh card), closes it (`done`) or surfaces it. An item in discussion is **not** counted as needing the owner and leaves the swipe deck (the session summary counts it as `discussing`). |
| Harness prompt  | the daemon, when a ferret's harness parks on a prompt it owns                            | One `question` item per wait (see below), pushed once. Answering it on the board types the answer into the form. It clears itself when the wait ends.                                                                                                                                                                                                                                                                                                                                                                                                                                        |

- **What the ferret reads.** The owner has six ways to answer a card, and the message tells them apart so the
  ferret never has to guess which one it got. Every answer is one line, `[answer to !A3 «<ask>»] …`:

  | The owner…                                    | The ferret reads                                                                                             |
  | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
  | picks an option                               | `Yes`                                                                                                        |
  | picks an option and adds a note               | `Yes · note: <note>`                                                                                         |
  | writes their own words INSTEAD of the options | `Other answer (none of the options): <text>`                                                                 |
  | marks a task done (with a note)               | `Done` (`Done · note: <note>`); a bare done is `[done !A3 …]`                                                |
  | dismisses it as not needed                    | `[dismissed !A3 «<ask>»] Not needed: <reason>`, or `Not needed — the owner dismissed this without a reason.` |

  An **other answer** is the owner's own words, not a pick: it ignores the options and the ferret acts on the
  text. Any ask that offers options takes it (a choice, a permission, a review); an open question and a task
  do not (the owner already answers those in words). A note equal to the answer's own words is not repeated.
  `fy attention done A3 --other "<text>"` records the same answer from a shell. An other answer cannot fill a
  harness question form (the Harness prompt row above): that answer is refused and the item stays open.

- **Need more info and Discuss are exactly once per request.** Each request of either kind bumps the item's one `infoRequests` counter. The
  delivery is keyed `A3~<n>` in the reply outbox (answers keep the plain `A3`), so a replay re-sends
  nothing and a second request after the ferret replied is a new delivery. Asking again while the ferret
  has not answered is the same request. The push for the edit is keyed `attention:<session>:A3:info-<n>` and says "Updated after your discussion: <summary>" when the cleared wait was a discussion ("Updated: <summary>" otherwise),
  and the state machine clears the mark in the same commit, so a retried edit is no change and pushes
  nothing. `history` keeps the last 20 `{at, kind: 'needs-info'|'discuss'|'updated'|'surfaced', note?}` entries, oldest dropped,
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
- **Answers are batched per ferret, and delivered on proof.** The delivered message wakes the ferret: it
  starts the ferret's next turn. So answers to one ferret are held in its own outbox, apart from the
  owner's ordinary sends, and delivered as **one message**, each answer in the form above, a blank line
  apart. When, how and what counts as delivered is [Delivery](#delivery).
- **The delivery never blocks the owner.** The owner's answer never waits for a ferret's launch or
  revive. A batch goes through the ordinary send path, queued while the ferret is mid-turn, and it
  wakes an idle ferret. **Every closing the owner makes is told**, a bare done or dismiss included: a
  ferret told nothing waits on an item the owner already settled. A chat reply is the one exception,
  because the message itself already carried the owner's words.
- **A raise says when nobody was told.** The response to the raise that created an item carries
  `enrolled`, the number of devices enrolled for push on the machine. At zero, `fy attention add`
  prints `Warning: no device will be notified (0 enrolled)` under its confirmation. The item is on the
  board either way.

## Delivery

How the owner's card actions — an answer, a done, a dismiss, a Discuss or a request for more information —
reach the ferret (`AttentionReplyBatcher`, `packages/daemon/src/lib/attention/reply-batch.ts`). The
owner's words that drove it: "only on receipt (the harness receive the 'card reply'), then it can be
considered 'DONE', else it surfaces back as a card again".

1. **Held.** The action goes to the ferret's outbox (`attention-replies.json` beside the board). It is
   due **10 seconds after the last card action**: every further action on that ferret's cards restarts
   the countdown, and the first one never waits more than **2 minutes**. The board says so:
   `replies: {pending, dueAt, heldForTurn?}` on every `GET` and `POST` of
   `/v1/sessions/:id/attention`. "Send now" (`POST /v1/sessions/:id/attention/replies`,
   `fy attention send-now`) skips the countdown.
2. **Waiting for the turn.** A due batch waits while the ferret's `turnState` is `working`, and later
   answers join it. It is looked at again every 5 seconds and goes once the turn ends. Past 15 minutes it
   goes through the ordinary send path anyway, which queues natively. A state that cannot be read
   counts as not busy.
3. **Waiting for an empty composer.** A due batch is typed **only into an empty composer**: the pane is
   read first, and Claude's dim ghost suggestion is not text. A person's draft, or a screen that cannot
   be read, holds it (`delivery.heldForComposer`) and it is looked at again every 5 seconds. If a draft
   appears between the read and the keys, the send path refuses before a single key and the batch goes
   back to waiting. Past the composer wait (10 minutes after the cap) it is **undelivered** (step 5).
4. **Sending.** Once the send path accepts the batch it is `sending` (`delivery.sending` lists its
   items: the app's "Sending…"). It is **delivered only when the send ledger proves it** in the
   ferret's transcript (the send tracker’s `delivered` fate). The outbox then never queues
   those items again.
5. **Undelivered.** A send refused outright, a fate of `timed_out`, `unaccounted`, `withdrawn` or
   `cancelled`, no proof within the receipt wait (15 minutes), or a composer that never emptied: each
   item goes **back to the owner as an open card**. An answer, done or dismiss reopens the closed item; a
   Discuss or request for more information ends that wait. The item carries
   `undelivered: {at, reply, reason}`: the app shows "Your answer didn't reach <ferret> — answer again
   or Retry", and Retry posts `{...reply, id}`, the same action again. The owner's next action on the
   item clears the mark. A board already full of open items keeps the answer closed.

| Key in `config/daemon.json`          | Default | Range (whole seconds) | What it bounds                                   |
| ------------------------------------ | ------- | --------------------- | ------------------------------------------------ |
| `attention.replySettleSeconds`       | 10      | 1–3600                | the quiet time after the last card action        |
| `attention.replyMaxWaitSeconds`      | 120     | 1–3600                | the longest the first action waits               |
| `attention.replyComposerWaitSeconds` | 600     | 10–86400              | waiting for an empty composer, past the cap      |
| `attention.replyReceiptSeconds`      | 900     | 30–86400              | waiting for the transcript's proof after sending |

A settle longer than the max wait is **refused** by the config check, not clamped. All four are read at
start.

- **Exactly once per item.** An item held, sending or delivered is never queued again. A batch is sent
  under `attention-<session>-<ids>-<stamp>`, the stamp being when the batch began. It is written down
  before it is sent, so a batch told twice, or re-sent after a restart, is one message. The stamp keeps an
  item answered again after an undelivered first answer off the id the ledger already settled. The
  instructions-updated note ([launch-settings.md](launch-settings.md)) is queued here too, under
  `instructions~<digest>`, and belongs to no item.
- **Durable.** A daemon restarted before a batch was accepted re-sends it under the same id; one
  restarted after looks for its proof. Answers held across a restart are delivered once it is back.
- **A damaged outbox** is set aside as `attention-replies.json.damaged-<id>` and a fresh one starts, so it
  never stops later answers.
- **Why this replaced the old outbox.** The old one recorded a batch as delivered the moment it was handed
  over, and swallowed a refusal. A ferret whose composer held text (a person mid-message, or a stranded
  draft) refused the send, and the owner's Discuss or answer was lost while the board said it had gone.

## The card

Every item is drawn as ONE self-contained card. The owner can answer it from the card alone, with a
swipe, a tap or an arrow key, and add words when they want to. The wire shapes are `AttentionCardShape`
in `packages/protocol/src/lib/attention.ts`; every reader goes through
`packages/protocol/src/lib/attention-card.ts`, so the CLI, the daemon's push and the app agree.

| Part    | Field                    | What it holds                                                                                                                       |
| ------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Title   | `title`                  | What the item is about, in a few plain words, under 40 characters. **The push's heading.** Required by `fy attention add --title`.  |
| Ask     | `subject`                | The one question or action, one line under 120 characters. **The push's text.** (The wire keeps its old name; `ask` is the object.) |
| Kind    | `kind`                   | `task`, `yesno`, `permission`, `choice`, `review`, `info` — or `reply`, a question only words answer.                               |
| Answers | `answers[]` (at most 3)  | `{direction: left·up·right, label, does, description?}`. `does` is what the answer does: see below.                                 |
| Reply   | the action's `note`      | Optional words on EVERY card, sent with whichever answer is given. Open by default on a `reply` card.                               |
| Detail  | the brief (next section) | Context, recommendation, body (Markdown and fy-render media), steps, links, terms, impact, urgency, history: all shown when open.   |

**Directions.** The answer the owner swipes left IS the button on the left. The bar lays answers out
left · up · right, each with its arrow, and the swipe stamps the same label. The recommended answer is
always on the right. The defaults per kind (`defaultAttentionAnswers`):

| Kind       | ←              | ↑ (optional, `--up`)  | →                   |
| ---------- | -------------- | --------------------- | ------------------- |
| task       | Need more info | e.g. Skip (dismisses) | Done                |
| yesno      | No             |                       | Yes                 |
| permission | Deny           | e.g. Always allow     | Allow               |
| choice, 2  | the other      |                       | the recommended one |
| choice, 3  | the third      | the second            | the recommended one |
| review     | Needs changes  |                       | Looks good          |
| info       |                |                       | Got it              |

- **What an answer does** (`does`): `choose` answers a choice with that option; `approve`/`reject` a
  permission; `good`/`clarify` a review (`clarify` needs the reply's words); `other` is the owner's own words instead of the options (any ask with options); `done` resolves, `needs-info`
  asks the ferret for more and keeps the item open, `dismiss` closes it unanswered. An answer whose label
  is not its effect's default (↑ "Always allow", ↑ "Skip") reaches the ferret with that label first:
  `Always allow — <reply>`.
- **At most three answers.** `fy attention add` refuses a fourth option and says to split the item or to
  let the owner answer in words (`--kind reply`). A choice with no recommendation recommends its first
  option. A `yesno` card's options are exactly Yes and No.
- **Old items.** An item raised before cards has no `title`, `kind` or `answers`. Nothing is migrated on
  disk: `attentionCardKind` reads the kind from its ask, `attentionCardAnswers` gives it its kind's
  defaults (its brief's recommendation on the right), and `attentionTitle` titles it with the start of its
  ask cut at a word. An old choice with more than three options keeps the rest as plain buttons.
- **Isolated.** The card is read alone, often days later. Everything needed to decide is ON it; links are
  extras. The writing check below warns about anything that points elsewhere.

## What an item says

The owner reads an item cold, often on a phone, often days later. So an item is **structured**, and every
part is written for a reader who has not been following. The wire shape is `AttentionBriefShape` in
`packages/protocol/src/lib/attention.ts`. Every part is optional except the summary, so an item raised
before the structure existed still reads.

| Part             | Field                                               | What it holds                                                                                                                                                                   |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title / ask      | `title`, `subject`                                  | See "The card": what it is about, and the one question or action. Each drawn once.                                                                                              |
| Premise          | `premise`                                           | The SITUATION: what is going on, in point form, so a cold reader starts here. Optional; a string, or a list drawn as bullets.                                                   |
| Context          | `context`                                           | WHY IT MATTERS NOW, and the supporting facts — not the situation. Point form, Markdown.                                                                                         |
| Terms            | `terms[]` `{term, meaning}`                         | Every codename or term of art the item uses, spelled out. At most 12.                                                                                                           |
| Questions        | `questions[]`                                       | One per decision: `question`, optional `options`, `recommended` and `why`. ≤ 6.                                                                                                 |
| Already decided  | `decided`                                           | Earlier answers that bear on this item, in point form, so the owner need not remember them. Same shape as `premise`.                                                            |
| Still open       | `stillOpen`                                         | What remains to be settled, in point form. Same shape as `decided`; read it with `decided` as the card's running summary.                                                       |
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
  fixed-layer prompt says so, and never to leave an ask only in prose. [The turn-end check](#the-turn-end-check)
  reminds a ferret that did. On `[needs more info !A3 …]` the
  ferret expands that SAME item with `fy attention edit`, or says in the item why it cannot, and resolves
  its own item when it is no longer needed.
- **The ask follows the questions.** `fy attention add` makes exactly one question with options a
  `multiple-choice` ask between them, and several questions an `open-question`. So only a single-question
  item has options the swipe deck can map. Several questions are answered one by one, and the board sends
  them as ONE open answer, numbered by question.
- **Where it is drawn.** The inbox card and the in-ferret panel draw the same card: a header line
  (kind · ferret · machine · age), the title, the ask, the recommendation, then every detail the item
  carries in a scrolling region, and the answer bar pinned at the bottom (left · up · right, then
  "Reply…").
- **Nothing open, nothing drawn.** A chat with no open item shows nothing above its composer: no "all
  clear" line and no resolved history. Open items are the pinned card and an accent count in the chat
  header. The history is one step away: the header's Actions menu has an "N resolved" entry (only when
  there is any), and the inbox has a Resolved filter that reads the boards of the 30 most recently active
  conversations.
- **Raising one.** It can be raised from flags (`--premise`, `--context`, `--decided`, `--still-open`, `--term "X=meaning"`, `--question`,
  `--option`, `--recommend`, `--recommend-why`, `--impact`, `--urgency`, `--link`) or from a JSON body
  (`--json-file <path>`, `-` for stdin), where a flag wins over the same field. `fy attention add --help`
  prints the JSON shape. Every length is checked before anything is sent, and a refusal names the field.

### The order a card reads in

Premise, Context, the question, Already decided, Still open, Options, Recommendation and why, Terms, Steps, More
detail (the body). A section that an item does not carry is skipped; the order never changes.

**Premise and context are different things.** The premise is the situation — "the work login expires
every day". The context is why it matters now and the facts that back it — "a 30-minute keepalive stops
the daily logout". Neither is a hard rule. A short item may need only one, and a card that says
everything in its question needs neither.

**The hard rule is isolation.** Could the owner answer this with nothing else open — no chat, no PR, no
terminal? If not, the card is wrong, whatever fields it fills. Premise and context are the way a card
gets there. They are written in point form, one idea per bullet, for a reader with a short attention
span: scannable first, detail after. When a picture beats words, put a chart or diagram in `--body` as an
`fy-render` fence.

### Writing rules

An item must stand alone, be easy to scan and be short. The fixed-layer Attention section teaches every
ferret the same rules, with a good and a bad example:

- **Self-contained (the hard rule).** The reader has not followed the conversation, and the test is
  "could the owner answer this with nothing else open?". No ticket or PR ids, codenames,
  file paths or unexplained capitals. A needed term goes in `terms` with its meaning.
- **A title and an ask.** The title says what the item is about in a few plain words, under 40
  characters, with no ids. The ask is one plain sentence under 120 characters, answer first.
- **Point form.** One idea per bullet. `premise`, `context`, `decided`, `stillOpen` and `impact` take a list (`--premise`, `-c`, `--decided` and `--still-open` repeated, or a JSON array) and are stored as
  `- point` lines; the app draws them as a bullet list, collapsed as before.
- **Instructions in the item.** When the owner must DO something, give every step with `--step "<markdown>"`
  (repeat, in order; or `steps` in the JSON body), or one `--body-file <path|->` document: exact commands,
  where to click, what to paste where, never a secret value. Commands and paths inside `steps` and `body`
  are legitimate, so the writing check does not read them. The item alone must be enough to finish the task.
  `fy attention ls` prints them numbered, `✓` on done ones; `fy attention step <id> <n> [--undo]` ticks one.
- **Concrete questions.** Two or three short options that each say what choosing them does, and a
  recommendation with its reason in one line. More than three is refused: split the item.
- **Never point elsewhere.** No "as above", "as discussed", "the earlier PR": say the thing itself.

The daemon checks this on every `fy attention add` and `fy attention edit`. It **warns, never refuses**:
the item is already on the board. The warnings come back on the response (`warnings` on the snapshot)
and the CLI prints them under the confirmation with the fix to run. It flags a missing title, a title
over 40 characters, an ask over 120, words that point at an earlier message ("as above", "as discussed",
"the previous PR"), ticket-like ids (`ABC-123`, `#1234`) unless followed by what they are in brackets
(`#812 (the push worker fix)`), URLs, file paths, ALL-CAPS words not defined in `terms`, and choice
options that name nothing ("A", "Option 2") with no description. A decision card (a permission, a choice,
a question or an open question) with NO premise and NO context draws the strongest warning — "a reader
opening this cold cannot tell what is going on" — but is never refused
(`packages/daemon/src/lib/attention/writing-lint.ts`). The CLI itself refuses a raise with no title or
with more than three options.

**`fy attention edit <id>`** rewords an open item the ferret raised: summary, premise, context, decided, still open, terms, the
questions' words (same count and options, in order), title, recommendation, impact, urgency, links, steps and body. It
never changes the ask, who raised it or the question options, and it does not push again — except an
edit that answers an open Need more info request, which pushes once (see "The loop"). An edit of an item in
discussion never pushes and never surfaces it, and each edit that changes a field is recorded as a revision.

### How the app shows steps and to-dos

- `context`, `body` and every step render as full Markdown through the chat's own renderer (`ChatProse`),
  so fy-render blocks and the proof-before-link reference gate behave exactly as in chat. There is no
  second renderer. Code spans and fences in an item get a Copy button.
- `steps` are a checklist. A tick sends `{action:'progress', id, step, done}`; it shows at once and rolls
  back with a message if the board refuses. When every step is ticked, Done is the primary action.
- A `task` card answers Done (→) and Need more info (←), plus an optional ↑ such as Skip, and takes an
  optional reply like every card. An item with `waitingOn:'ferret'` shows
  "Waiting on <ferret>" with no Done until the ferret edits it. Both actions ride the batched-delivery
  countdown. The history line ("You asked for more info 10:42 · updated 10:44") is local time.

## The turn-end check

The prompt tells every ferret that each thing the owner must do is its own item. A prompt rule alone is not
reliable: a ferret ends a reply with "Next steps: You: …" and raises nothing, and the owner, who reads the
board rather than every reply, never learns there was something to do. So the daemon checks
(`packages/daemon/src/lib/attention/turn-nudge.ts`, wired by
`packages/daemon/src/adapters/attention/storage-attention-nudge.ts`):

1. **When.** On every `turn.state` → `your-turn` the journal records, 2 seconds later, so the reply's last
   words have reached the transcript.
2. **What it reads.** The last turn in the transcript tail (400 events): from the last user-channel message
   to the end. The **reply** is the assistant text after the turn's last tool call.
3. **Does the reply ask the owner to act?** `ownerAsks` (`owner-asks.ts`) reads structure only, never
   tone:
   - a heading or label addressed to the owner ("Waiting on you", "What I need from you", "Action
     needed", …): every item under it;
   - a mixed heading ("Next steps", "To do", "Follow-ups", …): only items labelled for the owner
     (`You:`, `**You:**`, `Owner:`, `You —`, a bare `You:` line over a nested list);
   - a `You:` line anywhere, and the inline form `Next steps: You: …`;
   - a table with a `Who`/`Owner` column whose cell is `You`, or any table under an owner heading.

   Code blocks are skipped. "Next steps: none", items labelled `Me:`/`I'll`, and items that already name
   an item (`!A3`) are not asks. Prose is never an ask on its own. At most 8 asks, each at most 160
   characters.

4. **Did the turn raise them?** The turn's own tool calls are the evidence: a command running
   `attention add` or `attention edit`, a Ferretry `*_ask_owner` tool (or `askOwner` on an open), or the
   harness's question tool. When the turn raised at least as many as it asked, nothing is sent.
5. **The nudge.** Otherwise the ferret gets one message:
   `[attention check] Your last reply asked the owner to: - … Raise each as its own Attention item — … —
or, if an open item already covers it or it needs no owner, say why not in one line.`
   An interactive ferret is also offered its question tool. The nudge is journalled as
   `attention.nudged` with its asks.
6. **A discussed ask left alone.** When the turn's opener carries the owner's `[reply about !A5 …]` and the turn
   neither edited, closed (`done`, `dismiss`) nor surfaced `!A5` (a command `attention edit|done|dismiss|surface`
   naming it), the ferret gets ONE short nudge: `[attention check] You discussed !A5 — update its card (…: decided
so far, still open, fresh options), surface it (…) or close it (…).` One reply, one nudge (same send id rule as
   below); if the reply also asked the owner to act, the two lines go in a single message, the discussion line first.
   A turn the nudge started is never nudged again, so the exchange ends there.

- **Once per reply, never a loop.** The send id is `attention-nudge-<session>-<reply>`, derived from the
  reply's message id (or its words), and the send ledger keeps one message per id. So a turn end seen twice,
  or replayed after a restart, is one message. A turn that the nudge started is never checked, because its
  opener begins with `[attention check]`. One check per session runs at a time.
- **Only replies the owner reads.** A sub-ferret (a session with a `parent`) is never checked. Its
  reply goes to the ferret that started it, and that ferret raises what the owner must do (Pack mode).
  Messages a sub-ferret sends its lead are therefore never nudged.
- **Mode.** Interactive and auto ferrets are both checked. The owner of an interactive ferret may be at
  the keyboard, so the nudge accepts "the owner is here" as a reason not to raise.
- **The switch.** `machine.yaml` `attentionNudge` (default `true`; [config-files.md](config-files.md)).
  It is read at every turn end, so turning it off takes effect at once. It is neither a loosening nor a
  tightening, because it changes what a ferret is reminded of, never what it may do or spend.
- **What it cannot see.** An ask written as prose ("could you approve it?") is not detected, by design. A
  false nudge costs the owner's agents a turn. An item raised a turn earlier and repeated in a later reply
  is not matched to it. That nudge costs one line ("already !A3").

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

**What an Attention push says.** The card's title as the heading and its ask as the text, nothing
else. The title is trimmed to 40 characters at a word boundary; an item from before titles uses the
start of its ask (`attentionTitle`). The body is the ask, at most 120 characters, trimmed at a word
boundary with `…`. It never carries the context, the options or the recommendation.

A title is an agent's own words, so it must never read as the daemon's new-device alert
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

| Path                                              | Where                                                               | Decision                                                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An Attention item is created                      | daemon `NotificationService`                                        | **The** notification. Once per item (the key is session + item).                                                                                                            |
| A ferret raises one or more asks in a turn        | daemon `GroupedAttentionRaises` → `NotificationService.groupRaised` | **ONE push per ferret turn** (3 s window per session): "<ferret> needs 3 things: t1 · t2 · t3", a lone ask as itself. A `--surface`, warden or system item pushes at once.  |
| An ask is surfaced onto the owner queue           | daemon `AttentionSurfacedPush`                                      | **One push** for the card, once per item (key `…:surfaced`), whoever surfaced it.                                                                                           |
| A ferret adds the information the owner asked for | daemon `NotificationService.moreInfoAdded`                          | **One more push** for that request: same title and link, "Updated: more info added — <summary>". Once per item + request (key `…:info-<n>`); an ordinary edit never pushes. |
| `fy attention notify`                             | CLI and daemon `POST …/notify`                                      | **Now an item.** It raises an `info` card (→ Got it), so its push is the Attention push. `--kind completed` / `failed` is refused: progress and finishing never notify.     |
| Enrolment confirmation                            | daemon `PushService.register`                                       | Kept. One push, only to the browser that just enrolled.                                                                                                                     |
| A new device was paired                           | daemon audit log                                                    | Kept. This is a security alert.                                                                                                                                             |
| A harness parks on its own prompt                 | daemon `HarnessPromptAttention`                                     | **An item** like any other: one push per wait.                                                                                                                              |
| A session starts, finishes or idles               | daemon                                                              | Never pushed (unchanged).                                                                                                                                                   |
| Your turn / `awaiting_user` (a ferret waiting)    | PWA page watcher (`notification-ledger`)                            | **Removed.** Waiting is not an ask.                                                                                                                                         |
| `completed` (a ferret finished)                   | PWA page watcher                                                    | **Removed.** Finishing is not an ask.                                                                                                                                       |
| `needs-input` / `awaiting_question`               | PWA page watcher                                                    | **Removed.** The daemon raises an item for this wait, and that item pushes.                                                                                                 |
| `failed` / `stalled` / `kill_failed`              | PWA page watcher                                                    | Kept. A dead ferret cannot raise an item.                                                                                                                                   |
| Notifications a device's own filter hides         | push worker                                                         | Kept as one quiet, silent line per machine (a push that shows nothing gets a subscription revoked). Now carries the mark.                                                   |

## GAPs

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
