# Notifications

How a ferret tells the owner something, and exactly when the owner's phone buzzes.

Two rules carry everything here:

- **The Inbox is the owner's channel; the phone is the exception.** Everything a ferret sends lands in the
  Inbox and moves its badge. The phone buzzes only at the moments in [When the phone buzzes](#when-the-phone-buzzes).
- **Every ferret gets the notify rule; only some keep an agenda.** Plain notices are for everyone.
  Agenda items — things only the owner can decide or do — are for ferrets in
  [agenda mode](#agenda-mode). The agenda itself is [agenda.md](agenda.md).

## `fy notify`

```
fy notify "<summary>" [--body "<markdown>"] [--ping]
```

Tells the owner one thing: a result, a blocker, a decision the ferret made for them. It raises a **notice**
on the ferret's agenda (`notice: true`, see [agenda.md § Notices](agenda.md#notices)): no ask, no answers,
nobody's turn. The summary is the whole notification; `--body` is the longer reading behind it.

- A notice only moves the **Inbox badge**. It clears when the owner reads it.
- `--ping` ALSO buzzes the phone, once. It is for the rare notice that cannot wait for the Inbox.
- Progress and finishing are never notices. A ferret that is only waiting, or has just finished, tells nobody.
- `fy attention notify` is the same command under its old name (deprecated, like the rest of `fy attention`).
- A notice's summary cannot be exactly `agenda`: `fy notify agenda` is the mode switch below.
- The legacy `POST /v1/sessions/:id/notify` route raises the same notice, as the daemon's own act when the
  caller is a person.

Every ferret is told this rule, whatever its mode (`NOTIFY_INSTRUCTION` in `@ferretry/fleet`, quoted
verbatim; `fy` is the binary name):

> Notify: the owner reads the Inbox, not your replies. To tell them something worth their time (a result, a blocker, a decision you made for them) run `fy notify "<summary>" [--body "<detail>"]`: a quiet Inbox notice. Add `--ping` only when it must reach their phone now. Never notify progress or chatter.

## When the phone buzzes

Only these five. Everything else — a new item while the ferret works, an edit, a change of whose turn it
is, a notice without `--ping`, the owner's own moves — moves the Inbox badge and nothing more.

| #   | Moment                                                                                     | Push                                                              | How often                               |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------- |
| 1   | The ferret **stops on the owner**: it went idle with at least one item on the owner's turn | ONE grouped push: "<ferret> is stopped · N need you"              | Once per stop (however many items wait) |
| 2   | An item's **`neededBy`** comes within `attention.deadlineWarnHours` (default 3 hours)      | The item's title; "Needed in 25 min" / "Overdue" ahead of its ask | Once per item                           |
| 3   | A notice with **`--ping`**                                                                 | The notice's summary                                              | Once per notice                         |
| 4   | A **snoozed** item wakes and it **blocks** the ferret or has a **`neededBy`**              | The item's title; "Back from snooze: <ask>"                       | Once per wake                           |
| 5   | A card the owner asked for **reaches a gate** ([board.md](board.md#gates-ask-the-owner))   | The card's title; the lane's ask ("Try it: …", "OK to build? …")  | Once per gate item, at its raise        |

A gate item is the gate's one signal: it pushes at its raise (row 5) and never again inside a stop, so a ferret that
stops with only a gate item waiting makes no stop push, and one with other items too counts only those. An internal
card (a ferret's own errand) raises no gate item, so it never buzzes.

An input card always counts as inside the window (row 2), so it pushes once the moment it is raised, unless it is
**quiet** (below). An
**approve-on-phone card** ([input requests](input-requests.md#approve-on-your-phone)) is the one card that pushes
outside these rows: once when it is raised, and once more for each new number the daemon reads off the page (at most
four in all). It has no `neededBy`, so row 2 never pushes it a second time. A woken item already inside its deadline's window gets the deadline's push (row 2) instead, never both. A snoozed
or replied item is parked ([agenda.md](agenda.md#parked-items)): it never counts toward a stop or a deadline while
it sleeps.

### Quiet cards: filled in advance, never buzzed

An input card that is filled the moment it is raised, under a paste rule the owner approved in advance
([secure copy](secure-copy.md)), a task plan line ([input requests](input-requests.md#task-plan-fills-a-sign-in-the-owner-approved-in-advance))
or a standing sign-in rule ([input requests](input-requests.md#standing-rule-fills-a-sign-in-the-owner-approved-for-any-ferret)),
is raised and closed at once: it was never the owner's to answer, so it must not buzz. While the daemon fills it, the
card is QUIET (`InputRequestService.quietCard`): `AgendaBuzz` leaves it out of the owner's items, so it makes neither
its deadline push nor a stop. The card on the wire is unchanged; the agenda history shows it closed ("Filled under
your task plan (line 2) on github.com." for a plan; a rule fill closes in a tap fill's words, and the owner's input
card says "Filled under your standing sign-in rule on github.com.").

When the fill does not happen after all (a check missed, the write typed nothing), the card stops being quiet and the
daemon adds one line to its context ("A task plan line didn't apply here, so you're asked as usual."). That edit is a
daemon move, so the board settles at once and the card makes its one push, as any input card does. The line is the
same whatever went wrong: the reason is on the owner's input card only.

A standing rule's miss adds NO line: the ferret reads its own agenda, and its card must stay byte-identical to a
sign-in no rule was ever about. The daemon instead asks `AgendaBuzz` to look at the board again
(`AgendaBuzz.unquieted`), exactly as its edit would have, so the card still makes its one push. A suspension a fill
caused raises no card in the ferret's session either: the owner sees it in Settings and on the input card's reason line.

Each push opens the ferret's chat at the item that triggered it (`?attention=<id>`): the first blocking item
for a stop, else the oldest.

**What counts as a stop.** The ferret's session state says its turn ended on the owner (`turnState` is
`your-turn` or `needs-input`, with `turnStateAt`), and at least one non-notice item is on the owner's turn
(no `waitingOn: 'ferret'`, unresolved). A stop is named by that `turnStateAt` instant, so the same stop
never pushes twice — across a daemon restart too — and the next idle period is a new stop.

**What never buzzes.**

- The owner's own actions. A phone is never buzzed by what its owner just did.
- A ferret that is working. Items raised mid-turn wait for the stop.
- A ferret that was **already idle when the daemon started**. The start-up pass looks at deadlines only;
  a stop is something the daemon sees happen.
- An item on the ferret's turn (the owner asked for more, or to discuss it; the ferret has the ball).
- A parked item: one the owner replied to, or snoozed and not yet woken.

**Duplicate suppression is durable.** Each push is recorded in the notification ledger before it is
sent, under a key naming its reason — `attention:<session>:stopped:<stoppedAt>`,
`attention:<session>:<id>:deadline`, `attention:<session>:<id>:ping`, `agenda:<session>:<id>:phone-approval:<n>`
(`n` is 0 at the raise, then one per new number) — so a repeat of the same stop,
item or notice is no second push. Keys of the retired pushes (`:info-N`, `:surfaced`) still read, so an
old ledger loads.

**Deadlines** are checked when a board changes, and by a sweep every five minutes. The sweep looks at
deadlines only.

| Key in `config/daemon.json`   | Default | Range (hours) | What it bounds                               |
| ----------------------------- | ------- | ------------- | -------------------------------------------- |
| `attention.deadlineWarnHours` | 3       | 0.25–168      | how near `neededBy` must be for its one push |

Read at start; a change needs a restart.

### What a push says

- **A stop:** the title is "<ferret> is stopped · 3 need you" (a lone item: "1 needs you"). The count
  always survives a lock screen: a long ferret name is trimmed to 24 characters first. The body is the
  title of the item the owner most likely wants first.
- **A deadline or a ping:** the card's title as the heading and its ask as the text, nothing else. The
  title is trimmed to 40 characters at a word boundary; an item from before titles uses the start of its
  ask (`agendaTitle`). The body is at most 120 characters, trimmed with `…`. A push never carries the
  context, the options or the recommendation.

- **An approve-on-phone card:** the daemon's own title, "Approve on your phone", and a body built by
  `phoneApprovalWords` from what the daemon observed. By owner decision !A171 the body leads with the number
  the daemon read off the page: "Tap 42 on your phone: ClickUp · a@gmail.com", or "Enter 123 in Duo Mobile: …".
  With no number it ends "— open for the number" ("— check the terminal" for a terminal). The number only ever comes
  from the provider's own challenge view, never from an element a ferret points at. A sign-in
  Ferretry doesn't know is never named by its host here: the ferret chose that host by navigating.

A title is an agent's own words, so it must never read as one of the daemon's own: the new-device alert or the
approve-on-phone push. Only a name that reads as one of those is labelled, as `Ferret “…”`: any spelling, case or
punctuation, and Cyrillic, Greek and accented look-alikes (`agendaNotificationTitle`). Every other title is as
written.

### High priority

The owner asked for it: a push about a **one-time code** waiting on an input card (sensitivity `code`,
[input requests](input-requests.md#one-time-codes-code)) is high priority: only a push that SHOWS the code card, its own
push at raise or a stop whose shown item is the card (a code card waiting behind another item does not make that item loud). One rule decides it, `pushUrgencyFor` (`packages/protocol/src/lib/push.ts`):
`one-time-code` and `approve-on-phone` are high, everything else normal.

An **approve-on-phone push** differs from a code card's in three ways: its tag is the approval's own (`pa-<id>`) at
every priority, so a new number replaces the last one on the lock screen; its TTL is the seconds the card has left,
never more than 600; and it pushes once per new number, not once per card. It spends the same per-ferret and
daemon-wide high slots as a code card.

The app's service worker reads the `pa-` tag (`fy-push:<daemonId>:pa-pa_…`): it shows the push on its own, never
grouped into the ferret's summary, with `renotify` and `requireInteraction` so a new number sounds again and stays on
a desktop screen. The daemon sends no `urgency` for it; the app decides from the tag alone.

What a high push does, and who honours it:

| Part                                               | Set by         | Honoured by                                                                                                                                                                                      |
| -------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Urgency: high` header (RFC 8030)                  | the daemon     | the push service, if it chooses: Google's FCM (Chrome on Android) documents that it delivers a high push at once, waking a dozing phone; other services, Apple's included, decide for themselves |
| `TTL: 600` (a code card's life) instead of 4 weeks | the daemon     | every push service: a push not delivered in ten minutes is dropped, because its code has expired                                                                                                 |
| `requireInteraction`                               | service worker | Chrome and Edge on desktop keep it on screen until it is acted on; Android and iOS ignore it                                                                                                     |
| `renotify` with a tag per card, `silent: false`    | service worker | Chrome and Edge sound it again even when an earlier push for the ferret is showing                                                                                                               |
| `vibrate`                                          | service worker | Chrome on Android; ignored elsewhere                                                                                                                                                             |

**At most three high pushes an hour per ferret, and twelve across the daemon** (`HIGH_PUSHES_PER_SESSION_PER_HOUR`,
`HIGH_PUSHES_PER_HOUR`, rolling hours). Past either a code card still pushes once, at normal priority: a ferret raising
card after card spends only its own three, never the slots another ferret's real code needs. A slot is spent only
on a push a device accepted: one that reached no device (none enrolled, a failed send, nothing accepted) gives it
back.

**iOS has no "time-sensitive" option for a web app.** The interruption level (time-sensitive, which can break through
a Focus mode) is an option for native apps only; Web Push on iOS and iPadOS exposes none, so Ferretry does not and
cannot set it. A Focus mode can still hold a code push on an iPhone.

The payload says `urgency: "high"` and never the code, the value or anything typed: only what an ordinary push says
(the push service is a third party). Every input card pushes ONCE the moment it is raised, while its ferret still waits in
`input_wait`: its expiry is its deadline, and an input card always counts as inside the warning window whatever
`attention.deadlineWarnHours` says (`buzz.ts`, `deadlineDue`). A code card's push is high priority; every other card's
is normal. A service worker older than this field cannot read the payload and shows its
plain "something is waiting in your Inbox" notification instead: never nothing.

## Where a tap goes

The push's `url` is relative to the machine's own pages: `/session/<id>?attention=A3`
(`agendaNotificationPath`). The daemon never knows which name a browser files it under. The
browser's per-machine push worker places the path under that machine, so it opens
`/d/<daemonId>/session/<id>?attention=A3` (`packages/pwa/src/lib/push-scope.ts`). It reuses an open app
window when there is one, whichever worker controls it, and never a sign-in popup.

Every push names a page, and the worker opens a page even when one does not:

- **A push with no item** (a legacy notify) opens the conversation it came from: `/session/<id>`
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

## The unread signal

`SessionView.state.attention` is `{ open, first, ask, latestAt }` while anything is open, and absent
otherwise. Absent always means "nothing waits on the owner", never "unknown". It also carries
`agendaMode` (the ferret works in agenda mode) and `stopped` (it is stopped on the owner, the instant it
went idle), which are what the list shows beside the badge.

- The daemon rewrites it after every board change, and when a ferret's mode or idleness moves with no board
  change. It re-reads the board under one lock per session, so an out-of-order notice can never show an
  answered item as open.
- Notices are not counted: a notice moves the Inbox, not the "needs you" mark.
- Every board change also journals `agenda.changed` (`attention.changed` before `agenda.wire.1`). The fleet feed
  refetches on any event that is not `surface.*`, so lists update
  without polling.
- On start, the daemon reconciles every session once, in the background.
- It clears only when items resolve. Viewing a conversation does not clear it.

## Agenda mode

A ferret keeps an agenda only when it is told to. **Agenda mode** is a switchable section of its
instructions, like Pack mode, and a new ferret has it **ON** unless the machine default is off. With it on, the ferret is taught to put each
thing only the owner can decide or do on the agenda, as its own item (`fy agenda add …`, see
[agenda.md](agenda.md)); with it off, it is told only the notify rule above. A new ferret starts with it
on unless the machine default (below) is turned off.

The section (`AGENDA_INSTRUCTION` in `@ferretry/fleet`, about 1,230 characters, capped at 1,300 by a
test) opens with the rule that the agenda is only for what the owner alone can give — information, a decision or an
action — and never tracks or checks work (no "please test/verify" items: the board's Done / Not good covers that,
and after a Not good the ferret opens an item only if it needs something from the owner; [agenda.md](agenda.md)), adds that a question the owner asks is also answered there, on the item itself (`edit --question-answer`, its options stay live; the owner reads the agenda, not every reply; [agenda.md](agenda.md)), names the verbs and flags `fy agenda` takes — its one `agenda add` example carries `--premise` and
`--context`, which every new item requires ([agenda.md](agenda.md#rules-the-writing-keeps)) — one line mapping each kind to its answer shape (`AGENDA_SHAPE_LINE`; [agenda.md](agenda.md#what-i-need-from-you)), what `--blocking`,
`--will-block` and `--by` mean, and that `"[answer to !A3 …]"` is an answer while `"[re !A3 …]"` is chat that
parks the item as replied (bring it back with `fy agenda edit`: `--question-answer` to answer a question about it with its options kept, or refresh the whole card — `--summary`, `--premise` and `--context` — else `done --reason` withdraws it —
[agenda.md](agenda.md#parked-items)).

- **The switch** is the session's own recorded setting, `config.agenda` (`sessionAgendaEnabled`, absent
  means OFF), exactly like `config.hypermedia` and `config.pack`. At each launch the daemon turns it into
  the launch environment variable `FY_AGENDA=1|0` (`AGENDA_ENV`), and it is what sets `agendaMode` on the
  session summary, so with the switch off the summary carries no `agendaMode` and the chat draws no agenda
  line or drawer.
- **The machine default** is `agendaMode` in `machine.yaml` (**on** unless you turn it off; the Machine tab's
  **Agenda mode** section, `fy machine set agenda-mode on|off`, or the `machine.settings` change). A ferret
  that is started or imported records it ONCE as `config.agenda: true` (the same adoption step Pack mode's
  machine switch uses, run for `fy new`, the app's start, pack sub-ferrets and a continued conversation), and
  a value the ferret already recorded, on or off, always wins, so an owner's explicit off is never overruled.
  Ferrets that already exist are never touched, and turning the default off records nothing on anyone. It is
  **not a loosening** (the config machinery holds only agent control and skipped permissions for
  `fy config confirm`), so the change applies at once with no confirmation.
- **Flipping it in the app:** the ferret's **Actions › Agenda mode** toggle (beside Hypermedia and Pack
  mode, in the header and the sessions list), or the **Agenda mode** mark in the header. The ferret's
  Info › Runtime tab shows it as a row, and the sidebar / header marks (a to-do list icon) show it only
  while it is on.
- **Flipping it from a ferret:** `fy notify agenda` reads the mode, `fy notify agenda on|off` switches it,
  over `GET`/`PATCH /v1/sessions/:id/agenda-mode` (operator scope; no capability, like the Pack switch).
  `PATCH` answers `{ view, restartRequired, note }` like the Hypermedia and Pack switches: a running ferret
  reads its instructions once, at launch, so the change takes effect when the ferret next starts.
- **The nudge follows the mode.** The turn-end check (the safety net for a reply that asks the owner to act
  but raised nothing) names `fy agenda add …` for a ferret in agenda mode, and `fy notify …` for one that
  is not.
- **Size:** [pack-mode.md](pack-mode.md) has the whole instruction budget (its Size table).

## Migration

Before agenda mode, a ferret's open items WERE its agenda. So once, on the first start of a daemon that
knows about the mode:

1. every ferret with at least one **open non-notice item** gets agenda mode ON (it records `config.agenda: true`, which sets its launch
   environment and its summary);
2. the items are left exactly as they are;
3. the daemon records that it ran, in `agenda-mode-migration.json` in its home.

It is **idempotent and once**. The marker is written only when every session was handled; a start that
finds it does nothing, so an owner who later turns a ferret's mode off is never overruled by a restart.
A start that could not switch some session writes no marker and tries again next time (switching a
ferret already on is a no-op). It never stops the daemon starting.

A second, separate marker, `agenda-files-migration.json`, records the move of each session's `attention.json` and
`attention-replies.json` to `agenda.json` and `agenda-replies.json` (one line of counts in the log). It follows the same
rules: written only when every session succeeded, a failed session keeps its old file and is retried next start, and it
never stops the daemon starting. [agenda.md § On disk](agenda.md#on-disk) has the rest. Records in
`notifications.jsonl` are not rewritten: both key spellings (`attention:`, `agenda:`) are read as one, so an item
notified before the upgrade is never notified again. A record written before v4.116.0 names its item `attentionId`;
it is read as `agendaId`. Refusing that spelling silenced every push from v4.116.0, because the ledger then failed
closed on any line it could not read and the failure was swallowed.

**A push that cannot be made is never silent.** A ledger line this daemon cannot read — malformed, of an unknown
shape, or out of phase — is skipped and counted, and every other line still decides; the cost is at worst one repeat
push for the identity that line named. The count is said in the daemon log whenever it changes
(`notifications: …notifications.jsonl: N unreadable lines skipped (first: line L, <why>)`). Every push that fails
is said too (`notifications: push <key> failed — <reason>`), and `fy doctor` (also the app's doctor page) has a
`notifications` row that fails while the newest push failed, while no device is enrolled, or while the newest
recorded push errored or reached no device, plus a `notification log` note for skipped lines.

## Every automatic push, and why it stays or goes

| Path                                             | Where                                       | Decision                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A ferret stops on the owner                      | daemon `AgendaBuzz` → `NotificationService` | **The** push. One per stop, grouped. See above.                                                                                    |
| An item's `neededBy` comes near                  | daemon `AgendaBuzz`                         | **One push** per item. Never for a quiet input card (filled under a paste rule, a task plan line or a standing rule at its raise). |
| A notice with `--ping`                           | `fy notify --ping`                          | **One push** per notice.                                                                                                           |
| A sign-in to approve on the phone                | daemon `PhoneApprovalService`               | **One push** at the raise and one per new number read (at most four), high inside the caps.                                        |
| An item is created, edited, surfaced or answered | daemon                                      | **Never pushed.** Inbox badge only. (The per-turn grouped push, the surfaced push and the more-info push are retired.)             |
| A notice without `--ping`                        | `fy notify`, legacy `POST …/notify`         | **Never pushed.** Inbox badge only.                                                                                                |
| Enrolment confirmation                           | daemon `PushService.register`               | Kept. One push, only to the browser that just enrolled.                                                                            |
| A new device was paired                          | daemon audit log                            | Kept. This is a security alert.                                                                                                    |
| A harness parks on its own prompt                | daemon `HarnessPromptAgenda`                | **An item** like any other: it buzzes through a stop, not by itself.                                                               |
| A session starts, finishes or idles              | daemon                                      | Never pushed on its own (a stop is idle **with** an item waiting).                                                                 |
| `failed` / `stalled` / `kill_failed`             | PWA page watcher                            | Kept. A dead ferret cannot raise an item.                                                                                          |
| Notifications a device's own filter hides        | push worker                                 | Kept as one quiet, silent line per machine (a push that shows nothing gets a subscription revoked). Carries the mark.              |

## GAPs

- **The default is per machine, not per profile or runtime.** One `agendaMode` switch decides it for every new
  ferret on the machine; a profile- or runtime-level default is not built.
- **A running ferret keeps its launch-time instructions.** Flipping the mode changes the next launch, not
  the current turn; the owner restarts the ferret to apply it.
- **A stop is seen, not reconstructed.** A ferret idle on the owner when the daemon starts does not buzz at
  start-up (only its deadlines are swept); it buzzes the next time it stops.
- **A ferret whose state cannot be read** has no stop, so it never makes the stopped push; deadlines and
  pings are unaffected.
- **A notice carries no "needs you".** A ferret that sends a notice when it needed a decision pings the
  owner without leaving anything to answer; the safety-net nudge catches the reply that asks, not the
  notice that should have been an item.
- **Page-level notifications for a new item.** A device with no push enrolment learns about an item only
  from the unread mark while the app is open.
