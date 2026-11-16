# The 5.0 mailbox (design, not built)

Status: **proposal for the owner** (card &F4390, under &C58), 2026-11-16. Branch base: `rebuild/5.0-after` @ `aea955f7a0`.
Builds on abbygail's Claude channel work (`feat/claude-channel-send`, uncommitted at `4ef0b2bc2a`); does not redo it.

The owner's ask (verbatim, 2026-11-15 22:40 PST):

> in the end, the design is send should still send to a mailbox (ferretry owned) which write acknowledgement (also one
> in the browser). and these mailbox, depending on where they are from, and what harness, sends via different ways. for
> claude, it can be either via the channel, or pasting into tmux (like we do now), depending on the claude's support.
> also, it should wait for compacting, or if there's an existing text, or an interactive prompt (like now). this is all
> part of core right? ferretry should abstract sending with its OWN mailbox, and honestly, we should be able to see this
> mailbox. and this mailbox isn't a simple queue -- it is an multi-queue, since some of them needs to be batched some of
> them is direct (from users), and color coded (so we can see in a queue UI) -- can we do that?

And: **"dont use hooks"** — no Claude hooks for delivery, ever.

## Short answer

- **Yes, we can.** About 80% of it already exists in 5.0 — but it is **switched off**.
- 5.0 has the durable per-agent queue, the batching rules, the receipts and a queue screen. But **no send goes into
  the queue**: every send is typed straight away. The queue screen is therefore always empty, and FYI holding and
  action batching do nothing.
- The work is: **turn the mailbox on**, add **lanes** with colours, add one **delivery-way** choice (channel / codex
  queue / safe typing) under the mailbox, add a **compacting** wait, and poll **every second** while something waits.
