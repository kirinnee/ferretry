# The project board

The contract for the board: where a ferret's work is tracked when the owner wants it tracked. One board per project,
one card per piece of work, lanes the owner can rename, and a daemon that moves a card when a pull request or a
release does. **The board is opt-in** ([below](#the-board-is-opt-in)): most work needs no card. This page owns the
subject; the pages it links own their own facts.

| Subject                         | Owner                                          |
| ------------------------------- | ---------------------------------------------- |
| Importing the old task files    | [board-import.md](board-import.md)             |
| `&F412` and `!A48` references   | [reference-standard.md](reference-standard.md) |
| The agenda and its items        | [agenda.md](agenda.md)                         |
| Who may call the board's routes | [grants.md](grants.md)                         |

Where the board is on, most of it is automatic: a start makes the card, a PR and a release move it. The sections
below are the whole contract; the last ones are the part a ferret must do itself, and the backstop that catches it
when it does not.

## The board is opt-in

The owner's decision (2026-11-01): "board is overkill — most ferrets should not use tasks or boards — ask before
doing that". So each project's board has a switch, **off unless the owner turns it on**, and a ferret makes a card
only when

1. the project's board is on (`fy board status`),
2. the card goes under a live card on that board it holds (`--parent`: its own, or one its lead handed it with
   `fy new`), or
3. the owner said **Yes** to its agenda question "Track this on the board?" (`--approval !A<n>`).

Otherwise it asks first: one agenda yes/no, "Track this on the board?". A card a ferret holds works as it always did,
whatever the switch says. **The daemon enforces this** ([below](#the-daemon-refuses-a-card-nobody-asked-for)): words
alone did not hold, because a person's own instructions that say "record every task" outvoted the Board rule.

| Where the board is off                                    | What happens                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `fy start`, the app's New session                         | no card is made, unless `--card` hands over an existing one                                                        |
| `fy new`                                                  | a card only under a live card the lead holds on the child's board (brief or focus), or the one `--card` hands over |
| `fy task create`, `fy task refile` to another board       | a ferret's card is refused unless it rests on a live parent it holds there or on the owner's Yes                   |
| the [turn-end check](#the-turn-end-check)                 | silent                                                                                                             |
| the sweep's stale and unblocked nudges, a PR or a release | unchanged: they only ever touch a card that exists, so only a ferret holding one hears them                        |

### The daemon refuses a card nobody asked for

`BoardService.create` decides (`packages/daemon/src/lib/board/opt-in.ts`), for a **ferret on its own session
credential** only, after the sub-ferret refusal and the parent's standing — and so does a **refile onto another board**,
because a card made where the board is on must not be moved onto one that is off. The first proof that holds lets the
card through:

| Proof                  | What the daemon checks                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The board is on        | the switch of the board the card lands on. A switch that cannot be read is off.                                                                                                                                                                                                                                                                                                         |
| A live parent it holds | `--parent` (a refile: the card's parent) is a card on **that same board**, neither dropped nor closed, that the ferret may adopt under (owner, assignee or ancestor standing) — it is splitting work already on the board.                                                                                                                                                              |
| The owner's Yes        | `--approval !A<n>`: an item on the ferret's **own** agenda, raised by it, asking exactly Yes or No, whose title or ask is "Track … on the board?", closed by the **owner** with **Yes**. The card stores it (`approval`). **One Yes makes one card**: two creates on one Yes are decided one after the other, and the second is refused. A refile carries the Yes the card was made on. |

**The owner's words are no proof.** An earlier draft let a card through whose ask matched the owner's message when
that message named a card, the board or tracking. Its security review showed "track down the bug" and "the credit card
field" passing, so an honest ferret told to "record every task" would still have made cards. The Yes costs the owner one
tap and has no such hole.

Otherwise the create (or refile) is refused (`403 forbidden`) with one message that says what to do instead:

```text
The ferretry board is off, so this work needs no card: put only what the owner must decide or do on your agenda (fy agenda add …). To track it anyway, ask first: fy agenda add -k yesno "Track this on the board?" — then, once the owner says Yes, fy task create … --approval !A<n>.
```

A named approval that does not count adds why (`The approval does not count: the owner did not answer Yes to !A12.`).
An agenda that cannot be read counts as no Yes, so the rule fails closed.

**`fy new` asks the same of the card it makes for a sub-ferret**, of the board the **child** will work on (its own folder's
with `--cwd`, resolved as its start resolves it, and checked again on the board it lands on). Where that board is off it
makes one only under a card on that same board that the lead may adopt under and that is still work
(`BoardService.mayAdoptUnder`): the first card the brief names, else the lead's focus. A brief that merely mentions
somebody else's card, a closed or dropped one, or one on another board gives no card.

Not asked: the owner (a paired device, the admin CLI), the admin token, and the daemon's own writes — gates, PRs,
releases. Moves, links, notes and closes of a card a ferret holds are unchanged.

**GAP: the same user is the owner.** The admin token (`fy --as-owner task create`, an old `fy` without the session
credential) passes, the same GAP the switch has (below; closing it is RF-3, &F291). A ferret runs as the owner's own
user, so it can also write the daemon's files directly — the board, the switch, its agenda ledger — as
[secrets.md](secrets.md) says of every same-user process. The rule stops a ferret that follows instructions, not one
that sets out to forge the owner.

**Only the owner throws the switch**: `fy board on|off [--project <name>]` from their own terminal, or **Use the
board** on the project's page in the app. A ferret's `fy board on` is refused (`403 owner-only`), because the session
it runs in rides on every call. The switch lives in `<home>/board/switch.json`
(`packages/daemon/src/lib/board-projects/board-switch.ts`); a damaged one is refused and never overwritten, and a
board whose switch cannot be read is treated as off.

**Migration.** The first daemon with the switch decides every existing board once, at boot: **on** exactly where the
owner sent a card back (**Not good**, a `reopened` event by the owner) in the last 14 days, and **off** everywhere
else. Unfiled is always off. Only Not good counts, because it is the one act no ferret makes (see the GAP below); on
the machine this was built on that switched on Ferretry alone. The boot log says which
boards it switched on and off (`board switch: on for …; off for …`); the owner flips any of them afterwards. A board
registered later starts off.

**GAP: a ferret without its own credential has the owner's authority.** A call on the admin token with no session
(an older `fy` or harness without `FY_SESSION_ID`, a tool outside Ferretry) cannot be told from the owner at the
machine, so it passes every owner-only board gate — the switch included. It is no longer RECORDED as the owner: a
card's history says `admin-token` — "the admin token (the owner at this machine, or a ferret without its own
credential)" — and only a paired device's act reads as `owner`. A ferret on its own session credential is always
itself (`ferret`), never the owner. That is why the migration counts only Not good. Closing the gap for good is
`fy` presenting the session credential in every pane (RF-3, &F291).

## Tidy: dropping what nobody asked for

`fy tidy` is the one-shot clean-up for a ferret that made cards and work-tracking agenda items nobody asked for
(the owner's one-line prompt to such a ferret is "run `fy tidy`"). It acts on **the calling ferret's own work
only**, and it is a **dry run unless `--yes`**: it prints what it would drop, close and keep, each with the reason.
`fy tidy --yes [--reason "<why>"]` applies it; `--json` prints the plan (and, with `--yes`, the result). The OWNER, who
has no ferret of their own, names one with `fy tidy --ferret <id>` (a dry run, or `--yes` with `--reason`; v4's
`--session`, for the owner only): the daemon takes that target only from a caller that is not a ferret, and a ferret
credential naming any ferret but itself is refused (exit 2). `--session` stays refused and points at `--ferret`.

The daemon decides (`planTidy`, `packages/daemon/src/lib/tidy/plan.ts`, behind the read-only
`POST /v1/tidy/plan`; a ferret's plan is for its own credential's ferret; only a non-ferret caller may name one, in the optional body `{ "ferret": "<id>" }`). The CLI acts: it
applies the plan with the same card drop and agenda "done" the ferret could type itself, one by one, so every
change keeps its history and its authority check, and it names each failure without stopping. A failure makes
the command exit non-zero.

| It **drops** a card when …                                         | It **never** drops …                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| the caller owns or is assigned it, and it is not closed or dropped | a card the owner asked for (`askedBy: person`)            |
| its project's board is **off** ([switch](#the-board-is-opt-in))    | a card on a board that is on                              |
| `askedBy` is `agent`: it is the ferret's own work                  | a card assigned to another live session (a sub-ferret)    |
|                                                                    | a card waiting at a gate on the owner (an open gate item) |

| It **closes** an item when … (any open state: active, snoozed, replied, in discussion)       | It **never** closes …                                                                                                                       |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| it is on the caller's own agenda and the caller raised it                                    | a gate item or gate follow-up, or anything the daemon raised                                                                                |
| it is kind `info`, or linked (`--task`) to a card this run drops, or an ask with no question | an item on the owner's turn mid-reply (a reply held or being sent)                                                                          |
|                                                                                              | an item with a question, fields, options or a confirm: listed as "kept: needs the owner" with the `fy agenda done <id>` to close it by hand |

**GAP: `fy tidy` does not see card asks.** It keeps a card or an item only for a legacy gate item (`item.gate`), not for an open card ask (`cardAsks`; `tidy/service.ts`, `tidy/plan.ts`). A follow-up should make tidy treat an open card ask like a gate.

A sub-ferret may run it: its plan has no cards (the daemon already refuses a sub-ferret's drop) and only its own
tracking items. An older daemon without the route answers 404; the CLI says to run `fy daemon update`.

## Boards, cards and lanes at a glance

- A **board** is one registered project, or the machine-wide **Unfiled** board for work outside any git repository.
- A **card** is one piece of work. Its id is `<B|F|I|C><n>`, the prefix set by its kind (bug, feature, infra,
  chore). Ids come from one machine-wide counter and are never reused.
- A **lane** is a column of a board. Lanes are arbitrary names, each in one of six fixed categories.
- Only the daemon and the CLI write cards. The types live in `packages/protocol/src/lib/board*.ts`, the rules in
  `packages/daemon/src/lib/board/`.

## The Board rules

Every agent runtime is told the rules, always on, in the appended system prompt after the Notify rule
(`BOARD_INSTRUCTION` in `packages/fleet/src/lib/account/fixed-layer.ts`, the `board` launch section). A running
ferret launched with older words is told the new ones on the owner's next message
([launch-settings.md](launch-settings.md#instructions-that-changed-since-the-launch)). Exactly this, with the binary's
name for `fy`:

```text
Board: opt-in, enforced; overrides other task rules. Card only if `fy board status` is on, under your card (`--parent`), or on the owner's Yes (`--approval !A<n>`). Public=the owner's asks ("status of all I asked?"): top-level, never `--private`; private=your sub-cards. Cards (&F412) never ask: answers, tests, Done ride its agenda, which moves it. One outcome, no umbrellas; add to a related card. Planning is a phase. Title+summary=what it's doing (sitrep). Each step: `fy task show <id> --yaml`, rewrite stale title, summary, status (PRs in doneSoFar), howToTest (where/do/see) before try, then `fy task patch <id> --file f`. `fy task move <id> <lane> --reason "<why>"`. Blocked: `fy task depend`/`block`. Owner's bug: `fy task reopen <id> --to <lane> --ask "<words>"`. PRs, merges, `fy signal done` self-move.
```

Tasks are `&F412` and agenda items are `!A48`; nothing prints the retired `#F412`
([reference-standard.md](reference-standard.md)). The card-writing part is the owner's (2026-10-31): a title of at
most five words, a one-line summary, premise and context as short bullets, and — before a card reaches Released or Ready to try — a
How to test written for the owner ([How a card reads](#how-a-card-reads)). Registering a project by hand is no
longer in the rule, because a ferret's first card registers its repository. The full `fy task create` command is no
longer in the rule either: the command's own refusals and `--help` say every flag it needs.

The rule names no gate: **the board runs itself and a card never asks** (the owner, 2026-11-04: _"TASK no longer have
user interactivity anymore! agenda tracks all those and are the one request user to test so it can move it. the board
is almost fully autonomous!"_). The owner's answers about a card — approve this plan, try this release, Done or Not
good — belong in the card's agenda, which moves the card ([One card, one outcome](#one-card-one-outcome)). How the
daemon puts them there is [Card asks](agenda.md#card-asks).

The rest of the rule is the owner's too (2026-11-04):

- **Public = the owner's asks, private = the ferrets' own sub-cards.** _"the board should answer the question 'What's
  the current status of all the things I asked you to do' or 'what's the sitrep'. that is how you decide internal or
  external."_ ([Public and private cards](#public-and-private-cards)).
- **Planning is a phase** (_"planning can be a phase!"_): a plan is worked in the card's planning lane, never a reason
  to skip the card.
- **The title and summary read as a sitrep** (_"reading the title should directly reflect what is doing -- similar to
  asking "sitrep""_): "Rewrite card teaching" says what the work does; "Board stuff" does not.
- **The card's status is rewritten whole at each step** ([The card's Status](#the-cards-status)).

## One card, one outcome

**A card shows progress only.** It is one outcome, moving through its lanes; every ask of the owner about it goes in
the card's agenda ([agenda.md § One channel per topic](agenda.md#one-channel-per-topic)).

**No umbrella or overarching cards.** A card that gathers many outcomes ("Agenda overhaul", "Misc fixes") shows no
progress anybody can read and hides each part's asks. `fy task create` refuses one — and creates nothing — unless
`--broad "<why this must be one card>"` says why it must be one. The heuristic is `umbrellaSignals` in
`packages/cli/src/lib/board/umbrella.ts`; it reads the title and the summary, never the owner's own words in `--ask`:

- a strong broad title word alone: overhaul, umbrella, epic, system-wide, misc, miscellaneous, omnibus, catch-all,
  roadmap, grab-bag, assorted, odds and ends, "and more", etc;
- a summary that lists three outcomes or more (by line, semicolon, numbering, comma or "and"; a clause of one word,
  like "fast" in "easy and fast", is not an outcome);
- a weak broad title word (all, everything, various, every, whole, general, cleanup, improvements, fixes, polish) only
  together with a summary that lists two outcomes — "Show all sessions" is one outcome.

A card with a `--parent` is one part of a bigger card already, so it is never refused. The refusal offers one card per
outcome, `--parent F12`, `--related F12` and `--broad`.

**Check related cards first, and prefer adding to one.** `fy task create` asks the daemon's related check
([work-search.md](work-search.md#the-related-check)) before it creates. A strong duplicate refuses, as before. Weaker
related cards, up to five, are listed on stderr with `--related F12` offered, which adds the new ask to that card as
a note and creates nothing; the card is then created. `--new` skips the check. The command's `--help` ends with the
same rule (`TASK_CREATE_RULE`).

## Sub-ferrets: no moves, only reports

A **sub-ferret** is a session another ferret started (`config.parent`, e.g. `fy new` from a ferret); a **lead** has none.
The owner's decision (2026-10-30): only leads move cards. Weaker models writing to the board is a coordination
problem, and what a sub-ferret does is mostly report back to its lead. The daemon enforces it by the caller's
session identity — in `BoardService` (`create`, `act`) and on the lane route — so a prompt cannot talk past it
([pack-mode.md](pack-mode.md#sub-ferret-limits)).

| A sub-ferret may                                                                                           | A sub-ferret is refused                                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| read the board, `fy task note` on a card, `fy task edit --status-*` / `--how-to-test` on the card it holds | `fy task create`, `move`, `reopen`, `depend` / `undepend`, `block` / `unblock`,                                             |
| `fy task link --pr <url>` / `--branch <branch>` on a card                                                  | `reparent`, `focus`, `edit` (but `status` and `howToTest`), `file`, `order`, `refile`, `clarify`, `link --commit` / `--doc` |
| `fy task drop` / `assign` on a card **in its own subtree**                                                 | `drop` / `assign` on any card outside it (see [Authority](#authority))                                                      |
| `fy task trigger` (`deploy.done`) on its card                                                              |                                                                                                                             |
| `fy send` its lead (and peers the lead names)                                                              | editing a project's lanes (`PATCH` of the lane list: `403 sub-ferret`)                                                      |

The refusal is `forbidden` and speaks to the caller, never of "sub-ferrets" at large: it says what it can't do, what it MAY do, and who can do the rest, e.g.
`You are a sub-ferret, so you can't move cards. You may note on and link a PR or branch to your own card, and drop or reassign cards in your own subtree. For anything else ask your lead: fy send <lead-callsign> "…"`.
A sub-ferret's own PR or branch link is always allowed; a commit or doc link, a `move` and a `focus` are judged against the card's **current holder**
(assignee, else owner): the holder may, anyone else is refused. When the refused card is one the sub-ferret's lead holds, the last sentence is replaced by
"Your lead holds this card: claim it first: fy task claim &F12", because claiming is what makes the sub-ferret the holder
([Claiming a card](#claiming-a-card-your-lead-holds)). That hint is given only for those operations: every other refusal (`edit`, `block`, `reparent`, …)
stays "ask your lead", since a claim does not unlock them. A drop or assign outside the caller's subtree reads "…you can't drop a card outside your own subtree…". A sub-ferret that leads a subtree of its own
is therefore never told it can't manage that subtree ([Authority](#authority)); the agenda and the lanes route say what they allow the same way.
The daemon still makes the sub-ferret's card when `fy new` starts it (that is the lead's act), enters its working lane
for it when the session starts (`work.started`, below), and a PR or release still moves it. A directory that cannot place a caller refuses nothing: the limit narrows a ferret known to be a
sub-ferret, it never locks one out it cannot find.

A sub-ferret's system prompt drops the Board rules above and the Notify rule and the Agenda mode section, and
carries these two lines instead (`SUB_FERRET_INSTRUCTION`, the `sub-ferret` launch section; the daemon writes
`FY_SUB_FERRET=1` from the session's `parent` at every launch, so a stored value cannot switch it off):

```text
Sub-ferret: you were started by a lead ferret. Never raise agenda items or notify the owner; message your lead (`fy send <lead-callsign> "<message>"`) only for a result, a blocker or a decision it must make. Label every send: `--kind blocker` (stuck until answered; at once), `--kind action` (default; to do; batched a minute), `--kind fyi` (rarely; no action; at the receiver's turn end). Only a password, code or approval the daemon asks for reaches the owner from you.
With a card: each step, `fy task show <id> --yaml`, rewrite its status (now/doneSoFar/next, PR links) and howToTest, then `fy task patch <id> --file f`; `fy task note` adds history. Link your PR `fy task link <id> --pr <url>` (or `--branch`); it moves itself (start, PR, merge, `fy signal done`). Lead's card? `fy task claim <id>`, don't ask. No card? Make none.
```

Nudges about a sub-ferret's card — the turn that closes without a PR, a reopen, a go-ahead — go to its **lead** instead
(`nudgeTarget`, `packages/daemon/src/lib/sub-ferret/index.ts`). The three **alerts** that ask a card's people to act —
a stale card, a red CI, a PR closed unmerged — are routed by [who a board alert is for](#who-a-board-alert-is-for)
instead, so the sub-ferret doing the card hears them first.

## Which board a card is on, and how a project gets one

A board is a registered project (`<state home>/projects.json`). A session's board is decided when it starts
(`config.projectId`): its parent's when it works inside that project, else the project its git repository
belongs to (worktrees included), else the registered folder that contains it, else **Unfiled**.

**The owner never has to register a project.** Projects get registered in two ways:

1. **Automatically, by a ferret's first card.** When a ferret on the Unfiled board makes a card (`fy task create`,
   or the card `fy start` / `fy new` makes) while it stands in a **git repository** whose main checkout is inside
   one of the daemon's `projectRoots` (`config/daemon.json`; default `~/Workspace` and `~/.config`), the daemon
   registers that repository, moves the ferret onto its board, and proposes the project's lanes from what the folder
   suggests. A project with no lanes has nothing to protect, so that first proposal is live at once; the owner gets
   one agenda choice to accept or edit it. A linked
   worktree registers the checkout it was made from. This is `ProjectAdoption`
   (`packages/daemon/src/lib/board-projects/project-adoption.ts`).
2. **By hand, with `fy project add <path> [--name <name>]`.** It registers a folder (`fy project add .` for the one
   you are in) and prints the project's name, id and folder. A folder, or a git repository, that is already
   registered prints the project it already is and changes nothing. `fy project ls` lists every project. Use it for
   a folder the automatic path leaves alone: one that is not a git repository, or a repository outside every
   project root.

The automatic path never registers the home folder itself, a temp or scratch folder (`/tmp`, a harness's sandbox),
a folder that is not a git repository, or a repository outside every project root. Those stay Unfiled. It is
idempotent and safe under races: the registry dedupes on the folder and on the repository, one repository is
adopted one session at a time, and a project that already has lanes is never proposed again, so two ferrets in the
same repository at once make one project and one proposal. A failure leaves the card Unfiled, as before.

**Unfiled is only for work outside any git repository** (an ad-hoc chat in `~` or `/tmp`). A card that belongs on a
project's board moves there with `fy task refile <id> --project <name>`. A refile keeps the card's state: a card that
is already closed lands in the other board's closed lane without the owner's gate, because the owner already closed
it; moving an open card into Closed stays the owner's.

**The daemon refiles Unfiled cards that belong on a board, at once** (`UnfiledRefiler`,
`packages/daemon/src/lib/board-github/unfiled.ts`): on every GitHub watcher tick and once at boot, an open Unfiled
card moves to a project's board when

1. a linked PR's repository is a registered project's, or
2. the folder its owner ferret works in belongs to one: the board that session was stamped with, else the board its
   folder resolves to now, else its repository registered by the automatic path above, with the same rules (never
   the home folder, a temp or scratch folder, a folder that is not a git repository, or one outside every project
   root).

The refile goes through `BoardService` as the daemon, and its history says which rule moved it. A refiled card whose
PRs say something lands where work resumes on the new board (its last active lane) and its PR facts move it on from
there — stopping at the first gate on the way, as every fact does ([Cards show progress](#cards-show-progress-their-asks-ride-the-agenda)) — so a card merged but not released lands in Merged, never in Released because it sat in the Unfiled
board's Ready to try. A card with nothing to say lands by its lane's category, as a refile by hand does. It is idempotent
and safe under races: runs never overlap, a card someone (not the daemon) refiled to Unfiled on purpose stays there,
and a ferret whose folder names no board is asked again only after ten minutes.

A project registered before projects got lanes (or by hand, with none proposed yet) is given the lanes its folder
suggests first (`InferredLaneProposer`: unconfirmed, live at once, the owner's one agenda choice raised as the card's
ferret), and the card is refiled in the same pass. A project whose `origin` uses an SSH host alias
(`github-personal:kirinnee/ferretry.git`, with `HostName github.com` in `~/.ssh/config`) is known by its GitHub
repository too: the daemon asks `ssh -G <alias>` where the alias goes, which reads the ssh config and connects to
nothing.

`fy board lanes show|propose|edit --project <name|id>` and `fy board --project <name|id|all>` name a board by its
name or id, wherever the flag is written on the line.

## The lane design rule

**Lanes show progress; what the owner must DO rides the card's agenda.** The owner, verbatim (their build-time addition to the agenda redesign, &F559):

> make sure that the whole new attention system also changes how tasks works. task no longer have 'need human'
> lanes, and you need to remove those!

The earlier rule (2026-10-30) still decides which progress is worth a lane:

> remember the lane design is always about ACTION -- when user need to have action and INFORMATION -- its good for
> the user to feel like there is SOME progress, but action is more important. for example, in-progress tells the
> user its being worked on. merge/release tbh doesnt matter THAT much, but release tells user it can be tested. and
> closed keeps the board lean.

So every template, every proposal and every lane a ferret adds follows it:

- **No lane waits on the owner.** Plan/Design and Released are where the work is; the owner's OK to build and Done /
  Not good are [card asks](#cards-show-progress-their-asks-ride-the-agenda) on the card's agenda. A `verify` lane still
  stores `emphasis: action`, only as the mirror an app that predates card asks requires.
- **One lane that says work is moving.** In progress. Review and CI fold into it: they are the ferret's to finish,
  not the owner's to act on. A separate review lane is only for a project where the OWNER reviews (the `writing`
  template's Review). These are `emphasis: progress` lanes, drawn as ordinary lanes.
- **Information only where it costs nothing.** Merged is kept as a compact, de-emphasised lane (`emphasis: info`).
  A release is what the owner can try, so Released is one lane, never two.
- **Closed keeps the board lean.** It is hidden from the Kanban (`emphasis: info`), and only the owner's Done
  enters it. The one exception is a [sub-card, which closes itself](#sub-cards-close-themselves).
- **No lane the workflow does not need.** A ferret proposing lanes starts from a template and renames; it does not
  add lanes.

This section is the one owner of the rule; templates and the lane editor implement it.

## Lanes and categories

A project's lane set is a list of lanes plus, per workflow, which of them a card walks. A lane is a name the owner
can change; its **category** is one of six fixed values that the rest of the system reasons about.

| Category  | Means                                             |
| --------- | ------------------------------------------------- |
| `backlog` | not started                                       |
| `active`  | a ferret is planning or building it               |
| `review`  | built, waiting on review and CI                   |
| `shipped` | merged or released, not yet confirmed done        |
| `verify`  | waiting for the owner to try it                   |
| `closed`  | done; the owner closes (a sub-card closes itself) |

Each lane has an `id`, a `name`, a `category`, and optionally:

| Field        | Meaning                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enterOn`    | triggers that move a card here ([the table](#workflows-gate-and-automatic-stages)): `work.started`, `pr.opened`, `pr.ready`, `ci.green`, `pr.review_approved`, `pr.merged`, `release.published`, `release.running`, `signal.done`, `deploy.done`                                                                                                            |
| `stage`      | the lane's stage in the workflow: a gate the owner answers, or automatic ([Workflows](#workflows-gate-and-automatic-stages)); absent, it is read from `enterOn` and `ownerGate`                                                                                                                                                                             |
| `ownerGate`  | only the owner moves a card into this lane (`owner-gate` for a ferret)                                                                                                                                                                                                                                                                                      |
| `staleAfter` | how long a card may sit untouched here before it counts as stale                                                                                                                                                                                                                                                                                            |
| `emphasis`   | how the Board draws it: `action` (the owner acts here: prominent), `progress` (work moving: ordinary) or `info` (information only: compact). Absent, it follows the category: `verify` and an owner-gated lane are `action`, `shipped` and `closed` are `info`, the rest `progress`. A `verify` lane is always `action` and the `closed` lane always `info` |

A lane set also names the two lanes the owner's verdicts send a card to: **`doneLane`**, where Done (or Works)
moves it, which is the set's `closed` lane, and **`notGoodLane`**, where Not good sends it back, which is an
`active` lane where work resumes (In progress, Fix, Draft, Doing; a backlog lane only in a set with no active lane).
Templates declare both, the Kanban, the Table and the card detail all read them, and a set stored before they
existed reads with them derived: the closed lane, and the last active lane. An edit that names neither keeps the
set's own while those lanes are still there, so an app that predates them never resets them.

**Templates.** A ferret proposes a lane set from a template, then renames lanes if the project calls for it
(`packages/protocol/src/lib/board-lanes.ts`). Each is built by [the lane design rule](#the-lane-design-rule):

| Template            | Lanes                                                    | Done → / Not good →    |
| ------------------- | -------------------------------------------------------- | ---------------------- |
| `pr-release-verify` | Todo, Plan/Design, In progress, Merged, Released, Closed | Closed / In progress   |
| `pr-release`        | Todo, Plan/Design, In progress, Merged; Released closes  | Released / In progress |
| `pr`                | Todo, Plan/Design, In progress; Merged closes            | Merged / In progress   |
| `ops`               | Todo, Investigate, Fix, Verify, Closed                   | Closed / Fix           |
| `writing`           | Todo, Research, Draft, Review, Published, Closed         | Closed / Draft         |
| `quick`             | Todo, Doing, Ready to try, Closed                        | Closed / Doing         |

In the PR templates In progress keeps its old id `implement` and is entered on `work.started`, `pr.opened` and
`pr.ready`; Released (id `released`, category `verify`, owner-gated) is entered on `release.published`, its agenda
asks Done / Not good, and the owner's Done moves it on. A card that signals done with no PR goes to Released for the
owner to check. In `quick` (the Unfiled board's lanes) Ready to try (id `to-test`, category `verify`, owner-gated) is entered on
`pr.merged`, `release.published` and `signal.done`: quick work has no release step, so a merge is what the owner
tries, and only the owner's Done closes. No shipped template uses `release.running`; it stays a trigger for a
hand-made set.

**`fy signal done` with no PR** moves a card still in an active lane to the lane its variant enters on `signal.done`,
else the first review or verify lane ahead: a review lane where one comes first (today's behaviour on a board that
has one), else the verify lane where the owner tries it. It never moves a card into a closed lane, because only the
owner closes, never out of a gate, and stops at a gate on the way. A card with an OPEN PR goes to the review lane and waits there until the PR merges (never closed, never past it); one whose PR merged is left to its PR.

**A session starting on a card fires `work.started`.** `SessionCards` does it, for a card it just made (`fy new`,
`fy start`) and for one handed over by `fy new --card`, so a sub-ferret, who may not move cards, still lands in the
lane its workflow works in (In progress / Doing; Plan for `design-first`). A card already past that lane stays
where it is, and a failed move only warns: the session still starts. A card the lead makes with `fy task create`
has no session yet, so it stays in Todo until the lead passes `--lane` or moves it.

**Which lane, by what the work is.** `fy board lanes show`, and the refusal of `fy card move` to a lane the board lacks, give the rule by lane category,
and `lanes show` adds a "use when" per lane (`laneUse`, single-sourced in `@ferretry/protocol`): planning or designing
in the planning lane, building in the active lane, a PR, a merge, a release and
`fy signal done` move a card by themselves, and blocked is not a lane (`fy card block`, `depend`).

A card's **workflow** (`quick`, `design-first`, `research-first`, `investigate`) selects its variant of the lane
set and cannot change after creation. In the PR templates only `design-first` and `research-first` work walks
Plan/Design.

**Released and To test became one lane.** Boards stored before board v3 had a `shipped` Released lane and a
`verify` To test lane after it, entered when this machine ran the release. At every boot the daemon folds any set
that still has that pair into one Released lane (`mergeReleaseLanes`): the Released lane's id and place,
category `verify`, entered on release, gated as To test was. The cards of both end up in it, each moved card's
history says "Released and To test are one lane now: Released", the set's version rises, its confirmation
stands, and the owner is asked nothing. It is idempotent. Nothing else on an existing board changes: Review/CI
stays a lane there until the owner edits it out.

**Quick lanes gained To test.** A `quick` set stored before it (Todo → Doing → Closed, closing on `signal.done`) had
nowhere for a merged card to go: facts never enter Closed, so a card whose PRs all merged sat in Doing. At every boot
the daemon gives such a set its To test lane between Doing and Closed (`addQuickToTestLane`): every lane keeps its
id, name and place, Closed becomes owner-gated and is no longer entered on `signal.done`, every variant walks To test
where it walked Doing or Closed, the version rises, the confirmation stands and the owner is asked nothing. No card
moves in the migration itself; the cards whose PRs merged then move to To test on their facts, each with its own
history ("PR #985 merged"). It is idempotent. The Unfiled board with no stored set reads the new template directly.

A FIRST proposal, on a project with no lanes, is live at once but unconfirmed. The owner gets one agenda choice,
Accept or Edit ([agenda.md](agenda.md)); accepting confirms the set. Any later change a ferret makes waits for the
owner instead ([below](#a-ferrets-lane-change-waits-for-the-owner)). Edits are version-checked (a stale edit is a
`version-conflict`), and a lane cannot be removed without naming where its cards go. A project with no lane set
gets an inferred proposal: a repository with `v*` tags gets `pr-release-verify`, one
without gets `pr`, a folder with no repository gets `quick`.

### A ferret's lane change waits for the owner

Lanes are where the owner's gates live, so changing them is the owner's to decide. **A ferret's `propose` or
`edit` of a project that already HAS lanes never goes live.** The daemon stores it beside the live set as the
set's `pending` proposal (`LaneSet.pending`, `decideLaneChange` in
`packages/daemon/src/lib/board-projects/lane-set-policy.ts`), and the live set stays in force: no gate changes, no
card moves, nothing the board decides is different. A ferret could otherwise make Plan/Design or Released
an automatic step and watch its card move on, or remove Released with its cards sent to Closed.

- **What the owner sees.** One Accept / Edit choice on the proposing ferret's agenda, "Lanes for <project>: A →
  B → …", which says the board keeps its lanes until the owner accepts and names EVERYTHING the change would do
  that is the owner's to decide (`laneGateProblems`, `@ferretry/protocol`): each lane it removes and where that
  lane's cards go — into the closed lane (named by its category, never by a name the proposal gives it), into a
  lane that is new, or past a gate — each gate it makes automatic or whose `ownerGate` it drops, each answer of a
  gate that would send cards somewhere else (resolved per workflow, so a reorder that moves where `next` goes counts:
  "changes where "OK to build" on Plan/Design sends cards: In progress → the closed lane, which closes them"), is
  removed or is added, each lane it makes the closed lane and the closed lane it makes an open one (reopening its
  cards), and each gate workflows would skip or reach from a different place (one line per gate). A warning is never
  cut short: the proposer's name is capped, and when some do not fit on the card they are counted and the card has
  no Accept (Edit or Later): a change the owner has not read in full is accepted only in the lane editor. `fy board lanes show` adds one line, "Proposed by <ferret>, waiting for the owner",
  and the lane editor a banner with the same warnings, in the same words; when there are any, its Accept takes a
  second tap ("Accept these changes"), saying that cards move and may close.
- **Accept makes it live, as the owner.** The owner's Accept on that card (only a person's answer counts: a lead
  may answer the daemon's items on its sub-ferret's agenda, and the daemon its own, but neither accepts lanes), or a
  `confirm` of the proposal's version from the lane editor, makes the proposal the live set, confirmed, and only
  THEN moves the cards of the lanes it removes. Those moves are recorded as the owner's, so they may close a card.
- **One proposal waits at a time, and it is its proposer's.** Only the ferret that made it (`proposerSession`), a
  lead above that ferret, or the owner replaces it; any other ferret is refused `proposal-waiting` (409), naming
  whose it is. Every proposal is numbered above the live set and every earlier proposal, so an older card never
  names a newer one. A proposal also carries the live version it was made against: once the live set moves on,
  accepting it is a `version-conflict`.
- **A card goes when its proposal does.** A proposal replaced by a newer one, accepted in the lane editor, or
  dropped (the owner's own edit, a boot migration) has its card closed on the proposer's agenda with the reason
  ("A newer proposal replaced this one; its own card is on the agenda."), so the owner never answers a card that
  would do nothing.
- **The owner's own edit stays immediate** and drops a waiting proposal. The owner confirming the live set itself
  leaves the proposal waiting, for its own answer.
- **The closed lane is last.** Every layout a change submits, and every waiting proposal, keeps the closed lane as
  the last lane of the set (and so of every workflow): nothing comes after done, so no answer's `next` can close a
  card. A set stored before keeps reading as it was.
- **A ferret's propose on unconfirmed lanes** waits too, and is refused `relocation-missing` when the template
  drops a lane: a template cannot say where that lane's cards go, so the ferret edits instead. Once the owner has
  confirmed a set, `propose` is refused `already-confirmed` as before.
- **Nothing flips at boot.** A set a ferret proposed before this, unconfirmed and live, stays live; only a change
  made from now on waits. A boot migration that rewrites a set's lanes (the release merge, quick's To test) drops a
  waiting proposal, since it was made against the lanes before.

**No relocation but the owner's closes a card or passes a gate.** Every move of a removed lane's cards runs the
checks an owner-less move does (`relocationProblems`): a relocation that is not the owner's never puts a card in
a closed lane, never takes it forward out of a gate (even into another gate: that skips the owner's answer) and
never carries it forward past one, nor into a lane the set lacks; a move back is allowed. A ferret's change moves
no card at all (it waits, or it is a first proposal on a board with no cards), a boot migration that would need
such a move is reported and left undone, and `BoardService.relocate` runs the same checks itself on every move
that is not the owner's, judged from the lanes the cards were in: a card it may not move stays put, and the
diagnostics say why.

## Workflows: gate and automatic stages

A project's lanes are its workflow, and each lane is one **stage** of it, of one of two kinds:

- A **gate** asks the owner. It has one to three options, and each option has an outcome: `next` (the next lane of
  the card's variant), `lane` (a lane of the set, by id), `reopen-with-agenda` (back to the set's `notGoodLane`,
  with the owner's words, which a conversation about them follows) or `close` (the set's `doneLane`). The Inbox
  draws the options as →, ← and a button, so their ids are unique, at most one reopens with an agenda conversation,
  and a label is one line of at most 24 characters. A gate lane is still entered the way any lane is, on its
  `enterOn` triggers: its stage says how a card leaves it.
- An **automatic** stage moves a card in on its triggers. With none, the ferret moves it there.

Ferretry's own workflow is build → merge → release → **try it** (Done / Not good). A labelling project's is prepare
the PRs → **send for review?** → wait for approval (`pr.review_approved`) → merge and deploy (`deploy.done`) →
**confirm deployed?**. Raising one agenda item when a card reaches a gate, and answering it, is work in flight
([below](#gaps-and-work-in-flight)); this section is the model it is built on.

**A stage is optional, and `enterOn` and `ownerGate` stay its compatibility mirror.** `stage` is optional on the
wire and in storage. A lane without one reads the stage its other fields describe (`laneStage`, in
`@ferretry/protocol`, pure and total):

| A lane with no `stage`                        | Reads as                                                          |
| --------------------------------------------- | ----------------------------------------------------------------- |
| a `verify` lane, owner-gated or not           | a gate: Done (`close`), Not good (`reopen-with-agenda`)           |
| any other owner-gated lane but the closed one | a gate: OK to build (`next`), as Plan/Design                      |
| the `closed` lane                             | automatic on its own `enterOn`; only the owner enters a gated one |
| anything else                                 | automatic on its `enterOn`, or on nothing when it has none        |

A lane that states a stage keeps its mirror agreeing with it, settled where a lane is parsed (`LaneSchema`), so
either spelling round-trips. A gate is owner-gated: a lane that leaves `ownerGate` out gets `true` (a `verify` lane is
the owner's by its category, so its `ownerGate` is left as it is). An automatic stage enters on its triggers: a lane
that leaves `enterOn` out gets them. A field that disagrees is refused: a gate on the closed lane, a gate with
`ownerGate: false`, an automatic stage whose triggers are not its `enterOn`, an automatic lane that is owner-gated. So
an app that predates stages reads every lane right, and the helpers that read the mirror (`laneForTrigger`,
`laneUse`) answer as they did. `needsOwner` reads the stage as well as `ownerGate`: a move forward out of any gate
is the owner's, so a ferret's move out of a `verify` lane is refused `owner-gate` even where the lane is not
owner-gated (before stages it went through), and a move and a report agree on every gate. An app that predates stages drops the field when it saves a set,
and the lanes then read their derived stages again: only options the owner had changed are lost.

**The lane editor sets the stage.** Each lane row (the closed lane excepted, which only the owner moves cards into)
has a segmented switch, **Gate** or **Automatic**. A gate shows its options, one to three: a label of at most 24
characters and where it sends the card (the next lane, a named lane, **Not good** (reopen and talk, at most one per
gate) or **Close**). Switching a lane to Gate starts from `PLAN_GATE`, or `VERIFY_GATE` on a `verify` lane, and sets
`ownerGate`; switching back to Automatic clears it. An automatic lane shows its trigger chips, and the two that
nothing watches (`pr.review_approved`, `deploy.done`) are marked "reported with fy task trigger". The editor sends
the `stage` it drew with the lane and lets the protocol normalise the mirrors. It drops a lane's stored stage when its
category changes, so a saved lane is never refused for a stage its fields no longer describe.

`gateOptions(lane)` lists a lane's options, none for an automatic stage. `gateOutcomeLane(laneSet, workflow,
laneId, optionId)` says where an option sends a card: `{ option, lane }`, or `not-a-gate`, `unknown-option`,
`no-next-lane` (a `next` from the variant's last lane) or `unknown-lane`. Who may answer a gate is the daemon's to
decide, not this function's.

**Triggers.** What moves a card into a lane by itself. Most are facts Ferretry sees; the **external** ones happen
where it cannot look, and somebody reports them (`EXTERNAL_LANE_TRIGGERS`).

| Trigger              | When                             | Who knows                                                                       |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `work.started`       | a session starts on the card     | the daemon                                                                      |
| `pr.opened`          | a linked PR opens                | the GitHub watcher                                                              |
| `pr.ready`           | it is out of draft               | the watcher                                                                     |
| `ci.green`           | its checks pass                  | the watcher                                                                     |
| `pr.review_approved` | a reviewer approves it           | **reported**: the watcher reads a PR's state, checks and merge, not its reviews |
| `pr.merged`          | it merges                        | the watcher                                                                     |
| `release.published`  | a release contains its merge     | the watcher                                                                     |
| `release.running`    | this machine runs that release   | the daemon                                                                      |
| `signal.done`        | the ferret runs `fy signal done` | the daemon                                                                      |
| `deploy.done`        | a deploy finished                | **reported**: it happens where Ferretry does not run                            |

**Reporting an external trigger.** `POST /v1/board/tasks/:taskId` with
`{ "action": "trigger", "event": "deploy.done", "reason": "deployed to production" }` (`reason` optional). Only an
external trigger is taken: any other is `400 invalid` before it reaches the board, because a merge or a release is
read from GitHub, never taken on a caller's word. The owner, the card's owner ferret, its leads and its assignee may
report one, and so may a sub-ferret on the card it is doing, since it is the one that saw the deploy; anyone else is
`403 forbidden`. The move is the daemon's, through the same `triggerMove` every fact uses: into the first lane of
the card's variant that enters on the trigger, recorded `auto` with the trigger and with `reportedBy` naming who
reported it (an owner on the admin token is `{ kind: "owner", via: "admin-token" }`). It never goes back: a
card already there or past it is unchanged, and the answer is the card as it is. A dependency holds it as it holds a
move: a blocked card is not moved on to a later category (`409 blocked-by`, naming the blockers); sideways it moves,
and says what blocked it, and the owner's report moves it on as a fact would. A sub-ferret reports only on the card it
is doing (its assignee, else its owner): on any other card its standing reaches it is told to tell its lead. In the
card's history the move reads as by whoever reported it, never as Ferretry's own ("denisha · reported deploy.done →
moved In progress → Deployed"; the admin token is said for what it is), in the app and in `fy task show` alike
(`boardEventActor`). It is `400 invalid` for a dropped card or a board with no lane for the event. It is
`403 owner-gate` for a move into an owner-gated closed lane, whoever reports it, and, unless the owner is the one
reporting, for a move into any closed lane (a fact may close a set with no verify lane, a caller's word may not) or
past a gate the owner has not answered: the card's own lane, or one its variant walks between that lane and the
target. Entering a gate is not passing it.

So a report never takes a card anywhere the owner decides. A report after the owner's Not good may move the card on
again, and that is accepted: with every gate, every closed lane and every unshipped dependency out of its reach, it
only reaches a lane its lead could `fy task move` it to anyway, and the history says who reported what.

**Every lane's stage is written out at boot.** Every template lane states its stage. A set stored before stages has
none, so at every boot, after the two migrations above, the daemon gives each lane without one the stage it already
reads as (`stageLanes`): nothing a reader decides changes and no card moves, a lane that has a stage keeps it, the
confirmation stands and the owner is asked nothing. The VERSION STAYS, unlike the migrations above, because the set
means what it meant: an edit made against it still applies, and the Accept on a pending proposal's card still
confirms it. A damaged set is refused by the store, as on any read, reported, and the other projects go on, and a
staged set the next read would refuse is never written. It is idempotent: a set whose every lane has a stage does
not match.

## Cards and their fields

A card is stored as `BoardTaskSchema` (version 1) at `<state>/board/tasks/<id>.json`; the counters are in
`<state>/board/counters.json` and the lane sets under `<home>/board/lanes`. Reads return the **view**, the stored
fields plus the ones the daemon derives.

| Field                   | Meaning                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `id`, `kind`            | `<B\|F\|I\|C><n>`; the kind is fixed because the prefix must match it            |
| `projectId`, `laneId`   | the board and the lane the card is on                                            |
| `title`, `summary`      | a short name, and the one line the card face shows                               |
| `ask`, `clarifications` | the owner's words verbatim and where they were said; later words are appended    |
| `premise`, `context`    | why the work exists; what a newcomer needs to know                               |
| `terms`, `brief`        | glossary entries for the card; the full plan, or a sub-ferret's brief            |
| `howToTest`             | how the owner checks the result before Done; empty on a card stored before it    |
| `status`                | the card's current state `{ now, doneSoFar, next }`, or absent; see below        |
| `owner`, `assignee`     | the accountable ferret; the one doing it now (none reads as the owner)           |
| `parent`                | the lead's card, possibly on another project's board; the roll-up follows it     |
| `visibility`            | `public` or `private`; see [Public and private cards](#public-and-private-cards) |
| `dependsOn`             | cards this one waits on, each with an `until`                                    |
| `blocked`               | an external block with its reason, or none                                       |
| `dropped`               | why the card was dropped, or none                                                |
| `workflow`              | selects the lane variant; immutable                                              |
| `links`                 | PRs, branches, commits and documents                                             |
| `files`                 | advisory: the files or folders the work expects to touch; a clash queues it      |
| `order`                 | the owner's manual order within a lane                                           |
| `history`               | every move and note, each with who and why; at least one event                   |
| `legacyRef`             | `<sessionId>:<oldId>` for a card imported from the old per-session files         |

The view adds fields that are never stored:

| Field                        | Meaning                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `lastTouchedAt`, `touchedBy` | the latest real activity on the card or any descendant             |
| `activity`                   | `active`, `idle`, `stale` or `orphaned` (see below)                |
| `rollup`                     | a parent's children counted by category, and how many are working  |
| `suggestedLane`              | the lane the children suggest moving a parent to                   |
| `openAsks`                   | the open agendas that carry the card (`waitingOnOwner`: always []) |
| `blockedBy`, `blocks`        | dependencies not yet done; the cards that depend on this one       |
| `shippedIn`                  | the earliest release a merged PR of the card shipped in            |
| `origin`                     | `human` (the owner asked for it) or `agent`; see below             |
| `humanParent`                | the nearest ancestor card whose origin is `human`, or none         |

A card is referenced as `&F412`, an agenda item as `!A48`. The retired `#F12` is still accepted as input, and
never printed ([reference-standard.md](reference-standard.md)).

### Patch: a card as one document

The owner: _"can you make it such that they modify agendas and tasks as YAML or JSON as patched?"_ (&F957), and
_"we need to read to know what needs to be updated, else there might be many segments that might be outdated!"_. A
card's words are one document, so a ferret reads it whole, updates every part that is out of date, and writes it back
in one go:

```sh
fy task show F12 --yaml > f12.yaml   # the editable document, with the card's revision
$EDITOR f12.yaml
fy task patch F12 --file f12.yaml    # one atomic edit; --file - reads stdin; JSON works too
```

- **READ BEFORE WRITE: the revision is required.** `show --yaml` prints `revision:` — the seq of the card's newest
  history event (`boardTaskRevision`). Every change to a card appends an event, so anybody's write moves it on. A
  patch without it is refused before anything is sent; one whose revision is not the card's is refused
  `version-conflict` — by the CLI against the card it just read, and by the daemon inside the card's write, so a
  change in between is never overwritten unseen. Read it again, update, patch it back. It needs a daemon that
  reports `board.patch.1`; an older one refuses the field as malformed (`fy daemon update`).
- **The document**: `revision`, `title`, `summary`, `premise`, `context`, `terms` (a list of `{ term, meaning }`),
  `brief`, `howToTest`, `visibility` and the card's **Status** (`status: { now, doneSoFar, next }`, Markdown each,
  &C48) — the fields `fy task edit` changes. `show --yaml` prints the status whole when the card has one.
- **Semantics: JSON Merge Patch (RFC 7386)**, as on the agenda
  ([agenda.md § Patch](agenda.md#patch-the-item-as-one-document)): a key present replaces the field, an absent key
  leaves it, `null` empties it; lists (`terms`, a point list) are replaced whole. `status` is the one object that
  merges by key: `status: { now: … }` rewrites Now and keeps the rest, `""` empties a part, and only the parts that
  differ are sent — the daemon merges them inside the card's write, so two ferrets rewriting different parts never
  undo each other. `status: null` is refused.
- **`null` empties** `premise`, `context`, `terms`, `brief` and `howToTest`. `title` and `summary` are never removed,
  only rewritten, and `visibility` is `public` or `private`.
- **One patch is one `edit` action** on `POST /v1/board/tasks/:taskId`: the CLI parses the document with zod
  (`BoardTaskPatchSchema` in the protocol), drops values equal to the card's, and sends the rest with the revision as
  ONE edit — the same validation, title check and governance as `fy task edit`. Who may change which field is the
  daemon's decision on that action, so a per-field rule there (a card's holder, a sub-ferret included, changing only
  `status` and `howToTest` on its own card, &C48) binds a patch exactly as it binds `edit`. A document written back
  unchanged sends nothing.
- **What stays fixed**: the ask and its clarifications (the owner's words), the lane, links, files, dependencies,
  history, owner and assignee — each changed by its own verb with its own rules (`move`, `link`, `depend`,
  `assign`…), never by a patch. They are refused here by name, as is any unknown key, and every problem is said per
  field. The document has no token or credential field.

## How a card reads

Every text a ferret writes on a card — `summary`, `status`, `premise`, `context`, `brief` and `howToTest` — is Markdown,
drawn by the chat's one renderer (`ChatProse`), so `fy-render` hypermedia (mermaid, svg, html, chart, image…) draws
exactly as in a message or an agenda card ([fy-render.md](fy-render.md)), and references are read through the one
grammar and its proof-before-link gate ([reference-standard.md](reference-standard.md)). The card detail reads top to bottom
as an agenda card does, with nothing folded:

1. the title, with the **summary** as one line under it, then the **Status** ([The card's Status](#the-cards-status)) when
   it has one;
2. **premise** and **context** as two soft tinted blocks, each label above its points (the agenda card's own
   `Situation` and tokens); a repeated `--premise` / `--context` is one bullet each;
3. the owner's **ask**, verbatim, with its clarifications (the ask, clarifications, history notes and terms are Markdown too);
4. **How to test**: a list is drawn as numbered steps, each with a box the owner ticks as they go (on that screen
   only — a tick is a reminder, never a verdict). Steps keep the number they were written with (a list that
   starts at 4 reads 4, 5, 6); a heading or a paragraph set apart between steps is a sub-heading above the steps
   that follow, and text before the first step is the lead. The card draws no answer of its own: a card waiting to
   be tested is answered on its agenda ([Done and Not good](#done-and-not-good));
5. the **brief**, then the **terms** — and each term is also a dotted tap tip where the card's text first uses it.

A good How to test says where to go, what to do and what the owner should see, on which machine and version:

```markdown
On the Mac, once it runs v4.157:

1. Open the Inbox and tap the card's "Try it" ask.
2. Follow How to test, and tick each step as you check it.
3. You should see Done and Not good right under the steps.
```

The kanban card face shows the summary as one truncated line under the title (not in the side pane, which keeps
one short line), a small **How to test** marker when the card has one, and a quiet **no test steps** on a card in a
`verify` lane that has none, so a missing one stands out to the lead.

`fy task create` and `fy task edit` take `--how-to-test <md>` or `--how-to-test-file <path>`; any ferret that may
edit the card may write it (it is not a re-plan), and so may a sub-ferret on the card it holds, as it writes the
card's `status` ([The card's Status](#the-cards-status)).

## The card's Status

The owner (2026-11-04): _"card content should have well formatted status updates too -- what is happening to the card,
what has been implemented. sub-ferrets and ferrets should update them!"_ A card's notes are its history, appended one
line at a time, so the latest state is scattered across them. **`status` is the card's current state, in one place,
kept current** — the card's answer to "what's the sitrep?".

**Its shape is fixed: three parts**, so every card reads the same and every surface draws it the same way. On the wire
`status` is an object, each part Markdown (`MAX_BOARD_STATUS_PART_LENGTH` each); all three are required strings and
`''` is allowed; the whole field **absent** means the card has no status yet (every card stored before it existed):

| Part        | Holds                                                              |
| ----------- | ------------------------------------------------------------------ |
| `now`       | what is happening on the card at this moment, one or two lines     |
| `doneSoFar` | what is implemented, one bullet each, with the PR link where there |
| `next`      | what comes after, in order                                         |

```yaml
status:
  now: Writing the daemon route; the protocol field is in.
  doneSoFar: |
    - Protocol field `status` (https://github.com/kirinnee/ferretry/pull/321)
    - Design in docs/board.md
  next: |
    1. CLI `fy task edit --status-now`.
    2. PWA card view.
```

**Read it whole, then rewrite what is stale.** It is an ordinary editable field (`BoardEditableField` `status`).
An edit names **the parts it replaces** (`status: { now }`, or all three); each part it leaves out keeps the card's,
and a card with no status yet starts from empty parts. **The daemon merges the parts in the card's own write**, so a
holder rewriting Now while its lead rewrites Done so far never undoes the other. `fy task edit <id>` takes
`--status-now <md>`, `--status-done <md>` and `--status-next <md>`, each sending that one part, and
`--status-file <path>` with all three as YAML or JSON (`-` reads stdin; a part the file leaves out is empty, and a flag
beside it replaces its part). At each step the ferret reads the card (`fy task show <id>`) and rewrites every part
that is out of date, the title and summary included, so nothing on the card is stale. The edit records a
`field-edited` event naming `status`, never its text — the history says when it changed, and `status` says what it
is. A part is cleared by writing it empty (`--status-next ""`); the field itself is never removed. Notes stay the
history: `fy task note` is still how a ferret records a step, a finding or a decision as it happens.

**Who writes it.** The card's ferrets, at each step that changes the answer: the lead on its own cards, and **the
card's current holder** (assignee, else owner) — a sub-ferret included — on its own card. A sub-ferret's edit may name
only `status` and `howToTest` ([Sub-ferrets](#sub-ferrets-no-moves-only-reports)); any other field in the same edit is
refused whole, as before. The daemon never writes it: a daemon-made lane move, a PR fact or a release leaves `status`
alone, because only the ferret knows what the work is doing; the lane already says where it is.

**Where it reads.**

- The card detail draws it **first**, right under the title and the summary, under the label **Status**: **Now**,
  **Done so far** and **Next**, each drawn only when it has words ([How a card reads](#how-a-card-reads)). A card with
  no status draws nothing.
- `fy task show` prints it right after the header, before the ask, the same three labels.
- The work index reads it with the brief, so `fy search` finds a card by what it is doing now.
- A YAML or JSON patch of a card sends `status` parts by key (`now`, `doneSoFar`, `next`), merged as an edit's are;
  a part is cleared by writing it empty. A sub-ferret's patch follows the same holder rule.

## Public and private cards

**Public cards are the ones the owner asked for. Private cards are the ferrets' bookkeeping**, sub-cards and helper
cards included. The board shows public cards by default; the rest are one switch away. A public card stays linked
to its PRs and its approval exactly as any card is: visibility only decides whether the board lists it.

**How a ferret uses this.** The board has to answer the owner's "What's the current status of all the things I asked you to do?"
("what's the sitrep?"), and that question is how a ferret decides whether a card is public. A card for the owner's ask is
**top-level**: no `--parent`, no `--private`, because a sub-card is private and a ferret cannot make it public. `--parent` and
`--private` are for the ferret's own bookkeeping only. Related work is named in the card's `--context`, not by grouping the
asks under a parent. The Board prompt teaches it in one sentence, `fy task create --help` says it on `--parent` and in its rule,
and `fy task create --parent … --ask …` (without `--public`) prints one line: `this card will be private (a sub-card); drop --parent so the owner sees it`.

A card stores `visibility: public | private` and `visibilitySource: default | chosen`. A card stored before the field
reads through one pure, total function, `cardVisibility` (`packages/daemon/src/lib/board/visibility.ts`): **public** when
a person asked for it and it has no parent, **private** otherwise (an agent's card, a sub-card).

**A default is retryable; a choice is final.** `default` means the daemon derived it from the facts it had, `chosen`
means someone set it (`--private` / `--public` on create, `fy task edit --visibility`, the app). Boot stores the
default on every card whose asker is settled (`backfillVisibility`; idempotent, writes no history). A card whose asker
is still a guess (`backfillAskedBy` could not read the owner's words) is left alone for a later boot, and a stored
`default` is derived again whenever the asker is settled later, so a first-boot failure never freezes a person's ask
private. A `chosen` visibility is never touched by any of this. A new card gets the default unless the caller chose,
and is repaired the same way.

**A choice equal to the default is still a choice.** `fy task edit … --visibility private` on a card that already
reads private (nobody has chosen yet) records `chosen`, so a later repair of the default cannot turn it public; it is
refused as "already private" only once that choice is on the card. **A ferret's choice to hide a card is judged on
who asked for it, settled strictly:** on create (`--private`) and on edit, the daemon reads the owner's words again
and requires complete reads of the queue, send ledger, lineage and turn documents (including any author files).
An unreadable record answers unavailable and writes nothing. Strict reads bypass the turn cache, so an earlier
partial read cannot authorize hiding. Ordinary creates and boot backfills still use the readable records; the owner
is never held up by that lookup.

| Who                                             | May                                                                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| The owner                                       | set any card, public or private, including a sub-card public                                                    |
| A ferret that owns the card, or a lead above it | set a card an agent asked for, either way                                                                       |
| A ferret                                        | not make a card a person asked for private (it must never hide the owner's ask), and not make a sub-card public |
| Anyone else, a sub-ferret                       | change nothing                                                                                                  |

The daemon enforces this (`visibilityVerdict`) on create, on `fy task edit --visibility` and on a **reparent** (moving a
public top-level card under another makes it a sub-card, so a ferret is refused unless the owner does it; a ferret
cannot hide a person-asked card by moving it under another either), and answers `forbidden` with who could. A change
is recorded on the card as a note. `fy task edit --title … --visibility …` is **one** daemon mutation with one result:
the visibility rides in the edit action, so a refused or unsupported visibility (an older daemon rejects the unknown
field) leaves the text unedited. A caller off this host, a relayed phone included, is
never the owner on the strength of arriving at loopback: it is governed like any remote caller
([grants.md](grants.md)).

**What a reader sees.**

- `fy board` lists public cards. `--private` lists the private ones and `--all` both. A board scoped to one ferret
  (`--mine`, `--ferret`) is that ferret's own work, so it shows both kinds unless `--private` is given.
- `GET /v1/board` takes `visibility=public|private|all`. **Without it the daemon answers `all`**, so an app or
  script from before this change never loses a card. The CLI asks for `public` explicitly.
- The app asks for everything and hides private cards itself, so it keeps working on a daemon of any age. A card
  carries `visibility` on the wire when the daemon stores it; the app reads that, and for a daemon that predates the
  field falls back to the old ferret-card rule (`isFerretCard`).
- A daemon that serves the filter says so: `GET /v1/health` lists the feature `board.visibility.1`. The CLI reads
  the cards instead of the feature: if it asked for public cards and none of them declares a visibility, it prints
  that the daemon predates public and private cards, shows everything, and names `daemon update`.

**On the Board** (Kanban, List, Tree, Dependencies, Archive) public cards show by default and the **Show private**
toggle brings the rest back, each private card under its `humanParent` where it has one. On a desktop the toggle sits
in the filter bar; on a phone it is in the Filters sheet. The choice is remembered **per device** in
`localStorage` (`fy-board-private-v1`); storage that is missing or throws just means the default (off). The URL
parameter `agents` still overrides it for that view: `agents=1` shows private cards and `agents=0` hides them, so a
saved link keeps working. **Show private replaces the old "Ferret cards" filter**: same switch, same URL parameter,
now driven by the stored visibility. Choosing a ferret or an activity shows private cards, because a sub-ferret's own
card is a sub-card. While they are hidden, private cards are in no lane, overview or Home count.

**Known gap.** The admin token stands in for the owner, so a ferret that holds it could make a person-asked card
private. This is the same stand-in the rest of the board gives the admin token, and no other caller can do it.

## Human and agent cards

For an older daemon, a **ferret card** is one the daemon says is an agent's (`origin: agent`, and
`askedBy` is not `person`), or a sub-card that no person asked for. A top-level `origin: human` card stays on the board
even when `askedBy: agent`: no verbatim owner message matched its ask. The app reads that through one helper
(`taskAsker`), which goes by `askedBy` alone only for a daemon that sends no `origin`. A daemon that stores
`visibility` decides what is private by it; the rule above is what an older daemon leaves the app to use. `origin` is derived at read time by one pure rule, `cardOrigin` in
`packages/daemon/src/lib/board/origin.ts`, and never stored. A card is **human** when:

1. the owner made it (a paired device, the admin CLI; the Board page no longer has an "Add card", but a card an older
   app wrote carries the source `owner (board)`, which still counts);
2. its ask's source names the owner (`owner`, "owner via lead jaeda", "the owner (fy task reopen)"), whoever wrote
   it down; or
3. a ferret recorded it from a session the owner started: the source's `session:<id>`, else the recording ferret
   itself. Only the owner talks in such a session.

Everything else is **agent**: the card of a sub-ferret a lead started (`fy new`, or `fy start` from a ferret,
whose ask is `session:<lead>`), the daemon's own cards (the board import's untriaged asks), and a card a
sub-ferret recorded from its own brief. Whether a session was started by a ferret is its `config.parent`, read once
per session per board read; a session this daemon cannot read counts as the owner's, so a card is never hidden on
a guess.

**A `fy new` card is never the owner's ask.** A sub-ferret's brief is a ferret's words, so the card the daemon writes for it (the ask
source `session:<lead>`, or `fy new` when the boundary recorded no lead, which happens when the caller held the admin token and named
no session) is stored `askedBy: agent`, therefore private, and reads `origin: agent` whatever it quotes. That is a rule of `decideAskedBy`: a card the
daemon wrote for a session (`createdBy` is the daemon, with a session) is `person` only when its source names the owner, which only the
owner's own New session writes. Without it a brief that repeated the owner's message made the helper's card the owner's public ask
(&F1092), and the boot-time re-decision kept it so.

The rule cannot tell a top-level ferret's own idea from the owner's words in that ferret's chat; both read as
human, which errs toward showing the owner a card. Both fields are optional on the wire: a daemon older than the
split sends neither, and the app then shows every card and no toggle.

### Cards to test: a person asked

The Inbox's To test section and Answer quickly (on a machine without `agenda.card-asks.1`) list only the cards a PERSON asked
for, so the owner is not flooded with the follow-ups their ferrets file for themselves. That is `askedBy` on a card
(`person` or `agent`), and the card STORES it: the daemon decides it once, when it creates the card, and never from
the request (the create body has no such field, so a caller cannot claim it). `decideAskedBy` in `origin.ts` says
`person` when any of these holds:

1. the owner's own app made it (an owner caller that is not on the admin token, which a ferret can hold too);
2. the ask's source names the owner (`owner (board)`, "owner via lead jaeda");
   (A card the daemon wrote for a started session skips the next step: the ferret's brief proves nothing about the owner's words.)
3. the ask's text matches words the OWNER said to the session it came from (`wordsSessionOf`: the session id the
   source names, in any form — `session:<id>`, `session <id>`, a turn document's path — else the recording ferret),
   whoever wrote the card down: a ferret on the admin token is stored as `owner` and the board import as `daemon`.

Anything else is `agent`, including every card whose session is unknown. The owner's words
(`adapters/board/session-owner-words.ts`) come from three records of that session:

- its queue, in any delivery state, whose messages say who sent them;
- its send ledger (`channel/sends.jsonl`), which records every send's sender (`senderKind`, `by`) and the turn it
  started, back to before the queue existed;
- every turn document (`turns/turn-NNN.md`) no send accounts for — a revive's, or one older than the ledger. One with
  an author file (`turn-NNN.by.json`) is the owner's only when that file says so. The first turn of a session a ferret
  started is that ferret's brief and is left out.

A message with no recorded author is the owner's unless it is wrapped as a ferret's (`[message from ferret …`), less
any paragraph that is Ferretry's own notice (a board or Warden notice, "CI is red", "has had no activity", a turn-end
check): a busy session is handed those in the same delivery as the owner's next message. An agenda answer
(`[answer to !A…`, `[re !A…`) is the owner's. What was read is kept per session and read again only when the
turns directory changes, so a lead with thousands of turns is not re-read for every card.

Two texts match on their letters and digits alone (case, spaces and punctuation ignored, so a full stop joining two
lines or a mended "yo uhelp" still matches) when one contains the other and the shorter has at least 24 characters, or
when the ask is pieces of the owner's messages joined by `...`, `…` or `/`, each piece found in one of them and the
longest at least 24 characters. **A paraphrase does not match**: a ferret that rewrites the owner's ask in its own words
gets an `agent` card, which is still on the Board.

Every boot decides again each card not already `person` (`BoardService.backfillAskedBy`): a card from before the
field, and a card stored `agent` from fewer of the owner's words than are read now. It uses the same rule except that a
stored creator of `owner` proves nothing (it reads that way for a ferret on the admin token), so it is the source and
the owner's messages that decide. It only ever adds `person` — a stored `person` may rest on a fact it cannot see again
(the owner's own app made the card) — and writes only a card it changes. The pass writes no history event and does not
touch the card's last-touched time, is idempotent, and a card it cannot settle is reported and tried again next boot. A view reads the stored value,
and falls back to the ask's source (`cardAskedBy`) only for a card not yet backfilled. A daemon older than the field
sends nothing and the app reads that as `agent`. The cards left out are still on the Board, and each card shown names
its project beside its machine.

## Sub-cards close themselves

A **sub-card** is a card with a parent: a ferret made it under a bigger card for one piece of work (one PR, one review,
one fix round). The owner tests the PARENT and never the sub-card, so a sub-card never waits for the owner and never
sits in Released. `isSubCard` (protocol) is the one test: `parent !== null`. The daemon closes it, in three
places, and always as the daemon (`auto`, with the trigger that caused it):

| When                                                                               | Reason in history                               | Where it is decided                  |
| ---------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------ |
| its PR merged or released, no PR open: where a top-level card would go to be tried | `sub-card shipped; the parent carries the test` | `reconcileFacts` (every PR update)   |
| its ferret signals done (`fy signal done`) and it has no PR open or merged         | `helper finished`                               | `BoardService.signalDone`            |
| it was handed to another ferret that has ended (gone two minutes) and it has no PR | `helper finished`                               | the board sweep (`closeEndedHelper`) |

A sub-card with a PR still **open** stays open, whoever signals. A sub-card the lead keeps for itself (assigned to its
own owner) is bookkeeping, not a helper: the sweep never closes it. The close goes to the lane set's Done lane, else its
first `closed` lane, and is not a verdict: it records nothing for the owner and asks nothing of them. On boot the daemon
also closes the sub-cards that were already waiting in a verify lane from before this rule (`closeStrandedSubCards`,
idempotent).

**No card ask and no agenda item is ever raised for a sub-card** (`gateOf` returns nothing for one in a verify lane),
and a sub-card is never "awaiting the owner" in the app. The parent's roll-up (`rollup`) is unchanged by this: a closed
child counts under `closed`, so the parent still reads shipped, active or waiting from the children it has.

**On the Board** sub-cards are private (unless a person asked for them and the owner made one public): hidden by default, with the
**Show private** toggle to bring them back (URL `agents=1`; on a phone it is in the Filters sheet). Choosing a ferret
or an activity shows them, because a sub-ferret's own card is a sub-card. While hidden they are in no lane and in none of the header counts (Active,
Stale, Orphaned), so a count and its cards agree. They are always in the **parent's detail**, under
"Sub-cards", open or closed. The Archive follows the same filter; the ferret's own Tasks tab always lists its cards.

## A finished helper's card goes back to its lead

When the ferret a card is assigned to **ends** (it signalled done, was stopped, or completed) and the card is still open work, the daemon assigns the card back
to the nearest **live** ancestor of that ferret: the lead that started it, else that lead's lead, an ended one skipped. It happens as the daemon, on the board
sweep once the ferret has been gone the same two minutes a helper needs ([above](#sub-cards-close-themselves)), and the card's history reads
`returned to <lead>: <ferret> finished` (the `assigned` event carries `returnedFrom`). It is journalled and pushed like every other automatic move; nobody is
asked and nobody is messaged. The card stays in its lane: only its assignee changes, so the lead sees it on its own cards and decides.

The sub-card closes win, and the return takes what they leave:

| The card, when its ferret has ended                                  | What the daemon does                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| a sub-card handed to the ferret, no PR open or merged                | closes it: `helper finished` (the sweep, `closeEndedHelper`) |
| a sub-card whose PR merged or released                               | closes it: `sub-card shipped; the parent carries the test`   |
| a sub-card with a PR still **open**, in an active or review lane     | returns it to the nearest live lead                          |
| a top-level card a sub-ferret owns or was assigned, active or review | returns it to the nearest live lead                          |
| any card in a backlog, shipped, verify or closed lane, or dropped    | nothing: not work in flight                                  |
| no ancestor of the ferret is alive                                   | nothing: the card is **orphaned** and the Warden says so     |

A lead's own bookkeeping sub-card (assigned to its owner) is never closed or returned by this, and neither is a sub-card whose helper has no PR (it closes instead). The check runs again inside the card's write, against the stored card and a fresh read of the sessions the return rests on: if the ended ferret came back, the chosen lead ended or a nearer one is alive, the card moved, was reassigned, dropped or closed, or its PR closed so that the helper-finished close now applies, the return is declined and the next sweep plans or closes it afresh. The orphan alert ([Activity](#activity-and-staleness),
[who a board alert is for](#who-a-board-alert-is-for)) therefore fires only when nobody above the ended ferret is alive to take the card back.

**The return is atomic with the sessions it rests on.** A return rests on three facts about sessions: the ferret has ended, each ended session between it and the lead is still ended, and the lead is alive. The sweep names that line of sessions (the ferret, the ones above it, the lead; `lineageThrough`) and the commit takes the serial lane of every one of them at once (`DaemonStorage.holdSessions`, one claim of all the keys, so two holds cannot wait on each other and a queued exclusive pass cannot wait on a hold that waits on it). Only after the hold is taken are those sessions read again, from the files, and only those, never the fleet; the decision is made on that read and the card is written while the hold is still taken. The lane is the one every write of a session's status goes through (a stop, a completion, a resume, the pane's exit, a turn change), so such a write either landed before the read, and the return declines or follows the lead up, or it waits for the card to land and the return is ordered BEFORE it. Nothing is handed to an ended or unrelated session on any interleaving of those. The journal and the notices of the move run after the hold is released. The sweep's earlier whole-fleet roster only plans; it never decides.

Declared GAPs of the return's atomicity:

- **A transition decided but not yet written is ordered after the return.** A stop that has killed the pane and not yet recorded `stopped` still reads as alive, so the card can reach a lead a moment before its end lands. The lead's end then makes the card the lead's ended card, and the next sweep returns it one lead further up; the card is never lost, and never handed to somebody that had already ended when it was written.
- **Only writes through the daemon take the lane.** A hand edit of a session's state document, or a session ended by the host outside the daemon's knowledge, is seen by the next read and not held back.
- **A card written by something other than the sweep is not covered.** A lead's own `fy task assign` runs under the card's lock only; whether the person it names is alive is a fact of that request, not of this guarantee.

## Authority

Who may write a card follows from the card itself and from the lineage of the session asking; there are no roles to
grant. This replaced the old `task-boards` access list. The code is `packages/daemon/src/lib/board/authority.ts`.

| Standing        | Who                                                               | May                                                                                                                             |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `owner-human`   | the owner: loopback, or a device the `fleet` grant let in         | everything, including owner gates and dependency overrides                                                                      |
|                 | (on the admin token it is recorded as `admin-token`)              |                                                                                                                                 |
| `owner`         | the card's owner ferret                                           | the assignee's writes, plus re-plan                                                                                             |
|                 |                                                                   | and, on an INTERNAL card, passing its gates                                                                                     |
| `ancestor`      | a ferret above the card's OWNER in the `parent` chain of sessions | the same as the owner                                                                                                           |
| `assignee-lead` | a ferret above the card's ASSIGNEE, but not above its owner       | drop and reassign the card, nothing else: never a gate, a close or a re-plan                                                    |
| `assignee`      | the ferret doing it                                               | move, note, link, block, edit files, clarify, reopen, report an external trigger                                                |
| `daemon`        | the daemon's own automation                                       | trigger moves, link cache, refile, note (a withheld alert on a public ancestor), relocate a removed lane's cards (never closed) |
| `reader`        | any other ferret                                                  | read; depend, but only from its own card                                                                                        |

**A lead plans its whole subtree.** A card is in a ferret's subtree when the ferret asking owns it, or started, directly or through a chain of leads, the card's owner or its assignee (a returned card, owned and held by a middle lead, is still in that lead's subtree). So a lead may drop or assign a card owned by its grandchild, and one assigned to a descendant but owned by another party (a card its subtree was
handed), as an `assignee-lead`. That reach stops at drop and reassign: the owner ferret's gates and its re-plan belong to the owner's own lineage (`ancestor`), so a lead that only reaches a card through its assignee cannot pass or close an internal card owned by somebody else. A card outside the subtree is a `reader`'s: a sideways sibling, a cousin or a stranger can plan nothing there. This holds for a sub-ferret that leads a
subtree of its own too: the sub-ferret limit refuses its `drop` and `assign` only outside its subtree.

### Claiming a card your lead holds

`fy task claim <id>` is the reverse of handing down: a ferret takes the assignment of a card whose **current holder** (its
assignee, else its owner) is one of the claimer's OWN ancestors. It exists because a lead that starts a helper on a
card it holds, or hands it a card, otherwise gets "please assign &F121 to me, I can't move or link it (forbidden)" and spends
a turn on each. It is a narrow lineage rule, not a standing: the daemon reads the claimer from the credential and the lineage from
the session registry, the request carries no argument, and a refusal changes nothing.

| The card is held by                                                     | `claim`                                                                                                  |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| the claimer's parent or any higher ancestor                             | assigned to the claimer, journaled `claimed by <ferret> from <lead>`                                     |
| a lead's assignee (a middle ferret, an ancestor)                        | the same: whoever owns the card, the holder is what counts                                               |
| an ancestor, though the claimer OWNS the card (it assigned the card up) | the same: ownership does not matter, the holder is an ancestor                                           |
| a sibling, a cousin, any ferret outside the lineage                     | refused: "…held by <ferret>… ask your lead". A shared lead that OWNS the card does not make it claimable |
| the claimer already                                                     | refused: "already yours"                                                                                 |
| nobody but the claimer, which owns it and assigned it to a non-ancestor | refused: "you own it": take it back with `fy task assign <id> <you>`                                     |
| the owner (a person) or the daemon is the CALLER                        | refused: `claim` is a ferret's; they `assign`                                                            |

A person and the daemon are caller kinds, never card holders: a card's owner and assignee are session ids under the current schema, so
"a card the owner holds" is a card assigned to a ferret the person started, and it is claimable like any other ferret's card.

Claiming makes the claimer the card's **holder**, and nothing more. The holder may `note`; `link` a PR, branch, commit or doc; `trigger`;
`focus`; `move` the card (a sub-ferret's move is judged in the write, against the current holder only: a card another ferret holds stays
refused, and the lane rules still apply: an owner gate or an unfinished dependency still holds it); and hand it down. It does **not** grant `drop`
(an assignee fails the drop authority, see the standings above), `edit`, `block`, `reparent`, `refile` or any other re-plan.
`fy start --card <id>` does the same for a NEW session: it assigns an existing card to the session being started under the same checks as
`fy new --card` (the caller must be allowed to hand that card down; the owner may take any existing card), makes no second card, and needs a prompt.
**The handover is not best effort.** The card must exist, be open work (a dropped or closed card is refused up front) and the session an ordinary
ferret (a miner, guide builder or warden takes no card); all of it is judged before a session is written. The assignment itself is one write that
re-judges the card, so a card dropped, closed or reassigned after that check is refused there: the new session is stopped with the reason, the card is
left as it was, and the start answers `card_refused`. Nothing launches on a card it was not given.

Re-plan means retitle, rewrite the brief, reassign, drop and reorder. The one re-plan write an `assignee` has is handing the card DOWN: it may assign it to one of its own descendants (`fy new --card`, `fy task assign <child>`), recorded as "handed down by" the assignee; never sideways, upward or to nobody. A sub-ferret that is the assignee may do it too: it is the one reassign the sub-ferret limit lets through. A ferret never moves a card on out of a gate
or past one (a lane whose stage is a gate, owner-gated or a `verify` lane), and only the owner closes — except on an internal card, whose owner ferret and its leads pass its gates
and close it ([Cards show progress](#cards-show-progress-their-asks-ride-the-agenda)), and a sub-card, which the daemon closes when its work
ships or its helper finishes ([Sub-cards close themselves](#sub-cards-close-themselves)). A ferret's change to a project's lanes waits for the owner
([above](#a-ferrets-lane-change-waits-for-the-owner)). Reaching the routes at all is a `fleet` capability matter for a caller
who is not on this host ([grants.md](grants.md)).

### An orphaned card is adopted

A card is **orphaned** when its owner ferret AND its assignee have both ended. Nobody left holds it, and the standings above give
the owner alone a say over it, so a card the owner never asked for sat there until they assigned or closed it by hand ("don't
drop it, assign someone to it!"). `fy task adopt <id> [--reason <why>]` lets a live lead take it instead. The daemon judges every
condition itself, in the card's write, from the session roster: the request names nobody, and a refusal changes nothing. The write
runs inside a hold on the owner ferret, the assignee and the adopter, and judges them on a roster read after the hold was taken, so
none of them can end or resume between that read and the card landing. Where no hold can be taken, nothing is adopted.

| Condition                                                                                                           | Refused as                                       |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| the caller is a ferret (the owner and the daemon `assign`)                                                          | "adopt is a ferret's"                            |
| the card is open work (not dropped, not in a closed lane)                                                           | "is dropped" / "is closed: nothing to adopt"     |
| the owner ferret and the assignee are both ended (a session the daemon cannot read is NOT ended)                    | "is not orphaned: <ferret> has not ended"        |
| the caller is alive                                                                                                 | "only a live ferret may adopt"                   |
| the caller is a lead, not a sub-ferret: its configuration was read and says it was started by nobody (else refused) | "only a lead may adopt" / the sub-ferret refusal |
| the caller works on the card's own board (the same machine is implied: a card is local to its daemon)               | "is on another board than the one you work on"   |
| the daemon can read which ferrets are alive                                                                         | "cannot be shown to be orphaned"                 |

An adoption makes the caller the card's **owner ferret and assignee**, in one write, and journals it as an `assigned` event carrying
`adopted: { from: <the ended owner ferret>, reason }` (read as "adopted by <ferret> from <ferret>, whose ferrets ended: <reason>").
`reason` is the lead's own words, else "owner ferret X and assignee Y ended". From then on the adopter is judged as an owner
ferret: it may `assign`, `drop`, `edit` and re-plan the card like any other. **Nothing else about the card's authority changes.**
A card a person asked for (`askedBy: person`, public) still closes only through the owner's agenda answer; an internal card
(a ferret's own errand, private) is closed by its owner ferret, which after an adoption is the adopter. So "orphaned and
private" is the case a lead can close.

## Done and Not good

**A card has no owner buttons** (the owner, 2026-11-04: _"TASK no longer have user interactivity anymore! agenda tracks
all those and are the one request user to test so it can move it. the board is almost fully autonomous!"_). The Board's
surfaces — the Kanban card, the Table row, the side pane and the card detail — draw the card's state (its lane, its
Status, its How to test) and no answer. The owner answers a card only on its agenda: the card ask
([below](#cards-show-progress-their-asks-ride-the-agenda)) on the Inbox deck, a to-test row in the Inbox list and the
Answer-quickly run, which move the card.

### The owner's Board is read-only

The Board page and the card view are for **reading**. The owner has no hand control on them (the owner, 2026-11-04, on
!A358: _"Remove them all"_). Gone from the PWA — the Kanban, Table, Tree, Dependencies and Archive views, the per-chat
Tasks tab (side and expanded), and the card drawer / phone card page:

- the lane pill dropdown ("Review/CI ▾") and every "Move to…" menu — the card ⋯ menu, the drawer's lane menu — and
  **drag-and-drop between lanes**, including the "Done" drop target; the lane is now plain text or a badge;
- **Add dependency** and the × on a dependency chip (the chips stay, and open the other card);
- the **"Comment to <ferret>…" box** — the owner talks to a ferret in its own chat, which the card's **Open chat** opens;
- the drawer's **⋯ More actions** menu: Move to…, **Reparent…** and **Drop…**;
- the **Add card** button (header and phone floating button) and its new-card form, and the **Lanes ✎** links to the
  lane editor (the editor itself stays at the project's page).

Cards stay fully readable: the lane, the Status, links, history, sub-cards, dependencies and the agenda asks — each ask
is a link that opens its item in the ferret's chat, with no answer buttons. What stays, because it reads or navigates
and writes to no card: **Open chat**, **Copy link**, **Add to chat** (puts the card's `&F18` in that chat's draft), the
view switches, the filters, **Show private**, the scope toggle, the theme switch, and the ticks on How to test steps
(a reading aid on that screen only, never saved). The daemon routes and the `fy` commands that make, move, link, edit, reparent,
drop and comment on a card are unchanged: ferrets and the CLI still use them, and the owner's only way to move a card is
to answer where it asks, in the agenda.

The owner's two answers about a card, on the agenda surfaces:

- **Done** moves the card to the project's Closed lane, and its ferret is told in one plain line.
- **Not good** opens the chat's own composer, detached from any chat: the words, plus any images or files, with the
  same mic, Enter to send and Shift+Enter for a new line. What is typed is kept nowhere — never the ferret's chat draft,
  never queued as a message — and the box is as wide as the column it sits in (under the Inbox deck's card it takes the
  card's own inset; one rule in `board.css` and `agenda-inbox.css`, one component for the Board, a to-test row, the
  Answer-quickly run and the Inbox deck). It is the owner's move back, so it
  is a reopen: the card goes back to the rework lane, the words are added to its clarifications, and the
  ferret is sent them through its queue as the owner. The `reopened` history event names the files, so the
  card reads "reopened Released → Implement … with 2 images".

Where the box opens is one rule too: **inline, directly under the card it answers, at the card's exact width** — under the
Inbox deck's card, under a to-test row in the Inbox list and in the Answer-quickly run (no sheet, no popup over the page).
It ends at the field: a
detached composer draws no empty status row under it, and its placeholder is short enough for a phone (`What went wrong?`).

The files travel as ordinary chat attachments. The app uploads them to the card's ferret (its assignee, else
its owner ferret) through the session attachment route, then names them on the move (`attachments: { from,
ids }`). The daemon refuses files from anyone but the owner, files in any other session, and files on a move
that sends nothing back. Whichever ferret the reopen reaches gets a copy in its own session; if the copy
fails, the line still lands with a sentence saying the files did not. A daemon reports
`board.reopen.attachments.1` on `GET /v1/health` when it takes files; the app offers attaching only there.

The upload rides the same carrier as every other call to that machine (the router's fetch), because a paired
device holds no bearer value: the device key that opened the session is the credential, and a request sent over
the raw network reaches the daemon as nobody and is refused `401 unauthorized`. The session attachment store
keeps files by session id and does not require the session to be running, so a card whose ferret has stopped or
finished still takes files; they wait in that session until the reopen carries them to whichever ferret it
reaches. A `401 unauthorized` on an upload reads "pair it again from Settings", not the bare word.

While a move is in flight, the pressed button shows a spinner and both answers are disabled; a refusal is
shown next to them.

## Cards show progress; their asks ride the agenda

A card never asks the owner itself, and no lane means "waiting on you". Lanes show where the work is. When the work
needs the owner — a plan to approve (Plan/Design's **OK to build**) or a release to try (Released's **Done / Not
good**) — the daemon puts a **card ask** on the agenda that carries the card, with the card's How to test, and the
owner answers it there ([agenda.md](agenda.md#card-asks) has the wire). The code is `GateItems`
(`packages/daemon/src/lib/board/gate-items.ts`); the pure half is `gate-policy.ts` and `agenda/card-asks.ts`.

Internally the lane's stage is still a **gate** (`laneStage` in `@ferretry/protocol`): it is what makes the daemon put
a card ask, and what refuses a ferret's move past it. A lane stored without a stage reads with one.

**Attaching.** After every committed write of a card, by any path — a move, a trigger, PR facts, a refile,
`fy signal done`, a lane edit's relocation — a card the owner asked for (external, below) that sits in a gate lane
has its ask on exactly ONE open agenda, found in this order:

1. an open agenda that already **carries the card**: it is about the card (`task`, or a card a merge brought in), or it
   carries one of the card's asks;
2. else an open agenda that carries its **parent card**;
3. else a **new agenda** named after the card, raised by the daemon on behalf of the card's ferret on its **agenda home**
   (the assignee's, else the owner ferret's; [agenda.md](agenda.md#the-agenda-home)), `sourceRef` `card-agenda:<card>`,
   stage `test` or `plan`. Its own ask is only a reply; the card ask's buttons move the card.

Of several candidates, the one on the card's ferret's home wins, then one on the owner's turn, then the newest. A
ferret's item that the daemon acts on (an input card, a held configuration change, a plan) never carries one. The
ask is named `gate:<card>:<lane>:<entry>`, where `entry` is the history `seq` of the event that put the card there:
the same entry is restated in place (a renamed lane, new steps), never asked twice, and an ask the owner answered —
or that was still open when the owner closed its agenda (Not needed) — is never asked again. At boot every card
already at a gate gets its ask once, in the background. The daemon never raises a standalone gate item.

**It wakes the agenda.** A new card ask puts its agenda in Needs you, fresh — even out of a snooze or a discussion,
because it is a blocker of its card — and it stays ONE entry in the unique queue, blockers first. Its ferret cannot
rest the agenda or mark it done while the ask is open: only the owner answers it.

**One agenda per machine, whoever has the card.** A card changes hands and its agenda stays where it is, so the agendas
that carry a card are looked for on **every** agenda that ever held an item about it (read once from every session at
boot, then kept as they are written). A second open copy of the same ask is withdrawn.

**Answering** is the owner's alone: at the machine (the admin token, recorded `admin-token` on the card) or from a
paired device the `fleet` grant lets use the board — exactly who could have moved the card on the Board. The card
moves FIRST, through `BoardService` as the owner, so authority, history and the done and reopen ladders are the
board's own; only a move that went through records the answer, and a refused move leaves the ask open with the
reason (`409 gate_not_moved`; `409 gate_moved_on` when the card left that gate). The answer is kept on the ask with a
receipt of everything it said, so an exact repeat (a lost response, a second tap) moves nothing again and comes back
unchanged, and the same choice with other words or files is refused.

**After the answer the agenda RESTS**, waiting on its ferret, and the ferret is told. The answer never closes it: the
ferret marks it done once nothing more is expected.

| Option outcome          | The card                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `next`, `lane`, `close` | moves there, reason "<option> (from the Inbox)"; the ferret is told the owner's answer                               |
| `reopen-with-agenda`    | needs the owner's words (`400` without): reopened to the set's Not good lane as the owner's Not good is, the words a |
|                         | clarification sent to the ferret by the reopen ladder; the talk about the rework stays on the same agenda            |
| "Not yet"               | the extra answer of a gate with one option: the card stays and the ask stays open; words reach the ferret            |
| Not needed (dismiss)    | the owner closes the agenda: the card stays where it is, quietly, and that entry asks nothing again (`fleet` grant)  |

**Leaving.** A card that leaves the gate any other way — the owner's move on the Board, a drop, a refile — has its open
ask withdrawn quietly. If that was the last open ask, the agenda rests waiting on its ferret, or closes when it is the
daemon-opened card agenda with no conversation; a ferret's thread that carried it goes back to the turn the ask woke it out of
(the owner's, or the park, rest or wait it was in), unless it has moved on since. A Not good conversation raised before card asks
(`gate-followup:`) still closes by itself when the card next reaches a gate, unless it is still going with the owner or
now carries the ask.

**Only the owner passes a gate.** Their answer to its card ask, or their own move or report (and, on an internal card,
its owner ferret's or a lead's move, below). Every other path may bring a card INTO a gate and move it between
automatic stages, never out of one or past one: a ferret's `fy task move` (refused `owner-gate`, naming the lane),
a daemon trigger (`work.started`, a PR, a release — it stops in the first gate on its way, and the history says
"stopped at <lane>, which waits for the owner"), PR facts (they never pull a card back out of a gate for an open PR
either), `fy signal done` (held, or stopped at the gate) and a refile's facts. A refile by anyone else never lands a card
past a gate of the other board's variant: it stops in the first one on the way, and a lane named past one is refused;
and a card waiting at a gate lands at a gate of the same stage or earlier, never a later one; a dropped card is reopened by anyone else only where it was dropped, or earlier. Leaving a gate is
`needsOwner`'s and a gate on the way `gatesBetween`'s (`card-actions.ts`), both from each lane's stage
(`laneStage`), so a `verify` lane with no `ownerGate` is a gate too. A ferret may still move a card back out of a
gate, with a reason. A card's workflow never changes, so no variant can skip one.

**Lane changes.** A ferret's lane edit or proposal over a live set never goes live: it waits for the owner
([A ferret's lane change waits for the owner](#a-ferrets-lane-change-waits-for-the-owner)), and what it would do to a
gate (`laneGateProblems`, `@ferretry/protocol`) is what its Accept card and the lane editor say: remove a gate lane,
make it automatic, drop its `ownerGate`, move it among the lanes a variant walks, let a variant skip it, rewire its
options, or send cards into a closed lane, into a new lane, or past a gate of the new layout.

**Answers, one at a time.** Answers to one card take turns, and each move is written only if the card still sits in
that gate by the entry the ask names. The owner's bare done on an agenda with an open card ask is refused: they
answer the ask or say Not needed. Clearing the agent ferrets' backlog and the duplicate sweep never close an agenda
that carries a card ask.

**A PR opened while the card waits.** The card stays at the gate; a card agenda says so in its context ("A new PR is
open for this card: <url>"), so the owner waits or says Not good. Done while it is open closes the card as usual.

**Nobody else answers.** A ferret, a lead over its sub-ferret (`overSubFerret`) and the daemon's other producers are
refused every verb that would answer, rest or close an agenda's open card ask; a raise that carries `cardAsks`, a
`gate`, a `gate:` or `card-agenda:` reference, or a discussion start is the daemon's alone. Only the daemon writes a
card ask (the state machine's `card-ask` command), and it records an answer only after the owner's check passed and
the card moved.

**Notifications.** A card ask buzzes the phone once, when it is put on its agenda, and that agenda is left out of
a stop's push only while its sole open items are card asks ([notifications.md](notifications.md#when-the-phone-buzzes)). A daemon that puts card asks lists
`agenda.card-asks.1` on `GET /v1/health`.

**Cards carry no "waiting on you".** `waitingOnOwner`, the activity `waiting`, the `toTest` and `waitingOnYou` counts
and the `to_test` and `waiting_on_you` filters are deprecated, and the app draws none of them (no board pills, no badge on the Board tab): the daemon sends `waitingOnOwner: []` and both counts as
0, never derives `waiting`, and the two filters match no card, so an app that predates card asks still reads the board.
`fy board` shows none of them, and a card's detail lists the agendas that carry it.

**Internal cards.** A card that is positively a ferret's own errand never asks, never buzzes and is not in the Inbox.
Only what the daemon recorded decides it, never what a ferret wrote: the daemon made the card (`createdBy`
`daemon`: a board import, or the card `fy new` makes for a sub-ferret — written by that start alone, kept by every
hand-over, refile and reopen), or the session that wrote it was started by a ferret (a sub-lead's own card); AND no
person asked for it (`askedBy` is not `person`). Anything else — a top-level ferret's `fy task create`, whatever its
ask's source says; a lineage that could not be read — is EXTERNAL. One function decides it for the card asks and for
who passes the gate alike (`BoardService.audienceOf`, `cardAudience` in `origin.ts`), so an external card at a gate
always has its ask, and an internal one always has someone who may pass it. By design a lead's `fy new` sub-card is internal even when the lead is top-level: the owner's own session card
stays external and gated, so the owner still passes the gate that matters. An imported legacy task that recorded no
creator is read as the owner's. A sub-card never asks at a lane the owner tries things in: the owner tests the parent.

| Standing             | External card's gate | Internal card's gate |
| -------------------- | -------------------- | -------------------- |
| `owner-human`        | passes               | passes               |
| `owner`, `ancestor`  | refused              | passes               |
| `assignee`, `reader` | refused              | refused              |
| `daemon`             | PR facts only        | PR facts only        |

**The migration.** Agendas are read into card asks, read-time and losslessly ([agenda.md](agenda.md#card-asks)): an
open gate item becomes its card's agenda (same id, history, snooze and turn), or puts its ask on the card's open thread
and closes saying where it went; a thread's old `gateAttached` becomes its card ask. Answered gate items keep their
receipt. Stored lane sets are renamed as progress at boot: a lane still named as the template named it
("Released · to test", "To test") becomes "Released" or "Ready to try", and the template's Plan/Design and Review are
no longer drawn as the owner's action. A lane the owner renamed keeps its name; no card moves.

**GAPS.** Every guarantee here holds against a ferret on its own session credential. The admin token with no session
(an older `fy`, `fy --as-owner`) still has the owner's authority and is only RECORDED as `admin-token`
([The board is opt-in](#the-board-is-opt-in), &F291). A Not good takes files only on a machine that reports
`agenda.gate.attachments.1`. An app that predates card asks answers the ask `gateAttached` shows and names none: a
answer with the same receipt given in the last two minutes, or in the two minutes after the shown ask took another one's place, is never
applied to another ask on that agenda (`409 gate_moved_on`); with no ask left to show, an exact repeat comes back unchanged. The app now names the ask. An answered ask is remembered only as long as the agenda keeps it
(the newest 16 answered asks of an open agenda, `MAX_AGENDA_RESOLUTIONS` closed agendas).

## Activity and staleness

Activity is attributed to a session's focus card (`config.focusTask`, set by `fy task focus` and by creating a
card). The first state that applies wins:

| State      | When                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `active`   | an attributed session is working now                                                                                                                                           |
| `orphaned` | its ferrets are gone while the card sits in an active or review lane, and no lead above them is alive ([returned to its lead](#a-finished-helpers-card-goes-back-to-its-lead)) |
| `idle`     | blocked, waiting on another card, or its agenda carries its open card ask: someone else's clock, never stale (`waiting` is deprecated, never derived)                          |
| `stale`    | idle past its lane's `staleAfter`                                                                                                                                              |
| `idle`     | none of the above                                                                                                                                                              |

A lane without its own `staleAfter` uses the category default: backlog 3 days, active 2 hours, review 24 hours,
shipped 3 days. Verify and closed never go stale. An unassigned child card still in a backlog lane is nobody's work yet, so it
never keeps its parent from being `orphaned`; an assigned or started child does.

The **sweep** (`packages/daemon/src/lib/board/sweep.ts`) ticks on its own and does three things. It closes a helper whose ferret ended and hands any other card of an ended ferret back to its lead ([above](#a-finished-helpers-card-goes-back-to-its-lead)). It nudges the ferret
of a stale card ([who a board alert is for](#who-a-board-alert-is-for)), at most once per card per `staleAfter`
however the recipient changes, never one that declared a wait, never for a card that is blocked or whose ask is open.
It also queues quiet events: a child's move, block, drop or new blocking ask goes to its lead, and `&F20 unblocked`
goes to a dependent's assignee. Quiet events ride the next message and never start a turn
([ferret-messages.md](ferret-messages.md#board-events-that-ride-the-next-message)). The first sight of a card is a
baseline, not news.

### Who a board alert is for

The board raises three alerts that ask a card's people to act: a **stale** card, a **red CI** on a linked PR, and a PR
**closed unmerged**. They used to go to the session that made the card, which is usually the owner's interactive chat
even when a lead was doing the work. Now one function, `noticeRecipient`
(`packages/daemon/src/lib/board/notice-route.ts`), picks the session from the card and one roster read:

1. the card's **assignee** (its owner when unassigned), while it is alive;
2. else the **nearest live lead above the assignee** (`config.parent`, walked up);
3. else the card's **owner** (its creator by default), and then the owner's leads, ONLY when nobody in that line is alive;
4. an **interactive** session (the owner's own chat) only when no automatic session is alive anywhere in that order.
   Such an alert is **never typed** into it: `BoardAlerts` (`packages/daemon/src/lib/board/alert-sends.ts`) reads the
   recipient's `config.mode` at the send, whichever way it was picked — this route, the fallback below, or a
   sub-ferret's lead standing in — and journals an interactive one's alert on it as `board.alert-withheld` with its
   words. A red CI or a PR closed unmerged on a **private** card is also written as a note on the card's **nearest
   public ancestor that is open on the default board** (`AlertSurface`, same file; "open" is the board's own
   `isOpenOnBoard`, so a dropped ancestor or one in a closed lane is walked past), so the default board shows it without
   a turn. Declared gap: a private card with no such ancestor — none public, or every public one archived — has no
   visible place for it (it is in the journal and the card's own history/PR facts),
   and a stale nudge is journalled only, because a note would count as its parent's activity. A mode that cannot be read
   (the send document is damaged) is not a reason to hold an alert back: it is sent as before. An automatic session gets every alert as before. Folding them into the
   owner's agenda is a declared GAP: the agenda is being redesigned, and a lead's turns are the cost this saves.

A session that declared `fy signal waiting` is never nudged, and nobody is nudged in its place. An assignee that
cannot be read (neither alive nor ended) gets the stale nudge withheld rather than passed to someone else. What is
raised and how often does not change: the stale throttle is per card, and CI-red and closed-unmerged fire once on the
change, so reassigning a card never repeats an alert. With nobody alive anywhere, a stale nudge is not
sent, and a PR alert goes where it went before routing existed (`alertFallback`), the send path reviving an ended
session: a **red CI** to the card's working ferret (its assignee, else its owner), a PR **closed unmerged** to the
card's owner; either way a sub-ferret's lead stands in for it. An assignee that is busy (thinking or running a
tool) is alive, so it is now nudged itself; it used to fall through to the owner. The go-ahead
(`&F20 can go ahead`) is not an alert and keeps going to the assignee's lead.

## Lanes follow PR facts

A card never sits behind its own PR. `laneFromFacts` (`packages/daemon/src/lib/board/lane-facts.ts`) is the one
owner of where PR facts put a card: all PRs merged and released is the `release.published` lane (Released · to
test; in a hand-made set that still has a `release.running` lane, that one once this machine runs the release), any
merged with none open is `pr.merged`, any open is `pr.opened` / `pr.ready`, and otherwise no opinion. It never moves
a card backward, with one exception: any open PR, draft or not and however old, on a card that has shipped
something pulls it back to where `pr.ready` goes (In progress, or Review/CI on an older board: "moved back to In
progress: PR #1013 ready for review"), because work still in flight means the card is not shipped. A PR closed
unmerged says nothing. Nor does a fact move a card out of Closed or a drop, or into a Closed lane in a set with a
`verify` lane. A fact never passes a gate: it moves a card into one and stops there, and it neither moves nor pulls back
a card waiting at one (Plan/Design, Released), whatever its PRs say
([Cards show progress](#cards-show-progress-their-asks-ride-the-agenda)); the "pulled back" exception above applies only outside a gate.
The GitHub watcher reconciles every linked card on every poll, refile and `fy task link --pr` re-evaluate at once, and a
PR nobody has asked GitHub about is polled on the next tick. A card the owner sent back stays back until a PR newer
than that move merges. History names the fact; no move is ever typed into a chat
([ferret-messages.md](ferret-messages.md#what-the-board-types-into-a-chat)).

The watcher itself polls GitHub through the host's `gh` about once a minute while a repository has an open linked
PR, and every ten minutes otherwise, and after `gh` is missing or signed out. Every tick also re-reads each open card's lane set
and reconciles the card against it, PRs that can no longer change included, so a lane set that gains a lane (the
boot migrations) moves its cards on the first tick after boot, with no call to GitHub.

## Dependencies

A card waits on another with `dependsOn`, stored on the dependent. `blocks` is the inverse and is derived, never
stored.

- `until` is `shipped` (the default) or `released`: how far the dependency must get before the dependent may advance.
- While a dependency is not done, the dependent can move sideways or back but not on (`blocked-by`). Only the owner
  overrides it, with a reason (`fy task depend --override`).
- A cycle is refused (`cycle`), and a card does not depend on itself.
- When the last blocker ships, the dependent's assignee hears `&F20 unblocked: &F18 merged` on its next message.
- A ferret may add a dependency only from its own card.

### Clashing claims queue the later card

The owner: _"make sure that features that will conflcit gets "queued up", and add depends on on the board, and wait
for that feature to be built before merging."_ (&I38; the design is
[design/clash-queue.md](design/clash-queue.md)).

- **A claim is a file or a folder** the work will touch: `fy task create --file <path>` or `fy task file <id> <path>`.
  The card's lead claims at brief time, and the ferret holding the card may claim and release files on it too.
  Claim the shared hot files when the work touches them: `packages/daemon/bin/fyd.ts`, `knip.json`,
  `packages/protocol/src/lib/daemon-features/index.ts`.
- **Two claims clash** when the paths are the same, or one is a folder the other sits inside (`packages/daemon`
  holds `packages/daemon/bin/fyd.ts`, not `packages/daemon-x`). `.` is the whole repository, and `./` or `..`
  inside a path are read as the path they name.
- **The daemon queues the later claim.** In the same write as the claim, the claiming card gets a `dependsOn`
  (`until: shipped`) for every open card on the same board that already claims a clashing path and has not shipped
  (backlog included), plus a note: `queued behind &F18 to merge: both claim knip.json …`. The dependency is on the
  card whose PR **ships** the clashing work — the clashing card itself when it has a PR of its own (open, not polled
  yet, or merged) or no parent, else its parent's shipping card — because a helper sub-card with no PR closes when
  its ferret finishes, long before its lead's PR merges. A finished helper's claims keep counting until then. Both are recorded as the
  daemon's, acting for the session that claimed. The command prints the note back. Claims and dependency writes
  share one board-wide section, so two clashing claims cannot miss each other.
- **Never queued:** a card in the same shipping unit — the same shipping card, an umbrella lead and the cards under
  it, or a PR in flight they both link (an old merged PR they both kept does not count, and a child with its own PR
  is a separate merge from its lead's) — a card it already depends on, one it took out of its queue with
  `fy task undepend`, and a wait that would close a cycle between cards or between two PRs' units (that clash leaves
  a note instead). The rule is `ShippingUnits` in `packages/daemon/src/lib/board/shipping-unit.ts`.
- **Only the merge waits**, as the owner put it: _"wait for that feature to be built before merging"_. Both cards are built at once; the later one's PR
  merges after the first ships, then rebases. `fy task merge-gate <pr-url>` (over `GET /v1/board/merge-gate?pr=`)
  answers for the merger from ONE read of the board. A PR ships a **merge unit**: every card not dropped that links
  it, and every card not dropped riding one of those cards' units (its helpers, finished or not, and an umbrella lead
  above it). Units change after a claim lands (a card opens its PR, a helper finishes), so the gate does not trust
  the daemon's claim-time depends-on: it derives the **clash order live** — of two units whose claims clash, the one
  that claimed first merges first, by one rank per unit (the earliest claim of any card riding it, then of the cards
  riding only it, then its key), so no set of PRs ever waits in a circle — and adds the dependencies a person made. Exit 0 when the unit waits on nothing; 1 (printing `&F20 waits on &F18 (until
shipped)`) when it does; 2 when it cannot tell — the daemon is down or predates the gate, a card on the machine is
  unreadable (it might link the PR), or the URL is not a PR. The merger treats 2 as "do not merge". A card inside the
  unit, or one linking the same PR, never holds it; nor does a unit that shipped or was dropped.
- **To jump the queue**, the card's lead removes the wait on purpose: `fy task undepend <id> <other> --reason
"<why>"` (when the gate names a wait the board has no depends-on for, `fy task depend` it first). The owner may
  override instead. Releasing a claim does not remove a dependency.

## Agenda and cards

An agenda item names the card it is about. `fy agenda add --task <id>` sets it, defaulting to the calling
session's focus card ([agenda.md](agenda.md)). The card's view then derives `openAsks` (every open agenda that
carries it), and a card whose agenda carries its open [card ask](#cards-show-progress-their-asks-ride-the-agenda) is never stale. The link is optional
in the agenda's schema, so an item raised with no focus card simply belongs to no card; the board import creates a
card for the open items it finds that name none ([board-import.md](board-import.md)).

## Start a ferret on a card

The owner can start work on a card that has nobody working on it, from the Warden's notice or from the card
(`POST /v1/board/tasks/:taskId/start`; [agenda.md](agenda.md#the-machine-agenda) draws the buttons).

- **It starts a NEW ferret on the card**, never the old assignee: that one may be gone, may have been started for
  another repository, or may carry a focus the card has left. The client sends only the card id; the daemon decides
  the rest, through the same start `fy new --card` makes (`SessionCards.open` over an existing card):
  - **the card** is the new ferret's focus task and its anchor, and is assigned to it (the start moves the card into
    its working lane);
  - **the folder** is the card's own project's folder, read from the card as it is now, so a card refiled to another
    project starts there; a card under no project folder is refused in plain words;
  - **the runtime** is the machine's default;
  - **the brief** is built from the card: its ask, summary, why it exists, context, how to test it, links and last
    events (`startOnCardBrief`, over `focusCardBrief`).
- **A closed or dropped card is refused** — "This card was closed; reopen it first." — checked inside the same
  per-card step that starts the ferret, and again after the launch. The recheck reads the WHOLE card, not only the
  assignee: `cards.open` assigns the new ferret before it launches, and a close in between drops the card but keeps
  that assignee, so the recheck also stops the new ferret when the card is dropped or sits in a closed lane. A move
  into a closed lane is refused by `assignTo` as well ("reopen it before you …").
- **A launch that failed is refused in words.** The session service returns a failed view, not an error, once the
  session record exists; the start reads that view and answers `invalid` with "No ferret was started on &X:
  <reason>", never `started: true`. A failed view is not proof nothing runs (the lifecycle can fail AFTER delivering
  the first turn), so the start stops that session's pane first; if the pane will not stop, the refusal says so and
  asks the owner to check it before starting another. A retry therefore never runs two panes: a session the
  lifecycle recorded as `kill_failed` is terminal to the roster, but the start (and only the start) counts it as
  still holding its card (its assignee, or the card as its focus) and refuses with "A ferret on &X could not be
  stopped; stop it first."
- **A card a live ferret holds is not started again.** Its assignee, its owner (unless the card is unclaimed in the
  backlog), or any live ferret whose focus it is, counts. The answer is `200` with that ferret and `started: false`,
  and the notice swaps its button for **Open its chat**; its line reads "&B1 … — a ferret has picked it up."
  That answer is remembered per key like any other, so a lost reply followed by the holder finishing still gets
  the same answer on retry, and no new ferret.
- **One action key per click.** The PWA sends a key with each Start click as `x-fy-request-id`, and sends the SAME
  key on a retry of a click that got no answer. The daemon remembers the result per card and key (a bounded
  in-memory map, separate from liveness) and returns it: a retry after a lost response gets the first start's answer
  even when that ferret has already finished, and starts no second ferret. A new click carries a new key, so it may
  start new work. A request without the header is its own click.
- **Alone per card.** The check and the start run one at a time per card, so a second client racing a start gets
  the first start's ferret back (`started: false`) instead of a second ferret.
- **The person's act only.** A ferret, even a lead, is refused (`forbidden`); the route spine also needs the
  `fleet` capability at operator minimum for a caller who is not on this host. Closing the card is the other way
  out (`drop`, with a reason, as `fy task drop --reason` does).

## The turn-end check

When a turn ends, the daemon reads it (`packages/daemon/src/lib/board/turn-check.ts`) — **only on a board that is
on** ([The board is opt-in](#the-board-is-opt-in)). If the turn did **mutating work** while the session had **no focus
card in an open lane**, the ferret gets one queued message:

```text
You changed code this turn without a card. Create one (fy task create …) or record why not: fy task skip "<why>"
```

- **Mutating work** is the turn's own tool calls: an edit tool (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`,
  Codex's `apply_patch`), or a shell command running `git commit`, `git push`, `fy new` or `gh pr create`. A
  read-only turn — questions, research, a plan — never triggers it.
- **An open lane** is any lane whose category is not `closed`, on a card that is not dropped. A focus card that is
  gone counts as none.
- **At most once an hour per session.** The send id carries the hour, so a turn end seen twice is one message.
- **A turn the check started is never checked**, so answering it cannot loop.
- **When in doubt it says nothing**: a transcript, session or card it cannot read sends no message.
- Each nudge is journalled on the session as `board.unfiled-work`, with the work it saw.

The check is a queued nudge, not a refusal to end the turn (`board-design.md` §7, decision 2).

### The gate check

A card that reaches a gate stage asks the owner through **one** agenda: the daemon puts its card ask on the agenda
that carries the card, so there is never a task notice and a second agenda item for the same thing. A ferret that
also raises its own item on that card makes the owner answer twice, so a second check reads the same turn end
(`packages/daemon/src/lib/board/gate-check.ts`, `BoardGateCheck`). If the turn raised an agenda item (`fy agenda add`,
or an `*_ask_owner` tool) that is open on a card **currently** in a gate lane, and ANOTHER open item on the same
agenda carries that card's open ask, the ferret gets one queued message per item:

```text
&F412 already asks the owner on !A31, which carries the card: put yours on it (fy agenda edit A31 --where "<each existing point>" --where "<what you need>"; --where replaces them all, so repeat the ones already there), then drop !A44: fy agenda dismiss !A44
```

- **Once per item.** The send id carries the item, so a turn end seen twice is one message.
- **A turn the check started is never checked**, so answering it cannot loop.
- **Only on a board that is on**, and never for a sub-ferret (it raises no agenda items).
- **When in doubt it says nothing**: no carrying agenda to point to, a card or session it cannot read, or a turn whose
  start time is unknown sends no message.
- Each nudge is journalled on the session as `board.gate-nudged`, with the items it named and their cards.

## `fy task skip "<why>"`

Records that this session's work needs no card — chit-chat, or the owner said not to track it — as
`config.boardSkip` (`{ reason, at }`) on the calling session, through `POST /v1/board/skip`. Only a ferret records
one, and only for itself; the owner has no session to record it on. While a skip stands the turn-end check stays
quiet. Taking a card (`fy task create`, `fy task focus`, a start) clears it, so a later ask is checked afresh.

## `fy ps`

The CARD column shows each session's focus card and its lane (`&F18 Plan/Design`). A running ferret with no card
shows `—` in amber.

## Commands

Every `fy task` verb takes `--session <id>` (act as that session instead of the ambient one) and `--json`.

| Verb                                              | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fy task create`                                  | make a card: `-k/--kind`, `-t/--title`, `--summary`, `--ask`, `--ask-source`, `--premise`, `--context` (each repeatable, one bullet each), `--term`, `--brief`, `--brief-file`, `--how-to-test`, `--how-to-test-file`, `--workflow`, `--depends-on`, `--parent`, `--assignee`, `--project`, `--lane`, `--file`, `--pr`, `--branch`, `--doc`, `--private` or `--public`; asks the daemon first and refuses a strong duplicate unless `--new` (or `--related <id>` notes that card instead), lists weaker related cards, and refuses an umbrella card unless `--broad "<why>"` ([One card, one outcome](#one-card-one-outcome)) |
| `fy tidy`                                         | drop your own unwanted cards and close your own work-tracking agenda items; a dry run unless `--yes`; `--reason`, `--ferret <id>` (owner), `--json` ([Tidy](#tidy-dropping-what-nobody-asked-for))                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `fy search <words>`                               | find cards and agenda items by what they say; `--kind`, `--open`, `--all`, `--project`, `--limit`, `--json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `fy task show <id>`                               | print one card                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `fy task show <id> --yaml`                        | the editable document `fy task patch` takes back                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `fy task patch <id> --file <f\|->`                | change the card as ONE YAML or JSON document: one atomic edit ([Patch](#patch-a-card-as-one-document))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `fy task move <id> <lane>`                        | move it; `--reason` is required for a move back                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `fy task trigger <id> <event>`                    | report an external event for a card (`pr.review_approved`, `deploy.done`); the daemon moves it if a lane waits on it. A sub-ferret may run it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `fy task focus <id>`                              | attribute this session's work to the card                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `fy task skip "<why>"`                            | record that this work needs no card                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `fy task block` / `unblock`                       | mark or clear an external block                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `fy task depend` / `undepend`                     | add or remove a dependency; `--until`, `--override <why>` (owner)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `fy task merge-gate <pr-url>`                     | whether a PR may merge as far as the queue goes: exit 0 free, 1 a card it ships waits on another, 2 cannot tell ([Clashing claims](#clashing-claims-queue-the-later-card))                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `fy task drop --reason`                           | drop a card                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `fy task reopen <id> --to <lane> --ask "<words>"` | reopen a finished card with the owner's new ask                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `fy task clarify <id> --source`                   | append verbatim words to the original ask                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `fy task link`                                    | attach one `--pr`, `--branch`, `--commit` or `--doc`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `fy task assign`, `note`, `order`, `file`, `edit` | assignee, a note, manual order, expected files or folders (a clash queues the card), edit the text fields; `edit --visibility public\|private` ([Public and private cards](#public-and-private-cards))                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `fy task refile <id> --project`                   | move a card to another project's board; `--lane`, `--reason`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `fy board`                                        | the board; `--project <name\|all>`, `--ferret`, `--mine`, `--private`, `--all`, `--kind`, `--pr`, `--activity`, `--state`, `--closed`, `--query`, `--json`, `--md`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `fy board lanes propose\|show\|edit`              | read or change a project's lane set; `--project`, `--rename`, `--remove`, `--into`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `fy board workflow show`                          | each lane in order as a GATE (its options and where each sends the card) or AUTO (what moves a card in); `--project`, `--json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `fy board workflow edit --lane <id>`              | make a lane a gate (`--gate "<Label>=<next\|close\|reopen\|lane:<id>>"`, up to 3) or automatic (`--auto <trigger,...>\|none`); version-checked through the lanes edit route, so a sub-ferret is refused as for `lanes edit`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `fy board status`, `fy board on\|off`             | whether the project uses the board; switching it is the owner's ([The board is opt-in](#the-board-is-opt-in)); `--project`, `--json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `fy board import`                                 | import the old task files ([board-import.md](board-import.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `fy project add <path>` / `ls`                    | register a folder as a project; list projects                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The routes behind them, all needing the `fleet` capability at operator minimum for a caller off this host
([grants.md](grants.md)):

| Route                                           | Does                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /v1/board`                                 | the board view; `visibility=public\|private\|all` (default `all`)             |
| `GET /v1/board/ids`                             | every card id on the machine, ids only: what `&F12` is proved against         |
| `GET /v1/board/merge-gate?pr=`                  | whether a PR may merge as far as the queue goes, from one read of the board   |
| `POST /v1/board/tasks`                          | create a card                                                                 |
| `GET /v1/board/tasks?legacyRef=`                | find the card an imported task became                                         |
| `GET, POST /v1/board/tasks/:taskId`             | read a card, or apply one action to it                                        |
| `POST /v1/board/tasks/:taskId/start`            | the owner's start of a NEW ferret on the card (or the live one that holds it) |
| `POST /v1/board/skip`                           | record `fy task skip`                                                         |
| `POST /v1/board/import`                         | run the import                                                                |
| `GET /v1/board/projects`                        | list projects                                                                 |
| `GET, POST /v1/board/projects/:projectId/lanes` | read, propose or edit a lane set                                              |
| `GET, PUT /v1/board/projects/:projectId/switch` | read whether the project uses the board; set it (the owner only)              |
| `GET /v1/search`                                | find cards and agenda items by any words ([work-search.md](work-search.md))   |
| `POST /v1/search/related`                       | the related check before filing                                               |
| `POST /v1/tidy/plan`                            | the calling ferret's tidy plan: what to drop, close and keep (read-only)      |

A write that fails answers with one of these codes: `invalid`, `not-found`, `forbidden`, `reason-required`,
`owner-gate`, `blocked-by`, `cycle`, `unknown-lane`, `no-lane-set`, `version-conflict`.

The PWA shows the board as kanban, list, tree, dependencies and archive views, and opens a card from `&F412`
wherever it appears ([reference-standard.md](reference-standard.md)). It is **read-only for the owner**
([The owner's Board is read-only](#the-owners-board-is-read-only)); these routes stay for ferrets and the CLI.

## Gaps and work in flight

- **Lane proposals: what is not covered yet.**
  - A daemon or app from before waiting proposals reads a lane file without `pending` and, on its next write,
    drops it; a later proposal can then be given a number an old, still-open card names. Its Accept takes the
    newer content.
  - A first proposal raised by `InferredLaneProposer` for a sub-ferret puts the card on that sub-ferret's agenda,
    where its lead may edit the daemon's item (not answer it).
  - An Accept on the agenda records the owner without saying it came on the admin token (`confirmedVia`), unlike
    the lanes route.
  - When the owner accepts, the lanes are stored first and the cards moved after; a move that fails leaves those
    cards in a removed lane, with nothing that retries it.
  - Anything running as the same user can delete a project's lane file under the state home, after which a
    ferret's proposal for it goes live as a first one (the admin-token GAP's class: the host's user is the owner).

- **`fy` cannot report a trigger yet.** The lane editor marks `pr.review_approved` and `deploy.done` as "reported
  with fy task trigger"; until that command exists they are reported with `{ "action": "trigger" }`.
- **`pr.review_approved` is reported, not watched.** The watcher asks GitHub for a PR's state, checks and merge,
  not its review decision, so for now an approval is reported (`{ "action": "trigger" }`).
- **A daemon or an app that predates the two new triggers cannot read a lane that uses one.** Its trigger list is
  closed, so a lane set naming `deploy.done` or `pr.review_approved` fails to parse there: an older daemon reads
  that lane file as damaged, and a cached older app cannot load the board. No template uses them; add one to a lane
  only once every machine and app runs this release.

- **Only `&F412` is a link in a card's text.** The card detail sits outside any session, and the reference
  surface is assembled per session (`components/reference-surface.tsx`), so `!A48` and `@file` in a card's Markdown
  stay prose until the Board builds a surface of its own — the same as an agenda card read in the Inbox. A task
  reference links on both, through `DaemonTaskReferences`: any card on the machine, per
  [reference-standard.md](reference-standard.md) §6.
- **Another machine's cards.** The `&F412@mac` spelling for a card on a different machine is not wired. A `parent`
  or `dependsOn` that names a card on another machine resolves to nothing, so it neither blocks nor rolls up.
- **Some messages bypass the pending-context carrier.** Quiet board events ride the next message, but agenda answer
  batches and Warden nudges are still delivered by their own paths, so they are not held for the next turn.
- **Old `&F12` references in the PWA resolve through the project or ferret board slice.** A chat reads one board query
  (`ferret = <session>`, `state = all`) and a reference that is the old id of a card whose `legacyRef` names this
  session links to that card, shown as the old text; a card on the slice with the same id wins. It does not call
  `GET /v1/board/tasks?legacyRef=` per reference. The limit is the slice: an imported card this ferret no longer
  owns or is assigned stays plain text ([reference-standard.md](reference-standard.md)).
- **Per-session task routes.** `/v1/sessions/:sid/tasks` and `/v1/tasks` survive as empty compatibility answers for
  one release and then go. Nothing in the PWA requests them any more; a unit test scans its source for the spelling.
