# How a message reaches an agent's composer

A message to a running ferret is TYPED into its harness's terminal — Codex or Claude Code — and
submitted with Enter. Nothing about typing into a TUI replies, so the daemon proves each step by
reading the pane afterwards. This page is the contract for those proofs, the states a message row can
show, and what a person can do about a message that did not get through.

The send ledger and its fates are in `packages/protocol/src/lib/session.ts` (`SendRecordSchema`); the
decisions are in `packages/daemon/src/lib/tmux/` and `packages/daemon/src/lib/session/send/`.

## The composer is read, never searched for

Every proof reads **the composer itself** — the last prompt-glyph line (`›`, `❯`, `>`) and the indented
lines a multi-line draft wraps onto, up to the first blank row — together with the cursor tmux reports
beside the capture (`lib/tmux/composer-screen.ts`). It never asks whether the message's words appear
somewhere on screen.

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
column, typed text moves it past itself. A frame with no readable composer (no prompt line, or no cursor
on it) falls back to the older character count, which is weaker but never claims a placeholder is input.

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

`—` is "not measured", never "no".

The daemon waits at least one poll (250 ms) between typing and Enter, which is outside the paste-burst
window, and if an Enter only opened a new line the composer still holds the message, so Enter is
pressed again — bounded, and only while that exact message is still there.

## Never typing onto unsent text

A send first reads the composer. If it already holds input — a person's draft, or an earlier message
that was typed and never submitted — **nothing is typed**: the send is refused (`409`) with the draft
quoted and the remedy named ("Press Enter on it or cancel it first"). The terminal makes the same check
again immediately before its first keystroke; a refusal there withdraws the just-accepted record, which
is honest because nothing was typed.

## What a message row can say

| Row                         | Proof                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------- |
| Sending                     | Accepted; nothing has proved where it is yet                                        |
| Typed, not sent             | `typedNotSent`: the composer holds exactly this message and it was not submitted    |
| Queued                      | The harness shows it in its own queue (a Claude queue record, or Codex's `↳` entry) |
| Delivered                   | A user record in the transcript carries it — or carries it JOINED to its neighbours |
| Unconfirmed / Not delivered | As before: `unaccounted` / `timed_out`, with the reason                             |
| Cancelled                   | A person took it back; `cancelEffect` says what that did on the agent's screen      |
| Status unknown              | THIS BROWSER could not read the ledger for 15 s; the row says since when, and why   |

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
- **Copy text** — in the app only.

The session menu's **Clear stuck messages** cancels every undelivered row of that session, one by one.

All three routes are `operator`, with no capability of their own — they finish or take back a send, and
are governed exactly as the send and its retry are. Each is journalled (`control.send_cancelled`,
`control.send_submitted`) and audited as `agent.prompted` (`send-cancel`, `send-enter`), never with the
text.

## Declared gaps

- **Claude's on-screen queue is not measured.** For Claude the queued proof is its transcript's
  `queue-operation` record, as before; the composer reading applies to Claude's `❯` composer but no
  Claude queue display is parsed.
- **A message in Codex's own queue cannot be cancelled there.** Codex offers `alt + ↑` to edit its last
  queued message; driving that is not attempted.
- **Rows older than the two-hour ceiling are not re-examined.** A row stuck before this fix stays stuck
  until a person cancels it — which is what Cancel and Clear stuck messages are for.
