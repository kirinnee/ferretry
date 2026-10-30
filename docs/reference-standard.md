# The Ferretry reference standard

`fy-reference/1`

This document is the contract for **references**: the sigil tokens that make a message, a task, an
agenda item, a notice, a file preview or a composer draft point at something real, and clickable.

It is written for two audiences at once, because they have to agree:

- **An agent or a person authoring text.** Sections 1 to 5 are all you need. They are the exact forms
  to type, what each one opens, and what happens when you type one that does not exist.
- **Somebody implementing a surface.** Sections 6 to 8 add the proof contract, the code-span rule,
  and how a new reference kind joins the system.

Reference implementation: `packages/pwa/src/lib/references.ts` (grammar, proof gate, remark
transform), `packages/pwa/src/lib/code-span-references.ts` (references inside code),
`packages/pwa/src/components/markdown.tsx` (the one renderer and the one click behaviour),
`packages/pwa/src/components/reference-surface.tsx` (the one per-session surface).

---

## 1. A reference is a token, never a Markdown link

Write the sigil and the name. Nothing else.

```text
ask :zelda to look at @src/api.ts:120-140 before &F12 lands
```

Do **not** write a Markdown link, and never invent a URL for a reference:

```text
DO NOT: [zelda](#fy-reference?kind=agent&daemon=d1&id=s9&name=zelda)
DO NOT: [&F12](/tasks/F12)
```

Those are dead on arrival. The renderer creates the link itself, and it only trusts links its own
transform produced — a reference-shaped URL written by hand renders as inert text on purpose. That
rule exists so a model cannot fabricate a destination by writing one.

## 2. The direct authored forms

| Form               | Means               | Example                       | Notes                                                       |
| ------------------ | ------------------- | ----------------------------- | ----------------------------------------------------------- |
| `:name`            | An agent's session  | `:zelda`                      | Case-insensitive, 1–32 chars, letters/digits/`-`            |
| `@path`            | A file              | `@src/api.ts`, `@./README.md` | Session-relative, `./`-relative, or absolute inside the cwd |
| `@path:line`       | A file at one line  | `@src/api.ts:120`             | 1-based                                                     |
| `@path:line-end`   | A file line range   | `@src/api.ts:120-140`         | Inclusive; `end` must be ≥ `line`                           |
| `&ID`              | A task              | `&F12`, `&B7`, `&I3`, `&C1`   | Case-insensitive prefix, up to 9 digits; machine-wide       |
| `!AN`              | An agenda item      | `!A3`                         | Always `A` + a positive number; session-scoped              |
| `/name` or `$name` | A skill             | `/summary`, `$summary`        | **Lowercase only**; both sigils mean the same skill         |
| `%terminal:<key>`  | A live terminal     | `%terminal:dev`               | The terminal's name, or the daemon's id; session-scoped     |
| `%browser:<key>`   | A live browser page | `%browser:app`                | The page's name, or the worker's page id; session-scoped    |

Both skill sigils are accepted because the harnesses differ: Claude invokes a skill as `/name` and
Codex as `$name`. Whichever you type is what the reader keeps seeing — a reference is never rewritten
into "the canonical form" behind your back.

Terminals and browser pages are **surfaces**, and they are SESSION-scoped, as agenda ids are and
card ids are not — a card id is minted machine-wide and is unique on this machine's board. The
twelve hex characters that name a shell in one session name nothing at all in another, so a proved
surface carries both the daemon and the session it was proved against.
A surface reference is never an index — "the second terminal" shifts when a neighbour closes, and a
shifted reference is how an agent types into the wrong shell.

**A surface's NAME is the shared handle.** A terminal or page opened with a name — by a person, or by
an agent through the Ferretry tools (`terminal.open`, `browser.open`) — is written `%terminal:dev`
and `%browser:app`, and the agent's tools take exactly that name, so a reference in a message is a
handle the agent can use as-is. A name is a lowercase letter then up to 31 lowercase letters, digits or
dashes, unique within its session, and it may never be twelve hex characters: the id form
(`%terminal:0a1b2c3d4e5f`) keeps working for surfaces opened without a name and for every reference
written before names existed, and a name that could also be an id would make one key mean two shells.
The key grammar below is unchanged — a name is already a valid key.

### What is NOT a reference

- `#F12` and `?A3` — the pre-Ferretry sigils. Gone as output; use `&F12` and `!A3`. The CLI still
  accepts `#F12` as input for one release, and nothing prints it.
