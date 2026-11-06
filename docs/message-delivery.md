# How a message reaches an agent's composer

A message to a running ferret is TYPED into its harness's terminal — Codex or Claude Code — and
submitted with Enter. Nothing about typing into a TUI replies, so the daemon proves each step by
reading the pane afterwards. This page is the contract for those proofs, the states a message row can
show, and what a person can do about a message that did not get through.

The send ledger and its fates are in `packages/protocol/src/lib/session.ts` (`SendRecordSchema`); the
decisions are in `packages/daemon/src/lib/tmux/` and `packages/daemon/src/lib/session/send/`.

## The durable queue (being built)

Every message to a session goes through ONE durable queue per session, owned by one deliverer
(owner-approved 2026-10-30). The deliverer hands each message to the send path described in the rest of
this page, which is still how a message reaches the pane.

- **Model** — `packages/protocol/src/lib/session-queue.ts` (`QueuedMessageSchema`): ✓ `queued` on accept,
  ✓✓ `delivered` once typed and submitted (pane proof), ✓✓✓ `read` once the transcript shows it as a user
  turn; `cancelled` and `failed` are final. `unconfirmed` is a message typed and not proven — the send ledger
  says `unaccounted` — which may have landed: never a failure, it holds nothing behind it, and a later proof
  still moves it to delivered or read. A waiting message carries a `waitReason` a person can act on.
- **Log** — `channel/queue.jsonl` beside the session, append-only and flushed to disk before an accept
  answers (`FileSessionQueueStore`). The queue is the fold of that log (`foldQueue`), which applies only a
  move that is legal from where the message stands, so a replayed or stale line changes nothing.
