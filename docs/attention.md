# Attention

**This page moved.** "Attention" is now the **agenda**, and plain notifications are **notices**.

- [agenda.md](agenda.md) — the model: turns, items, chat, what an item blocks, the writing rules, the verbs
  (`fy agenda …`; `fy attention …` still works, deprecated).
- [notifications.md](notifications.md) — `fy notify`, when the phone buzzes (a stop, a near deadline, a
  `--ping`), what a push says and where a tap goes, agenda mode and its migration.

What is still only here is how the owner's answers reach the ferret.

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