- A bare path (`src/api.ts`) — a path is only a reference with `@` in front of it.
- `@@`, `@@@`, `@@@@` — those are composer **triggers** (section 5), not authored syntax.
- `/plugin:skill`, `$apps/web:deploy` — a harness may accept these invocation forms; the reference
  grammar does not, because `:` and `/` are its own token boundaries.
- `$HOME`, `$PATH` — skill names are lowercase, so a shell variable is never read as a skill.
- `50%`, `100%` — a `%` only opens a surface candidate before `terminal:` or `browser:`.

### Boundaries

A token has to start at the beginning of the text or after whitespace or one of `([{"'`` ` ``<>=—–`,
and end at the end or before whitespace or ordinary punctuation. So `bob@example.com` is an address,
`and/or` is a word, and `see :zelda.` links `:zelda` and keeps the full stop.

## 3. Escaping

Put a backslash in front of the sigil, and the token stays literal text:

```text
write \:zelda to name an agent, and \&F12 to name a task
```

This works in prose and inside code. In prose Markdown eats the backslash, exactly as it does
everywhere else; inside code the backslash is part of the code and keeps rendering, because code is
never rewritten.

## 4. What each click opens

| Reference    | Click opens                                                                   |
| ------------ | ----------------------------------------------------------------------------- |
| `:agent`     | That agent's session, **on the daemon the reference was proved against**      |
| `@file`      | A file tab in the session workspace, scrolled to the referenced line or range |
| `&task`      | That card's detail on **this machine's board** (`/d/<daemon>/board/<id>`)     |
| `!attention` | The agenda panel at the top of this conversation, at that item                |
| `/skill`     | The Skills tab of this session's "This folder" context                        |
| `%terminal:` | That exact terminal instance's workspace tab, opened if it is not open        |
| `%browser:`  | That page's workspace tab, opened if it is not open, with the page in view    |

The `!attention` reference kind keeps its name in the grammar and in the proof table below; it points at the
agenda (renamed in a later release).

A modifier-click or middle-click is never intercepted: it is the reader asking their browser for a
new tab.

## 5. Composer triggers — the autocomplete matrix

Triggers are how a picker is opened. They are not authored syntax: what the picker inserts is always
one of the tokens in section 2.

| Trigger | Menu                | Inserts                             |
| ------- | ------------------- | ----------------------------------- |
| `@`     | Files               | `@path`                             |
| `@@`    | Fleet agents        | `:name`                             |
| `@@@`   | The agenda          | `!AN`                               |
| `:`     | Fleet agents        | `:name`                             |
| `!`     | The agenda          | `!AN`                               |
| `$`     | Skills              | `/name` on Claude, `$name` on Codex |
| `/`     | Commands and skills | `/name` on Claude, `$name` on Codex |
| `%`     | Live surfaces       | `%terminal:<key>`                   |

Every family is reachable two ways, and both ways read one source. The repeated-`@` ladder is the
DISCOVERABLE one — a single sigil, repeated, teaches three families from a legend — and the direct
sigil is what you use once you know, because it is the first character of the token itself.

**No menu offers tasks** (owner decision, 2026-10-16): there is no `@@@` task tier and `&` opens
nothing. Only the OFFER is withdrawn — an authored `&F12` still parses, proves and links (sections 2
and 6), and Add to chat still inserts one.

The picker inserts what the harness invokes, which is why `$` can insert `/name`: an invocation the
harness ignores is a broken offer. That is not the same as rewriting an authored reference, which
never happens.

There is deliberately no fourth `@@@@` tier: Pins are a top link strip, not a reference tier
(handover #63), and they are readable composer text rather than a second reference grammar. Template
libraries are not an `@` tier either, and no build of this app has ever had one.

`!` opens the agenda and nothing else. It was once a shell-command mode, that was removed on purpose,
and this is not that decision being reversed: no trigger in this document can run anything.

### The direct sigils are harder to open than `@`, `/` and `%`

`@`, `/` and `%` are acts nobody performs by accident. `:`, `&`, `!` and `$` are ordinary prose, so
they open only where all three of these hold:

1. **The grammar's own left boundary** (section 2) — so `note:`, `R&D`, `done!` and `US$5` stay
   inert, and a picker can never insert a token the renderer would refuse to prove.
2. **A query the family's token could still start with** — so `$HOME` is a shell variable and `&x` is
   not a task id.
3. **At least one query character** — a bare sigil never opens anything, because `A & B` and an
   emphatic `Yes!` are the common case rather than the edge case.

A direct-sigil menu also opens with **no row selected**. Enter therefore falls straight through to
sending the message until ArrowDown or a tap chooses a row, which is the difference between a helpful
menu and a composer that eats your Enter key. The `@`, `/` and `%` menus still preselect their first
row, exactly as before.

The `@` and `%` triggers use a slightly WIDER left boundary of their own — `see:@src` opens a file
picker although the grammar would not link `@src` there. That divergence predates the direct sigils
and is a known gap, not a second rule to copy: a new trigger asks `isReferenceLeftBoundary`.

While an IME composition is active no menu opens at all, and the trigger is re-read when the
composition ends: a candidate window and a suggestion list must not fight over the same bytes.

### Which keys open a menu, and the one thing that choice cannot do

Settings › Behaviour › **Open suggestions with** is a device-local choice (`suggestionKeys`):

| Choice               | Opens a menu                                                       |
| -------------------- | ------------------------------------------------------------------ |
| `@ ladder` (default) | `@` files, `@@` agents, `@@@` agenda items; `:` and `!` stay prose |
| `Symbols`            | `@` files, `:` agents, `!` agenda items; no `@@` tiers             |
| `Both`               | every row of the matrix above                                      |

A separate switch, `skillSuggestions` (on by default), governs `$` only. `/` and `%` open in every
mode, so a skill and a live terminal always have a way in.

**A key that opens no menu suppresses the MENU, never the grammar.** An authored reference still parses,
still proves and still links, "Add to chat" still inserts one, and a skill may still be written
either way. Turning a menu off removes an offer, never a capability.

## 6. Proof before link

**Syntax is never existence proof.** A token becomes a link only when a live resolver says its target
is real, at the moment it is painted — and it is asked again before a click is allowed to act,
because the fleet, the filesystem and the board all move while a transcript sits on screen.

An unproved token stays plain text. This is not a degraded state: it is the only honest one. A link
that goes nowhere costs the reader a tap and their trust.

What "proved" means per kind:

| Kind        | Proof                                                          |
| ----------- | -------------------------------------------------------------- |
| `agent`     | A session in **this daemon's** fleet slice holds that callsign |
| `file`      | The session filesystem answers with a canonical, readable path |
| `task`      | The id is on this machine's board (see the GAP below)          |
| `attention` | The id is in this session's agenda ledger, open or resolved    |
| `skill`     | The name is in this session's skills catalog                   |
| `surface`   | The session's owner is holding that terminal or page right now |

**A `&task` click opens the card, not a sheet.** The card detail is the Board's own route, so the link
survives a reload, Back leaves it, and the id is no longer dropped on the way (the Tasks sheet opened
with no card selected). A host with no router keeps the session's Tasks sheet. A card id is unique on
its machine only, so the destination always carries the daemon the reference was proved against.

> **GAP — task proof still reads the session's task catalog.** The proof set behind `&F12` is the
> composer's per-session task catalog, not a read of the machine's whole board; a card the board holds
> that this session never touched stays prose, and the detail itself answers "no card" for an id the
> machine does not have. Closing it needs a machine-wide id read in the session page; U16's `legacyRef`
> lookup (old per-session `#T3` ids) is not wired into the resolver yet either, so an old per-session
> id opens "no such card" rather than its migrated card.

