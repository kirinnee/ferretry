# Messages between ferrets

A ferret messages another by running `fy send <ferret> "…"` (or `fy reply`) in its shell. This page is
the contract for what each end sees: the words the RECEIVING agent reads, and how both Chats draw the
message for the owner.

## What the receiving agent reads

The daemon prepends a **one-line** banner to the message, then a line break and the body. The agent reads
only text, so this is the only way it can tell a ferret from its owner:

```text
[message from ferret tomi (session mveq0r0r-ddd75d7b) — not from the owner] To reply: fy send tomi "<reply>"
Hello from home-manager-fd.
```

One line, because a banner of two lines plus a blank one made EVERY peer message multi-line, and a
multi-line message was refused the direct path — it travelled as a "Read the file …/turns/turn-N.md"
pointer that cost the receiver an extra model call. With one line a short message is pasted whole
([how it is delivered](message-delivery.md#which-messages-are-typed-whole)).

A **label** sits after the kind: `[message · fyi from ferret tomi …]`, one of `blocker`, `action`, `fyi` —
the sender's word (`fy send --kind`) for how soon the message is needed, and what lets several share one
turn ([queue rules](message-delivery.md#labels-and-combined-delivery)). The parser reads it into
`PeerEnvelope.label`; an unknown label is not a banner and the message stays plain text.

### Combined deliveries

Messages delivered together arrive as ONE turn, oldest first. The header counts them, and each part opens
with its own banner carrying its place:

```text
[2 messages from ferrets, oldest first — not from the owner]

[1/2 · message · action from ferret tomi (session mveq0r0r-ddd75d7b) — not from the owner] To reply: fy send tomi "<reply>"
PR is green.

[2/2 · question · blocker from ferret avary (session mvie18ro-172c460c) — not from the owner] avary is waiting for your answer. Reply with: fy send avary "<reply>"
Merge now or wait?
```

A combined text is read back (`parseCombinedDelivery`) only when the header's count equals the parts found and
their places run 1..N; anything else — including a body that merely quotes a banner — stays plain text, so
nobody can forge a sender. The owner's Chat draws a combined turn as one ferret row per part, never as
"You".

The first word is the message's **kind**:

| Kind       | When                                                                                      | Note after the banner                                                 |
| ---------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `message`  | A note; the sender carried on                                                             | `To reply: fy send tomi "<reply>"`                                    |
| `question` | The sender wants an answer: `send --ask` (parked until answered) or `send --expect-reply` | `tomi is waiting for your answer. Reply with: fy send tomi "<reply>"` |
| `reply`    | The RECEIVER is parked waiting on this sender — this answers it                           | `To reply: fy send tomi "<reply>"`                                    |

`reply` wins over `question`: an answer that asks something back is still, first, the answer the
receiver was waiting for.

A note never says "no reply needed": the sender may simply not have said, and a ferret told it owed
nothing went silent on a lead that was waiting for its verdict (2026-10-31). Ask with `--expect-reply`
to make the request plain without parking yourself; the Warden reads the same fact when it chases a
sub-ferret that never answered its parent.

Rules for the wording:

- **Ferretry's words only**: "ferret" and "the owner" — never another tool's vocabulary.
- **Short**: it is in every peer message a ferret is ever sent.
- **One owner for both ends**: the writer and the parser are `packages/protocol/src/lib/agent-messages.ts`.
  The daemon writes it (`session/send/policy.ts`), the app parses it back out. Reword it there, with
  its tests, and nowhere else.
- **Old records stay readable**: the parser also reads the two-line banner (note on its own line, then a
  blank line) and the banner earlier daemons wrote (`[peer message from teammate …]`), so a transcript
  recorded before a rewording still renders the message as coming from the ferret that sent it.

A message too long to type travels as a **turn file**; the banner is at the top of that file, and the
transcript records only the pointer to it.

## What the owner sees

Structured facts, never the banner:

- **Who sent it** — the banner's name and session id, or for a turn-file message, the send ledger's
  `from` / `fromName` (`SendRecord`), which is known before the file has been read.
- **What kind** — the banner's first word.
- **Where it got to** — the send ledger's `fate`.

### The receiver's Chat

A card on the LEFT, distinct from the owner's right-hand bubbles: the sender's monogram, the sender as a
`:name` reference ([reference standard](reference-standard.md) — proved by session id, so a link only
appears when this daemon's fleet holds that ferret), "ferret", the kind ("waiting for a reply",
"replied"), the body as Markdown, the time and the receipt mark, and a quiet **Open conversation with
tomi** link. The banner, the session id and the reply command are never shown: they are addressed to the
agent, not to the person reading.

The agent's own read of the turn file (`Read turn-001.md`, or Codex's `cat`) is hidden — it is the
delivery's plumbing. A read that FAILED stays.

### Messages still waiting

A message that has not gone into the receiver yet — queued on the machine, held to be combined with others
(`holdUntil`), or saved on the owner's device — is **not in the Chat at all**, whether the owner or a ferret
sent it: no card, no strip. It shows on that ferret's Queue page ([queue views](message-delivery.md#the-durable-queue-being-built)),
with "sends by 11:20" per held message and the earliest as the ferret's "next send", and appears in the Chat
once delivered. A message that failed or could not be confirmed is not waiting and stays in the Chat, where the
owner can retry it. The sender's own **Sent to** card is unchanged: it lives in the sender's Chat.

### The sender's Chat

The tool call that ran `fy send` becomes a **Sent to** card: the recipient as a `:name` reference, the
message (a quoted argument or the `"$(cat <<'EOF' … EOF)"` heredoc; a `--message-file` or any other
shell expansion is named, never guessed), and its state:

| State     | Read from                                                                                                                                                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sending   | No result yet                                                                                                                                                                                                                                                          |
| Held      | The CLI said `held` — the line reads just "Held"; `held as an FYI` adds "delivered when Tanna's turn ends" and `held until 10:38:00` (an action batched with others) adds "delivered at 10:38, batched with its other messages", as the tooltip and to a screen reader |
| Queued    | Any other successful result that is not a delivery                                                                                                                                                                                                                     |
| Delivered | The CLI said `delivered` (or `revived the session`)                                                                                                                                                                                                                    |
| Replied   | A later message in this Chat came from the recipient — the proof it was read                                                                                                                                                                                           |
| Failed    | The call failed; the reason is the CLI's own first line                                                                                                                                                                                                                |

The raw command stays one tap away under **Show command**. Anything the reader does not recognise as a
send stays an ordinary tool call. The parsing lives in `packages/pwa/src/lib/peer-delivery.ts`.

The card is compact (&F949): "Sent to :name" is a meta line the size of a chat row's name, and the foot is
ONE line — the state's mark and its short word, `·` and "Show command" (the separator belongs to the control after it, so a wrap never strands it), then the time at the right. A longer meaning
("Queued — it reads this when its current turn ends") is the state's tooltip and is read to a screen reader;
a failure's reason takes the one line of its own under the foot, and is part of the failure's alert, so a screen
reader hears "Not delivered: <reason>" at once.

Each send is drawn ONCE (&B157). Claude Code (seen on 2.1.317) writes every message it sends the model again
as an untimed `api-request-blob` record — an earlier tool call, its result, the owner's words, its own system
reminders. Read as conversation, that drew every `fy send` twice: a copy with no time, and both cards stuck
on "Sending…" because the copy took the call's result. The daemon's Claude parser
(`packages/daemon/src/lib/transcript/claude.ts`) drops those records. The one thing only a snapshot ever drew
was a prompt queued while Claude was busy whose drain is content blocks (its text and a pasted image, as
Claude 2.1.281 writes it): the parser now reads that drain's blocks itself, so the words draw once as one
message and each picture once after them.

## Declared gaps

- **A held send does not follow itself to Delivered** (&B157). "Held — delivered when Tanna's turn ends" (or "Held —
  delivered at 10:38, batched with its other messages") is what the CLI said when it sent; the delivery is in the RECEIVER's send ledger (`/v1/ferrets/:ferretId/sends`), and the
  sender's Chat does not read another session's ledger. Following it means reading the receiver's ledger from
  the sender's Chat and matching the send to its row.

- **One machine.** A send is always between two sessions on the same daemon, so no machine is shown.
- **Live sender state.** The Sent card reads the CLI's answer at send time, then `replied` from the
  Chat; it does not follow the receiver's ledger afterwards.
- **The hand-off wire is unchanged.** `GET /v1/ferrets/:ferretId/handoffs/:name` still returns the document's
  text, banner included, because its schema is strict and a new field would break an older app reading
  a newer daemon; the app lifts the sender off the banner itself.

## Notices from Ferretry itself

**No tag and no footer, on anything** (the owner, 2026-10-30: "there should not be any append or prepend on
any feature"). A message Ferretry types into a session on its own account is plain sentences with Ferretry
— or its Warden — as their subject ("Ferretry restarted you mid-turn…", "Ferretry's Warden resumed you…",
"Ferretry could not confirm your message to…"), so the agent reads whose it is from the words themselves.
Who it is from is METADATA the app reads, never text: a queued message's `by` (`QueuedMessage.by`), and a
relaunch turn's author kept beside its document (`turns/turn-NNN.by.json`, `SessionHandoff.by`, from
`resumeTurnAuthor`: the Warden, a restart, the owner or a ferret). Both Chats draw it as Ferretry's, never as
the owner's bubble. Older history that still opens with `[ferretry] ` (`agent-messages.ts`) is stripped for
display. A contract test (`tests/unit/no-prepend-notices.test.ts`) holds every notice to this.

A **restart or same-harness migrate** resumes the same conversation, so it sends a notice only when the
session was mid-turn AND the in-flight inventory held something not classified safe (re-armable,
destructive or unknown, or a blind spot). Otherwise it sends nothing. An auto session is the exception: its resume would otherwise type the default "continue the assigned task" prompt, so it is told `Ferretry restarted you, and nothing was interrupted.` instead. When sent it reads
`Restarted mid-turn — 1 command was interrupted · details`, and the agent is told it came from Ferretry,
not the owner, and where `migration-inflight.md` is (`packages/daemon/src/lib/migrate/restart-notice.ts`).
A notice that travelled as a turn file is recognised by the document it holds, so it is a system row once
that file has been read.

A **migration refused only by the agent's own background jobs** — processes it started from its own tool
shell (a Claude `Bash` call, a codex `exec`) and left running — offers the owner "Ask the agent to stop its
background jobs" in Change model or account. That press queues ONE message, `by: {kind: 'ferretry',
feature: 'Migrate'}`, that opens `Ferretry could not move this session…`, names each blocking pid and
command, and asks the agent to stop them or say why not (`packages/daemon/src/lib/migrate/agent-jobs.ts`).
The daemon looks again before it asks, asks about the same set of pids once, and stops nothing itself: the
owner runs the safety check again, which stays the only way a migration starts. Anything else in the way —
an open tool call, a program the agent did not start from its shell, a blind spot — keeps the offer away.
Claude's own `statusLine` command (`sh -c 'fy' statusline …`, from `claudeStatuslineCommand`) is the
harness's helper, not a job. A daemon older than 4.153.0 marks no job, so when one refuses on processes
alone the card says to update this machine's daemon instead of offering the ask.

## What the board types into a chat

No board news reaches a chat (the owner, 2026-10-30: "there should not be any append or prepend on any
feature"). A card's move, block, unblock, drop, reopen or done is never typed into the lead's chat, alone
or as a batched digest: the ferret that finished tells its lead in its own words (`fy signal done` reaches
it through `fy wait`), the board shows the state, and the card's history keeps every event.

The one digest the owner has allowed (2026-11-03) is not the board's: it is made of messages a FERRET
labelled `fyi` (`fy send --kind fyi`), which the queue holds and delivers with the receiver's other pending
ferret messages ([rules](message-delivery.md#labels-and-combined-delivery)). The board's messages are the
daemon's, carry no label, and are never held or combined.

The board types only what a ferret has to **act on**, each as a plain sentence with no tag in front and no
footer behind. Who sent it is the queue item's metadata, `by: {kind: 'ferretry', feature: 'Board'}`, which
the app shows as a "Ferretry · Board" sender chip — never as text in the message:

| Producer                                     | To                                                         | Message                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Stale nudge (`lib/board/sweep.ts`)           | [alert route](board.md#who-a-board-alert-is-for)           | `&F412 has had no activity for 3h in Implement. Move it, note why, block it, or drop it.`                          |
| Go-ahead (`lib/board/sweep.ts`)              | the dependent card's assignee, once its last blocker ships | `&F20 can go ahead: &F18 merged.`                                                                                  |
| PR closed unmerged (`lib/board/pr-cache.ts`) | [alert route](board.md#who-a-board-alert-is-for)           | `&F412 PR #930 was closed without merging. Reopen it, link its replacement, or drop the card.`                     |
| CI red (`lib/board/pr-cache.ts`)             | [alert route](board.md#who-a-board-alert-is-for)           | `&F412 PR #930 CI is red. Fix it, or note on the card why it can stay red.`                                        |
| Turn-end check (`lib/board/turn-check.ts`)   | the ferret that changed code with no card                  | `You changed code this turn without a card. Create one (fy task create …) or record why not: fy task skip "<why>"` |
| Reopen (`lib/board/reopen-delivery.ts`)      | the card's assignee, else its owner ferret                 | `&F412 was reopened by the owner: <reason>`                                                                        |

**The alert route.** A stale nudge, a red CI and a closed-unmerged PR go to the card's assignee while it is alive, else
the nearest live lead above it, else the card's owner (its creator) and the owner's leads. They are never sent to the
session that merely made a card another lead is working. The route is `noticeRecipient` (`lib/board/notice-route.ts`);
when it can only name an interactive session, the alert is **not typed** there at all: `BoardAlerts`
(`lib/board/alert-sends.ts`) journals it on that session (`board.alert-withheld`) and the card shows the fact.
[board.md](board.md#who-a-board-alert-is-for) has the rules.

The stale nudge goes at most once per card per its lane's stale threshold, whoever receives it, and never to a ferret that
declared `fy signal waiting`. A go-ahead that could not be sent is said again on the next sweep. The
contract is tested in `packages/daemon/tests/unit/board/no-prepend.test.ts`.

**The agent's side.** The agent reads the sentence as it is: there is no agent-facing framing on these,
because each names its card and says what to do, so nothing needs a "not from the owner" line.

Declared gaps:

- **An interactive session's daemon messages skip the queue**, and every one but the three alerts above is still
  typed, by the direct send path. The direct send path carries the sender itself: the ledger record has
  `senderKind: daemon` and the same `by` the queue item would have held (`SendRecord.by`), so the app draws it
  the way it draws a queued one.

**How the app shows it.** A board message (`by: {kind: 'ferretry', feature: 'Board'}`, read from the queue
item or from the ledger record) is never the owner's bubble: it is one compact system row — a board mark,
"Board" as the sender, the sentence as it is, and the card (`&F412`) and the PR (`PR #930`, when the card links
it) as links (`BoardNudgeRow`, `packages/pwa/src/components/agent-message-rows.tsx`).

## The Warden and the board

The Warden reads the board (`board-design.md` §3.4). Its orphaned-card message is a plain sentence, from
"Ferretry · Warden" as the queue item's `by`; the resume turns below are still `[ferretry] ` notices (a GAP).

- **An orphaned card.** A card in an active or review lane whose ferret is finished, with nothing alive
  under it and no lead above the finished ferret alive to take it back ([board.md](board.md#a-finished-helpers-card-goes-back-to-its-lead)), is the Warden anomaly `orphaned_card` (`packages/daemon/src/lib/warden/orphans.ts`). The
  board decides "orphaned"; the Warden reads its word. The card's **owner ferret**, when it is alive and
  is not the finished ferret, gets one queued message naming the card and the three ways out:
  `fy resume <ferret>`, `fy task assign F412 <ferret>` or `fy task drop F412 --reason "<why>"`.
  The message is the daemon's (`senderKind: daemon`), never typed into an **interactive** owner ferret —
  that is the owner's own chat, so it gets the notice below instead — and a message that could not be
  typed becomes that notice too, rather than being typed again every sweep.
  Otherwise the owner gets a plain notice tied to the card (`task` on the agenda item, source reference
  `warden-orphan:F412`) on the owner ferret's board, else the finished ferret's. Each is sent once per
  card and ferret that left it; a message to an owner ferret that has finished since moves on to the
  notice; the notice clears itself once a ferret is on the card again. Nothing is investigated: the flag
  never reaches Jev, an investigation or the Warden's spawn fingerprint. It is shown on the Warden page
  as **card orphaned**.
- **A ferret stuck on an unsent message.** A ferret idle at its prompt with a message of Ferretry's own typed in
  its box and never submitted is the Warden anomaly `input_stuck` (`packages/daemon/src/lib/warden/input-stuck.ts`),
  shown on the Warden page as **stuck unsent**. It is facts only — the session's state and its send ledger — and
  never reaches Jev or an investigation. The Warden presses Enter on it once per episode, through the send path's
  verified re-submit; if that does not submit it, the ferret's health becomes `stalled` and it is named on the
  `warden:input-stuck` machine item ([agenda.md](agenda.md#the-machine-agenda)). The whole rule is in
  [message-delivery.md](message-delivery.md#b144-a-ferret-idle-behind-its-own-unsent-message).
- **A ferret whose inbox is stuck.** A ferret whose oldest undelivered message has waited in Ferretry's own queue
  far past due is the Warden anomaly `inbox_stuck` (`packages/daemon/src/lib/warden/inbox-stuck.ts`), shown on the
  Warden page as **inbox stuck**. Facts only — the session's queue and its send ledger — never put to Jev and never in
  the spawn fingerprint. The Warden re-checks it once per episode, safely; if that does not move it, the ferret is
  named on the `warden:inbox-stuck` machine item and handed to an investigation whose verdict can only re-check
  again. The whole rule is in [message-delivery.md](message-delivery.md#b148-a-ferret-whose-inbox-is-stuck).
- **The card a resumed ferret carries on.** When the Warden starts an auto ferret again — an auto-revive,
  or a verdict's resume or restart — and the ferret has a focus card, its turn names the card: id, title,
  lane, the ask and every clarification verbatim, its links and its last five history lines
  (`packages/daemon/src/lib/warden/focus-card.ts`). A ferret with no card gets the turn it got before. The closing line
  tells a lead to move the card as it works; a sub-ferret, who may not, is told its card moves itself.
  An interactive ferret never gets a card typed into its terminal.

Declared gaps:

- **A failover is not handed the card.** Moving a ferret to another login keeps its conversation, and the
  migration writes its own notice; the card is not added to it.