- **"Is this core?"** — It acts like core (every message goes through it) but should **stay in the Conversation
  plugin**, which already owns sends. Moving it into `packages/core` would make every mailbox change touch the most
  shared files in the repo. Details in [Where it lives](#where-it-lives).

## 1. Gap table: what the owner asked for vs. what 5.0 has today

Legend: ✅ there · 🟡 partly there · ❌ missing. Paths are relative to the repo root on `rebuild/5.0-after`
unless marked **(abbygail)**, which is `.worktrees/claude-channel-send`.

| #   | Owner wants                                   | 5.0 today      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Every send goes into a Ferretry-owned mailbox | 🟡             | The store is built (`packages/plugins/conversation/daemon/host.ts:408`), but `api.send` types at once (`host.ts:1591-1612` → `typeMessage`). `QueueingSends` (`daemon/queue/lib/queueing-sends.ts:53`) and `QueueDeliverer` (`daemon/queue/lib/deliverer.ts:112`) are never built. The plugin says so itself: `packages/plugins/conversation/ports-pending.json` — "An fyi is typed at once … batching … wait on QueueingSends and the queue deliverer". |
| 2   | The mailbox writes acknowledgements           | 🟡             | The state machine exists: `queued → typing → delivered → read`, plus `unconfirmed / cancelled / failed` (`daemon/queue/lib/model.ts:21-29`, `contract/wire-send.ts:169-178`). Proof comes from the send ledger (`daemon/queue/lib/delivery.ts:230-254`). Because of #1 the mailbox never writes them; only ledger rows exist.                                                                                                                            |
| 3   | An acknowledgement in the browser too         | ✅             | Browser outbox state `saved` (`app/queue/queue-view.ts:16`, `app/composer/send-outbox.ts`); tick marks clock → ✓ → ✓✓ → coloured ✓✓ (`app/chat/send-receipt-model.ts:1-17`).                                                                                                                                                                                                                                                                             |
| 4   | Way of sending depends on sender and harness  | 🟡             | Codex: `codex queue` (`packages/plugins/codex/daemon/adapters/codex-harness.ts:358`), tried inside core's harness seam (`packages/core/ferrets/daemon/lib/ferrets/service.ts:1787-1806, 1838-1845`). Claude channel: being built **(abbygail)** `host.ts:1136` (`channelled`), `:1224`. The choice is made deep inside the send path, and the row does not record which way was used (`'left'` covers both injected and typed, `service.ts:1845, 1855`). |
| 5   | Claude: channel **or** tmux paste, by support | 🟡             | **(abbygail)**: `claudeChannels` default on (`packages/plugins/runtimes/daemon/lib/account/schema.ts:215`); no receipt in 5 s and no ack → typed once (`delivery/lib/tracking.ts:115`, `delivery/lib/tracker.ts:397`). Her channel outbox is **in memory only** (`daemon/channel/lib/outbox.ts:8`), so it is a second, invisible queue beside the mailbox.                                                                                               |
| 6   | Wait while compacting                         | 🟡             | On `rebuild/5.0-after`, compacting is treated as **busy**, so the text is typed into Claude's own queue mid-compaction (`daemon/delivery/lib/policy.ts:94`). The queue has no `compacting` wait reason (`contract/wire-send.ts:52-60`, `daemon/queue/lib/delivery.ts:179-189`). **(abbygail)** adds a "do not type while compacting" gate on the send path (`host.ts:1185`, `unsafePane`).                                                               |
| 7   | Wait if the input box already has text        | ✅             | `draft` wait (`daemon/queue/lib/delivery.ts:187`); our own stuck text is finished once, B144 (`daemon/queue/lib/deliverer.ts:275-290`).                                                                                                                                                                                                                                                                                                                  |
| 8   | Wait for an interactive prompt                | ✅ / ⚠️        | `dialog` and permission prompts (`packages/plugins/terminals/daemon/adapters/tmux/composer-acts.ts:83-85`); `question` (`daemon/queue/lib/delivery.ts:181`). ⚠️ The Claude `question` signal comes from a **`PreToolUse` hook** (`packages/plugins/claude-code/daemon/lib/harness/fixed-layer.ts:14`). It does not deliver anything, but it gates delivery — see decision **D3**.                                                                        |
| 9   | Check the gates every second                  | 🟡             | Queue looks again every **5 s** (`deliverer.ts:105`, `lookMs: 5_000`); the queue screen polls every 5 s (`app/queue/queue-page.tsx:396`). **(abbygail)** her untyped retry runs every second.                                                                                                                                                                                                                                                            |
| 10  | "This is all part of core?"                   | ❌ (by design) | Conversation is a plugin, `core: false` (`packages/plugins/conversation/manifest.ts:102`). Core packages are `kernel`, `ferrets`, `gate`, `vault`, `asks` (`packages/core/`). No plugin is `core: true`.                                                                                                                                                                                                                                                 |
| 11  | A multi-queue: some batched, owner's direct   | 🟡             | The rules exist (`daemon/queue/lib/policy.ts:97-153`): owner first and alone; blocker flushes; action combined for 60 s; FYI held to turn end or 10 min; daemon alone (`settings.ts:273-278`). Off because of #1. Lanes are implicit (sender × label), not a field.                                                                                                                                                                                      |
| 12  | Colour-coded lanes                            | 🟡             | Only `blocker` is coloured (red text, `app/queue/queue-page.css:128`); `action` is not even labelled (`queue-page.tsx:160`); owner / ferret / Ferretry are not coloured.                                                                                                                                                                                                                                                                                 |
| 13  | We can see the mailbox                        | 🟡             | Per-agent queue panel and an All queues screen exist (`app/queue/all-queues-screen.tsx:1-12`, `manifest.ts:497`). It reads one queue per agent (N calls) and shows only queue rows — empty in 5.0 because of #1.                                                                                                                                                                                                                                         |
| 14  | No Claude hooks for delivery                  | ✅             | Delivery never uses a hook: typing goes through the runner (`daemon/send-terminal.ts:49`), Codex through `codex queue`, Claude channel through the MCP server **(abbygail)** `packages/plugins/mcp/cli/lib/serve/channel.ts`.                                                                                                                                                                                                                            |

**The single biggest gap is #1.** Everything else is small once the mailbox is actually on.

## 2. Design

### 2.1 One mailbox per agent

- **One mailbox per agent**, owned by Ferretry: today's `queue.jsonl` log and its fold (`daemon/queue/lib/model.ts`).
  It is append-only and written to disk **before** the sender gets an answer. That write is the first acknowledgement.
- **Every sender goes in through it**: the owner (browser and `fy send`), other agents, Warden, Board, Agenda. They all
  already call `ConversationPort.send` (`host.ts:1591`). Only the inside of that call changes: **enqueue, answer,
  then let the deliverer deliver.**
- **One deliverer** (`QueueDeliverer`, already written) decides **when** and **in what order**. A new
  **delivery-way** step (2.4) decides **how**. The send ledger keeps the **proof** (unchanged).
- **One thing in flight per agent** (unchanged rule, `policy.ts:120`).
- The interactive-session exception stays: a daemon notice is never typed into the owner's own chat (`boardOnly`,
  `policy.ts:17`).

