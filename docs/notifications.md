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

Every ferret is told this rule, whatever its mode (`NOTIFY_INSTRUCTION` in `@ferretry/fleet`, quoted
verbatim; `fy` is the binary name):

> Notify: the owner reads the Inbox, not your replies. To tell them something worth their time (a result, a blocker, a decision you made for them) run `fy notify "<summary>" [--body "<detail>"]`: a quiet Inbox notice. Add `--ping` only when it must reach their phone now. Never notify progress or chatter.

## When the phone buzzes

Only these five. Everything else — a new item while the ferret works, an edit, a change of whose turn it
is, a notice without `--ping`, the owner's own moves — moves the Inbox badge and nothing more.

| #   | Moment                                                                                                                                            | Push                                                              | How often                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------- |
| 1   | The ferret **stops on the owner**: it went idle with at least one item on the owner's turn                                                        | ONE grouped push: "<ferret> is stopped · N need you"              | Once per stop (however many items wait) |
| 2   | An item's **`neededBy`** comes within `attention.deadlineWarnHours` (default 3 hours)                                                             | The item's title; "Needed in 25 min" / "Overdue" ahead of its ask | Once per item                           |
| 3   | A notice with **`--ping`**                                                                                                                        | The notice's summary                                              | Once per notice                         |
| 4   | A **snoozed** item wakes and it **blocks** the ferret or has a **`neededBy`**                                                                     | The item's title; "Back from snooze: <ask>"                       | Once per wake                           |
| 5   | A card the owner asked for **reaches a gate**: its ask is put on its agenda ([board.md](board.md#cards-show-progress-their-asks-ride-the-agenda)) | The agenda's title; "&F12 <card> is at <lane>: Done or Not good"  | Once per card ask, when it is put on    |

A card ask is the card's one signal: it pushes when it is put on its agenda (row 5) and that agenda is left out
of a stop only while its sole open items are card asks, so a ferret that stops with only such an agenda waiting makes
no stop push, and a question it asked on the same agenda is counted. An internal card (a ferret's own errand) never asks, so it never buzzes.

An input card always counts as inside the window (row 2), so it pushes once the moment it is raised, unless it is
**quiet** (below). An
**approve-on-phone card** ([input requests](input-requests.md#approve-on-your-phone)) is the one card that pushes
outside these rows: once when it is raised, and once more for each new number the daemon reads off the page (at most
four in all). It has no `neededBy`, so row 2 never pushes it a second time. A woken item already inside its deadline's window gets the deadline's push (row 2) instead, never both. A snoozed
item is parked, and a replied item rests (stored as `parked: replied`; [agenda.md](agenda.md#parked-items)): neither
counts toward a stop or a deadline while it sleeps.

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
for a stop, else the oldest. **The item opens AT ITS ASK**: its view scrolls to "What I need from you" and focuses it
([agenda.md](agenda.md#the-item-view)), so the owner lands on what to do.

**What counts as a stop.** The ferret's session state says its turn ended on the owner (`turnState` is
`your-turn` or `needs-input`, with `turnStateAt`), and its Needs-you queue is not empty (`needsYouQueue`,
[agenda.md](agenda.md#the-needs-you-queue): no notice, nothing resting on the ferret or snoozed, unresolved). The
push opens at the queue's first item — a blocker first — and its count is the queue's length (`agendaBadgeCount`). A
stop is named by that `turnStateAt` instant, so the same stop never pushes twice — across a daemon restart too — and
the next idle period is a new stop.

**What never buzzes.**

- The owner's own actions. A phone is never buzzed by what its owner just did.
- A ferret that is working. Items raised mid-turn wait for the stop.
- A ferret that was **already idle when the daemon started**. The start-up pass looks at deadlines only;
  a stop is something the daemon sees happen.
- A RESTING item: the owner replied to or answered it, asked for more or to discuss it, or the ferret took it on
  (`fy agenda rest`). The ferret has the ball; the Warden's silence nudge goes to the ferret, never to the phone.
- A snoozed item that has not yet woken. (An item the owner replied to is RESTING, above, not parked.)

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
  ask (`agendaTitle`). The body is at most 120 characters, trimmed with `…` (an ask is meant to be about 80, so it fits whole). A push never carries the
  context, the options or the recommendation.

- **An approve-on-phone card:** the daemon's own title, "Approve on your phone", and a body built by
  `phoneApprovalWords` from what the daemon observed. By owner decision !A171 the body leads with the number
  the daemon read off the page: "Tap 42 on your phone: your account on company.okta.com", or "Enter 123 in Duo Mobile:
  …". It names the place, never the account, because every subscribed device shows it.
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

### One line per item

Every item push goes out under **its own tag**, `attention-<session>:<item>` (`agendaItemPushTag`): a ping, a
gate, a deadline and a woken item each replace only that item's earlier line. **So a ferret with two pushed items
shows two lines**, not one line with "+1 more". A stop's push keeps the ferret's tag, `attention-<session>`
(`agendaSessionPushTag`), even when it goes out loud for a code card, because it is about the ferret and everything
waiting then: clearing that one card never takes the stop's line down. The own tag is what lets a handled item's line
come down on its own (below). A push recorded before tags were went out under the ferret's tag, the item's (a high
push), its approval's (`pa-<id>`) or — a high stop — a code card's: a clear names each one it may have used, every
code card that no longer waits included, since the ledger never said which card a high stop showed.

## When an alert is cleared

The owner asked for it: "if an agenda went to sleep, then you should dismiss all notifications sent out related to
the agenda! or when on 1 device is alr replied or resolved. then it should dismiss on other phones".

**When.** After every change to a board, the daemon (`AgendaAlertClearer`) looks at each item whose push a device
accepted, and takes its alerts down on every device once the item no longer waits on the owner:

- it was **answered, resolved or dismissed**, on any device, by the ferret or by the daemon;
- it is **resting** (the owner replied and it waits on the ferret) or **snoozed**;
- it moved to **the ferret's turn** (needs more information, discussed);
- a notice was **read**.

It decides from the board, not from what changed, so a new way for an item to stop needing the owner clears its alerts
without a new rule. The **stop's line** ("N need you") comes down only once no item it could count is left on the
owner's turn, because until then its words are still true.

**When the owner opens the item.** Opening an item's card anywhere in the app takes its alerts down too: the Inbox
deck's top card, or the item's card in its conversation (an agenda row, a `!A3` reference, a notification tap, paging
to it). The app closes that item's lines on the device in the owner's hand at once, and tells the machine
(`POST /v1/push/seen`, `fleet.use`, only where the machine lists `push.clear.1`). The machine clears every OTHER device
and answers the tags it named, so the app closes those here too, the stop's line included when it was the last item.
The device the item was opened on is skipped, so it never gets the iPhone note below about its own tap.

An Inbox card counts as opened only while someone is at that page (`ATTENDED_MS`): it came on top within a minute of
a press, key or tap on a visible page — coming to the page counts — or else it is told at the next one. A deck left
open on a screen nobody is at moves on by itself when its card is answered elsewhere, and that is not the owner
opening the next card, so it never takes that card's alert off the phone in their hand.

The answer can be slow, and by then a NEWER line can be up under one of its tags (the next item was raised, and a new
stop went out). So the app closes, for the answer's tags, only a line whose `timestamp` is at or before the moment of
the open, read when the item was opened rather than when the answer came. A line the browser gives no `timestamp`
(Safari does not stamp them) is left up: losing a newer alert is worse than keeping an old one. **GAP:** on such a
browser the stop's or approval's line the answer names stays up on the opening device until it is handled again or
swiped away. **GAP:** a push that already reached the opening device but is still being shown when the owner opens its
item there (its worker is reading the filter) is not caught by either half, and that one stale line stays on that
device; the other devices are cleared as usual. Once the machine answers, the app also closes the item's OWN lines
however new — any is about the item open in front of the owner — which takes down one of its pushes that landed
here after the open; one that lands after that close stays (the same push-ordering GAP as below).

**What a clear says.** Nothing about the item. A clear push is `{ version, kind: "clear", eventKey, sessionId, tags }`
and the parser refuses anything more (`PushClearPayloadSchema`): no title, no body, no link, no item words. The
worker turns each tag into its own machine's namespace (`fy-push:<daemonId>:<tag>`), so one machine can never take
down another's lines.

**What each device does with it** (owner decision !A324). Which push service delivers it is read from the
registration's own subscription endpoint (`mustShowForEveryPush`, from the protocol's `PUSH_SERVICE_ALLOWS_SILENT`): only FCM (`fcm.googleapis.com`) and WNS
(`*.notify.windows.com`) are known to let a push show nothing; every other service — Apple's, Mozilla's, one not
known — and an endpoint the worker cannot read need every push to show something.

| Push service                                      | The item's line is showing                                                                         | Nothing is showing                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| FCM, WNS (Android, Chrome, Edge)                  | closed                                                                                             | nothing                                                                       |
| any other (iPhone, iPad, Safari, Firefox, others) | **replaced** by "<machine> · Handled on another device" / "Nothing to do here." (same tag, silent) | the same note once, under one fixed tag per machine (`fy-handled:<daemonId>`) |

Such a device swaps rather than closes because its push service revokes the subscription of a site that receives a
push and shows nothing — Apple's at once, Mozilla's once a small quota of such pushes is spent — the same rule a
muted push answers (below). The note never names the item. A tap on it opens that machine. Chrome lets a push show
nothing too, within a budget: past it, Chrome shows its own "This site has been updated in the background" line.
Each note is marked as one (`data.handled`), and showing one closes this machine's other notes on that device, so it
keeps one quiet note however many items were handled (the newest, so the push that showed it still showed something).

**Once each.** A clear is written to `notifications.jsonl` with the pushes it covers before it is sent, so a second
change or a restart never clears the same push again; a later push about the same item (it woke again) is cleared on
its own later. Each clear has its own key (`clear:<session>:<instant>:<count>`). A burst of more than eight tags goes
as several clears, and a push counts as covered only by the clear that names its LAST tag, so one stopped between two
sends the rest again on the next look. Opening an item again tells the machine again, because it may have buzzed
since; a clear with nothing left to cover sends nothing.

**A push raised while a clear is decided.** A ferret's pushes and its clears run one at a time in one lane
(`agendaAlertLane`): a push is recorded, sent and its outcome recorded inside it, and a clear reads the ledger, then
the board, and is recorded and sent inside it. So a clear decided from a board read before an item was raised or woke
is sent before that item's new push, never after it, and never counts that push as covered.

**An open that names many tags.** One answer to `seen` carries at most `PUSH_SEEN_MAX_TAGS` (as many as one board can
name: the ferret's tag, and an item's and its approval's for each open and retained item). A clear past that skips
nobody: it reaches the opening device too, whose worker takes those lines down (an iPhone may show the quiet note).

**A push still on its way.** A push the owner handles or opens before it has reached a device had no line to take
down yet. The daemon looks again as soon as that push's outcome is recorded: a handled item's line comes down then,
and an open made while it was on its way is honoured then too (that memory is not kept across a restart). That late
clear reaches EVERY device, the one that opened the item included: its page closed only what was showing when it
asked, so an iPhone there may show the quiet note for that one line. The same holds for a push being sent when the
owner opens its item: the open notes it before it waits its turn in the ferret's lane, and clears it on every device
if it landed meanwhile. One that had already landed when the open reached the machine (the owner most likely just
tapped it) is the ordinary clear's, which skips the opener, so the phone in the owner's hand almost never says "Handled on
another device" about its own tap — only when another device's push service holds that push up (10 s at most) is it
still on its way at the open. A push recorded with no outcome counts as on its way for 10 minutes at most. At
start the daemon looks once at every ferret with a line this release pushed still up, for a board that changed while
it was down.

**A push and its clear at once.** A service worker can handle a push and the clear after it at the same time, and a
push reads this device's filter before it shows anything. So the worker numbers pushes in the order they arrive, runs
showing and clearing one at a time, and remembers each clear's tags for a minute (`RecentlyCleared`): a push whose
line a LATER-arriving clear took down is settled as that clear would have, instead of showing. A push that arrives
after the clear (the item woke again) shows as usual, and an older push that resumes after it never touches that
newer line: on an iPhone it shows only the quiet line under the fixed tag. A clear the push service delivers before
the push it clears is not caught: nothing on the wire tells that push from a newer one. A clear is never in
`fy doctor`'s push count: one that reached no device (the only one was the device that opened the item) is not a
failed push. A clear the push service refused leaves that line up.

**Pushes from before this release.** No daemon before this one wrote a clear, so on the first start every push it
ever made counts as uncovered. The start-up look therefore skips a push recorded before tags were: it is cleared only
by its own ferret's next board change or open, one ferret at a time as the owner works, and only while it is under
two days old. A finished ferret's old lines stay up as they did before this release, and an upgrade sends no burst of
clears. A push this release made has no age bound: its item may be answered days later.

**GAP: the ledger is never rotated.** The clearer reads the whole `notifications.jsonl` on every board change, every
landing and each open, and the file only grows (its bounded rotation is a follow-up), so that cost grows with it.

**Rolling back.** A daemon older than this release reads the new ledger records (a push's `tag`, a clear) as lines
it cannot read and skips them: `fy doctor` counts them, and it may repeat a deadline, stop or wake push for an item
still open, at most once each (the ledger's own rule).

**Older apps.** A service worker older than this release cannot read a clear and shows its plain "Something is
waiting in your Inbox." line instead. The hosted app ships before a daemon release does and a worker refreshes the
next time the app opens, so the window is small; a device that has not opened the app since may see that line once
per clear.

### Known limits

Each is a declared GAP: an alert may stay up longer than it should; none takes a wanted alert down or puts item words
in a clear.

- **A clear the push service delivers before the push it clears** is not caught: nothing on the wire tells that push
  from a newer one, and the clear carries only its five fields.
- **The opening device itself**: a push already reaching it while the owner opens its item (its worker still showing
  it), or reaching it after the page's last close, stays on that device.
- **A browser that gives notifications no `timestamp`** (Safari): the stop's or approval's line the machine's answer
  names stays on the opening device; the item's own line still comes down.
- **The tapped phone may get the quiet note** when another device's push service holds that push up (10 s at most), so
  the push is still on its way when the owner opens it.
- **Pushes from before this release** are cleared only by their own ferret's next change or open, and only while under
  two days old; a finished ferret's old lines stay up.
- **Chrome's own "This site has been updated in the background" line** may show once Chrome's budget for pushes that
  show nothing is spent.
- **A desktop notification clicked into a visible, idle window** is not counted as an open until the next press, key
  or tap there (a window focus is not an input yet), so that item's line stays on the other devices until then.
- **An open made while its push is on its way** is remembered in memory only: a restart before the push lands leaves
  that one line up.
- **The ledger is never rotated**, and the clearer reads it whole on every change.
- **A service worker older than this release** shows its plain "Something is waiting in your Inbox." line for a clear,
  and **a daemon rolled back** past this release skips the new ledger records (above).

## Where a tap goes

The push's `url` is relative to the machine's own pages: `/ferrets/<id>/chat?ask=A3`
(`agendaNotificationPath`; `ask` is `ASK_LINK_PARAMETER`). The daemon never knows which name a browser files it
under. The browser's per-machine push worker places the path under that machine, so it opens
`/d/<daemonId>/ferrets/<id>/chat?ask=A3` (`notificationUrl` in `packages/app/src/worker/notifications.ts`). There is
no other spelling of the path and no `/session/` alias. The page that tap lands on is checked by the shell's own route
table (`notificationTapTarget`): an address it does not draw opens that machine's home, and one off this origin the app's. It reuses an open app
window when there is one, whichever worker controls it, and never a sign-in popup.

Every push names a page, and the worker opens a page even when one does not:

- **A push with no item** opens the chat it came from: `/ferrets/<id>/chat`
  (`sessionNotificationPath`).
- **A push that names no page it may open** opens the conversation its `sessionId` names, on its
  machine. A daemon older than #768 sent every push with `url: '/'`, an ask included. A push about no
  conversation (a new device, enrolment, a passkey) opens that machine's sessions.
- **Which window.** An app window wins over the landing page, which has no router. Among app windows,
  the one the reader is looking at wins.
- **How the window gets there.** The worker brings the window forward and asks the app to route there
  in place (`packages/pwa/src/lib/notification-open.ts`). The app's entry point listens before React
  mounts, so a tap that lands while the app is still starting is routed once it is up. It moves the app
  to the tapped machine, and the conversation opens at the item — scrolled to its ask — again on every new tap (each tap carries its own number, and paging or closing leaves the request, so the same item opened from the list starts at its top).
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

`SessionView.state.agenda` is `{ open, first, ask, latestAt }` while anything is open, and absent
otherwise. Absent always means "nothing waits on the owner", never "unknown". It also carries
`agendaMode` (the ferret works in agenda mode) and `stopped` (it is stopped on the owner, the instant it
went idle), which are what the list shows beside the badge.

- The daemon rewrites it after every board change, and when a ferret's mode or idleness moves with no board
  change. It re-reads the board under one lock per session, so an out-of-order notice can never show an
  answered item as open.
- Notices are not counted: a notice moves the Inbox, not the "needs you" mark.
- Every board change also journals `agenda.changed` (`attention.changed` in older releases). The fleet feed
  refetches on any event that is not `surface.*`, so lists update
  without polling.
- On start, the daemon reconciles every session once, in the background.
- It clears only when items resolve. Viewing a conversation does not clear it.

## Machine notices

Notices that belong to no ferret — a ferret the Warden could not move, a card with nobody working on it, a login at its
budget limit — are raised **once per cause** on the machine agenda ([agenda.md](agenda.md#the-machine-agenda)), not
once per ferret. They notify and count like any item, an update in place does not buzz again, and nothing is raised
on a stopped session.

## Agenda mode

A ferret keeps an agenda only when it is told to. **Agenda mode** is a switchable section of its
instructions, like Pack mode, and a new ferret has it **ON** unless the machine default is off. With it on, the ferret is taught to put each
thing only the owner can decide or do on the agenda, as its own item (`fy agenda add …`, see
[agenda.md](agenda.md)); with it off, it is told only the notify rule above. A new ferret starts with it
on unless the machine default (below) is turned off.

The section (`AGENDA_INSTRUCTION` in `@ferretry/fleet`, 1,352 characters, capped at 1,360 by a test; the shipped
prompt as a whole has its own cap, so a new rule here is paid for by tightening words) teaches the model first: what an
agenda is (one channel of the owner's attention), the three-part test, search-check-open, splitting, then the one
command that opens one, then the states, the tabs as the live document (read whole, then every stale part edited — premise, context, the ask,
its options, still-open and each tab — on every update; any kind of content, steps and explainers kept there), chat discussion, and the two standing rules (a bug batch is one
agenda; an owner’s question is answered on its item)
([agenda.md § One channel per topic](agenda.md#one-channel-per-topic)). It names only verbs that exist. Exactly this,
with the binary's name for `fy`:

```text
Agenda mode: one channel of the owner's attention; only what they can give. Share if same place, same context, same pace; dependent things always share. Search, check, then open (`fy search`): none fits→open, else closest. `split` misfits, `merge` items that share.
Open: `fy agenda add --title "<topic>" --premise "<now>" --context "<facts>" "<ask>"`. Title ≤40, ask ≤80. Read cold: no ids/paths/jargon (`--term X=meaning`); short points, answer first, no headings. Kinds: choice=ONE question+2–3 `-o "Label: why"`, `--recommend`; reply=open or several asks (one `-q` each); form=several structured answers (`--field`); todo=`--step`s; info=Got it; permission=Approve/Deny. `--blocking`=stuck, `--will-block`=later, `--by <time>`.
Needs you buzzes; Resting is quiet. Owner reply/answer rests it; `answer <id> "…"` returns it. `rest <id> --why …`=working. Every update: `show <id> --yaml` whole, rewrite all that's stale (premise, context, ask, options, kind, still-open, each tab), then `patch <id> --file f`; chat points there. Tabs hold any kind (to-dos, steps, explainers), one each, serial stays one, kept there. Only you mark it `done` when nothing's left. Chat: `log <id> --reply|--rest` logs their words verbatim; link it; unsure→closest, say so.
Bug batch: ONE agenda, line each + where tracked. Owner Q: answer ON it, options stay; no item: ONE `-k info`.
```

- **The switch** is the session's own recorded setting, `config.agenda` (`sessionAgendaEnabled`, absent
  means OFF), exactly like `config.hypermedia` and `config.pack`. At each launch the daemon turns it into
  the launch environment variable `FY_AGENDA=1|0` (`AGENDA_ENV`), and it is what sets `agendaMode` on the
  session summary, so with the switch off the summary carries no `agendaMode` and the chat draws no agenda
  line or drawer.
- **The machine default** is `agendaMode` in `machine.yaml` (**on** unless you turn it off; the Agents tab's
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

| Path                                                 | Where                                       | Decision                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A ferret stops on the owner                          | daemon `AgendaBuzz` → `NotificationService` | **The** push. One per stop, grouped. See above.                                                                                    |
| An item's `neededBy` comes near                      | daemon `AgendaBuzz`                         | **One push** per item. Never for a quiet input card (filled under a paste rule, a task plan line or a standing rule at its raise). |
| A notice with `--ping`                               | `fy notify --ping`                          | **One push** per notice.                                                                                                           |
| A sign-in to approve on the phone                    | daemon `PhoneApprovalService`               | **One push** at the raise and one per new number read (at most four), high inside the caps.                                        |
| An item is created, edited, surfaced or answered     | daemon                                      | **Never pushed.** Inbox badge only. (The per-turn grouped push, the surfaced push and the more-info push are retired.)             |
| A pushed item is handled, rests, sleeps or is opened | daemon `AgendaAlertClearer`                 | **One clear** per push: its line comes down on every device, content-free (see When an alert is cleared).                          |
| A notice without `--ping`                            | `fy notify`                                 | **Never pushed.** Inbox badge only.                                                                                                |
| Enrolment confirmation                               | daemon `PushService.register`               | Kept. One push, only to the browser that just enrolled.                                                                            |
| A new device was paired                              | daemon audit log                            | Kept. This is a security alert.                                                                                                    |
| A harness parks on its own prompt                    | daemon `HarnessPromptAgenda`                | **An item** like any other: it buzzes through a stop, not by itself.                                                               |
| A session starts, finishes or idles                  | daemon                                      | Never pushed on its own (a stop is idle **with** an item waiting).                                                                 |
| `failed` / `stalled` / `kill_failed`                 | PWA page watcher                            | Kept. A dead ferret cannot raise an item.                                                                                          |
| Notifications a device's own filter hides            | push worker                                 | Kept as one quiet, silent line per machine (a push that shows nothing gets a subscription revoked). Carries the mark.              |

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
