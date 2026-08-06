# The Ferretry reference standard

`fy-reference/1`

This document is the contract for **references**: the sigil tokens that make a message, a task, an
Attention item, a notice, a file preview or a composer draft point at something real, and clickable.

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
| `&ID`              | This session's task | `&F12`, `&B7`, `&I3`, `&C1`   | Case-insensitive prefix, up to 9 digits                     |
| `&ID@{session}`    | An exact task owner | `&F12@{mshahp8i-fb9fe194}`    | Session id is exact and case-sensitive                      |
| `!AN`              | An Attention item   | `!A3`                         | Always `A` + a positive number                              |
| `/name` or `$name` | A skill             | `/summary`, `$summary`        | **Lowercase only**; both sigils mean the same skill         |
| `%terminal:<key>`  | A live terminal     | `%terminal:0a1b2c3d4e5f`      | The daemon's own terminal id; session-scoped                |
| `%browser:<key>`   | A live browser page | `%browser:page-1`             | The worker's own page key; session-scoped                   |

Both skill sigils are accepted because the harnesses differ: Claude invokes a skill as `/name` and
Codex as `$name`. Whichever you type is what the reader keeps seeing — a reference is never rewritten
into "the canonical form" behind your back.

Task ids belong to sessions. The durable bare form `&F12` always means F12 in the session being read;
it is never searched across a Shared board. The additive qualified form puts the exact owner after
the id: `&F12@{Session_A-1}`. Braces are required, the task id case-folds to uppercase, and every byte
of the session id keeps its authored case. Session ids may contain letters, digits, `.`, `_`, and `-`,
are at most 128 characters, must begin with a letter or digit, and cannot be `.` or `..`.

Terminals and browser pages are **surfaces**. The twelve hex characters that name a shell in one
session name nothing at all in another, so a proved surface carries both the daemon and the session
it was proved against. A surface reference is never an index — "the second terminal" shifts when a
neighbour closes, and a shifted reference is how an agent types into the wrong shell.

### What is NOT a reference

- `#F12` and `?A3` — the pre-Ferretry sigils. Gone; use `&F12` and `!A3`.
- A bare path (`src/api.ts`) — a path is only a reference with `@` in front of it.
- `@@`, `@@@`, `@@@@` — those are composer **triggers** (section 5), not authored syntax.
- `/plugin:skill`, `$apps/web:deploy` — a harness may accept these invocation forms; the reference
  grammar does not, because `:` and `/` are its own token boundaries.
- `$HOME`, `$PATH` — skill names are lowercase, so a shell variable is never read as a skill.
- `50%`, `100%` — a `%` only opens a surface candidate before `terminal:` or `browser:`.
- `&F12@{}`, `&F12@{.}`, `&F12@{../other}`, `&F12@{missing` — malformed task qualifiers. None
  becomes a bare `&F12` link; the whole attempted qualified token remains prose.

### Boundaries

