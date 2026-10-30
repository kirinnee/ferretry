# How a message reaches an agent's composer

A message to a running ferret is TYPED into its harness's terminal — Codex or Claude Code — and
submitted with Enter. Nothing about typing into a TUI replies, so the daemon proves each step by
reading the pane afterwards. This page is the contract for those proofs, the states a message row can
show, and what a person can do about a message that did not get through.

The send ledger and its fates are in `packages/protocol/src/lib/session.ts` (`SendRecordSchema`); the
decisions are in `packages/daemon/src/lib/tmux/` and `packages/daemon/src/lib/session/send/`.

## The durable queue (being built)

Every message to a session is moving onto ONE durable queue per session, owned by one deliverer, in
slices (owner-approved 2026-10-30). Until delivery rides it, the queue is written and read but nothing
is typed from it; the rest of this page is still how a message reaches the pane.

- **Model** — `packages/protocol/src/lib/session-queue.ts` (`QueuedMessageSchema`): ✓ `queued` on accept,
  ✓✓ `delivered` once typed and submitted (pane proof), ✓✓✓ `read` once the transcript shows it as a user
  turn; `cancelled` and `failed` are final. A waiting message carries a `waitReason` a person can act on.
- **Log** — `channel/queue.jsonl` beside the session, append-only and flushed to disk before an accept
  answers (`FileSessionQueueStore`). The queue is the fold of that log (`foldQueue`), which applies only a
  move that is legal from where the message stands, so a replayed or stale line changes nothing.
- **Order** — a person's message first, then a ferret's, then the daemon's; acceptance order within each;
  one message typing at a time (`nextToDeliver`). A daemon notice to an interactive session is never in the
  delivery order (`boardOnly`): that session is the owner's own chat, and the notice goes on its board.
- **Ready** — the deliverer types the next message as soon as the agent's input box is EMPTY, mid-turn
  included (the harness queues it itself). It holds only for a draft in the box, a question, dialog or
  permission form on screen, a session still launching, or a pane it cannot read, and says which as the
  `waitReason` (`waitReasonOf`). A stopped session is not held: the send path revives it.
- **Deliverer** — `QueueDeliverer` (`lib/session/queue/deliverer.ts`) is the one owner of WHEN and IN WHAT
  ORDER. It marks a message `typing` on disk, then hands it to the tracked send path under the message's
  own id (`SendPathQueueTransport`), which does the HOW: the turn file, the turn record, the busy-pane
  queue, a revive. The send ledger, keyed by that id, is where every later tick comes from
  (`movesFrom`): `queued` there is ✓✓, `delivered` there is ✓✓✓. A `typing` message the ledger never saw
  had no key typed and waits again; nothing is ever typed twice on a guess. It looks at a session when a
  message is enqueued, when its state document changes, at boot, and every `lookMs` (5 s) while something
  in it is still waiting or unproven. Both harnesses follow one rule: Claude Code's own queue shows a
  message typed mid-turn, so its hand-over is proven at once; Codex steers it into the running turn and
  shows nothing, so it stays `typing` — holding the next message — until Codex's transcript proves it.
- **Switch** — `"delivery": { "queue": true }` in `config/daemon.json` (off by default until every producer
  rides the queue; read at start). On, `POST /v1/sessions/:sessionId/send` ENQUEUES: the person's agenda
  context, any held board events and the attachment paths are baked into the text at that moment, the
  answer is `disposition: "queued"` with the message id as `sendId` as soon as it is on disk, and the
  deliverer types it. `--now` (stop the running turn first) still goes straight down the send path.
- **Read it** — `GET /v1/sessions/:sessionId/queue` (operator), `fy queue <ferret> [--json]`.
- **Edit or cancel** — only while `queued`: `PATCH /v1/sessions/:sessionId/queue/:messageId` `{ "text" }` and
  `DELETE …/queue/:messageId` (operator, audited as `agent.prompted` without the text), `fy queue edit
<ferret> <id> <text…>` and `fy queue cancel <ferret> <id>`. Once a key has gone to the pane the words are
  the agent's, and either answers `409`.

## The composer is read, never searched for

Every proof reads **the composer itself** — the last prompt-glyph line (`›`, `❯`, `>`) and the indented
lines a multi-line draft wraps onto, up to the first blank row — together with the cursor tmux reports
beside the capture (`lib/tmux/composer-screen.ts`). It never asks whether the message's words appear
somewhere on screen. A Claude composer (`❯`/`>`) that its rule closes runs to that rule, blank rows
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

### The tracker presses Enter again for a pointer of ours

The transport already presses Enter a bounded number of times while the payload is visibly still there.
A pointer that outlives that is the tracker's: on a look where the composer still holds exactly the
send's pointer, it asks the send service (`resubmit`) for one more verified Enter at each of
`submitNudgesMs` (4 s, 12 s, 30 s after the attempt typed it). The service re-checks everything under the
session's lock, counts the nudge on the record (`submitNudges`, daemon-only) BEFORE the key, and presses
only at an idle, undialogued pane. A pointer is said to be **typed, not sent** only once the last nudge
has had `typedStableMs` to take; a message typed as itself is never nudged, because a person may have
typed the same words.

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

## Declared gaps

- **Claude's on-screen queue is measured on 2.1.281 only.** An earlier or later rendering that moves or
  rewords the `ctrl+x ctrl+s to send now` hint reads as `unknown` while the queued placeholder shows
  (unconfirmed, never retyped), and as no queue at all once it does not — where the mid-turn guard above
  still keeps a send from being typed behind the turn twice.
- **A queue taller than the pane cannot prove absence.** The messages above its top could be this one, so
  the send is settled unconfirmed rather than retyped.
- **A message in Codex's own queue cannot be cancelled there.** Codex offers `alt + ↑` to edit its last
  queued message; driving that is not attempted.
- **Rows older than the two-hour ceiling are not re-examined.** A row stuck before this fix stays stuck
  until a person cancels it — which is what Cancel and Clear stuck messages are for.