```
 senders ─► ConversationPort.send ─► MAILBOX (queue.jsonl, per agent)  ── ack ✓ queued
                                         │
                                  deliverer: lanes + gates (every 1 s while waiting)
                                         │
                               delivery way (per harness, per sender)
              ┌──────────────────────────┼──────────────────────────┐
         Claude channel            Codex `codex queue`         safe typing (tmux)
              └──────────────────────────┴──────────────────────────┘
                                         │
                       send ledger + transcript proof ── ack ✓✓ delivered, ✓✓✓ read
```

### 2.2 Lanes

A **lane** is decided once, when the message is accepted, and stored on the `enqueued` line (new field `lane`). The
browser never works it out again. It comes from today's inputs: sender, `--kind`, `--ask/--expect-reply`, `--now`.

| Lane         | Who / what                                                                                           | Rule (today's numbers)                                                                                          | Colour token                |
| ------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **Owner**    | The owner's own words (`sender: human`)                                                              | **Direct.** Goes first, alone, never combined.                                                                  | `--lane-owner` → `--accent` |
| **Urgent**   | An agent's `blocker`, a question (`--ask`, `--expect-reply`), a reply the receiver waits on, `--now` | Goes at once. Takes every waiting Action and FYI with it, as one combined turn (max 20).                        | `--lane-urgent` → `--err`   |
| **Ferretry** | Warden, Board, Agenda notices (`sender: daemon`)                                                     | Goes at once, alone. Never typed into an interactive (owner's) chat — it shows on the board instead.            | `--lane-ferretry` → `--ok`  |
| **Action**   | An agent's `action` (the default)                                                                    | **Batched.** Held 60 s for others to join (`actionWindowMs`), then sent combined.                               | `--lane-action` → `--warn`  |
| **FYI**      | An agent's `fyi`                                                                                     | **Batched.** Held until the receiver's turn ends, at most 10 min (`fyiMaxHoldMs`). Never wakes a stopped agent. | `--lane-fyi` → `--pend`     |

Order between lanes: **Owner → Urgent → Ferretry → Action → FYI.** One rule is kept from today: a Ferretry notice may
pass an Action or FYI that is still being held, but never one that is already due (`policy.ts:107-108`).

**Promotion:** an Action or FYI that turns out to answer what the receiver is waiting on is sent as Urgent
(`effectiveLabel`, `policy.ts:47-61`). The row keeps its first lane and adds `promoted: urgent`, so the person can see
why it jumped ahead.

**Kill switch:** `coalesce: false` (exists, `settings.ts:264`) makes every lane send at once, one turn each.

### 2.3 Acknowledgement states (the mailbox writes them; the browser shows them)

| Mark | State                  | Written by                     | Means                                                                                                 |
| ---- | ---------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 🕓   | `saved`                | the browser (outbox)           | On this device only; it has not reached the machine yet.                                              |
| ✓    | `queued`               | the mailbox, on accept         | On the machine's disk. Waiting, with a lane and a wait reason ("waits: compacting").                  |
| ✓ …  | `handing`              | the mailbox (today's `typing`) | The deliverer is sending it now, **via** `channel` / `codex-queue` / `typed`.                         |
| ✓✓   | `delivered`            | the mailbox, from proof        | The harness has it: the pane showed it, Claude's channel receipt line, or Codex's "Queued message …". |
| ✓✓✓  | `read`                 | the mailbox, from proof        | The transcript shows it as a user turn: the agent took it in.                                         |
| ⚠    | `unconfirmed`          | the mailbox                    | Sent, but could not be proven either way. Never sent again by itself; "send again…" stays offered.    |
| ✗    | `failed` / `cancelled` | the mailbox                    | Proven never delivered (Retry offered) / taken back by a person.                                      |

Changes to today: rename only the **words** shown (`typing` → "sending via …"); keep the wire state names, so no
data migration. Add `via` (on the `moved → typing` line, from the way that was used) and `lane` (on `enqueued`).

### 2.4 Delivery ways (one port, one implementation per way)

The deliverer asks a **delivery-way chooser** which way to use for one delivery. Each way is one small adapter with
the same shape:

```ts
interface DeliveryWay {
  readonly via: 'channel' | 'codex-queue' | 'typed';
  /** Can this way carry this delivery to this agent right now? Pure: reads the view only. */
  offers(view: DeliveryView, delivery: QueueDelivery): boolean;
  /** Hand it over. Same answers the deliverer already reads: landed | unproven | refused(reason) | failed. */
  handOver(id: SessionId, delivery: QueueDelivery): Promise<HandOver>;
}
```

**Order tried, per harness:**

| Harness     | Sender             | 1st way                                                                                                     | Fallback                                                                                                                                                                             |
| ----------- | ------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | Agent, Ferretry    | **channel** — if `claudeChannels` is on, the agent's MCP server is connected, not `--now`, not a `/command` | **typed**: if no ack and no receipt within 5 s, taken back from the channel and typed **once** (abbygail's rule, `tracker.ts:397`). Ack but no receipt → `unconfirmed`, never typed. |
| Claude Code | Owner              | **typed** (see decision **D2**)                                                                             | —                                                                                                                                                                                    |
| Codex       | Anyone             | **codex-queue** — if the thread is proven, text ≤ 64 KiB, not a `/command`                                  | **typed** when `codex queue` says `unavailable`. `uncertain` → `unconfirmed`, never typed again (today's rule).                                                                      |
| Any         | Any, agent stopped | revive with the message as its first turn (today's rule). An FYI never revives.                             | —                                                                                                                                                                                    |

**Safety gates for the `typed` way** — checked in this order, **every second while a message waits**:

1. `launching` — the agent is still starting (or Codex is "Waiting for startup").
2. `question` — the agent is asking the owner a structured question.
3. `dialog` — a permission, consent or other prompt is on screen (a key would answer it).
4. `compacting` — **new wait reason.** Claude shows "Compacting conversation…". We **wait**, instead of today's
   "busy, type into Claude's queue" (`delivery/lib/policy.ts:94`).
5. `draft` — the input box already has text. If it is ours, left stuck, finish it once (B144); if it is a person's,
   wait and say so.
6. `unreadable` — the screen could not be read. Wait; never guess.

Mid-turn is **not** a gate (owner ruling 2026-10-30, `queue/lib/delivery.ts:160-163`): the harness holds text typed
mid-turn in its own queue.

**Gates for `channel` and `codex-queue`:** these type nothing, so the screen gates (3, 5, 6) do not apply. `launching`
and the stopped rule do. `compacting` also applies to `channel` until it is measured as safe (risk **R4**).

**Every second, cheaply:** `lookMs` drops from 5 s to **1 s only while a message waits on a gate**. An agent with
nothing waiting is not looked at at all (today's rule, `deliverer.ts:23-26`). One look is one screen read, which the
send path already does.

**Abbygail's channel outbox fits under this, not beside it.** The deliverer pushes the one delivery in flight into
her `ChannelOutbox`. The MCP server polls it and acks. The outbox stays in memory and holds **only in-flight** items,
so it is no longer a second queue. The mailbox is the record. After a restart, a message still in `handing via
channel` is settled by the tracker exactly as she wrote it.

### Where it lives

**Owner's question: "this is all part of core right?"**

**Answer: it behaves like core, but it should live in one plugin folder: `packages/plugins/conversation`.**

| Option                                      | Good                                                                                                                                          | Bad                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Conversation plugin** (recommended)    | Already owns send, the queue, the ledger, receipts and the queue screens. Every sender already calls it. A mailbox change is a one-folder PR. | Not "core" on paper (`core: false`), so in principle a machine could run without it. In practice nothing can message an agent without it, so this is a label, not a risk.                                                                                                                    |
| **B. Move it into `packages/core/ferrets`** | Guaranteed always on; any package could reach it.                                                                                             | Moves about 5,000 lines (`daemon/queue` + `daemon/delivery`) into the most shared code. `scripts/ci/one-folder.ts:5-6` records the core ferrets daemon index and service being touched by 7–53 PRs a week. Every later mailbox fix would need "Outside files" reasons. Biggest blast radius. |

**The one-folder rule** (`CLAUDE.md`, `scripts/ci/one-folder.ts`): a feature lives in its own plugin folder. With option
A, almost every unit below stays inside `packages/plugins/conversation`. The few outside files are named per unit.

The **harness side** stays where it already is: Codex's `inject` in the codex plugin, Claude's transcript receipt in
the claude-code plugin, the MCP channel pump in the mcp plugin, typing in the terminals plugin. The mailbox only
**chooses** between them.

## 3. The mailbox UI

Two views. Both are today's queue screens, renamed **Mailbox** and given lanes.

- **Per agent:** the agent's side panel (today's queue panel).
- **All agents:** today's `/queues` screen, renamed **Mailboxes**.

**Each row shows:**

1. A **lane bar** at the left edge, in the lane's colour, **plus the lane name as text**. Colour is never the only cue.
2. **Who** sent it: You, an agent's name, or "Ferretry · Warden".
3. **The message** (first line). A combined delivery shows "×3" and expands to its members.
4. **Receipt** marks (🕓 ✓ ✓✓ ✓✓✓ ⚠ ✗) and **via** (channel / codex queue / typed).
5. **Why it waits**, in plain words: "waits: compacting", "waits: your text in the box", "goes at 10:45 pm (batching)",
   "waits for its turn to end (latest 10:52 pm)". Plus "checked 1 s ago".
6. **Time** (PST). Edit and Cancel while it is still ✓ queued (today's actions).

**Filters:** one chip per lane, with counts. The All view also has "only waiting" on by default.

**Colours:** new tokens `--lane-owner`, `--lane-urgent`, `--lane-ferretry`, `--lane-action`, `--lane-fyi`, defined in
the plugin's own CSS (`app/queue/queue-page.css`) and **mapped onto existing theme tokens** (`--accent`, `--err`,
`--ok`, `--warn`, `--pend` — `packages/app/src/styles/themes.css:226-286`, dark at `:430-464`). Light and dark mode
come for free, and nothing outside the plugin changes.

**Per agent (side panel):**

```
 Mailbox · rosalind                        [All 5] [Owner 1] [Urgent 1] [Ferretry 1] [Action 1] [FYI 1]
 ─────────────────────────────────────────────────────────────────────────────────────────────
 ▌OWNER     You         can you also check the PWA build             ✓✓✓ read · typed       10:41 pm
 ▌URGENT    abbygail    blocked: which flag turns channels off?      ✓✓  delivered · channel 10:43 pm
 ▌ACTION    lizzette ×3 rebase on 5.0-after, then re-run…           ✓   goes 10:45 pm (batching)
 ▌FYI       britnee     PR 1684 merged                               ✓   waits for turn end (≤10:52 pm)
 ▌FERRETRY  Warden      pane idle for 20 min                         ✓   waits: compacting · 1 s ago
```

**All agents:**

```
 Mailboxes                          Owner 1 · Urgent 2 · Ferretry 1 · Action 5 · FYI 7     [only waiting ✓]
 ─────────────────────────────────────────────────────────────────────────────────────────────
 rosalind   ▌▌▌▌▌  1 urgent · 1 action · 1 fyi · 1 ferretry     waits: compacting · 1 s ago      ›
 abbygail   ▌▌     2 action                                     goes 10:46 pm (batching)        ›
 britnee    ▌      1 owner                                      ✓✓ delivered · typed            ›
 codex-ana  ▌▌▌    1 urgent · 2 fyi                             sending · codex queue           ›
```

Opening a row in the All view jumps to that agent's chat with the mailbox panel open (today's behaviour).

**One read, not N:** add `GET /v1/mailboxes` (every agent's waiting rows plus counts per lane), so the All view does
not make one call per agent. It is also refreshed by the existing `QueueChanged` event, not only the 5 s poll.

## 4. Build plan

Sizes: **S** < 200 changed lines · **M** 200–600 · **L** > 600 (tests included).
Each unit is one PR into `rebuild/5.0-after`. Home is `packages/plugins/conversation` unless said.

| Unit                            | What                                                                                                                                                                                                               | Files touched                                                                                                                                                                                                                                                                        | Size | Depends on               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------ |
| **M1 Mailbox on**               | `api.send` enqueues, then answers; `QueueDeliverer` is built and armed at boot, told on `ferret.changed`, stopped on shutdown; its transport calls today's `typeMessage` on the agent's lane. Remove the GAP line. | `daemon/host.ts`, `daemon/index.ts`, `daemon/queue/lib/queueing-sends.ts`, `daemon/queue/adapters/send-path-delivery.ts` (new transport over `typeMessage`), `ports-pending.json`, tests under `tests/`                                                                              | L    | —                        |
| **M2 Lanes + compacting + 1 s** | `lane` on `enqueued`; `promoted` on the view; `compacting` wait reason; `lookMs` 1 s while gated.                                                                                                                  | `contract/wire-send.ts`, `contract/lines.ts`, `daemon/queue/lib/service.ts`, `daemon/queue/lib/policy.ts`, `daemon/queue/lib/delivery.ts`, `daemon/queue/lib/deliverer.ts`, `daemon/delivery/lib/policy.ts` (compacting no longer "busy" for typed sends)                            | M    | M1                       |
| **M3 Delivery ways**            | `DeliveryWay` port and chooser; `typed`, `channel` (wraps abbygail's outbox), `codex-queue`; `via` on the row. Moves her `channelled` branch out of `typeLocked` into the chooser.                                 | new `daemon/queue/lib/ways.ts`, new `daemon/queue/adapters/{typed,channel,codex}-way.ts`, `daemon/host.ts`, `contract/wire-send.ts`. **Outside:** `packages/core/ferrets/daemon/lib/ferrets/service.ts` (+ `contract/kinds.ts`) so `queue` reports `'injected'` apart from `'left'`. | M    | M1, abbygail's PR merged |
| **M4 Receipts in the browser**  | Rows carry lane, via, promoted and the new words; tick marks unchanged.                                                                                                                                            | `app/queue/queue-view.ts`, `app/queue/send-queue.ts`, `app/chat/send-receipt-model.ts`, `app/chat/send-badge.ts`                                                                                                                                                                     | S    | M2, M3                   |
| **M5 Mailbox UI**               | Rename to Mailbox(es); lane bar, lane chips, colour tokens, combined rows; `GET /v1/mailboxes`.                                                                                                                    | `app/queue/queue-page.tsx`, `app/queue/queue-page.css`, `app/queue/all-queues-screen.tsx`, `manifest.ts` (route + screen title), `daemon/host.ts` (route), `daemon/delivery/lib/mounts/session-send.ts`                                                                              | M    | M4                       |
| **M6 Docs**                     | Update the delivery contract.                                                                                                                                                                                      | **Outside:** `docs/message-delivery.md` (§ "The durable queue", § "Labels and combined delivery"), `docs/ferret-messages.md`                                                                                                                                                         | S    | M1–M5                    |
| **M7 (only if D3 = replace)**   | Detect Claude's structured question from the screen and the transcript instead of the `PreToolUse` hook.                                                                                                           | `packages/plugins/claude-code/daemon/lib/harness/fixed-layer.ts`, `packages/plugins/conversation/daemon/questions/**`                                                                                                                                                                | M    | —                        |

Suggested models (Routing): M1 and M3 are high impact (they change how every message is delivered), so build on
`claude-sonnet-5-5` with review on `gpt-6.1-sol` high. M2, M4–M6 build on Sonnet as well.

### Risks

- **R1 Double typing after a restart (M1).** The mailbox marks `typing` before it hands over, and the ledger is keyed
  by the same id, so this is designed for (`deliverer.ts:17-21`). But the 5.0 send path (`typeMessage`) has never run
  under the deliverer. **Test:** kill the daemon between "marked typing" and the first key, and between the key and
  the ledger write.
- **R2 Owner messages feel slower (M1).** Today the owner's send types at once. Through the mailbox it waits for the
  deliverer's look. **Fix:** `enqueued()` looks at once (it already does, `deliverer.ts:156`); measure owner
  send-to-typed time before and after (target: same within 200 ms).
- **R3 Interactive chats getting daemon notices.** Today the direct path types them; `QueueingSends` keeps that
  exception (`queueing-sends.ts:21-24`). Keep it until Board/Warden post to the board instead.
- **R4 Channel during compaction is unmeasured.** We do not know whether Claude keeps or drops a channel
  notification that arrives while compacting. Hold the channel during compaction until measured.
- **R5 Batches via channel.** A combined delivery goes as one channel message. Claude's receipt must match the
  combined text; abbygail's matcher uses the exact text, so it should hold. Needs one test.
- **R6 1 s looks cost.** One screen read per waiting agent per second. With 20 agents all gated that is 20 reads a
  second. Cap: only agents with a gated message; back off to 5 s after 2 min of the same reason.
- **R7 Abbygail's branch is uncommitted.** M3 must wait for it to merge, or it will conflict in `host.ts`.

## Decisions for the owner

- **D1 — Where it lives.** Recommend: Conversation plugin (option A), not `packages/core`.
- **D2 — Owner's own words via the Claude channel?** Recommend **no**: keep them typed, so they show as "You" in the
  chat and stay one message per bubble. Channel messages arrive as tagged channel events, not as your turn.
- **D3 — The question hook.** Claude's "asking you a question" signal is a `PreToolUse` hook
  (`fixed-layer.ts:14`). It delivers nothing, but the mailbox waits on it. Keep it (it only **detects**), or replace it
  (unit M7)?
- **D4 — Ferretry lane colour.** Proposed `--ok` (green). Alternative: `--pend` (grey), which would then match FYI.