- **Order** — a person's message first, then a ferret's, then the daemon's; acceptance order within each;
  one message (or one combined delivery, [below](#labels-and-combined-delivery)) typing at a time
  (`planDelivery`). The daemon's notice may pass a ferret message that is still being HELD for combining —
  a Warden alert never waits behind a ferret's note — but never one that is due. A daemon notice to an interactive
  session is never in the delivery order (`boardOnly`): that session is the owner's own chat. Being out of the order
  does NOT keep it out of the pane — the queue hands it to the direct path, which types it — so a producer that must
  not type into that chat holds it back itself. The board's alerts do: they go to the card's working ferret and its
  leads first, and one whose recipient is interactive is journalled on it, never typed
  ([board.md](board.md#who-a-board-alert-is-for)).
- **Ready** — the deliverer types the next message as soon as the agent's input box is EMPTY, mid-turn
  included (the harness queues it itself). It holds only for a draft in the box, a question, dialog or
  permission form on screen, a session still launching, or a pane it cannot read, and says which as the
  `waitReason` (`waitReasonOf`). A stopped session is not held: the send path revives it. A "draft" that is
  a send of this session's OWN, typed by the daemon and never submitted, is not a person's: the deliverer has
  the send path finish it (`clearOwnDraft`) and goes on, or — when the Enter does not take — names it as the
  message's `waitBehind` ([below](#b144-a-ferret-idle-behind-its-own-unsent-message)).
- **Deliverer** — `QueueDeliverer` (`lib/session/queue/deliverer.ts`) is the one owner of WHEN and IN WHAT
  ORDER. It asks `planDelivery` what is next, marks it `typing` on disk, then hands it to the tracked send
  path under one id (`SendPathQueueTransport.handOver` → `SessionSendService.send`, the ONE function that
  delivers a turn; a combined delivery is handed to it as one payload with its `parts`), which does the HOW: the turn file, the turn record, the busy-pane
  queue, a revive. The send ledger, keyed by that id, is where every later tick comes from
  (`movesFrom`): `queued` there is ✓✓, `delivered` there is ✓✓✓. A `typing` message the ledger never saw
  had no key typed and waits again; nothing is ever typed twice on a guess. It looks at a session when a
  message is enqueued, when its state document changes, at boot, every `lookMs` (5 s) while something
  in it is still waiting or unproven, and at the moment the earliest HOLD ends (a hold is not a wait reason:
  nothing is wrong, the message is simply not due). It is armed after the bind, like the send tracker, and stopped FIRST
  on the way down: a send answers once its message is on disk, so one sent just before a stop is still
  being typed, and the stop waits (up to `drainMs`, 15 s) for that hand-over rather than cutting it in half. Both harnesses follow one rule: Claude Code's own queue shows a
  message typed mid-turn, so its hand-over is proven at once; Codex steers it into the running turn and
  shows nothing, so it stays `typing` — holding the next message — until Codex's transcript proves it.
  A `typing` message whose ledger row is still `accepted` after `recheckMs` (60 s) is put to the send
  tracker (`QueueTransport.recheck` → `SendTracker.check`), at most once per `recheckMs` per session, so a
  hand-over nothing else is watching cannot hold the queue ([below](#b153-a-send-that-gave-up-before-its-first-key)).
- **Switch** — `"delivery": { "queue": false }` in `config/daemon.json` turns it off (on by default; read at
  start). On, `POST /v1/sessions/:sessionId/send` ENQUEUES. The refusals only a person can lift (an open
  structured question, a quarantined harness, an unconfirmed kill) are said first, exactly as the direct
  path says them, and nothing is queued. The person's agenda context and the attachment paths are baked
  into the text, and nothing else is: no board news rides on it, on top or as a message of its own. The route then waits, up to
  `QUEUE_ANSWER_WAIT_MS` (20 s), for the deliverer's first look and answers what the send ledger says the
  hand-over did (`answerOf`), so a message into an empty box is answered exactly as the direct path
  answered it; one held for a draft or a question is answered `queued` at once, with the message id as
  `sendId`. `--now` (stop the running turn first) is a flag on the queued message (`interrupt`), not a separate path: it keeps its place, and when its turn comes AND the input box is empty the deliverer hands it over with the send path's own stop-then-type.
- **No board news and no board alert is typed into the owner's own chat** (an interactive session): board news
  is not sent at all ([ferret-messages.md](ferret-messages.md#what-the-board-types-into-a-chat)), and a board
  alert is journalled instead (below). The other daemon notices still are typed there; see **Every producer**.
- **Board alerts reach the card's working ferret first.** A stale card, a red CI or a PR closed unmerged is addressed to
  the card's assignee, else its nearest live lead. When the only one left is an interactive session, the alert is
  NOT sent: `BoardAlerts` (`lib/board/alert-sends.ts`) journals it on that session as `board.alert-withheld`
  and a red CI or closed-unmerged PR on a private card is noted on its nearest public ancestor that is open on the default board (an archived one is skipped; with none, it is
  journalled only), so the board shows it ([board.md](board.md#who-a-board-alert-is-for)); a mode that cannot be read is sent to as before. Before this, a lead
  the owner chats with had 177 alerts typed into it as turns in three days (2026-10-31 to 2026-11-03) — 158 "CI is red",
  17 stale, 2 closed unmerged — 134 on the `direct` path and 43 on `native-inline`, every one `senderKind: daemon`.
- **Every producer** — the Warden, the board's nudges and checks, the declared-wait watcher, the learning
  re-instruction and the owner's agenda answers send through `QueueingSends`: enqueued under the request's
  own id (so receipts read from the send ledger still find it once typed), as the daemon's — or, for the
  agenda answers, the owner's. A daemon message to an INTERACTIVE session still takes the direct path, and so is
  still typed, for every producer but the board's alerts above: the Warden, the declared-wait watcher, the learning
  re-instruction, the agenda's attention check, and the board's go-ahead, turn-end and gate checks and reopen
  words. Holding those back too is a declared GAP — each tells the session something about its own turn or the
  owner's own words, so it needs its own home before it can stop being typed. The
  owner's agenda answers are no longer batched, held for a working ferret or held for a draft: the queue
  does all three (&C38); their receipt and reopen-as-a-card still come from the agenda outbox. A send
  failure told back to a ferret, and a held message released after a revive, keep the direct path.
- **A page, not the log** — `GET …/queue` answers the same WINDOW `GET …/sends` does (`lib/session/queue/page.ts`
  over `windowPage` in `lib/session/send/page.ts`, one owner of the rule): the newest `limit` messages (default
  100, at most 1,000) and EVERY open one however old (`queued`, `typing`, `unconfirmed`), oldest first, with
  `nextCursor` (OPAQUE: hand it back untouched) naming the oldest message of the page proper (`null`: nothing older).
  `?before=<nextCursor>` answers the next older page, each message once — even one that changes state mid-walk: the
  cursor is `<instant>~<session>~<id>` (session and id percent-escaped), the instant being the newest the first page's messages show, and an older page leaves out
  every message the first page carried, which is the open ones AND any that stands in `delivered`/`cancelled`/`failed`
  with a `stateAt` after that instant (it was open when the page was cut). The one move that cannot be read that way,
  `unconfirmed` → `read`, is answered again rather than left out (a rare repeat, never a gap); the app holds a repeated
  id once, in the fresher look: every message carries a `version` (the log position of its latest change) that decides it, and a look from a daemon without one falls back to revision, `stateAt` and how far along the state is. A snapshot cursor is BOUND to its session and checked: another session's, one whose instant is later than anything the log holds or earlier than the message it names, and any cursor naming no message is `400 invalid_cursor`. A bare-id cursor (an older daemon's) is a separate, still-accepted path and judges by the state at the time of
  the read. Same minimum and caller as before. Measured on a long-lived lead (2,948
  messages ever queued, 14 waiting, a 3.5 MB log): the unpaged answer was ~2.2 MB and the app read it 16 times in an
  18-second start-up. A reader written before the window parses the same `messages` array, only shorter, and
  needs no delivered history: a bubble whose queue row is outside the window is drawn from its ledger row. The
  daemon still folds the whole log to answer — this saves the wire, not the read.
- **What the app shows** — the app reads `GET …/queue` on the same beat as the send ledger
  (`readSessionQueue`; an older daemon's 404 is "no queue", never an error, and a failed read keeps the last
  queue) and joins the two BY ID (`joinQueue`, `packages/pwa/src/lib/send-queue.ts`). One message is one
  bubble for its whole life: a queue message with no ledger row yet becomes a bubble of its own, and the
  ledger row of the same id wears the queue's view once it exists. The ticks (a fourth, ✓ first, is this
  device's own outbox, below):

  | Queue state | Mark           | Words under the bubble                                                                                                                                                                  |
  | ----------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `queued`    | ✓✓             | `waiting: <reason>` — it is still starting / the ferret is busy / a question is open / a dialog is on its screen / its box holds a draft / its screen can’t be read / it is not running |
  | `typing`    | ✓✓             | `sending`                                                                                                                                                                               |
  | `delivered` | ✓✓✓            | `delivered`                                                                                                                                                                             |
  | `read`      | ✓✓✓✓           | `read`                                                                                                                                                                                  |
  | `failed`    | failed mark    | the daemon's failure sentence                                                                                                                                                           |
  | `cancelled` | cancelled mark | `taken back before it was typed; the agent never saw it`                                                                                                                                |

  A queue-backed row never shows the red "retry did not go through" copy and never offers a resend or retry:
  the tick and its reason replace them. Two rules keep it honest. A queue state of `delivered` or `read`
  WINS over any ledger fate, and a ledger row that already says `delivered` outranks a queue that has not
  caught up — a message the agent received is never shown as "not delivered". And a ledger `timed_out` row
  whose `unaccountedReason` is `session_ended` is shown as `unconfirmed` (quiet, not red): the session ended
  before the proof arrived, so the message may well have landed. While a message is `queued` its bubble menu
  offers **Edit** (an inline editor that PATCHes) and **Cancel** (DELETE). A `409` says "it was just typed into
  the agent" and a `404` says the queue no longer has it; both refresh the row.

- **The Queue page reaches older messages** — one ferret's Queue page (`/queue/<sessionId>`) shows the window and, when
  the machine has more, a **Show older messages** button (between what waits and what finished) that reads `?before=<cursor>` through the same daemon fetch (so it
  rides the relay like every other read) and adds the page to the list; a poll keeps what was added
  (`refreshQueueHistory`). A page answers the WALK and cursor it was asked from: a poll that restarts the walk (a held open message the window no longer carries has finished, and the walk would never bring its new state) bumps the walk number and keeps every other loaded row, and a page still in the air for the old walk is not merged but asked again on the new one. **All queues** lists only what waits, and every waiting message is always in the window, so it
  never asks.
- **The chat reads the queue on a nudge, not on every tick** — the 3-second working-chat poll still reads the transcript
  and the send ledger, but reads `GET …/queue` only on the first read, on a feed nudge (a journal event for the session,
  which a send always is), on any explicit refresh (a send, an edit, the page coming back) and every tick while a
  queued message's menu or editor is open (`watchQueue`). Ten idle ticks are zero queue reads. **A queue change IS a
  feed event**: every writer of `channel/queue.jsonl` (the service's enqueue/edit/cancel and the deliverer's moves and
  waiting reasons) appends through `NotifyingSessionQueueStore` (`lib/session/queue/notifying-store.ts`), which journals
  `control.queue_changed` (`{ messageId, change }` — never the text) AFTER the event is durable, so an open chat's feed
  nudges a queue read; the fleet feed leaves the session list alone for it. A failed announcement never fails the
  change. Under that, the chat keeps a bounded safety net: a queue unread for 30 s (`QUEUE_FALLBACK_MS`) is read on
  the next poll tick, and a failed queue read is retried with a doubling backoff from 3 s up to 30 s, even on a relaxed
  page — so a lost event or a failed read can never leave a bubble stale for good.

- **The device outbox is tick 1** — a message is written to a durable per-device IndexedDB outbox
  (`ferretry-outbox`, `packages/pwa/src/lib/send-outbox.ts`, keyed by the request id) BEFORE the machine hears of
  it, so "thank you" can be typed offline and survives a reload. Ticks: ✓ saved on this device → ✓✓ on the
  machine's queue → ✓✓✓ typed → ✓✓✓✓ read. The first attempt goes straight away; if it cannot reach the
  machine the bubble reads `waiting for connection` (with `n of m` when several wait). Each session drains in
  order, one flight at a time, on the browser coming online and on the machine's connection recovering
  (`watchOutbox`), and again after a reload. The send is idempotent: the request id is the queue id, and the
  daemon answers a repeat from its first record, so a retry never types twice. A file picked while offline is
  **deferred**, not failed: the browser already says it is offline, or the connection drops and stays down through
  the composer's retries, so the chip reads `uploads when the connection is back` (with a retry), the message can
  be sent, and the file goes into the outbox entry (IndexedDB keeps the `Blob`). A refusal with a reason (too
  large, a type nothing reads) still fails on the chip. Attachments are uploaded during the drain, before the
  send; a failed upload keeps the message in the outbox with the plain reason
  (`attachmentErrorMessage`) and holds the ones behind it. Only a failure that never reached the machine counts
  as waiting — the typed client's transport error, a deadline, a carrier with no route, a 408/429/5xx, or a bare
  fetch's own network `TypeError` ("Failed to fetch", "NetworkError when attempting to fetch resource.", "Load
  failed"). A message the machine refuses outright, or one that hit a bug in the app (any other error), is shown
  as **Not sent** and not retried. **Edit** and **Cancel** act on the outbox copy locally; once the message has
  left they fall through to the daemon queue's PATCH/DELETE. The `now` flag rides the outbox untouched, and so
  do the Agenda items a reply is about (the composer's "re" chips, `referencesOf`): they are stored beside the
  words and sent as the `!A3` prefix on every attempt, so a reply that leaves after a reload is still about its
  item, while an edit shows only what was typed.
- **Queue views** — the chat header's ⋯ menu has **Message queue** (that ferret: `/d/<id>/queue/<session>`), and
  **All queues** (`/d/<id>/queue`, also in Find / ⌘K) lists every ferret with something waiting across every
  paired machine, longest-waiting first. Both read `GET …/queue` every five seconds plus the outbox, one row per
  message with its tick, sender (only when it is not you; never tag text in a body) and reason, with Edit and Cancel. **When it
  goes** (`rowSend` / `groupNextSend` in `queue-view.ts`): a queued row whose `holdUntil` is still ahead says
  `sends by 11:20` (the reader's clock), and its ferret's heading shows the earliest as `next send 11:20`; a
  queued row with no hold left, or none, waiting on a busy ferret says `when its turn ends`; a row waiting for
  something else (a stopped ferret, an open question) and a row still on this device say only their own reason.
  A message still **waiting** (saved on this device, or `queued` here, owner's or a ferret's, held or not) is
  **not drawn in the chat at all** — this page is the only place it shows (`hideWaiting`,
  `lib/waiting-fold.ts`, applied to the Transcript's rows only) — and it appears in the chat once it is typed
  or delivered. A message that needs the person (failed, refused, unconfirmed, typed but not sent) is not
  waiting and stays in the chat.

- **Read it** — `GET /v1/sessions/:sessionId/queue` (operator), `fy queue <ferret> [--json]`.
- **Edit or cancel** — only while `queued`: `PATCH /v1/sessions/:sessionId/queue/:messageId` `{ "text" }` and
  `DELETE …/queue/:messageId` (operator, audited as `agent.prompted` without the text), `fy queue edit
<ferret> <id> <text…>` and `fy queue cancel <ferret> <id>`. Once a key has gone to the pane the words are
  the agent's, and either answers `409`.

## Labels and combined delivery

A ferret labels every message it sends: `fy send --kind blocker|action|fyi` (default `action`; `--ask`,
`--expect-reply` and `--now` are blockers). The label is the sender's own word about how soon the receiver needs the message, and
it decides how long the queue may hold it so that several can ride in one turn instead of waking the receiver
once each (owner-approved 2026-11-03).

| Label     | Delivered                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| `blocker` | At once, with every ferret message already waiting in front of it.                                            |
| `action`  | After `actionWindowMs` (60 s) from its arrival, with every ferret message that arrived in that time.          |
| `fyi`     | When the receiver ends a turn that began after it arrived, or after `fyiMaxHoldMs` (10 min), whichever first. |

These are never held, whatever label they carry or lack: **the owner's messages, the daemon's (Warden,
Board, Agenda) and a ferret's `--now`**. A **question** (`--ask`, `--expect-reply`) is never held at all, as
news or to be combined: the CLI makes it a blocker and refuses `--kind fyi` beside it, and the daemon treats
any message that expects a reply as a blocker whatever label it arrives with (a raw or older client included).
**The reply to a ferret the receiver is parked on is a blocker** too. A message with no label is delivered at
once only when it was queued before this existed. One that arrives with no label from an older CLI is an
`action`: the queue stamps it with the 60 s window and combines it, unless it expects a reply or is an
interrupt, which go at once.

- **One decision** — `planDelivery` (`lib/session/queue/policy.ts`) is pure: it takes the queue, the
  receiver's turn state, the clock and the settings, and answers `single`, `batch` or `hold`. A person's
  message goes alone and first. If ANY ferret message is due, EVERY pending ferret message goes with it, in
  acceptance order, up to `batchMax` (20; the rest follow as their own delivery).
- **Hold** — `enqueue` stamps `holdUntil` on a held message; the answer to `fy send` says so
  (`heldUntil`) and the CLI prints "held until …; do not resend". An FYI-only batch is never delivered to a
  STOPPED session (an FYI must not revive a ferret); it waits as `stopped` until a blocker or action
  arrives or the session runs. That is judged on the WHOLE pending queue: once a blocker or action is
  waiting behind any number of FYIs, they drain in order (a capped batch of FYIs included) so its turn
  comes. FYIs alone never hold back a daemon message.
- **One turn, one record** — the members are all moved to `typing` on disk, each carrying the batch id, BEFORE
  anything is typed; the send ledger gets ONE record, under the oldest member's id. `deliveredAs` on every
  member names that id, so a member's ticks and `GET …/sends/:id` come from the batch's record
  (`sendRecordFor`). A crash before the hand-over leaves them `typing` with no ledger record: all go back to
  `queued`, none is typed twice.
- **What the receiver reads** — one turn that lists each message with its place, kind, label and sender, in
  order ([format](ferret-messages.md#combined-deliveries)). Each part keeps its own kind, so the one that
  answers a wait still ends it. If the turn cannot be proven delivered, EVERY sender in it is told, each
  under its own message id (the ledger row keeps the members in `batch`).
- **A failure notice survives a crash** — the senders still to be told are written on the ledger row
  (`noticesOwed`, daemon-internal, never on the wire) in the SAME line as the `unaccounted` / `timed_out` fate,
  and each member is crossed off only after its notice was sent. A crash after the fate, or mid-loop, leaves
  the row owing exactly the members not yet crossed off; the next look — the boot walk included — pays them
  under the existing per-member key `send-failed:<recipient>:<sendId>`, so a notice sent but not yet crossed
  off is attempted again and lands once. A notice that throws stays owed. A send later proven `delivered`
  drops its debt, and a final row owing nothing stays quiet.
- **A debt that could not be paid schedules its own retry** — a look that leaves any notice unsent (the notifier
  threw, or the crossing-off would not write) schedules another look for that session after 60 s, then 2×, 4× …
  the wait before it, at most 6 in a row; the earlier of that and the sends' own next look wins, since one look
  is kept per session. Past the cap nothing is scheduled but the debt stays on the row, and `watching` counts it
  **whatever the age of its send** (the proof-age ceilings end a wait for proof, not for a notice), so the next
  reader's look or the next boot pays it. A paid debt resets the backoff and schedules nothing.
- **Settings** — `delivery` in `config/daemon.json`: `coalesce` (default `true`; `false` is the kill switch —
  every ferret message is a blocker and goes alone, as before), `actionWindowMs` (60 000),
  `fyiMaxHoldMs` (600 000), `batchMax` (20). Read at start.
- **Not a digest of anything else** — the only digest Ferretry allows is this one, of FERRET messages the
  sender chose to label `fyi`. Board news, Warden alerts and every other daemon message are never batched
  ([board.md](board.md)).
- **Downgrade** — a daemon that does not know `label` answers 400; the CLI retries once without it and says
  so, and the message is then unlabelled. A combined turn already written is only text: an older app shows it
  as one message.

## The composer is read, never searched for

Every proof reads **the composer itself** — the last prompt-glyph line (`›`, `❯`, `>`) and the indented
lines a multi-line draft wraps onto, up to the first blank row — together with the cursor tmux reports
beside the capture (`lib/tmux/composer-screen.ts`). It never asks whether the message's words appear
somewhere on screen. A composer the CURSOR reaches past a blank row runs down to the cursor, blank rows and indented rows
included: Codex draws no rule under its composer, and a ferret's message (an envelope line, a blank row,
paragraphs) typed into a busy Codex 0.156.1 pane was read as its first line only, so nothing pressed Tab
and it sat under "tab to queue message". A Claude composer (`❯`/`>`) that its rule closes runs to that rule, blank rows
included: a multi-paragraph draft (a Warden notice is three paragraphs) draws its blank lines inside the
composer, and ending it at the first one put the cursor below it, read the composer `unreadable`, and
refused every later send — the owner's included — while the notice itself was never proven landed, so
never submitted.

That search was the bug the owner hit on Codex ("sometimes Enter doesn't work, and then the message is
stuck forever"):

1. An empty Codex composer draws a rotating placeholder — `Ask Codex to do anything`,
   `Run /review on my current changes` — and those contain ordinary words (`hi`, `review`). Typing `hi`
   removed the placeholder's `hi` and added one, so a count of `hi` across the screen did not move. The
   daemon decided nothing had landed, cleared and retyped three times, and gave up with `hi` left typed
   in the composer: **typed, never submitted**.
2. The next message, `hello`, was typed onto it, and Codex submitted `hihello` — one message neither
   send could match in the transcript.
3. Both rows then waited for proof, re-extended every minute for the two-hour ceiling, because "is it
   still held?" was answered by finding `hi` / `hello` anywhere in view — in the placeholder, or in the
   conversation the message had already been submitted into. `hello` was even reported **Queued**.

The cursor is what tells a placeholder from input: an empty composer parks the cursor at its first
column, typed text moves it past itself. Claude Code's idle suggestion (`Try "…"`) and its queued
placeholder are placeholders by their wording, whatever the cursor says.

**The ink settles what the cursor cannot.** A person who types the ghost suggestion's very words and
presses Home parks the cursor in exactly the place the ghost does (`2|27`, measured), so the cursor alone
reads their draft as empty. Both harnesses draw the difference themselves: every placeholder — Claude's
ghost suggestion, `Try "…"`, `Press up to edit queued messages`, Codex's `Ask Codex to do anything` — is
SGR 2 (dim), and typed text, a collapsed paste chip included, never is. So `captureFrame` takes a second,
tiny capture, `capture-pane -e -p -S <row> -E <last>` of ONLY the composer's rows through the in-band
control client, and `composerInk` (`lib/tmux/composer-ink.ts`, pure) reads it: every non-blank glyph
after the prompt dim → `dim` (a placeholder, empty); any glyph not dim → `plain` (input). Measured on
Claude Code 2.1.281 and Codex 0.156.1; the frames are `tests/fixtures/composer/*-ink-*.{txt,ansi,cursor}`.

- Dim ends at `22` or a reset, **not** `39`; a `2` inside `38;2;r;g;b` is a colour channel, not dim.
- Claude fakes a cursor on its placeholder by drawing the first glyph in inverse video, outside the dim
  run. Inverse cells are the cursor, not ink, and are skipped, as are blanks and the prompt glyph.
- **The ink says "cannot say" (`undefined`) rather than guess**: a capture with no SGR at all (a harness
  started without a colour terminal), one whose row count or text differs from the plain capture (a
  repaint between the two), or a composer with no glyph to read. The cursor rule and the wording above
  are then exactly what they were. The ink never makes a send riskier: the fallback is today's rule.
- The two captures are not atomic, so the plain rows are compared with the attributed ones' text before
  the ink is believed.

The folder-trust screen is a dialog, not a draft. Claude Code 2.1.281's draws **unnumbered** rows —
`❯ No, exit` selected first, then `  Yes, I trust this folder` — and `menuOptions` found nothing numbered,
so `waitReady` saw a `❯` row with text after it and refused the pane as holding someone's draft.
`startupDialogAction` now also reads `Yes`/`No` rows for the trust and API-key dialogs
(`yesNoOptions`) and answers by moving to the affirmative row (Down, Enter here; Up, Enter for the
API-key screen, whose `No (recommended)` is selected). Fixtures: `tests/fixtures/startup-dialogs/`.

**Nothing is typed into a composer that is not proven empty** (`composerState`, `fillComposer`). A
frame with no prompt line, or text the cursor cannot place, is `unreadable` — it may be a person's
draft — and a fill looks again a few frames apart (`COMPOSER_READS`), then types nothing. Only AFTER
typing into a proven-empty composer may a frame with no cursor fall back to the older character count
as proof of landing.

## Measured Codex behaviour

Measured on real Codex **0.145.0, 0.156.1 and 0.163.0** TUIs driven in tmux against a local fake
Responses API (fixtures: `packages/daemon/tests/fixtures/composer/`, each a `capture-pane -p` with its
`cursor_x|cursor_y`).

| Behaviour                                                        | 0.145    | 0.156 | 0.163 |
| ---------------------------------------------------------------- | -------- | ----- | ----- |
| The placeholder contains a word a short message is made of       | `review` | `hi`  | `hi`  |
| Enter sent with no gap after the text opens a new line instead   | yes      | yes   | yes   |
| A second Enter then submits it                                   | —        | yes   | —     |
| Text left in the composer is sent when the turn ends             | —        | no    | no    |
| Enter mid-turn holds it under `Messages to be submitted …` (`↳`) | yes      | yes   | —     |
| Enter mid-turn steers it straight into the running turn          | —        | —     | yes   |
| Tab mid-turn holds it under `Queued follow-up inputs` (`↳`)      | yes      | —     | —     |
| `C-u` on an empty line joins it onto the line above              | yes      | yes   | yes   |
| One `C-u` erases a whole logical line, however it wraps          | yes      | yes   | yes   |

Claude Code does NOT share that last row: see below.

`—` is "not measured", never "no".

The daemon waits at least one poll (250 ms) between typing and Enter, which is outside the paste-burst
window, and if an Enter only opened a new line the composer still holds the message, so Enter is
pressed again — bounded, and only while that exact message is still there.

### Codex 0.166: a submission parked until startup ends

Measured on real **Codex 0.166.0** at the daemon's 80x24 (fixtures `codex-0.166.0-startup-*` and
`started-idle`; no inference: the probes were `/model`, and the one plain message was captured while a
loopback proxy held every connection, then the pane was killed before startup could finish).

- The composer is drawn **before startup has finished**, about 0.4 s in, with no status line under it.
  Startup then waits on an `account/read` round trip to chatgpt.com — under a second on a good link,
  and up to a timeout of about fifteen seconds, after which Codex exits with
  `account/read failed during TUI bootstrap: … workspace routing discovery timed out`.
- A payload submitted in that window **stays drawn in the composer** with
  `Waiting for startup · esc cancel` as the pane's last line, and is sent when startup ends. Escape
  cancels the park and leaves the same text as an ordinary draft.
- So the composer cannot tell a parked payload from an unsent one; the bottom line can. Delivery reads
  that line as **delivered** (`paneShowsStartupWait`): a turn for a message, the TUI's own for a slash
  command. Pressing Enter again would key a harness that has already taken the payload — and a `/model`
  whose picker opened between the frame and the key would have its first row chosen.
- **A parked pane is not a draft and is never finished.** The send service's pane observation reports it
  as `startupParked` with no `draft`, so nothing that finishes a stranded send (a send's own
  `withoutStrandedPointer`, the queue's `finishOwnDraft`, the Warden's `finish_own_draft` and
  `resubmitStuck`) presses Enter into it. A send that arrives meanwhile is **pending, not refused**
  (`SendPending`, which the queue reads as `launching`) and is tried again once startup ends; the
  parked message's own tracking reads it as held by the harness (`paneHoldOf` answers `queue`), not as
  typed-and-unsent.
- **The send side holds the same line at every entry.** A send, a re-attempt or a submit at a parked
  pane is refused as pending (a re-attempt: busy) and nothing is typed or pressed; the queue reads it as
  launching. A revive's held-send release waits **outside the session lock** for the park to clear (a
  2 s poll, bounded at 10 min) and otherwise leaves the sends held and journals
  `control.send_release_deferred`, as it also does for a record skipped because the pane parked again
  under the lock. `clearComposer` answers stuck rather than wiping the harness's own text.
- **A NEW session's start no longer types `/model` at all** (`fy new`, the app's New ferret). It used to
  set a Codex start's reasoning level by driving the picker the instant the composer appeared, which on
  0.166 meant typing into a Codex that could not run it yet; the picker driver's bounded wait then
  failed the start with "Codex did not reach a model list" whenever startup outlasted it. The level now
  rides the launch command (`-c model_reasoning_effort="<level>"`), checked against the login's catalog
  before the pane exists (`planStartupEffort`, `codexStartupEffortRefusal`). A live switch and a
  **fork** (which applies its target's model and effort through the startup picker hook) still drive
  the picker, and that drive tolerates a slow startup because a frame showing the park is not charged
  to its budget (`CODEX_STARTUP_WAIT_OBSERVATIONS`, which outlasts Codex's own startup timeout).
- The captures were taken through the real fleet wrapper, which configures the ferretry MCP server, and
  once with that server deliberately delayed 8 s; no line was drawn below the wait line, and MCP
  start-up did not hold startup.

#### Why a Codex start is slow

A slow Codex start is the network, not the machine. Measured on one box, start of the process until
`Waiting for startup` clears:

| Condition                                                     | Startup completes                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Normal link to chatgpt.com                                    | ~0.8–1.1 s                                                                                       |
| A 216 MB `thread_history` sqlite database vs a near-empty one | the same                                                                                         |
| Six starts in parallel                                        | the same                                                                                         |
| +1.5 s of latency to chatgpt.com                              | 2.45 s                                                                                           |
| +3 s of latency to chatgpt.com                                | 3.9 s                                                                                            |
| No answer for ~15 s                                           | Codex exits: `account/read failed during TUI bootstrap: … workspace routing discovery timed out` |
| A brand-new sqlite home                                       | one-time ~4–5 s backfill on top                                                                  |

Every millisecond of latency adds one, and the size of Codex's history adds nothing. So the start is made
visible instead of guessed at:

- **`harnessStartupMs`** (on the session's state, `fy status <id> --json`) is the time from just before the
  pane was launched until the first turn was delivered **and** the harness had finished its own startup,
  read from the lifecycle's clock port. The start waits for that after delivery
  (`TmuxPaneDelivery.waitStartupSettled`, deciding each frame with `startupSettleStep`): while the last line
  is the park line it polls every `pollMs` (250 ms) for up to `startupSettleMs` (30 s). Claude, and a Codex
  that was not parked, are settled on the first frame and wait for nothing. A bound that passes is **not**
  a failure, and it is **not** a startup time: the wait answers `timed-out`, `harnessStartupMs` is left
  unset, and the time from launch until the wait gave up (at least the 30 s bound, since it also covers launch and
  delivery) is recorded as `harnessNotReadyAfterMs` instead. A pane that dies while
  waiting **fails the start** with the harness's own reason (`harnessExitReason`), so `account/read failed
during TUI bootstrap … timed out` is reported at start time rather than by a session that dies later; the
  reason ends `; its first turn was never run, so start a new session rather than reviving this one` when the
  wait saw the turn parked before the pane died (delivery was already recorded, but a parked Codex never ran it),
  and `; its first turn may not have run, so start a new session rather than reviving this one` when it did not. A clock reading that is not an instant
  records neither field. Only a launch the start made
  is measured; a retried start that finds its pane already live, and a revive, leave any earlier value.
- **`fy new`** appends `, harness ready in 4.2 s` (or `, harness not ready after 31.4 s`) to the started
  attempt's line, and for a Codex that took 3 s or more prints one more line: `Codex waits on an account
check with chatgpt.com before it starts, so a slow start is usually the network (the first start on a new
Codex home also indexes its history once)`. `fy status <id>` shows `ready in 4.2 s` (or `not ready after
31.4 s`) with the session's other vitals. A start whose session comes back `failed` is **not** a started
  ferret: Pack answers it as a `start_failed` refusal carrying the session's reason, and `fy new` prints
  `refused (start_failed): …` (and `refused <runtime> … — start_failed: …` among the attempts) and exits 2 like
  any refusal.

## Measured Claude Code behaviour

Measured on **Claude Code 2.1.281** from live captures of the incident below (fixtures:
`packages/daemon/tests/fixtures/composer/claude-2.1.281-busy-queued-*.txt`; they carry no cursor, so
the tests check every cursor tmux could report).

- Text submitted mid-turn is drawn **above the spinner**: each message a `❯ <text>` line, its wrapped
  rows indented two columns, blank rows between messages, and the block closed by
  `  ctrl+x ctrl+s to send now`.
- The composer then shows `Press up to edit queued messages`. That is a **placeholder whatever the cursor
  says** — read as input it refused every later send over a draft nobody typed.
- **No transcript record is written** for text typed into that queue (no `queue-operation`), so the
  block on screen is the only proof the message is held until the turn ends and Claude submits it.
- A named session (`claude -n`) draws its name inside the rule ABOVE the composer
  (`──── [Aime] MXO OCI Migration ─`). The composer is read upward from its own prompt line, so the
  title changes nothing (fixtures `claude-2.1.281-titled-*`, live at 82 columns, with their cursor).
- The cursor sits after the last typed character, on the composer's last wrapped row; an empty composer
  shows a `Try "…"` suggestion with the cursor at its first column.
- **`C-u` erases back to the start of the wrapped ROW the cursor is on**, not the message: a pointer
  wrapped over three rows loses only its last row (`claude-2.1.281-titled-draft-pointer-after-cu`).
- A queued prompt Claude feeds into the running turn is recorded as an `attachment` › `queued_command`,
  and its `prompt` is a STRING only for plain text. A drain that carries an image, a paste, or several
  queued prompts at once records CONTENT BLOCKS, read like a user record's (`claudeUserText`). Read as a
  string only, that drain proved nothing: on 2026-10-30 a ferret's message the lead had read was called
  absent, typed three more times, and shown on the owner's phone as "not delivered".

**"Not delivered" is a claim of absence, and only absence earns it.** A typed send whose session ended
before anything proved it is `unaccounted` (`session_ended`) — a harness queue holding it at a restart
delivers it all the same — and only a send nothing was ever typed for is `timed_out` there. A `timed_out`
send stays watched for the repair window (`repairLimitMs`, 3 days), like a cancelled one, so a record
the transcript holds corrects it to delivered: the rows the old reader got wrong correct themselves the
next time their ferret's sends are read.

**A paste Claude lifted an image out of is the same message.** Claude Code records a long typed message as
`<pasted_content id="…">…</pasted_content id="…">`, and an image path in it that names a real file becomes an
attachment: the path leaves the text, an `[Image #N]` goes in FRONT of the paste (not where the path was), and
the paste is re-wrapped. Neither the wrapper's text nor the placeholder's place matches what was typed, so on
2026-10-30 a ferret's message the lead had read four times was called "not delivered". With the wrapper and the
file placeholders out of the record, and every image-path token out of both, the two must be the same text —
and the send must have had an image path to lift and the record a placeholder for it.

**The pre-queue "not delivered" rows are re-proved once** (`LegacySendReproof`, marker
`send-reproof-migration.json` in the daemon's home). After the tracker is armed, every session's typed
`timed_out` rows — however old — are read against the recipient's transcript with the same incremental
evidence reader, one session at a time, judging every look: found is `delivered` (journalled as a
correction), read to the end and not found is `unaccounted` (`landing_unconfirmed`), and a transcript that
cannot be read to its end is `unaccounted` (`transcript_unreadable`). None stays red: only a send nothing
was ever typed for keeps "not delivered". A stop mid-pass writes no marker, so the next start finishes it.

**A long transcript is slow, not unreadable.** The tracker reads a session's transcript through a window it
holds from the oldest send it watches, appending only what is new on each later look, and a look reads at
most `WINDOW_STEP_LIMIT` batches. A window that stopped at that budget kept its place and has more to read
(`catchingUp`), so the send WAITS for the next look rather than settling `unaccounted`
(`transcript_unreadable`) — the lead's 369 MB transcript was called unreadable on every look, each send to
it read "unconfirmed", and each sender was told it might need sending again, though every one had arrived.
Only a read that fails, or a window that cannot start where it was asked (`window-capped`), is unreadable;
the hold ceiling still ends a read that never finishes. A step that stops at its read limit (8 MiB) reports
`source-truncated`, and that is paging: the next step reads on from there, so a window read to its end saw
every record. Counting it as blind meant no send to a transcript longer than one step could ever be proven
absent — an 11 MB conversation's sends all read "transcript unreadable".

The incident: one `fy send` to a mid-turn Claude ferret was not recognised as held, so at each deadline
(15 s, 30 s, 60 s) the tracker called it absent and typed it again — **four copies in one queue**, and
the sender told "did not reach it: it was not delivered … after 4 attempt(s)".

The queue is read only when anchored to that hint (`readHarnessQueue`), never from a `❯` line alone,
because the conversation above draws the person's past prompts with the same glyph; the read goes up
from the hint until a flush-left line that is not a queued message (the assistant's `⏺` output). A read
that reaches the top of the pane first, or a composer showing the queued placeholder with no hint to be
found, is **incomplete**: a payload found in it is held, but one not found is `unknown`, never absent
(`paneHoldOf`), and the terminal's `heldAt` throws for it — an unread pane proves nothing.

## Never two copies behind a running turn

A queue is the one place a typed message can sit unseen, so a send is typed into a **mid-turn** pane at
most once unless a person forces another (`typedIntoBusyPane`: its first transport rode the queue —
path `native-inline` / `native-file` — or a re-attempt was typed behind a turn, recorded as `busyTyped`
before the keys). Two places enforce it:

- **The tracker** proves such a send absent only once the turn has ended. While the pane is mid-turn it
  waits — pushing the deadline out, up to the hold ceiling, without spending an attempt — because at
  the turn boundary the harness either submits what it held (and the transcript proves it) or holds
  nothing at all. **An unreadable pane waits too**: a queue that runs past the top of a short pane (a
  multi-line peer message in a 24-row pane loses its head) makes the capture unreadable, and that is
  a reason to wait for the turn to end, not to say "unconfirmed" — it is reported (`pane_unreadable`)
  only when no turn is running to wait for. A dialog on screen still settles it `blocked_by_prompt`.
- **The screen reader** proves a queued message whose head scrolled off the pane by its visible tail
  (at least 12 characters that end the payload), and ignores lone ```fence rows on both sides because
Claude's queue does not draw them (fixture`claude-2.1.281-busy-queued-overflow.txt`).
- **Every re-attempt**, the tracker's as well as a person's, re-reads the pane under the send lock first.
  Shown held in the queue: the daemon's retry settles it `queued` on that proof and types nothing (a
  person's is refused). Shown typed in the composer: refused. The pane cannot be read, or the queue runs
  off it: refused unless forced, and the tracker settles the send `unaccounted` (`pane_unreadable`) —
  never "not delivered" — unless the pane is mid-turn and the send was already typed into it, when the
  tracker keeps waiting for the turn to end instead. Mid-turn and already typed into a mid-turn pane once: refused unless forced
  (`SendRetypeWithheld`, reason `held` / `busy` / `unreadable`).

An `unaccounted` send's notice to an agent sender says it **could not be confirmed** and may still have
landed — not that it "did not reach" the recipient, which invited the sender to send the copy itself.

## A message a revive carried

A send to a session whose harness has exited (an auto ferret that finished its task) becomes the first
turn of a **revive**: the message is written to the new turn file and the relaunched pane is typed a
POINTER at it, so the transcript records the pointer — not the message — as what the user said.

The incident: two peer messages to finished sub-ferrets were revived, read and acted on within seconds,
and both senders were told "did not reach it … (not delivered) after 1 attempt(s)" at 15 s. The ledger
kept only the message, so the tracker looked for text no transcript would ever hold; at the deadline it
found nothing, could not re-type a revive, and settled `timed_out`.

- **The relaunch says what it typed.** `SessionResumeService` reports `delivered` — the pointer, or the
  message itself when it found a live pane and typed into it — and the send records it as `matchText`,
  with the attempt clock restarted at that moment. The pointer proves it `delivered` at the
  `turn-instruction` tier.
- **Never judged mid-relaunch.** Until the relaunch has said what it typed, the send's first look is
  `reviveLaunchMs` (90 s) after acceptance, not the agent window of 15 s: a relaunch waits for the new
  harness to be ready before typing anything, about 45 s at the delivery adapter's worst.
- **Unconfirmed, never "not delivered".** A revive send past its deadline without proof is never typed
  again and never proven absent — the agent may have read the file and even finished. A pointer still
  visibly typed or queued waits; otherwise it settles `unaccounted` with reason `revive_unconfirmed`
  (`blocked_by_prompt` when a dialog is on screen), stays watched, and a pointer that turns up later
  still proves it delivered. Its agent sender is told it was handed over as the relaunch's first turn
  and most likely landed, and not to send it again unless the recipient stays silent.

## Never typing onto unsent text — and never typing twice

The owner's screenshot of a Claude ferret (`claude-pileup-screenshot`): the person's half-written
question, then SIX copies of one turn pointer glued onto it, one of them cut at `This is your `, and
nothing submitted. Each copy came from the composer fill's old retry: it could not prove its own
landing — the composer held the draft as well, never exactly the pointer — so it sent `C-u` and typed
again, three fills a delivery. `C-u` took only Claude's last wrapped row, which is the clipped copy,
and because landing was never proven Enter was never pressed. A second delivery of the same turn
(`turn-026` again: a failed delivery never started its turn) made six. The reading that let the first
copy land beside a draft — a composer the cursor could not place, read as empty, or the person's keys
arriving during the fill — is the one the rule above now refuses.

So a fill types its payload into a proven-empty composer, ONCE. The delivery adapters allow no second
fill (`composerAttempts: 1`): after a typing, only a person — a forced Retry — types that send into the
pane again (see below for why). A composer holding anything after a fill — the payload, the
payload beside a person's text, a clipped copy — is left exactly as it is, with no `C-u`: the send's
fate stays open and the tracker reads it. A payload found ANYWHERE in the composer (`composerContains`,
for a payload of 12 or more characters) is held there, never absent, so no deadline retypes it, and
Enter is pressed on it only when the composer holds exactly it.

### An empty composer after typing proves nothing until the pane has drawn

The owner's phone, sending to a Claude ferret on their Mac: `the turn did not land in the composer of
tmux session fy-mvgrig6j-51ec0eb3`, with the message still in the app's composer. Reproduced on Claude
Code 2.1.281 by stalling the harness (`scripts/local/soak-composer-landing.ts`, `--stop-ms`): typed keys
wait in the pty until the harness reads them, and a stalled harness — a throttled or napping host, a long
synchronous render — reads and draws nothing for seconds. The fill looked six times, 250 ms apart, saw
the composer still empty, decided the keys had never arrived, and typed again; three fills later it
threw that error, and the woken pane drew all three copies, unsubmitted. Every capture was fresh — the
delivery path reads `capture-pane` in-band through the control client and never the session worker's
`PaneFrames` — so the frames were not stale: the PANE was.

So the landing wait is a window in time that stretches with the pane's own latency
(`landingDeadlineMs`): 6 s for a pane that draws promptly, `settleMs` (2 s) past its first repaint for
a slow one, and up to 12 s for one that draws nothing at all, backing off from 100 ms to 1 s between
looks and never reading fewer than five frames. The clock counts only the waits, so a host whose
captures are slow stretches the window rather than shrinking it. Nothing short of proof leads to a
second fill: a fill configured for more than one (the delivery adapters are not) types again only when
the pane has drawn since the first (`paneResponded`) and its composer is proven empty holding nothing.
That proof trusts that an empty-looking composer after typing means dropped keys, and the owner's Mac
showed one message typed three times by fills that each saw it empty — so by default anything short of
landing is **unconfirmed**: the send is settled `unaccounted` with
reason `landing_unconfirmed`, never withdrawn and never typed again, and stays watched so a transcript
record that turns up later still proves it delivered. The send answers `409 send_unconfirmed` with the
send's id in the body's `sendId`; the app keeps the person's text in its composer and offers **Send it**
(`submitSend`: Enter, only if the composer holds exactly that message), **Clear it** (`cancelSend`)
and **Retry** (`retrySend` with `force`, which types only when the pane holds no copy). No tmux session
name reaches the person. Enter follows the same rule: a pane that has drawn nothing since an Enter is
watched up to the stalled window before the next one, which would only queue behind the first.

Measured with the soak (Claude Code 2.1.281, SIGSTOP 2 s / run 150 ms, every tenth message a
multi-line paste, paced by transcript arrival): echoes took p50 2.5 s and up to 4.3 s. Before this rule
29 of 50 sends were delivered and every one of the 21 failures left two copies typed in the composer;
after it, 200 of 200 were delivered exactly once with nothing retyped, and 50 of 50 with captures slowed
to 0.16–0.48 s each. The recorded frames of one stalled send are
`packages/daemon/tests/fixtures/composer/claude-2.1.281-stalled-echo.json`, replayed on a virtual clock by
`packages/daemon/tests/integration/tmux/pane-delivery.test.ts`.

**What the owner's Mac showed.** Its pane
(`packages/daemon/tests/fixtures/composer/claude-2.1.281-mac-draft-autocompact.txt`) drew
`❯ go ahead with all three` under a titled rule and above a right-aligned `2% until auto-compact` line,
with tmux reporting the cursor at `2|17` — the composer row's first column. That is Claude's dim ghost
SUGGESTION of the person's next prompt (SGR 2 under `capture-pane -e`; `❯ ok` in a soak here), which
can be any words; the dim ink (above) reads it as an empty composer, and so does the cursor rule when no
attributes could be captured, and the status lines change nothing. It is also why one message was typed three times there: typed onto the suggestion, unread by a
stalled pane, every look still showed the suggestion — empty — and each fill typed again. The one-fill
rule and the stretching window above are the fix; the reader was right.

A composer that cannot be read is refused before a key. A **person's** fresh send is kept open rather
than withdrawn: it stays `accepted` and `untyped` (journal `control.send_deferred`), and the tracker
tries it every `untypedLookMs` (5 s), ahead of every other send in the same look, until the pane reads
clear and it is typed — its first typing, so still attempt 1. Nothing was typed, so none of the duplicate
guards (a turn taken since, a busy-pane typing, an unreadable transcript) hold it back; a re-read that
still cannot prove the composer empty, or a draft in the way, only waits. Never typed by the hold
ceiling, it is `timed_out` (`not_delivered`) and retryable. This is what the owner's message lacked:
withdrawn a second after it was accepted, it was never tried again. A ferret's or the daemon's fresh
send is still withdrawn and answered `409` (`send_refused`: "nothing was typed; send it again in a
moment"), a released held message goes back to held, and a tracker re-attempt of a TYPED send is
withheld (`unreadable`) and settled `unaccounted` (`pane_unreadable`) — never retyped.

A pane that never comes to a prompt is refused before a key the same way
([B153](#b153-a-send-that-gave-up-before-its-first-key)): a person's send is kept open and `untyped`, a
ferret's or the daemon's is withdrawn with `SendNotReady`, a released held message is kept open and
`untyped` too, and a re-attempt puts its record back and is withheld (`busy`), so the tracker waits. A pane
that went away during the wait is the exception: nothing is kept for the tracker, the send is withdrawn (a
released one goes back to held), and the next send revives the session.

A send first reads the composer. If it already holds input, **nothing is typed onto it**. What happens
next depends on whose text it is.

**A pointer of Ferretry's own is finished, not refused.** A long message travels as one line — "Read the
file …/turns/turn-008.md now, then …" — and when the Enter for that line was swallowed (a stalled daemon,
a repaint) the line sat in the composer and every later send was refused over a "draft" the person never
wrote. Now, when the composer holds exactly the pointer of one still-unsettled send in THIS session's own
ledger (`accepted`, `queued` or `unaccounted`; path `turn-file` or `native-file`), the send presses Enter
on it with the usual verification, journals `control.send_resubmitted` (`reason: pointer typed but not
submitted`), re-reads the session and the pane, and then carries on — normally into the harness's queue,
because the agent is now working on the turn it just received. The matcher (`lib/session/send/stranded.ts`)
ignores whitespace, because a TUI re-wraps a long line, and accepts a `…`-clipped pointer only when the
visible part runs past the whole turn-file path — a clip inside the path could be any session's pointer. A
person's draft, an edited pointer, another session's pointer, a pane mid-turn or behind a dialog, and an
Enter that does not take all end in the refusal below, with nothing pressed or wiped.

The earlier send is recorded as **entered**, not `delivered` — only the transcript proves that, and the
tracker looks. Its `typedNotSent` flag goes, an `unaccounted` fate re-opens to `accepted`, and its attempt
clock restarts at the Enter, so a deadline long past cannot call it absent before the harness has written
its record and retype it. A turn its own send never got to start (the stranded send threw before the
turn bookkeeping) is started then, so the next send does not claim the same turn number.

**Anything else is the person's, and is refused.** The send answers `409 composer_occupied` with the
draft quoted in the message ("Press Enter on it or clear it first") and the whole draft in the body's
`draft` field. The app shows that as a notice under its composer with **Send it** and **Clear it**; each
calls `POST /v1/sessions/:id/composer` with `{ action: 'submit' | 'clear', draft }`, which acts only while
the composer still holds exactly that draft (`changed` otherwise), and the app then re-sends the person's
own message. The terminal makes the same occupied check again immediately before its first keystroke; a
refusal there withdraws the just-accepted record, which is honest because nothing was typed.

### The tracker presses Enter again for text of ours

The transport already presses Enter a bounded number of times while the payload is visibly still there.
Text that outlives that is the tracker's: on a look where the composer still holds exactly the send's own
text, it asks the send service (`resubmit`) for one more verified Enter at each of `submitNudgesMs` (4 s,
12 s, 30 s after the attempt typed it). The service re-checks everything under the session's lock, counts
the nudge on the record (`submitNudges`, daemon-only) BEFORE the key, and presses only at an idle,
undialogued pane; a nudge that falls due mid-turn or behind a dialog is not pressed, and is tried again
every `deferredNudgeMs` (5 s) — still owed after the row says "typed, not sent", so a long turn ending gets
its Enter. A pointer is said to be **typed, not sent** only once the last nudge has had `typedStableMs` to
take.

"Its own text" (`strandableText`, `showsOwnText` in `lib/session/send/stranded.ts`) is a pointer — or,
since B144, a message typed AS ITSELF (`direct`, `native-inline`) of at least `OWN_TEXT_MIN` (12)
characters: the fill typed it into a composer it proved empty, so text that is exactly it is the send's.
A shorter message could be a word a person typed and is never pressed. Re-wrapped and `…`-clipped text
matches as for a pointer, and a message that travelled as a paste matches the composer only when one
collapsed placeholder is ALL it shows and its own count agrees with the message (`lonePasteOf`,
`lib/tmux/composer.ts`): Claude's `+N lines` (the message's line breaks, or its lines) or Codex's `N chars`.
A person who cleared our paste and pasted their own draft shows a placeholder too, so one with a count that
disagrees, or no count at all, is never ours. Every automated Enter — the tracker's, the queue's, a new
send's, the Warden's — also requires that no OTHER unsettled send of the session would match the box
(`strandedSend`): two pastes whose placeholders read alike are neither provably ours.

**The key itself is guarded by a fresh, exact read** (`submitComposer`, `holdsExactly`). The service's
decision and the key are a few awaits apart, and a person may type in between, so the terminal captures the
pane again right before Enter and presses only when the composer is the payload and nothing else (its lone
paste placeholder, for a paste), at a pane that is not mid-turn or behind a prompt. Containment — the payload
anywhere in the composer — still rules out a retype; it never licenses a key. The person's own **Press Enter**
(`POST …/sends/:id/enter`) and **Send it** (`/composer`) are held to the same exactness. So is the delivery's own
FIRST Enter (`TmuxPaneDelivery.submit`, `TmuxPaneQueue.queue`): a fresh frame before each key that READABLY shows
anything beside or instead of the payload — a person's words after it, or a paste placeholder whose count
disagrees, i.e. a person's replacement paste (`composerHoldsOtherText`) — stops the Enter; the send is typed and
unconfirmed, and never typed again.

**One Enter budget, durably.** The tracker writes the ledger under its own lock and the send service under
another (the tracker calls the service, so they cannot share one); a tracker write from a stale read used to
append after the service counted an Enter and put the count back — seven Enters past a limit of five. The file
ledger now runs every read-modify-append for a session as one transaction (`FileSendLedger.transaction`), a
leaf lock with nothing else awaited under it.

## Which messages are typed whole

An IDLE session is sent a message one of two ways, decided by `isDirectSend` (`lib/session/send/policy.ts`):

- **`direct`** — the text itself is typed (or pasted) into the composer and submitted. The agent reads the
  message with no further call.
- **`turn-file`** — the text is written to `turns/turn-N.md` and the composer is typed a one-line pointer,
  "Read the file …". The agent must make one more model call to read it.

The turn file is written on BOTH paths (a revive and the logs rely on it); the paths differ only in what is
typed.

| The message                                                                                              | Claude Code                    | Codex / others |
| -------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------- |
| One line, no control characters, within the session's `directSendMaxChars`                               | `direct`                       | `direct`       |
| Several lines, no control characters, within `directPasteMaxChars` (2,000) and the session's own ceiling | `direct`, as a bracketed paste | `turn-file`    |
| Longer than that, or holding a tab, `\r` or another control character                                    | `turn-file`                    | `turn-file`    |

- **`directPasteMaxChars`** (`settings.ts`, default 2,000) is the longest MULTI-LINE message pasted whole. It
  can only narrow a session's `directSendMaxChars`, never widen it: the multi-line ceiling is the smaller of
  the two, and `directSendMaxChars: 0` turns every direct send off, pasted ones included. An interactive Claude
  session has no single-line ceiling, but an explicit `directSendMaxChars` it was given (zero included) still
  bounds a multi-line paste.
- **Newlines are allowed, nothing else is.** Quotes, backticks, `$`, and unicode are text and pass; a tab or any
  other control character could be read by the composer as a key, so it still goes by turn file.

- **The paste is the same one the busy path already uses.** Text with a line break (or over 240 characters) is
  sent with tmux's bracketed paste (`paste-buffer -p`), so Claude takes the lines as text, not as Enter. A busy
  pane is unchanged: up to `nativeQueueInlineMaxChars` (1,000) is typed into the harness's own queue
  (`native-inline`), longer is a pointer (`native-file`).
- **The landing proof is B144's.** A paste is proven by the characters appearing in the composer or by a
  collapsed chip — `[Pasted text #N +M lines]` — whose line count matches the message's line breaks
  (`lonePasteOf`, accepted at `breaks` or `breaks + 1`). Enter is pressed once the paste is seen and
  pressed again, with the same verification and bounded budget, while the composer still holds it; a paste that
  never shows is `unaccounted` (`landing_unconfirmed`) and never retyped.
- **Codex stays on the one-line rule.** The repository has no capture proving a multi-line bracketed paste
  lands and submits in Codex's composer (its paste-burst window swallows Enter — see
  [Measured Codex behaviour](#measured-codex-behaviour)), so multi-line messages to Codex, and to any harness
  that is not Claude Code, still go by turn file until one is measured.

**Where "is this Claude?" comes from.** The policy never looks at the pane for it; it reads
`SendTarget.harness`, which the repository fills from the session's own `config.harness`
(`StorageSendRepository.target()`, `adapters/session/send/storage-send-repository.ts`). Two decisions hang on
that one field:

- **Whole paste.** `isDirectSend` types a short multi-line message whole only when the target's harness is
  `claude`.
- **The idle stop key.** `shouldPressStopKey` presses the stop key at an idle prompt only for an interactive
  `claude` session; at an idle Codex prompt that key can quit the TUI, so it stays suppressed there.

A target built WITHOUT `harness` reads as "not Claude": every multi-line send quietly falls back to a turn
file and the idle stop key is never pressed. Policy tests that build targets by hand cannot catch this, so
`tests/unit/session/send/storage-send-repository.test.ts` exercises the real repository and asserts both
outcomes.

### The peer banner is one line

A message one ferret sends another opens with ONE banner line, then the message on the next
(`peerEnvelopePreamble`, `packages/protocol/src/lib/agent-messages.ts`):

```
[<kind> from ferret <name> (session <id>) — not from the owner] <note>
<message…>
```

- **`<kind>`** is `message`, `question` or `reply`. Only a `question` is waiting for an answer.
- **The label slot.** The kind may be followed by ` · <label>` before `from`, so a sender can say how
  urgent a message is without the receiver reading it first:

  ```
  [message · fyi from ferret <name> (session <id>) — not from the owner] <note>
  ```

  The allowed labels are `blocker` (the sender cannot go on without an answer), `action` (something for the
  receiver to do) and `fyi` (no action needed) — `PEER_MESSAGE_LABELS`. **Nothing emits a label yet**: the
  banner writer can carry one, but the daemon does not pass one, so every banner sent today is the label-less
  shape above. The parser already accepts it (`parsePeerEnvelope` returns the `label`), so the change that adds
  labels to `fy send` needs no parser change.

- **Old banners still parse.** The two-line banner (`[message from ferret <name> …]`, the note on the second
  line, a blank line after it) and the older `[peer message from teammate <name> …]` wording are read, never
  written, because transcripts and queued messages still hold them. The PWA reads banners through the same
  parser.
- **Why one line.** A composer takes a single-line message verbatim but pastes a multi-line one. A two-line
  banner plus a blank line made every peer message multi-line before its first word, so each one went by turn
  file and cost the receiver an extra model call to read it.

## B144: a ferret idle behind its own unsent message

On 2026-11-02 two ferrets sat idle for hours with a message typed in their box and never submitted. annabeth:
a peer's turn pointer typed at 15:00:32 into a pane too busy to draw it; the fill saw nothing in its window and
settled it `unaccounted` (`landing_unconfirmed`); the pane drew it later; nothing pressed Enter. braelynn: a
lead's message typed mid-turn whose Enter was swallowed, left as `[Pasted text #40 +3 lines]` when the turn
ended. Every later message to either waited, the Warden called both `healthy`, and `fy send` told every sender
"queued in the agent's own queue (it auto-submits at the turn boundary)" for messages never typed. Four causes,
four fixes:

1. **The tracker never looked at an unconfirmed send's composer.** It skipped every send that was not open, so
   a `landing_unconfirmed` send whose keys arrived late got no Enter. Now, for up to `strandedWatchMs`
   (10 min) after its typing, such a send's composer is looked at (every `busyExtensionMs` while the text is not
   there), and its own text found there gets the same bounded, verified nudges. An Enter that takes re-opens it
   (`entered`) and starts the turn it carried; the transcript then proves it. A message typed as itself is now
   nudged too (above), which is braelynn's.
2. **The queue held every message behind the "draft" — our own pointer.** The send path already finished a
   stranded pointer before typing (`withoutStrandedPointer`), but the deliverer waited on `draft` and never
   reached it. Now the deliverer asks the send path (`finishOwnDraft`) whose the draft is: ours and submitted
   (`clear`), it reads the box again and delivers; ours and stuck, the message waits as `draft` with
   `waitBehind: <sendId>`; a person's, it waits as before. All callers' Enters on one send share one budget,
   `STRANDED_ENTER_LIMIT` (5), counted before each key.
3. **The next send reused the turn number.** An unconfirmed pointer never started its turn, so the next send
   claimed the same number and overwrote the very turn file the pointer named — what the agent read when the
   pointer was finally submitted. Now an unconfirmed typing RESERVES its turn on the session record
   (`control.turn_reserved`, reason untouched), so every turn file after it — a send's, a revive's, the resume
   domain's own — is numbered past it; an Enter that later takes the pointer starts that reserved turn. A send
   also numbers past every turn a non-withdrawn send still names (`nextTurnNumber`), and a revive reserves that
   number first, so its record and the relaunch's file agree.
4. **`fy send` claimed a queue the message was not in.** A queued answer whose ledger has no record yet is in
   FERRETRY's queue, untyped — and so is one whose ledger row is `withdrawn` (a hand-over refused before any
   key), which used to answer "delivered". The send answer now carries the queue's `waitReason` and `waitBehind`
   (`SendResult`), and `fy send` says "NOT delivered yet: it is waiting in Ferretry's queue … because …" — and,
   behind an unconfirmed send of ours, that a re-submit was attempted and the Warden flags it. `fy send --wait`
   treats the ledger's 404 for such a message as still waiting, never as "no such send", and ends a long wait
   saying it was never typed, without failing — a script that resent on failure would make a copy.

**The tracker keeps "it is in the box" true to the screen.** `typedNotSent` is set when the tracker sees a
send's own text in the composer and dropped when it does not: on every look for an open send, and — since
B144 — for an `unaccounted` one too, which is set on first sight (a late-drawn pointer) and watched for as long
as a repair is (`repairLimitMs`), past the hold ceiling, every `busyExtensionMs` once its Enters are spent. A
message typed into a three-hour turn whose Enter was swallowed is still there when that same turn ends, and
only a look can see it.

**The Warden's backstop — `input_stuck`** (`lib/warden/input-stuck.ts`). A send is stuck when it was typed by the
daemon (not held, not untyped, not a revive), is `accepted`, `queued` or `unaccounted`, and the tracker says its
text is in the composer (`typedNotSent`) — the flag decides, not the turn clock. An autonomous ferret at
`your-turn` for `STUCK_INPUT_MS` (3 min) with such a send typed that long, within a day, is flagged. Once per
episode the Warden presses Enter through the send path (`resubmitStuck`, one press past the daemon's own
budget). If the text is there and that does not submit it, the ferret's health is set `stalled` (journal
`control.input_stuck`) and it is named on the `warden:input-stuck` machine item
([agenda.md](agenda.md#the-machine-agenda)); when it is no longer flagged it leaves the item and the mark is
taken off (`control.input_unstuck`). An EMPTY box at the press (`absent`) proves only that nothing is held
now — the message may have been read — so it is neither marked nor noticed, and nobody is told to send it
again. Nothing is pressed or noticed while the Warden is off; the flag is still shown. The flag never reaches
Jev, an investigation or the spawn fingerprint.

**On the wire it has its own field.** The Warden status and run views carry `input_stuck` flags in an optional
`stuckInput` list (`WardenStuckInputFlagSchema`), never in `anomalies`: an app or CLI built before the kind
existed parses `anomalies` against a closed list, and one unknown kind there rejected the whole status. A
newer reader shows both (`wardenFlags`). For the same reason the kind is never put on a blessing.

## B148: a ferret whose inbox is stuck

Between 2026-11-02 and 11-04 the messages sent to ryu, a lead in a declared wait, sat undelivered eleven times for
38 minutes to almost six hours (2h, 2h, 5h49m, 2h07m, 5h06m, 1h38m, 2h52m, 2h50m, 59m, 44m, 38m), and on 2026-11-03
elta's queue held 28 messages for five hours. `input_stuck` saw none of it. Two shapes, read from each ferret's
`channel/queue.jsonl`, `channel/sends.jsonl` and `events.jsonl`:

1. **A hand-over that never typed (ryu).** One message was `typing` — handed to the send path — and its ledger row
   was `accepted`, attempt 1, with no `control.send`, no deadline and no settlement. Its session said `waiting`
   (a declared wait) while the agent was still mid-turn, so the send was routed as idle; the pane never became
   ready, the transport threw before its first key, and the throw skipped telling the tracker. The queue, which
   types one message at a time, held everything behind it with no wait reason at all. Only a look by the tracker
   freed it — a daemon boot, or a `fy send --wait` from somebody else reading the ledger — and it then landed in
   seconds. Nothing was typed, so `typedNotSent` was never set; and in a declared wait the turn state was `null`,
   not `your-turn`, so the ferret was not even an `input_stuck` candidate. (The send path's own fix is [B153](#b153-a-send-that-gave-up-before-its-first-key).)
2. **A draft nothing proves ours (elta).** A send settled `unaccounted` (`landing_unconfirmed`) whose text the pane
   drew later, unrecognised: `finishOwnDraft` answered `foreign`, so every later message waited as `draft` with no
   `waitBehind` — for a person who was not there — at a ferret idle at its prompt.

**The Warden's backstop — `inbox_stuck`** (`lib/warden/inbox-stuck.ts`). Facts only: each autonomous ferret's
queue (folded `queue.jsonl`) and its send ledger, whatever its status or turn state — a declared wait is no hold,
because the queue never waits for one and a reply is what a waiting ferret wants. A message is undelivered while it
is `queued` or `typing`. Not stuck, because the queue holds them on purpose: a message before its due time (a held
action or FYI is due when its `holdUntil` ends), an FYI to a stopped ferret, a message waiting on a `question`, and
everything older than three days past due. Stuck once the oldest undelivered message is overdue by its urgency's
limit (`INBOX_STUCK_LIMITS_MS`):

| Urgency | Which messages                                                      | Limit past due |
| ------- | ------------------------------------------------------------------- | -------------- |
| blocker | a person's, `--kind blocker`, `--now`, a question (`replyExpected`) | 10 min         |
| action  | a ferret's action, unlabelled, and the daemon's own                 | 20 min         |
| fyi     | a ferret's `--kind fyi`                                             | 45 min         |

The flag names the oldest stuck message (the episode), how many are waiting, and the CAUSE at the head of the
queue: `hung_handover` (a `typing` message whose send is accepted, nothing typed — ryu), `held_for_revive` (its send
is held for a revive the reviver refused), `draft_own` (a send of ours sits typed in the box), `draft_unattributed`
(elta), `unreadable` (the queue's own wait, or a person's send the screen would not let be typed, which the tracker
types once the screen reads clear), `dialog` / `launching` (the queue's own wait, held far too long), or
`no_reason` (nothing has looked at the queue).

**What is read.** A queue file not written to for longer than the horizon plus the longest hold a message can be given
(a day: `fyiMaxHoldMs`'s maximum; `INBOX_STALE_QUEUE_MS`) is not read at all — one `stat` — since every message is
appended when it is accepted; finished ferrets keep their
queues for good, and reading all of them every sweep would grow without bound. A queue, a ledger or a `stat` that
cannot be read proves nothing: a ferret already flagged stays as it stands, on the notice and in memory.

**What is done**, once per episode, while the Warden is on:

1. **The safe re-check** for the cause (`unstickActs`): the send tracker's own look (`SendTracker.check`, the look a
   boot makes) for a hung hand-over, an unreadable screen or an unattributed draft — the transcript's proof wins, a
   message held in the pane or the harness's queue or typed into a busy turn is waited for, an unreadable screen
   settles it unconfirmed, and only a send PROVEN never to have arrived is typed again, under the send lock, its
   attempt ledgered before any key; the send path's verified finish of a draft (`finishOwnDraft`, which presses Enter
   only on text that is exactly a send of ours, within its own Enter budget) for either kind of draft —
   `input_stuck` presses for one of ours only at a ferret whose turn has ended, never in a declared wait, so a
   declared-wait draft whose Enters are spent is left to a person; and, for every cause, one more look by the
   deliverer.
   A revive the reviver refused is not retried: it is a decision. Nothing is deleted or resent on a guess, and a
   person's draft is never touched. Journal: `fleet.warden_inbox_rechecked` with what each act did.
2. **Escalation**, when the same episode is still flagged a sweep later: the ferret is named on ONE machine item,
   `warden:inbox-stuck` ([agenda.md](agenda.md#the-machine-agenda)), one line each — who, how many, how long, the
   cause and the send in the way — and leaves it once its queue moves (`fleet.warden_inbox_noticed`,
   `fleet.warden_inbox_recovered`), or once what waits in it is past the horizon (`fleet.warden_inbox_expired`: no
   longer tracked, which is not drained). No health mark: the ferret is not the faulty party.
3. **An investigation**, in the same sweep and ONCE per episode (`investigatedAt`): the flag goes to an assigned
   warden, never to Jev (it is a fact about the daemon's queue, which a ferret's transcript cannot show). It never
   displaces the ferret's own investigation: a ferret that is also frozen, say, is investigated for THAT, with the
   remedies a frozen process needs — unless that anomaly is left alone or waiting its backoff, when it will not be
   investigated and the inbox is. Its prompt has it read the queue, the ledger and the events, read-only, and
   offers only `LEAVE`, `NEEDS_HUMAN` and `NUDGE` — which here asks the daemon to run the safe re-check once more.
   Whatever its verdict names, the ferret is never messaged, resumed, restarted or stopped for this flag
   (`fleet.warden_inbox_rechecked` with `by: investigation`), and a `LEAVE` grants no blessing. Its report — a
   `NEEDS_HUMAN` saying what a person must do included — is on the Warden page; it raises no agenda item of its own,
   since the ferret is already on `warden:inbox-stuck`.

**On the wire it has its own field**, for `input_stuck`'s reason: the Warden status and run views carry the flags in
an optional `stuckInbox` list (`WardenStuckInboxFlagSchema`), never in `anomalies`, and `wardenFlags` lists both.
The kind is never offered for **Leave it alone**.

## What a message row can say

| Row                         | Proof                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sending                     | Accepted; nothing has proved where it is yet                                                                                                         |
| Typed, not sent             | `typedNotSent`: the composer still holds this message — alone or beside other text — ≥4 s after it was typed (a pointer: after its last Enter nudge) |
| Queued                      | The harness holds it in its own queue (a Claude queue record or `❯` entry above the spinner, or Codex's `↳` entry)                                   |
| Delivered                   | A user record in the transcript carries it — or carries it JOINED to its neighbours                                                                  |
| Unconfirmed / Not delivered | As before: `unaccounted` / `timed_out`, with the reason                                                                                              |
| Cancelled                   | A person took it back; `cancelEffect` says what that did on the agent's screen                                                                       |
| Status unknown              | THIS BROWSER could not read the ledger for 15 s; the row says since when, and why                                                                    |

`typedNotSent` is set by the tracker on **every** look (the first is ~2 s after the send), not only at a
deadline, and is dropped when the composer no longer holds the message. **Queued** is set only when the
pane shows the message in the harness's queue; a message that merely left the composer of a busy pane
is `sent`, and the transcript decides. A message delivered joined to its neighbours (`hihello`) is proven
by `merged-text` evidence: one user record that is EXACTLY two or more consecutive unproven sends, in
acceptance order, written after the first was accepted.

### A row only moves when the ledger is read

The app learns a fate from one thing: a successful `GET /v1/sessions/:id/sends`, polled every 3 s. So
everything between the person and that answer must end, and must say so when it fails:

- **The page is read by the app, not by the typed client.** `IFyApiClient.sends` validates the page
  with closed enums, so one value a newer daemon added (an evidence tier, a fate) rejected the whole
  page and the row kept its last fate. `readLedgerSends` reads the same route with the field-by-field
  parser in `packages/pwa/src/lib/send-ledger.ts`.
- **A failed read is said on the row.** After `LEDGER_UNREAD_GRACE_MS` without a good read, every open
  row (sending, queued) reads **Status unknown** with the failure's own words, instead of "the daemon
  has it and is checking".
- **A relayed request has a deadline.** The client's timeout reaches the relay session, which drops a
  late answer; a session whose request ran out of time is retired, because the relay's edge answers
  the keepalive by itself and a silent daemon end otherwise looks alive. The reconnect probe has its
  own deadline too.
- **A read takes a look, bounded.** `GET …/sends` asks the tracker to look first, but waits at most
  `SEND_READ_LOOK_BUDGET_MS`; a slow look finishes by itself. A look that throws schedules the next.
- **A read is a page, not the ledger.** The ledger keeps every send a session ever had (2,139 sends and
  2.3 MB per answer for one long-lived lead), so `GET …/sends` answers the newest 100 sends, newest first,
  plus **every open send however old** (any fate but delivered or cancelled, and anything held; never a
  withdrawn one). `nextCursor` names where the older sends start: `?before=<nextCursor>&limit=<1–1000>`
  pages back, and a reader merges pages by `sendId`. An older daemon answers the whole ledger with no
  `nextCursor`, which reads the same. Behind the route, `FileSendLedger` parses only the lines appended
  since its last read, and reads the file whole again when it was replaced, shortened or rewritten in place.

## What a person can do

Every undelivered row (sending, queued, typed-not-sent, unconfirmed, not delivered) offers:

- **Cancel** — `POST /v1/sessions/:id/sends/:sendId/cancel`. The record becomes `cancelled` and is never
  retyped or settled again. If the composer holds exactly that message it is erased with `C-u`, one key
  per verified read (two per line; `BSpace` is never sent, because after a join it deletes a real
  character); if the composer holds anything else as well, it is left alone (`left_in_composer`). A
  message already in Codex's own queue cannot be edited from here (`left_in_queue`) — the agent may
  still read it, and the row says so.
- **Press Enter** — `POST …/sends/:sendId/enter`, only for a typed-not-sent message. One Enter per
  request, and only when the composer holds exactly that message, so it can never submit somebody's
  draft; the tracker then proves delivery from the transcript.
- **Retry** — the existing `POST …/retry`. A still-open message may now be retried with `force`, but is
  refused while the pane shows it typed in the composer ("press Enter instead") or held in the queue.
  Without `force` it is also refused while the pane cannot be read, and while the agent is mid-turn if a
  copy was already typed into it mid-turn (see [Never two copies behind a running turn](#never-two-copies-behind-a-running-turn)).
- **Copy text** — in the app only.

In the app these are not a row of buttons: one small **⋯ "Message actions"** button beside the row's status mark opens a menu
that lists exactly the actions valid for that state (plus **Hide** and **Dismiss**, which only change what this device shows).
A retry that may make a second copy is still two steps — the menu item opens a warning, and only its own button sends.

The session menu's **Clear stuck messages** cancels every undelivered row of that session, one by one.

All three routes are `operator`, with no capability of their own — they finish or take back a send, and
are governed exactly as the send and its retry are. Each is journalled (`control.send_cancelled`,
`control.send_submitted`) and audited as `agent.prompted` (`send-cancel`, `send-enter`), never with the
text.

When a send is refused because the composer holds the person's OWN text, the notice under the app's
composer offers **Send it** and **Clear it** — `POST /v1/sessions/:id/composer` with the quoted draft.
That route is not a send: no ledger row is behind it and the text is not Ferretry's, so it is governed
as every other key into the agent's pane is, `terminal` / `use` ([grants.md](grants.md)), journalled
`control.composer_submitted` / `control.composer_cleared` with the outcome only, and audited as
`terminal.input` (`mode: composer`), never with the text.

**Dismissing is a view choice, never a daemon one.** A send that settled without arriving (cancelled, given
up on, superseded, delivered elsewhere) sits in the timeline at its send time — never below the live
conversation — as a one-line note: whole for ten seconds, then folded, then gone ten minutes after it
settled unless the reader opened it. Each has **Dismiss**, remembered per device by send id (the
`fy-dismissed-sends-v1` key; the ledger is append-only and is never told), and the session menu's **Dismiss
all cancelled** and **Clear stuck messages** do it in bulk. If repair later finds the message in the
transcript, the same row (`send:<id>`) becomes the ordinary delivered bubble in place.

## B153: a send that gave up before its first key

From 2026-11-02 to 11-04 ryu's queue stopped eleven times, for 38 minutes to 5 h 49 min: one message `typing`,
its send `accepted` at attempt 1 with nothing typed, and up to twenty messages behind it with no wait reason.
Each was freed only by a daemon restart, or by an `fy send --wait` from another ferret that made the tracker
look. Every time ryu's record said `waiting` — a declared wait, set by the agent from inside its turn — while
the agent was still at work.

What happened, in order: `routeSend` took `waiting` as idle by the status alone, so the send wrote its
`accepted` row and took the idle path. `waitReady` looked for a prompt for about 27 s, found none, and threw
a plain `PaneDeliveryError` before any key. Neither the terminal nor the service knew that error meant "no key
went", so `send()` threw before it told the tracker. The deliverer saw a ledger row and left the message
`typing`, and its five-second looks only read the fate, which never moved. Four fixes:

1. **A pane that never comes to a prompt is a refusal before typing.** `waitReady` throws
   `PaneNotReadyError` (`busy` / `dialog` / `exited`) for every way it gives up, and the terminal says it
   as `SendPaneNotReady`. The send path takes it back the way it takes back an unreadable composer:
   - a ferret's or the daemon's send is withdrawn and refused with `SendNotReady`, and the queue waits on it
     as `busy`, `dialog` or `stopped`, so its sender sees why;
   - a person's send, and a held message released into a live session, is kept open and `untyped` for the
     tracker (back on hold, the held message would wait for a revive a live session never gets);
   - a pane that went away is withdrawn instead (a released message goes back to held), so the next send
     revives the session;
   - a re-attempt puts its record back and is withheld (`busy`).

   A startup dialog's known answer may have been pressed on the way, but never a character of the message,
   so nothing is typed again that might have landed.

   **The queue does not hand the message over again until a prompt shows.** Each try holds both the queue
   lock and the send lock through a readiness wait of about half a minute, and a refusal used to bring the
   message back on the next `lookMs` look. A pane that showed neither a prompt nor work then looped for as
   long as it stayed that way. After an `untilPrompt` refusal the deliverer keeps the message waiting on its
   reason until the pane shows a prompt, the record's readiness flag changes to ready, the pane goes away, or
   `recheckMs` (60 s) has passed. A record flag that was already true when the pane was refused is the
   stale reading that was refused, so it ends nothing; it counts only after it has been seen false and
   turned true again. The last case is a safety net, in case a prompt is drawn but not recognised.

2. **A send that throws with its row open always tells the tracker.** `send()` and `reattempt()` schedule
   a tracker look whenever they throw and the send's row is still open, or the ledger cannot be read to rule
   one out. That look follows every existing rule: transcript proof wins, a pane or queue holding the text
   waits, a turn started since waits, an unreadable pane is unconfirmed, and only a send proven absent is
   typed again, with the attempt ledgered before any key.
3. **A declared wait does not overrule a pane at work.** Under `waiting` a pane that visibly shows work routes
   `busy`, so the message goes into the harness's own queue. A prompt still wins, and a pane that shows
   neither work nor a prompt still routes idle, because a ghost turn is the worse mistake. Being busy, a
   `--now` message (an interrupt) now ends that turn with the stop key, as it does for any busy agent. A
   ferret parked in a blocking `fy wait` call has that call cut short. The other idle
   statuses (`awaiting_user`, `rate_limited`, `interrupted`) are set at a turn's end and keep their word.
4. **The deliverer asks the tracker about a hand-over left `accepted`.** See the deliverer above. The ask is
   not awaited: the tracker's look takes the send lock while the deliverer holds the queue's. A stopping
   daemon asks nothing, so no look can start typing after the tracker has been disarmed.

The Warden's `inbox_stuck` ([B148](#b148-a-ferret-whose-inbox-is-stuck)) is the detector for whatever still gets past these.

## Declared gaps

- **A message held in Claude's own queue while the ferret is idle is not pushed.** Claude submits what it
  queued at the turn boundary; a queue still drawn at an idle prompt is not driven with `ctrl+x ctrl+s`, which is
  unmeasured here. Its send stays `queued` and the transcript decides.
- **A paste placeholder is matched by its count, not its identity.** The placeholder's counter (`#40`) is not
  recorded when a paste lands, so a person who clears our paste and pastes a draft with exactly the same line
  (or character) count is indistinguishable from it. Every other check — a lone placeholder, one unsettled
  send that matches, an idle pane, a fresh exact read before the key — still holds.
- **An interactive session is not flagged `input_stuck`.** It is the owner's own terminal; the send path's
  nudges and the queue's clearing still apply to it. Nor `inbox_stuck`, for the same reason.
- **An app older than `inbox_stuck` may refuse a Warden status that lists an investigation of it.** The flags
  themselves travel in their own field (`stuckInbox`), but an investigation and its report's verdict carry the kind
  in fields an older app parses against a closed list. Reloading the app (the hosted app is always the current one)
  clears it.
- **`inbox_stuck` re-checks a hung hand-over; it does not prevent one.** The send-path cause (a declared-wait status
  trusted as idle, and a pre-key throw that skips tracking) is B153's.

- **Claude's on-screen queue is measured on 2.1.281 only.** An earlier or later rendering that moves or
  rewords the `ctrl+x ctrl+s to send now` hint reads as `unknown` while the queued placeholder shows
  (unconfirmed, never retyped), and as no queue at all once it does not — where the mid-turn guard above
  still keeps a send from being typed behind the turn twice.
- **A queue taller than the pane cannot prove absence.** The messages above its top could be this one, so
  the send is settled unconfirmed rather than retyped.
- **A message in Codex's own queue cannot be cancelled there.** Codex offers `alt + ↑` to edit its last
  queued message; driving that is not attempted.
- **An idle-routed send to a pane that is neither at a prompt nor visibly working waits about 27 s per try.**
  Under any idle status such a pane routes idle, and the wait for a prompt runs out before it refuses. The
  queue tries again only once a prompt shows or `recheckMs` has passed. A pane stuck that way therefore
  costs one readiness wait, with both locks held, about every 90 s. A person's kept send is retried by the
  tracker every `untypedLookMs` and pays the same wait each time.
- **A retype withheld before any key is still journalled as a retry.** `control.send_retried` is written
  before the keys, so a re-attempt that put its record back (a composer it could not read, a pane with no
  prompt) shows in the journal as an attempt that typed nothing. The ledger is right; readers that count
  journal retries over-count.
- **Rows older than the two-hour ceiling are not re-examined.** A row stuck before this fix stays stuck
  until a person cancels it — which is what Cancel and Clear stuck messages are for.
