# The Ferretry reference standard

`fy-reference/1`

This document is the contract for **references**: the sigil tokens that make a message, a task, an
agenda item, a notice, a file preview or a composer draft point at something real, and clickable.

It is written for two audiences at once, because they have to agree:

- **An agent or a person authoring text.** Sections 1 to 5 are all you need. They are the exact forms
  to type, what each one opens, and what happens when you type one that does not exist.
- **Somebody implementing a surface.** Sections 6 to 8 add the proof contract, the code-span rule,
  and how a new reference kind joins the system.

Reference implementation: `packages/app/src/references/grammar.ts` (the one grammar, the proof gate, and the remark
transform that reads it), `packages/app/src/references/code-spans.ts` (references inside code),
`packages/app/src/references/reference-surface.tsx` (the one per-surface bundle of resolvers and openers).

**Two readers, one scanner and one proof gate.** An assistant's message is read as Durian hypermedia by
`packages/plugins/conversation/app/hypermedia/hypermedia-prose.tsx`: `with-references.ts` lays the same scanner
(`findReferences`) over Durian's parsed tree, `reference-chip.tsx` and `reference-proof.tsx` prove each token at paint,
re-prove it at the click and open it (the one click behaviour), and `slots.tsx` draws code with the references proved
inside it. Every other Markdown surface — file previews, warden reports, skills, the composer — is the shell's
`packages/app/src/prose/markdown.tsx`, which reads the same scanner through `remarkReferences` and keeps its own
copy of the same click rule. The shared part is the scanner: the same sigils, boundaries and backslash-escape rule,
and the same proof bundle. **It is not a guarantee that both readers produce identical output on every input.** The
Durian reader works on a tree whose character references are already decoded, so `with-references.ts` (the
`CHARACTER_REFERENCE`, `DECODED_CHARACTER` and `splitRun` rules, lines 46-66 and the `withReferences` line that
decides `ambiguous`) adds one Durian-only heuristic: when the message source holds a character reference anywhere
(`&amp;`, `&#38;`), the first decoded `&`, `<`, `>`, `"` or `'` in a text node ends linking in that node, and a
reference after it stays prose. That fails closed, and the test is made over the whole message source while the
Markdown reader stops only in the text node that holds the character reference, so Durian can leave as prose a
reference the Markdown reader would link (a literal quote before a reference in one paragraph, when an `&amp;` sits
in another). That difference is read from the two sources, not pinned by a test.

