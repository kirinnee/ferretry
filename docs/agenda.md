# Agenda

The agenda is what the owner has to decide or do, and what each item blocks. It replaces "Attention"
as the name of the feature (`fy attention …` still works, deprecated). A plain notification with
nothing to decide is a **notice**, not an agenda item (see [Notices](#notices)).

The daemon owns the model: the state machine is `packages/daemon/src/lib/attention/state-machine.ts`,
the wire contract is `packages/protocol/src/lib/attention.ts`. This page says what they mean.

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
covered by the notification policy (docs/notifications.md, owned by the notify unit).

## Notices

A notice is a plain notification: `notice: true` on the raise request. No ask, no answers, no steps, kind
`info`, and **never anybody's turn** — it does not count as open in the session summary and chat cannot
reference it. `ping: true` asks for the phone to buzz and is only valid on a notice. `fy attention notify`
raises one (the top-level `fy notify` is the notify unit's).

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