A reader with no resolver for a kind cannot prove it, so that kind stays prose there. A missing
answer is refusal, never assumption: a fleet that has not been read yet is **not** a fleet with
nobody in it, and is treated as "cannot prove".

**A proof is read the way every other daemon read is.** The listing a `file` proof asks for travels
the carrier router, so a session on a daemon that only the relay reaches proves its paths too; and
the answer is parsed against the protocol's listing schema before any entry is believed, so a body
that is not a listing proves nothing rather than promoting a path.

**Surfaces have a third answer, and it is visible.** For every other family "we cannot prove it" and
"it is not there" are the same answer, so both render as prose. For a surface they are not: the
daemon's terminal listing for a session is a COMPLETE enumeration, so an id missing from it is proved
gone — and so is the session's browser status (`GET /v1/sessions/:id/browser`) for pages, while the
browser is `running`, `stopping` or `stopped` (a stopped browser holds no pages: they end with it).
While it is `starting` or in `error` its list proves nothing either way. A proved-closed surface renders as an inert tombstone (struck through, never a link) rather than
as prose, because silently reprinting the token would leave the reader and the agent believing they
still share a shell. No listing at all still proves nothing, and stays prose.

Everything is keyed by `(daemonId, …)`. A resolved agent reference carries the daemon it was proved
against and navigates to `/d/:daemon/session/:id`, so a reference in one daemon's transcript can
never open a same-named session on another. A resolved task reference carries the machine whose
board proved it, because a card id is unique there and nowhere else. Agenda ids still collide per
session, so an `!attention` reference stays session-scoped and resolves against the transcript's
own session — on the Board and on a card an ask is always shown with its card chip and its ferret,
so it is never ambiguous there.