A token has to start at the beginning of the text or after whitespace or one of `([{"'`` ` ``<>=—–`,
and end at the end or before whitespace or ordinary punctuation. So `bob@example.com` is an address,
`and/or` is a word, and `see :zelda.` links `:zelda` and keeps the full stop.

For a qualified task the right boundary is checked after `}`: `&F12@{Session_A-1}.` keeps the full
stop. `@` is deliberately not a right boundary for a bare task, so an empty, unsafe, overlong,
unterminated, or otherwise malformed qualifier can never degrade to a link for its `&F12` prefix.

## 3. Escaping

Put a backslash in front of the sigil, and the token stays literal text:

```text
write \:zelda to name an agent, and \&F12 to name a task
```

This works in prose and inside code. In prose Markdown eats the backslash, exactly as it does
everywhere else; inside code the backslash is part of the code and keeps rendering, because code is
never rewritten.

## 4. What each click opens

| Reference                   | Click opens                                                              |
| --------------------------- | ------------------------------------------------------------------------ |
| `:agent`                    | That agent's session, **on the daemon the reference was proved against** |
| `@file`                     | A file tab in the side pane, scrolled to the referenced line or range    |
| bare `&task`                | The Tasks pane for this session                                          |
| qualified `&task@{session}` | Not wired yet — the later Shared-board surface will select the exact row |
| `!attention`                | The Attention pane for this session                                      |
| `/skill`                    | The Skills pane for this session                                         |
| `%terminal:`                | That exact terminal instance's tab                                       |
| `%browser:`                 | Nothing yet — no browser worker exists to prove a page, see section 7    |

A modifier-click or middle-click is never intercepted: it is the reader asking their browser for a
new tab.

## 5. Composer triggers — the autocomplete matrix

Triggers are how a picker is opened. They are not authored syntax: what the picker inserts is always
one of the tokens in section 2.

| Trigger | Menu                 | Inserts                             |
| ------- | -------------------- | ----------------------------------- |
| `@`     | Files                | `@path`                             |
| `@@`    | Fleet agents         | `:name`                             |
| `@@@`   | This session's tasks | `&ID`                               |
| `@@@@`  | Attention            | `!AN`                               |
| `:`     | Fleet agents         | `:name`                             |
| `&`     | This session's tasks | `&ID`                               |
| `!`     | Attention            | `!AN`                               |
| `$`     | Skills               | `/name` on Claude, `$name` on Codex |
| `/`     | Commands and skills  | `/name` on Claude, `$name` on Codex |
| `%`     | Live surfaces        | `%terminal:<key>`                   |

Every family is reachable two ways, and both ways read one source. The repeated-`@` ladder is the
DISCOVERABLE one — a single sigil, repeated, teaches four families from a legend — and the direct
sigil is what you use once you know, because it is the first character of the token itself.

The picker inserts what the harness invokes, which is why `$` can insert `/name`: an invocation the
harness ignores is a broken offer. That is not the same as rewriting an authored reference, which
never happens.

The `&` and `@@@` pickers remain local by default and insert bare tokens. When the later Shared-board
surface supplies an action for a foreign row, it will generate the qualified spelling through
`formatReference` and deliver it into the current/viewer's composer, never the owner's composer.

There is deliberately no fifth `@@@@@` tier: Pins are a top link strip, not a reference tier
(handover #63), and they are readable composer text rather than a second reference grammar. Template
libraries are not an `@` tier either, and no build of this app has ever had one.

`!` opens Attention and nothing else. It was once a shell-command mode, that was removed on purpose,
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

### Three switches, and the one thing they cannot do

Settings carries three device-local switches, all on by default:

| Switch                       | Governs                                       |
| ---------------------------- | --------------------------------------------- |
| `mentionSuggestions`         | the whole `@` ladder, bare `@` files included |
| `directReferenceSuggestions` | `:` `&` `!`                                   |
| `skillSuggestions`           | `$` only                                      |

`/` and `%` are never governed, so a skill and a live terminal always have a way in.

**A disabled switch suppresses the MENU, never the grammar.** An authored reference still parses,
still proves and still links, "Add to chat" still inserts one, and a skill may still be written
either way. Turning a menu off removes an offer, never a capability.

## 6. Proof before link

**Syntax is never existence proof.** A token becomes a link only when a live resolver says its target
is real, at the moment it is painted — and it is asked again before a click is allowed to act,
because the fleet, the filesystem and the board all move while a transcript sits on screen.

An unproved token stays plain text. This is not a degraded state: it is the only honest one. A link
that goes nowhere costs the reader a tap and their trust.

What "proved" means per kind:

| Kind             | Proof                                                                      |
| ---------------- | -------------------------------------------------------------------------- |
| `agent`          | A session in **this daemon's** fleet slice holds that callsign             |
| `file`           | The session filesystem answers with a canonical, readable path             |
| bare `task`      | The id is in this session's local task snapshot                            |
| qualified `task` | The exact current-session local row or authorized foreign Shared board row |
| `attention`      | The id is in this session's Attention ledger                               |
| `skill`          | The name is in this session's skills catalog                               |
| `surface`        | The session's owner is holding that terminal or page right now             |

A reader with no resolver for a kind cannot prove it, so that kind stays prose there. A missing
answer is refusal, never assumption: a fleet that has not been read yet is **not** a fleet with
nobody in it, and is treated as "cannot prove".

**Surfaces have a third answer, and it is visible.** For every other family "we cannot prove it" and
"it is not there" are the same answer, so both render as prose. For a surface they are not: the
daemon's terminal listing for a session is a COMPLETE enumeration, so an id missing from it is proved
gone. A proved-closed surface renders as an inert tombstone (struck through, never a link) rather than
as prose, because silently reprinting the token would leave the reader and the agent believing they
still share a shell. No listing at all still proves nothing, and stays prose.

Everything is keyed by `(daemonId, …)`. A resolved agent reference carries the daemon it was proved
against and navigates to `/d/:daemon/session/:id`, so a reference in one daemon's transcript can
never open a same-named session on another.

A task resolver answers with the identity it proved; truthiness is not proof. The answer must carry
a nonblank daemon id, a safe exact session id, and the normalized task id that was asked for. A
qualified answer must also carry the exact session that was asked for. Bare lookup is offered only
the local-session input; a qualified foreign lookup is offered only ready, authorized Shared board
rows. An aggregate row can never satisfy a bare token.

Resolved task links carry the exact five-key envelope
`#fy-reference?kind=task&daemon=<daemon>&session=<session>&id=F12&form=<local|qualified>` and identity
`task:<daemon>:<session>:F12:<form>`. On a primary unmodified click the renderer asks the same lookup
again and requires the daemon, session, id, and form to equal the painted link. A scope change,
missing/refused aggregate, lost membership, or missing row makes it inert. Modifier and middle
clicks retain the browser's own behavior.

The older internal `kind=task&id=F12` href and `task:F12` identity were ephemeral DOM artifacts, not
durable authored syntax. The strict decoder refuses them; a transcript already open across this
upgrade may leave those old painted links inert until it repaints or reloads.

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

Bare and qualified task tokens follow the same rule. `&F12@{Session_A-1}` inside inline or fenced
code may be decorated when proved, but its braces, case, and every surrounding byte are unchanged.

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

`%browser:` is in exactly that intermediate state today: it parses and encodes, and nothing can prove
it — there is no browser worker and no authoritative page list, so a page is neither open nor
demonstrably closed. Teaching one resolver about pages is the whole remaining change.

Qualified tasks extend the existing `task` kind; they are not a second reference family. Any change
to their shape must update the task arm of `parseReferenceToken`/`findReferences`, `formatReference`,
`resolveReference`, `referenceHref`/`parseReferenceHref`, `referenceIdentity`, `revalidateReference`,
and `referenceTitle` together. `formatReference` is the sole owner of both `&F12` and
`&F12@{session}` spelling, including generated composer and task-board text.