The two readers are compared by a parity suite
(`packages/plugins/conversation/tests/unit/app/hypermedia/hypermedia-prose.test.tsx`, the "parity with the Markdown
reader" block), and its limits are part of the claim: it is a fixed corpus of 26 strings, each drawn by both readers
and compared as the list of linked tokens only (the `a[data-fy-reference]` and closed-reference text), not their
proofs, markup or clicks. It holds one character-reference case (`&amp; then :zelda`) and none of the
literal-quote-after-a-character-reference shape above. An input outside that corpus is not proven to agree.

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

| Form                 | Means                   | Example                       | Notes                                                           |
| -------------------- | ----------------------- | ----------------------------- | --------------------------------------------------------------- |
| `:name`              | An agent's session      | `:zelda`                      | Case-insensitive, 1–32 chars, letters/digits/`-`                |
| `@path`              | A file                  | `@src/api.ts`, `@./README.md` | Session-relative, `./`-relative, or absolute inside the cwd     |
| `@path:line`         | A file at one line      | `@src/api.ts:120`             | 1-based                                                         |
| `@path:line-end`     | A file line range       | `@src/api.ts:120-140`         | Inclusive; `end` must be ≥ `line`                               |
| `&ID`                | A task                  | `&F12`, `&B7`, `&I3`, `&C1`   | Case-insensitive prefix, up to 9 digits; machine-wide           |
| `^AN`                | An agenda item          | `^A3`                         | Always `A` + a positive number; session-scoped                  |
| `/name` or `$name`   | A skill                 | `/summary`, `$summary`        | **Lowercase only**; both sigils mean the same skill             |
| `%terminal:<key>`    | A live terminal         | `%terminal:dev`               | The terminal's name, or the daemon's id; session-scoped         |
| `%browser:<key>`     | A live browser page     | `%browser:app`                | The page's name, or the worker's page id; session-scoped        |
| `%attachment:<name>` | A file sent in the chat | `%attachment:spec.pdf`        | The name it was delivered under; session-scoped; not proved yet |

Both skill sigils are accepted because the harnesses differ: Claude invokes a skill as `/name` and
Codex as `$name`. Whichever you type is what the reader keeps seeing — a reference is never rewritten
into "the canonical form" behind your back.

Terminals and browser pages are **surfaces**, and they are SESSION-scoped, as agenda ids are and
task ids are not — a task id is minted machine-wide and is unique on this machine's board. The
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

**An attachment is named by the file name the agent was handed it under.** A file sent with a message is
copied into the ferret's own `attachments/<attachment id>/<name>` folder, and the message lists that path,
so `%attachment:spec.pdf` points at the file whose path ends in `/spec.pdf`. The name is `deliveredFilename`
(`@ferretry/core-mailbox/contract`, one owner for the daemon that writes the copy and the app that writes the token):
the base name with every character outside letters, digits, `_`, `.` and `-` turned into `-`. Unlike a terminal
key it may contain dots, because file names do; it starts and ends on a letter, digit or `_` (a closing full stop
or dash is the sentence's), is at most 128 characters and is case-sensitive. A file whose delivered name cannot be
written that way cannot be pointed at, and the plus on its tile says so instead of inserting it. Two files of one
name in one session are one token — a declared GAP.

The plus on a stored attachment's tile in the chat inserts this token through the shared
`conversation.add-to-chat` action (`app/composer/attachment-plus.tsx`). **GAP: nothing proves an attachment yet.**
No resolver reads a session's stored files, so the token stays plain text in a message — the honest intermediate
state §8 names — and the agent reads it as the name of the file it was handed. Proof, a link and a scroll to the
tile are the next step and need a stored-files listing the daemon does not serve today.

### The attention sigil is `^`, and `!A3` is only an alias

An agenda item is `^AN`. The first spelling was `!AN`, but a line that starts with `!` is a **shell
command** in Claude Code and Codex, and an agent that typed one there ran it. The composers were checked
(Claude Code 2.1.317, Codex 0.166, strings and shipped completions only): `!` (shell), `/` (commands),
`@` (files), `$` (Codex skills/apps) and an empty line's `?` (shortcuts) are special; `^`, `~`, `%`,
`&`, `+`, `=` and `*` are not.

- **Emitters write only `^AN`.** Every one of them formats through `askReference` /
  `ASK_REFERENCE_SIGIL` (`packages/core/asks/contract/snapshot/ask-reference.ts`, the one place the
  sigil is spelled); the grammar in `packages/app/src/references/grammar.ts` imports the same constants.
  A scan test fails any source file that writes a literal `!A<n>`.
- **Readers accept `!AN` as an alias**: it is parsed, proved and rendered as the same link, because the
  transcripts, agenda messages and notes already written carry it. It is never offered by a picker and
  never emitted, and it is read-only forever rather than "for one release".

### What is NOT a reference

- `#F12` and `?A3` — the pre-Ferretry sigils. Gone as output; use `&F12` and `^A3`. The CLI still
  accepts `#F12` as input for one release, and nothing prints it.
- A bare path (`src/api.ts`) — a path is only a reference with `@` in front of it.
- `@@`, `@@@`, `@@@@` — those are composer **triggers** (section 5), not authored syntax.
- `/plugin:skill`, `$apps/web:deploy` — a harness may accept these invocation forms; the reference
  grammar does not, because `:` and `/` are its own token boundaries.
- `$HOME`, `$PATH` — skill names are lowercase, so a shell variable is never read as a skill.
- `50%`, `100%` — a `%` only opens a surface candidate before `terminal:` or `browser:`.

### Boundaries

A token has to start at the beginning of the text or after whitespace or one of `([{"'`` ` ``<>=—–`,
and end at the end or before whitespace or ordinary punctuation. So `bob@example.com`is an address,`and/or`is a word, and`see :zelda.`links`:zelda` and keeps the full stop.

## 3. Escaping

Put a backslash in front of the sigil, and the token stays literal text:

```text
write \:zelda to name an agent, and \&F12 to name a task
```

This works in prose and inside code. In prose Markdown eats the backslash, exactly as it does
everywhere else; inside code the backslash is part of the code and keeps rendering, because code is
never rewritten.

## 4. What each click opens

| Reference    | Click opens                                                                           |
| ------------ | ------------------------------------------------------------------------------------- |
| `:agent`     | That agent's session, **on the daemon the reference was proved against**              |
| `@file`      | A file tab in the session workspace, scrolled to the referenced line or range         |
| `&task`      | The task detail on **this machine's board** (`/d/<daemon>/board/<id>`), in a chat too |
| `^attention` | That item's view over this conversation (a full page on a phone), whatever its state  |
| `/skill`     | The Skills tab of this session's "This folder" context                                |
| `%terminal:` | That exact terminal instance's workspace tab, opened if it is not open                |
| `%browser:`  | That page's workspace tab, opened if it is not open, with the page in view            |

The `^attention` reference kind keeps its name in the grammar and in the proof table below; it points at the
agenda (renamed in a later release).

Every id the proof accepts opens the SAME view — the one the agenda line, Info's agenda list, the Inbox and a
task's "Agenda asks" open. An open item is answered there; a parked one (snoozed, or replied to) says so and offers
"Back to my list"; a resolved one is read-only. Agenda mode does not gate it. A proved `^A3` is therefore never a dead
click, and no click switches a tab or a menu instead of opening the item (#B76).

A modifier-click or middle-click is never intercepted: it is the reader asking their browser for a
new tab.

## 5. Composer triggers — the autocomplete matrix

Triggers are how a picker is opened. They are not authored syntax: what the picker inserts is always
one of the tokens in section 2.

| Trigger | Menu                | Inserts                             |
| ------- | ------------------- | ----------------------------------- |
| `@`     | Files               | `@path`                             |
| `@@`    | Fleet agents        | `:name`                             |
| `@@@`   | The agenda          | `^AN`                               |
| `@@@@`  | Tasks               | `&FN`                               |
| `:`     | Fleet agents        | `:name`                             |
| `^`     | The agenda          | `^AN`                               |
| `&`     | Tasks               | `&FN`                               |
| `$`     | Skills              | `/name` on Claude, `$name` on Codex |
| `/`     | Commands and skills | `/name` on Claude, `$name` on Codex |
| `%`     | Live surfaces       | `%terminal:<key>`                   |

Every family is reachable two ways, and both ways read one source. The repeated-`@` ladder is the
DISCOVERABLE one — a single sigil, repeated, teaches four families from a legend — and the direct
sigil is what you use once you know, because it is the first character of the token itself.

**Tasks have a menu** (owner decision, 2026-10-30, which REVERSES the 2026-10-16 decision that no menu
offers tasks): `@@@@` is the fourth rung of the ladder and `&` is its direct sigil. Both insert
`&FN`, the token section 2 already parses, proves and links. Rows are newest and active first, closed
tasks stay hidden until the query names one exactly, and each row says the id, the title, the lane and
the owning ferret.

The picker inserts what the harness invokes, which is why `$` can insert `/name`: an invocation the
harness ignores is a broken offer. That is not the same as rewriting an authored reference, which
never happens.

There is deliberately no fifth `@@@@@` tier: Pins are a top link strip, not a reference tier
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

| Kind         | Proof                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `agent`      | A session in **this daemon's** fleet slice holds that callsign                                                            |
| `file`       | The session filesystem answers with a canonical, readable path                                                            |
| `task`       | Any task on this machine's board, whatever its project, or the old id of one of this session's imported tasks (see below) |
| `attention`  | The id is in this session's agenda ledger, open or resolved                                                               |
| `skill`      | The name is in this session's skills catalog                                                                              |
| `surface`    | The session's owner is holding that terminal or page right now                                                            |
| `attachment` | Not proved yet: no resolver reads a session's stored files, so the token stays prose (see §2)                             |

**A `&task` click opens the task, not a sheet.** The task detail is the Board's own route, so the link
survives a reload, Back leaves it, and the id is no longer dropped on the way (the Tasks sheet opened
with no task selected). Chat included: the host's own Tasks destination is only the fallback when the task
route is unavailable (an older daemon without `/v1/board`, or a host with no router). A task id is unique on
its machine only, so the destination always carries the daemon the reference was proved against.

> **Task proof is the whole machine; the menu is the project.** The proof set behind `&F12` is the id of
> EVERY task on this machine's board — whatever its project, lane, state or assignee, closed and dropped
> tasks included — so a lead that cites tasks from many projects gets a link for each real one. It is
> ONE read per machine, `GET /v1/board/ids` (`{ ids }`, nothing about a task but its id), made through
> the PWA's board store and shared by every surface that draws a reference: the cost is a request per
> machine, never one per reference. `board.changed` adds the ids it names, so a task made a moment ago
> links without a re-read, and the resolver is asked again before a click acts, against the set the feed keeps current. The route is `fleet`
> _use_ like `GET /v1/board` ([grants.md](grants.md)): a remote caller whose credential cannot read the
> board gets no list, and the references stay prose. A daemon from before the route answers 404; the
> proof then falls back to the session's project slice below, so an older machine loses nothing it had.
> Unknown ids stay prose, and the detail itself answers "no task" for an id the machine does not have.
>
> **The `&` / `@@@@` Tasks menu stays project-scoped; only the proof widens.** The rows it offers are
> ONE board read, `project = <the session's project>` with `state = all` and agent tasks included, made
> through the same store. Every open human task on the project is offered whatever its lane or
> assignee; "human" is the daemon's `origin`, falling back to the older owner/waiting guess only for a
> task with no `origin`. The menu shows the most relevant 50 and the query (id, title or summary)
> narrows them. A session with no project, or a daemon that cannot answer that read, falls back to this
> ferret's own slice (`ferret = <session>`). The chat's task search keeps the ferret slice. Offering
> every task on the machine would drown the menu; proving every task costs one id list.
>
> **The Board's task detail does not use this gate.** Its text is drawn by the Board's own small renderer
> (`packages/plugins/board/app/views/prose.tsx`), which turns any well-formed `&B`, `&F`, `&I` or `&C` id into a link
> to that task's Board path with no daemon read, so there a task id that names no task is still a link. `^A48`, `@file` and the other kinds are plain text there. This is
> a declared exception to proof before link, not a second implementation of it.
>
> **Old references resolve through the project read.** A task imported from one of this session's old
> tasks carries `legacyRef = <session>:<oldId>`. `&F12` in the transcript is proved when `F12` is a task on the
> slice, or when it is the old id of one: it stays written as `&F12` and its click opens the task that
> replaced it. A task on the slice wins over an old id that spells the same, and so does a task id
> anywhere on the machine; the two cannot be told apart by their text, which is the GAP — a session
> whose old `F12` and a new machine-board `F12` both exist always means the new one. Because the lookup
> is the board read itself, it needs no `GET /v1/board/tasks?legacyRef=` call per reference; the
> project limit applies to old ids, so an imported task that sits on another project stays prose.
> A reader with no resolver for a kind cannot prove it, so that kind stays prose there. A missing
> answer is refusal, never assumption: a fleet that has not been read yet is **not** a fleet with
> nobody in it, and is treated as "cannot prove".

**A proof is read the way every other daemon read is.** The listing a `file` proof asks for travels
the carrier router, so a session on a daemon that only the relay reaches proves its paths too; and
the answer is parsed against the protocol's listing schema before any entry is believed, so a body
that is not a listing proves nothing rather than promoting a path.

**Surfaces have a third answer, and it is visible.** For every other family "we cannot prove it" and
"it is not there" are the same answer, so both render as prose. For a surface they are not: the
daemon's terminal listing for a session is a COMPLETE enumeration, so an id missing from it is proved
gone — and so is the session's browser status (`GET /v1/ferrets/:ferretId/browser`) for pages, while the
browser is `running`, `stopping` or `stopped` (a stopped browser holds no pages: they end with it).
While it is `starting` or in `error` its list proves nothing either way. A proved-closed surface renders as an inert tombstone (struck through, never a link) rather than
as prose, because silently reprinting the token would leave the reader and the agent believing they
still share a shell. No listing at all still proves nothing, and stays prose.

Everything is keyed by `(daemonId, …)`. A resolved agent reference carries the daemon it was proved
against and navigates to `/d/:daemon/session/:id`, so a reference in one daemon's transcript can
never open a same-named session on another. A resolved task reference carries the machine whose
board proved it, because a task id is unique there and nowhere else. Agenda ids still collide per
session, so an `^attention` reference stays session-scoped and resolves against the transcript's
own session — on the Board and on a task an ask is always shown with its task chip and its ferret,
so it is never ambiguous there.

**A `task` or `board` hypermedia block is a pointer under the same gate.** Its payload is nothing but `&F12` tokens, read by the same
token reader; what it draws (title, lane, progress, PRs) is whatever the board answered, and a task the daemon did not
answer is never a link or a frame, only a quiet note. It is drawn only where the surface lends a board to read
(`cardEmbed`, offered with a task route); anywhere else the fence stays an ordinary code fence
([fy-render.md](fy-render.md#tasks-and-boards)).

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
6. An inline span shows the bytes the author typed, character references included: `` `&lt;demo&gt;` `` reads
   `&lt;demo&gt;` and `` `<demo>` `` reads `<demo>`. Decoration therefore sees the author's own token, never a
   decoded stand-in. (Hypermedia's parser decodes the six common references before the reader sees a span, so the
   reader claims exactly the spans that hold one and draws their source text; a span over 400 characters that holds
   one is read decoded, a declared GAP until the parser hands over literal code.)
7. In the chat's hypermedia reading, code is the one code component of
   `packages/plugins/conversation/app/hypermedia/slots.tsx`, so rules 1 to 6 hold for a span and a fence there, and
   for a ` ```chart ` or ` ```codewalk ` fence, which is held as code
   ([fy-render.md](fy-render.md#where-a-block-renders-and-where-it-cannot)). A reference is **not** read inside a
   part Durian draws as a part (a terminal, a file tree, an editor, a tier list, an animation): that text belongs to
   the part, not to the prose around it, and a sigil there stays the text it was written as. It is read in prose
   (paragraphs, headings, quotes, callouts, lists, table cells) including the bodies of tabs, accordions and
   `:::human` containers.

## 8. Adding a new reference kind

The grammar is meant to be extended in one place, not forked. To add a kind:

1. Add its token to the grammar and its shape to the `Reference` union in `grammar.ts`, with a
   right boundary that cannot swallow sentence punctuation.
2. Add a resolver to `ReferenceResolvers` — a boolean existence check unless the kind needs a
   canonical answer back, as `file` and `agent` do.
3. Add its arm to `formatReference`, `referenceHref`, `parseReferenceHref`, `referenceIdentity`,
   `resolveReference`, `revalidateReference` and `referenceTitle`. TypeScript's exhaustiveness will
   list them for you.
4. Add its opener to the per-session surface, which both readers draw from (the chat's is
   `packages/plugins/conversation/app/chat/reference-surface.ts`). A kind with no opener stays prose,
   which is the correct intermediate state to ship.

`%browser:` went through exactly that intermediate state: it parsed and encoded for months while
nothing could prove it. The surface resolver now reads the session's browser status as well as its
terminal listing (`packages/app/src/references/surface-references.ts`), and the session page opens a proved
page in its own workspace tab.

## 9. Agenda message headings

Some chat messages are ABOUT agenda items: the owner's answer from an item, a request for more
information, a wish to talk an item through, and the owner's own message that references `^AN`. The
daemon words each with a bracketed heading — a kind, then every item it names as this grammar's `^AN`
token and its quoted ask or title — so the ferret always knows which item a message is about:

| Heading                           | Means                                    | What the item shows as the owner's words                               |
| --------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| `[answer to ^A3 «ask»] …`         | The owner answered from the item         | The answer (a choice as a selected pill), and any `· note: …` under it |
| `[done ^A3 «ask»] …`              | The owner marked it done, with no note   | The body as written                                                    |
| `[dismissed ^A3 «ask»] …`         | The owner dismissed it                   | The body as written                                                    |
| `[needs more info ^A3 «ask»] …`   | The owner needs more before answering    | Their note                                                             |
| `[discuss ^A3 «title»] …`         | The owner wants to talk it through       | Their note, without the instructions to the ferret                     |
| `[re ^A5 «title», ^A7 «title»] …` | The owner's own chat message about items | What they typed                                                        |

A burst of board answers is ONE message: each form in turn, a blank line apart.

**One owner, both directions.** The writer and the reader are the same module,
`packages/core/asks/contract/snapshot/agenda-message.ts`: the daemon builds every heading through it, and the app
reads them back through `parseAgendaMessage` to draw each as a compact item (kind, the `^AN` chip, the
item's title, the owner's words) instead of raw text. Never parse or word a heading anywhere else — a
second reader is how the two drift apart.

The `^AN` in an item is an ordinary reference: proved against the session's ledger and opened exactly as
in section 4, or left as plain text when it cannot be proved. The text the ferret actually received is
always one tap away on the item ("Show sent text", and copy), so the item is a reading of the message,
never a replacement for it. A message that does not read as headings in full — prose before the first
heading, an unknown kind, an id that is not `A` and a positive number — is drawn as the words it is.

## 10. Inputs are agenda items

An [input request](input-requests.md) is an agenda item of `kind: 'input'`, so it is cited exactly as
every other item: `^AN`, proved against the session's ledger, opened as in section 4. **There is no
new sigil.** Two consequences for this grammar:

- A message about an input uses the existing headings (`[delivered ^A7 …]` is worded by the
  daemon's agenda path). The heading never carries the value, and no heading is ever built from an
  input answer, because the generic agenda answer refuses `kind: 'input'`.
- The `^AN` of an input is a pointer to the item, nothing more. The item's own kind, `Input`, is
  drawn from the item's `kind` like the others.
