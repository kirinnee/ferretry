# Agenda

The agenda is what the owner has to decide or do, and what each item blocks. It replaces "Attention"
as the name of the feature (`fy attention …` still works, deprecated). A plain notification with
nothing to decide is a **notice**, not an agenda item (see [Notices](#notices)).

The daemon owns the model: the state machine is `packages/daemon/src/lib/attention/state-machine.ts`,
the wire contract is `packages/protocol/src/lib/attention.ts`. This page says what they mean.

## Agenda mode is a switch

A ferret keeps an agenda only while its **Agenda mode** switch is on. It is a recorded per-session setting
like Hypermedia and Pack mode (`config.agenda`, `sessionAgendaEnabled`; OFF unless set), switched from the
ferret's **Actions › Agenda mode** toggle or `fy notify agenda on|off`, and it takes effect at the ferret's
next launch. With it off the ferret is told only the notify rule and the session summary carries no
`agendaMode`, so the chat draws no agenda line or drawer. The whole contract is
[notifications.md § Agenda mode](notifications.md#agenda-mode).

## Turns

Every open item is somebody's turn. `attentionTurn(item)` (protocol) is the one definition:

| Turn       | When                                                                 |
| ---------- | -------------------------------------------------------------------- |
| **owner**  | A new ask. The owner has not answered, or the ferret handed it back. |
| **ferret** | The owner wrote about it in chat, or asked for more information.     |
| **done**   | Resolved (answered or dismissed), or the item is a notice.           |

A new ask is the owner's turn. Nothing starts "in discussion": the ferret raises it, the owner reads it.

Internally the ferret's turn is `waitingOn: 'ferret'` with `waitingFor` either `'discussion'` (the owner
replied) or `'info'` (the owner asked for more information). Clients read the turn, not those two fields.

## Handing it back

On the ferret's turn there are three ways out. **None of the first two pings the owner.**

- `fy agenda edit <id> …` — change the card (settled answers, what is still open, new options). Any edit by
  the raising agent on its own turn hands the item back to the owner, even one that changes nothing.
- `fy agenda surface <id> [--why "…"]` — hand it back as it stands.
- `fy agenda done <id>` / `dismiss <id>` — close it, if the talk settled it.

A human's edit never changes whose turn it is.

## Chatting about items

The owner can mention open items in a chat message: type `!A5`, or attach "re:" chips (several are fine).
The ferret receives the message as

```
[re !A5 «title», !A7 «title»] <text>
```

**Nothing resolves.** There is no answer-by-chat. Each referenced item becomes the ferret's turn and is
recorded as such (a silent `replied` change that no observer reacts to). A notice is never referenced.
If the ferret finishes a turn without touching a referenced item, the daemon nudges it once (nudge-once
keys on the `[re !A…` opener); after that it stays quiet.

Picking an option on the card (`respond`) still answers the item, exactly as before. `--other "<words>"`
remains on the CLI and in the app for "none of the options"; chat no longer guesses it.

## What an item blocks

Three optional fields say how much the owner's answer matters:

| Field         | Flag                     | Meaning                                              |
| ------------- | ------------------------ | ---------------------------------------------------- |
| `blockingNow` | `--blocking`             | The ferret is stopped until this is answered         |
| `willBlock`   | `--will-block "<thing>"` | What it will block ("the 14:00 deploy"), ≤ 200 chars |
| `neededBy`    | `--by "<time>"`          | When the answer is needed (an instant)               |

`--by` takes an ISO time (`2026-10-29T17:00:00Z`, local when it names no offset), a wait (`in 3h`, `in 90m`,
`in 1d`, `in 1h 30m`) or a clock time (`17:00`, its next occurrence). Anything else is refused with these forms.

On `edit`, each field is set again or taken off by name: `--not-blocking`, `--clear-will-block`, `--clear-by`.
These send `clear: ['blockingNow' | 'willBlock' | 'neededBy', …]`, because the fields have no empty value; a
request that sets and clears the same field is refused. Edits are kept in the item's revisions like any
other field. `fy agenda ls` prints them as `blocking now`, `will block` and `needed by`, under the turn.

The daemon does not decide when to push for these: stopped and deadline pings are
covered by the notification policy ([notifications.md](notifications.md)).

## Notices

A notice is a plain notification: `notice: true` on the raise request. No ask, no answers, no steps, kind
`info`, and **never anybody's turn** — it does not count as open in the session summary and chat cannot
reference it. `ping: true` asks for the phone to buzz and is only valid on a notice. `fy notify` raises one
(the older `fy attention notify` still works, deprecated).

## Verbs

`fy agenda add | edit | step | show | ls | history | surface | done | dismiss | needs-info | discuss | send-now`

| Verb                    | Does                                                                    |
| ----------------------- | ----------------------------------------------------------------------- |
| `add`                   | Raise an item (the owner's turn). `--title` and the ask are required.   |
| `edit <id>`             | Reword; on the ferret's turn also hands the item back (silent).         |
| `surface <id>`          | Hand it back to the owner without changing it (silent).                 |
| `done <id>`             | Resolve, optionally answering its ask (`--choice`, `--yes`, `--other`…) |
| `dismiss <id>`          | Close without answering; agents only their own.                         |
| `ls` / `show`           | Open items with turn and blocking fields / one item in full.            |
| `needs-info`, `discuss` | The owner's side, kept for old clients. They make it the ferret's turn. |

`fy attention …` runs the same handlers and prints one line to stderr first
(its text says `fy attention` is now `fy agenda`). It is hidden from help and will be removed.

`add` no longer takes `--surface`: the daemon still accepts `surface` on a raise (older CLIs send it) and
ignores it.

## Rules the writing keeps

The card is read cold, so it must stand alone: a title of about 40 characters, an ask in one sentence
(120 at most), the premise, context and what is decided or still open as short bullets, every term of art
defined with `--term`, never a secret value. The daemon lints for this and answers with advice, never a
refusal. Agents close their own items as soon as the reason is gone: an open item whose blocker has
cleared is a bug.

## Delivery

How the owner's card actions — an answer, a done, a dismiss, a Discuss or a request for more information —
reach the ferret (`AttentionReplyBatcher`, `packages/daemon/src/lib/attention/reply-batch.ts`; the class and
the files below keep their old names until a later release renames them). The owner's words that drove it:
"only on receipt (the harness receive the 'card reply'), then it can be considered 'DONE', else it surfaces
back as a card again".

1. **Held.** The action goes to the ferret's outbox (`attention-replies.json`, beside the agenda's own
   file). It is due **10 seconds after the last card action**: every further action on that ferret's cards
   restarts the countdown, and the first one never waits more than **2 minutes**. The agenda says so:
   `replies: {pending, dueAt, heldForTurn?}` on every `GET` and `POST` of the agenda route
   (`/v1/sessions/:id/attention`, renamed in a later release). "Send now"
   (`POST /v1/sessions/:id/attention/replies`, `fy agenda send-now`) skips the countdown.
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
   item clears the mark. An agenda already full of open items keeps the answer closed.

| Key in `config/daemon.json`          | Default | Range (whole seconds) | What it bounds                                   |
| ------------------------------------ | ------- | --------------------- | ------------------------------------------------ |
| `attention.replySettleSeconds`       | 10      | 1–3600                | the quiet time after the last card action        |
| `attention.replyMaxWaitSeconds`      | 120     | 1–3600                | the longest the first action waits               |
| `attention.replyComposerWaitSeconds` | 600     | 10–86400              | waiting for an empty composer, past the cap      |
| `attention.replyReceiptSeconds`      | 900     | 30–86400              | waiting for the transcript's proof after sending |

The keys keep their old `attention.` prefix until a later release renames them. A settle longer than the
max wait is **refused** by the config check, not clamped. All four are read at start.

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
  draft) refused the send, and the owner's Discuss or answer was lost while the agenda said it had gone.