## 7. References inside code

A proved sigil inside an inline backtick span or a fenced block renders as a clickable reference, and
**every surrounding byte is left untouched**:

````text
the fix is in `@src/api.ts:120`

```ts
const owner = ':zelda'; // clickable, and still a highlighted string literal
```
````

Rules:

1. Code keeps its own styling. A reference inside a fence inherits its highlight token's colour and
   is marked only by an underline.
2. Code content is decorated, never rewritten. The decoration is abandoned entirely rather than
   risking a changed byte — including when a highlighter's output cannot be read back to exactly the
   original text.
3. Unproved tokens and escaped tokens stay literal, the same as in prose.
4. A reference-shaped Markdown link inside code is still not a reference (section 1).
5. A proved-CLOSED surface stays literal inside code rather than becoming a tombstone: striking a
   token through would misrepresent the snippet as containing a `<del>`, and code is verbatim.

## 8. Adding a new reference kind

The grammar is meant to be extended in one place, not forked. To add a kind:

1. Add its token to the grammar and its shape to the `Reference` union in `references.ts`, with a
   right boundary that cannot swallow sentence punctuation.
2. Add a resolver to `ReferenceResolvers` — a boolean existence check unless the kind needs a
   canonical answer back, as `file` and `agent` do.
3. Add its arm to `formatReference`, `referenceHref`, `parseReferenceHref`, `referenceIdentity`,
   `resolveReference`, `revalidateReference` and `referenceTitle`. TypeScript's exhaustiveness will
   list them for you.
4. Add its opener to the renderer and to the per-session surface. A kind with no opener stays prose,
   which is the correct intermediate state to ship.

`%browser:` went through exactly that intermediate state: it parsed and encoded for months while
nothing could prove it. The surface resolver now reads the session's browser status as well as its
terminal listing (`packages/pwa/src/lib/surface-references.ts`), and the session page opens a proved
page in its own workspace tab.

## 9. Agenda message headings

Some chat messages are ABOUT agenda items: the owner's answer from a card, a request for more
information, a wish to talk an item through, and the owner's own message that references `!AN`. The
daemon words each with a bracketed heading — a kind, then every item it names as this grammar's `!AN`
token and its quoted ask or title — so the ferret always knows which item a message is about:

| Heading                           | Means                                    | What the card shows as the owner's words                               |
| --------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| `[answer to !A3 «ask»] …`         | The owner answered from the card         | The answer (a choice as a selected pill), and any `· note: …` under it |
| `[done !A3 «ask»] …`              | The owner marked it done, with no note   | The body as written                                                    |
| `[dismissed !A3 «ask»] …`         | The owner dismissed it                   | The body as written                                                    |
| `[needs more info !A3 «ask»] …`   | The owner needs more before answering    | Their note                                                             |
| `[discuss !A3 «title»] …`         | The owner wants to talk it through       | Their note, without the instructions to the ferret                     |
| `[re !A5 «title», !A7 «title»] …` | The owner's own chat message about items | What they typed                                                        |

A burst of board answers is ONE message: each form in turn, a blank line apart.

**One owner, both directions.** The writer and the reader are the same module,
`packages/protocol/src/lib/agenda-message.ts`: the daemon builds every heading through it, and the app
reads them back through `parseAgendaMessage` to draw each as a compact card (kind, the `!AN` chip, the
item's title, the owner's words) instead of raw text. Never parse or word a heading anywhere else — a
second reader is how the two drift apart.

The `!AN` in a card is an ordinary reference: proved against the session's ledger and opened exactly as
in section 4, or left as plain text when it cannot be proved. The text the ferret actually received is
always one tap away on the card ("Show sent text", and copy), so the card is a reading of the message,
never a replacement for it. A message that does not read as headings in full — prose before the first
heading, an unknown kind, an id that is not `A` and a positive number — is drawn as the words it is.
