import { AGENDA_SEGMENT_PARAGRAPH_LENGTH, agendaShapeHelp } from '@ferretry/protocol';
import type { Command } from 'commander';
import type { NotifyOptions } from '../notify/commands.ts';
import { ASK_KIND_NAMES } from './ask.ts';
import type {
  AgendaAddOptions,
  AgendaClearOptions,
  AgendaCommandOptions,
  AgendaController,
  AgendaEditOptions,
  AgendaLogOptions,
  AgendaResolveOptions,
  AgendaRestOptions,
  AgendaSnoozeOptions,
  AgendaSplitOptions,
  AgendaStepOptions,
  AgendaSurfaceOptions,
} from './controller.ts';

const SESSION_FLAG = '-s, --session <id>';
const SESSION_HELP =
  'target another session; an agent may mutate only its own session; a lead may also edit, surface, done or dismiss in a sub-ferret it started (defaults to the current session)';
const JSON_FLAG = '--json';
const JSON_HELP = 'print the protocol payload instead of the human rendering';

/**
 * The body rule (docs/agenda.md § Stage, the tabs, and the detail; the owner: "the chat is the stream of log, the
 * body is the DB, like an event store"): `fy agenda --help`, `add --help` and `edit --help` all say it, in the words
 * the Agenda-mode prompt (`AGENDA_INSTRUCTION`) says in short.
 */
export const AGENDA_BODY_RULE = `THE TABS ARE THE LIVE DOCUMENT; the conversation is only the log.
  ALWAYS KEEP THE ITEM CURRENT: before every update read it whole (agenda show <id> --yaml), then
  rewrite every part that is out of date — premise, context, the ask (what you need from the
  owner), its options and how to reply, still-open and each tab — so the item always holds the
  whole current state, and write it back in one go: agenda patch <id> --file f.yaml.
  EVERY ASK AND ANSWER ON A TOPIC STACKS ON THE SAME ITEM, and an open ask is never dropped: every
  unresolved ask stays floated in "where we are" (premise, context) and in "what I need from you"
  (the ask). An answered question moves to a "History" tab, oldest first, each marked answered
  with its answer. Open a new item only for a clearly separate topic.
  Tabs hold ANY kind of content — status, to-dos, steps, instructions, explainers, results,
  decisions, risks. There is no main type: "Where we are now" (--where-file, or --where points)
  is simply the tab that opens first: where things stand, what is decided, what is still open —
  as long and as rich as it needs to be.
  SPLIT THE REST BY CONTENT TYPE, never serial content: each kind gets a tab of its own, named for
  what it holds: --tab-file "Name=file" (6 at most); --rename-tab, --move-tab, --remove-tab.
  A long continuous report, explainer or argument, where each part builds on the last, stays ONE
  tab, "The full picture" (--body-file). One kind of content is one tab: never invent tabs. With
  everything in tabs of its own, the body may stay empty. Rewrite a tab whole whenever it
  changes: one edit is one version, and the owner sees which tabs changed.
  STEPS AND EXPLAINERS LIVE IN THE TABS AND STAY THERE, after the ask is answered too; a to-do's
  --step boxes are only what the owner ticks off.
  Never retype a tab into the conversation: answer there briefly and point at it.
  Write in explainer mode, ADHD-friendly (answer first, one idea per line, plain words, an example
  for each point), shown with hypermedia: fy-render charts, mermaid, an interactive html visual the
  reader changes (sliders, toggles, inputs that redraw it; never a stepper), card and board blocks. Plain Markdown draws no fold: fold a long part inside an fy-render
  html block (<details><summary>…</summary>…</details>).`;

/**
 * The patch rule (docs/agenda.md § Patch: the item as one document): `fy agenda patch --help` says it whole.
 */
const AGENDA_PATCH_RULE = `READ, THEN WRITE THE WHOLE ITEM. \`agenda show <id> --yaml\` prints every part the owner reads
and the item's revision; update every part that is out of date and write it back:
\`agenda patch <id> --file f.yaml\` (YAML or JSON; - or no --file reads stdin).
  The revision is REQUIRED: an item that changed since you read it (the owner answered, the ask moved
  on, anything was rewritten) is refused and nothing is written — read it again.
  JSON Merge Patch (RFC 7386), one level deep: a key present REPLACES the field, an absent key leaves
  it, null REMOVES it. tabs merge BY NAME: "Name: |" with Markdown makes or rewrites that tab, "Name:
  null" removes it. Every other list or object (decided, links, steps, questions, recommendation,
  ask) is replaced whole.
  Values equal to the item's are not sent, so writing back what you read changes nothing and an
  unchanged kind never re-asks the owner. Unknown or read-only keys are refused by name.
  null never removes title, summary, why, howToResolve, premise or context (rewrite them) nor the
  ask (a new kind replaces it). It is the edit action: same checks, same lint, same rules on whose
  item it is.

Example:
  revision: 3k9x1q0z2b7
  summary: Ship the patch command this week?
  why: The command is built; shipping it needs your yes.
  whereWeAre: |
    The patch command is built and reviewed; CI is green.
  decided: [JSON Merge Patch, tabs by name]
  stillOpen: null
  tabs:
    Status: |
      - Now: waiting for the merge
    Risks: null`;

const WRITING_GUIDE = `The reader has NOT been following this session. Write for that reader, in point form:
  --title        REQUIRED. What this is about, in a few plain words (aim for 40 characters, 60 at most,
                 no IDs): it heads the card and is the notification's title — not the conversation's name
  <the ask>      the ASK: a short title-like line, about 80 characters at most, answer first — not backstory;
                 the detail goes in the body (--body-file); no # headings in the ask or any segment (the
                 card draws them huge). It is the notification's body (\`--ask\` says the same when it is
                 not given as words)
  --premise      REQUIRED. The SITUATION: what is going on, so a cold reader starts here; plain lines, no
                 leading "- " (the card adds the bullet); repeat for one
                 bullet each (a --confirms card's premise is the daemon's: the held change)
  --context      REQUIRED. The CONTEXT: the facts around the situation that bear on the ask; repeat for bullets
  --decided      earlier answers that bear on this item, one bullet each (repeat)
  --still-open   what is still open to decide, one bullet each (repeat); update it as the talk goes on
  --term         TERM=meaning for every codename or term of art you use (repeat)
  --question     each thing they must answer (repeat); --option gives a lone question its choices
  --option       a choice's label, ONE word (a longer one letters them all); "Label: what it means" adds a one-line
                 detail, --option-detail "Label=markdown" a longer one
  --field        one field of a FORM (--kind form), repeat in order: "id|one/many/yesno/text|Question|option|option…"
                 (options "Label: what it means", a leading * recommends one; "Name~Question" names its answer line)
  --recommend    your suggested decision (an option label, or the answer in words); --recommend-why
  --impact       what happens if nobody answers; --urgency by when ("before the 14:00 deploy")
  --link         a PR, file or reference worth opening, "label=target=meaning" (repeat): the label is a word
                 or two (no / ? & \\), the meaning says in plain words what it is; "label=target" and a bare
                 target also work, but warn. A target with an = of its own (?id=7, docs/a=b.md) and a
                 one-word meaning cannot be told apart: use --json-file (the CLI says when it kept an =)
  --step         when the human must DO something: one Markdown step each, in order (repeat) — the
                 complete instructions (commands in code blocks, where to click, what to paste where;
                 never a secret value), so the item alone is enough
  --where-file   "Where we are now", the tab that opens first, a Markdown file (- reads stdin): where things stand, whole
                 (--where gives it as points instead, one each, repeat)
  --body-file    "The full picture", a Markdown file (- reads stdin): the report, explainer or plan
  --tab-file     a tab of your own, "Name=file" (repeat, 6 at most; see THE TABS ARE THE LIVE DOCUMENT below)
  --json-file    the same fields as JSON (- reads stdin); flags win over the file

THE RULE IS ISOLATION: could the owner answer with nothing else open? A card is read cold, so it
carries everything the answer needs. Premise and context are required because they are where a cold
reader starts — write them for that reader, not to fill a box.
Every field renders as markdown: short bullets, one idea each, no walls of text; a fence in the body
(fy-render) draws a chart or diagram when a picture beats words. Never use ticket or PR numbers,
internal codenames, file paths or unexplained capitals — say it in plain words, or define the term
with --term. The daemon warns when an item breaks these; fix it with
\`edit <id>\`. Agenda items never expire on a timer. The owner's answer or reply RESTS an item, waiting
on you: \`answer <id> "<text>"\` brings it back to them, \`rest <id> --why "<what>"\` while you work on it,
and \`done\` closes it once nothing more is expected — only you (or the owner's own done or dismiss)
close it, so run \`done\` or \`dismiss\` yourself the moment it is settled. An item whose reason is gone
but is still open is a bug, not a safe default.

${AGENDA_BODY_RULE}

The card is swiped, so it offers at most 3 answers (left, up, right) — see --kind below.

JSON body (title and ask are required; questions and options may be plain strings):
  {"title": "OCI work login",
   "ask": "Approve the OCI work-login plan?", "kind": "choice",
   "premise": ["Your work login expires every day", "A plan exists to keep it alive"],
   "context": "The plan adds a 30-min keepalive, so you stop being logged out.",
   "decided": ["You chose the shared account earlier"],
   "terms": [{"term": "OCI", "meaning": "Oracle Cloud Infrastructure"}],
   "questions": [{"question": "Which plan?", "options": ["Defaults", "I'll reply with changes"],
                  "recommended": "Defaults", "why": "Matches what runs today"}],
   "recommendation": {"decision": "Defaults", "why": "Lowest risk"},
   "impact": "You stay logged out of work accounts", "urgency": "today",
   "links": [{"label": "Plan", "target": "&F12", "meaning": "The plan to keep the login alive"}],
   "steps": ["Open **Settings** and choose Logins", "Run \`fy login work\` and paste the code it prints"],
   "body": "Anything longer than a list, as Markdown"}`;

/**
 * `fy agenda add --help`'s kinds: the protocol's one table of answer shapes (`agendaShapeHelp`), an example each,
 * then the answers each kind swipes with.
 */
const askKinds = (fy: string): string => `${agendaShapeHelp(fy)}

The answers a card gives, as buttons and swipes (left · up · right):
  choice       the options, in order (2 or 3; more is refused: split the item); the --recommend option is tagged
  yesno        ← No · → Yes                 (it brings its own options)
  permission   ← Deny · → Approve           (--up "Always allow" adds ↑, which approves)
  review       ← Request changes · → Approve (Request changes takes the owner's words from the reply box)
  todo         → Mark as done               (--up "Skip" adds ↑ Skip)
  info         → Got it                     (something to know; never where a question's answer goes)
  reply        none: the reply box is the answer (the default)
(task, open, multiple-choice and answer-review are still accepted as older names.) --up-why "<line>" describes
the --up answer. Without --kind: steps alone are a todo, --option makes a choice (exactly Yes and No, a yesno),
one --question with options is a choice, and plain questions — one or several — are a reply.

Segments (--premise, --context, --decided, --still-open, --question-answer, --body): short points, answer first, no
paragraphs. One paragraph over ${AGENDA_SEGMENT_PARAGRAPH_LENGTH} characters draws a warning: split this into short points (- …) or bold the answer first.`;

/**
 * The open rule, as `fy agenda add --help` says it first (docs/agenda.md § One channel per topic): the same model the
 * Agenda mode prompt teaches (`AGENDA_INSTRUCTION`), in the words the add's own listing uses.
 */
export const AGENDA_OPEN_RULE = `ONE AGENDA IS ONE CHANNEL of the owner's attention: everything in it is heard in the same place,
against the same background, decided at the same pace.
  Search, check, then open: add first lists your open agendas, closest first, and asks "Should this join !A3?"
  with the exact edit that adds the ask there instead. Two things share one agenda when all three hold: same
  place, same context, same pace. Dependent things always share one (a card that depends on, or blocks, a card
  an open agenda carries is listed first). Open a new one only when none passes: --new "<why none fits>". If
  unsure, add to the closest. Split off a part that stops passing the test.
  The owner's reply rests an item (quiet); your answer on it brings it back to Needs you. Only you mark it Done,
  when nothing more is expected.`;

const DISMISS_POLICY = `Agents may dismiss only agenda items they raised themselves.
A human may dismiss any agenda item. Every dismissal remains in the resolution audit.`;

/** Add the shared flags every attention verb carries. */
function scoped(command: Command): Command {
  return command.option(SESSION_FLAG, SESSION_HELP).option(JSON_FLAG, JSON_HELP);
}

/**
 * Mounts `fy agenda …` onto the program, and `fy attention …` as its deprecated spelling: the same
 * verbs, the same handlers, and one line on stderr saying the name moved.
 *
 * There is NO default verb: raising an item puts it on the owner's agenda, so it takes the explicit `add`. A
 * first word that is not a verb (`fy agenda show A6`, a typo) is refused with the verbs on offer, never read
 * as the summary of a new item.
 */
/** Sends one plain notification: `fy notify`'s own run, handed in so the alias cannot drift from it. */
export type AgendaNotifier = (words: readonly string[], options: NotifyOptions) => Promise<void>;

export function registerAgendaCommands(program: Command, controller: AgendaController, notify?: AgendaNotifier): void {
  mountVerbs(
    scoped(
      program
        .command('agenda')
        .description('your agenda: what the owner has to decide or do, and what it blocks')
        .addHelpText('after', `\n${WRITING_GUIDE}`),
    ),
    'agenda',
    controller,
    undefined,
  );
  mountVerbs(
    scoped(
      program
        .command('attention', { hidden: true })
        .description('deprecated: this is now `fy agenda`')
        .hook('preAction', () => {
          controller.deprecatedAlias();
        }),
    ),
    'attention',
    controller,
    notify,
  );
}

function mountVerbs(
  root: Command,
  name: string,
  controller: AgendaController,
  notify: AgendaNotifier | undefined,
): void {
  const agenda = root.argument('[verb...]', 'what to do: one of the commands below').action((words: string[]) => {
    throw new Error(unknownVerb(name, words, verbNames(agenda)));
  });

  const merged = <T extends AgendaCommandOptions>(command: Command): T => ({
    ...(agenda.opts() as T),
    ...(command.opts() as T),
  });

  scoped(
    agenda
      .command('add')
      .description('open an agenda for what the owner must decide or do — only when no open one fits')
      .argument('[ask...]', 'the ask: one line naming what the human must decide or do')
      .option('-t, --title <text>', 'REQUIRED: what this is about, plain words, aim for 40 characters, no IDs')
      .option('--ask <line>', 'the ask, when it is not given as words')
      .option('--summary <line>', 'the same as --ask (the older name)')
      .option(`-k, --kind <kind>`, `what the human does: ${ASK_KIND_NAMES.join(', ')}`)
      .option('--up <label>', 'the extra up-swipe answer of a todo (dismisses, e.g. "Skip") or a permission (approves)')
      .option('--up-why <line>', 'one line that describes the --up answer')
      .option('--task <card>', 'the board card this item belongs to (F18 or &F18; your focus card when omitted)')
      .option(
        '--offer-close',
        'give the owner a "Done · closes <card>" button: one tap resolves this item AND closes its card (needs --task, or your focus card; on by default for a to-do or review on a card waiting to be tried)',
      )
      .option('--todo', 'a to-do: the human does something; nothing to choose (steps with no question imply it)')
      .option(
        '--related <id>',
        'work this belongs to: a card (F12) links it there; an agenda item (A3) is edited, not duplicated',
      )
      .option('--new <why>', 'open a new agenda although open ones are listed: say why none fits')
      .option(
        '-o, --option <label>',
        'a choice label, or "Label: why" to add its one-line detail; repeat for each option',
        collect,
        [],
      )
      .option('--option-detail <label=markdown>', "an option's longer explanation, in Markdown; repeat", collect, [])
      .option(
        '--field <spec>',
        'one field of a form (--kind form): "id|one/many/yesno/text|Question|option|option…"; repeat for each field, in order',
        collect,
        [],
      )
      .option(
        '--premise <point>',
        'the situation: what is going on; a plain line, no leading "- " (repeat for more points)',
        collect,
        [],
      )
      .option(
        '-c, --context <point>',
        'the facts around the situation that bear on the ask; a plain line, no leading "- " (repeat for more points)',
        collect,
        [],
      )
      .option(
        '--decided <point>',
        'an earlier answer that bears on this; a plain line, no leading "- " (repeat for more points)',
        collect,
        [],
      )
      .option(
        '--still-open <point>',
        'what is still open to decide; a plain line, no leading "- " (repeat for more points)',
        collect,
        [],
      )
      .option('-w, --why <reason>', 'why this needs the human now (defaults to the ask)')
      .option('-r, --resolve <how>', 'the concrete action that clears it')
      .option('--term <TERM=meaning>', 'spell out one piece of jargon; repeat', collect, [])
      .option('-q, --question <text>', 'one thing the human must answer; repeat', collect, [])
      .option('--recommend <decision>', 'your suggested decision: an option label, or the answer in words')
      .option('--recommend-why <reason>', 'why you recommend it')
      .option(
        '--impact <point>',
        'what happens if nobody answers; a plain line, no leading "- " (repeat for more points)',
        collect,
        [],
      )
      .option('--urgency <when>', 'by when it matters, in words')
      .option(
        '-l, --link <label=target=meaning>',
        'a PR, file or reference worth opening, with what it is in plain words; repeat',
        collect,
        [],
      )
      .option('--step <markdown>', 'one step the human follows, in order; repeat', collect, [])
      .option('--body-file <path>', '"The full picture": the report, explainer or plan, a Markdown file or - for stdin')
      .option('--where-file <path>', 'the main tab, "Where we are now", a Markdown file or - for stdin')
      .option('--tab-file <name=file>', 'a tab of your own, its words from a Markdown file; repeat', collect, [])
      .option('--blocking', 'you are stopped until the owner answers')
      .option('--will-block <thing>', 'what this will block, in a few words (e.g. "the 14:00 deploy")')
      .option('--by <time>', 'when it is needed: ISO, "in 3h" or a clock time like 17:00')
      .option(
        '--confirms <file>',
        "a config file with a change held for the owner (fy config status): the owner's Allow applies it; the card's answers are Allow, Deny, Discard change",
      )
      .option(
        '--stage <stage>',
        'what it needs from the owner now: explainer, question, plan, tracker or test (its kind says when absent)',
      )
      .option(
        '--where <point>',
        'the main tab as points: where things stand now, one point each (repeat); or --where-file',
        collect,
        [],
      )
      .option('--detail <markdown>', 'the context explained from zero, for a reader new to the topic (shown folded)')
      .option('--json-file <path>', 'read these fields as JSON from a file, or - for stdin')
      .addHelpText('after', `\n${AGENDA_OPEN_RULE}\n\n${AGENDA_BODY_RULE}\n\n${askKinds(root.parent?.name() ?? 'fy')}`),
  ).action(async (words: string[], _flags: unknown, command: Command) => {
    await controller.add(words, merged<AgendaAddOptions>(command));
  });

  scoped(
    agenda
      .command('edit')
      .description(
        "rewrite an open item you raised: its writing, its stage, or — with --kind — a NEW ask (it asks again, fresh); an item resting on the owner's reply stays resting unless you answer on it (agenda answer)",
      )
      .argument('<id>', 'the item reference, like !A3')
      .option('-t, --title <text>', 'the new title: what this is about, aim for 40 characters')
      .option('--summary <line>', 'the new one-line ask')
      .option(
        '--premise <point>',
        'replace the premise (the situation); a plain line, no leading "- " (repeat for more points)',
        collect,
        [],
      )
      .option(
        '-c, --context <point>',
        'replace the context; a plain line, no leading "- " (repeat for more points)',
        collect,
        [],
      )
      .option(
        '--decided <point>',
        'replace the earlier answers; a plain line, no leading "- " (repeat for more points)',
        collect,
        [],
      )
      .option(
        '--still-open <point>',
        'replace what is still open; a plain line, no leading "- " (repeat for more points)',
        collect,
        [],
      )
      .option('--term <TERM=meaning>', 'replace the terms with these; repeat', collect, [])
      .option('-q, --question <text>', "reword the item's questions, in order, one per question; repeat", collect, [])
      .option(
        '-k, --kind <kind>',
        `REPLACE the ask with a new one of this kind (${ASK_KIND_NAMES.join(', ')}): --option and --question then name its options and questions`,
      )
      .option(
        '-o, --option <label-and-detail>',
        "an existing option's detail; with --kind, a new option (repeat)",
        collect,
        [],
      )
      .option('--option-detail <label=markdown>', "replace an option's longer explanation; repeat", collect, [])
      .option('--field <spec>', "replace a form's fields with these, all of them, in order; repeat", collect, [])
      .option('--recommend <decision>', 'replace the recommendation')
      .option('--recommend-why <reason>', 'why you recommend it')
      .option(
        '--impact <point>',
        'replace what happens if nobody answers; a plain line, no leading "- " (repeat for more points)',
        collect,
        [],
      )
      .option('--urgency <when>', 'replace by when it matters')
      .option(
        '-l, --link <label=target=meaning>',
        'replace the links with these (the meaning says what each is); repeat',
        collect,
        [],
      )
      .option('--step <markdown>', 'replace the steps with these, in order; repeat (clears ticks)', collect, [])
      .option('--body-file <path>', 'rewrite "The full picture" with this Markdown file, or - for stdin')
      .option(
        '--where-file <path>',
        'rewrite the main tab, "Where we are now", with this Markdown file, or - for stdin',
      )
      .option(
        '--tab-file <name=file>',
        'make or rewrite a tab of your own with this Markdown file; repeat',
        collect,
        [],
      )
      .option('--rename-tab <old=new>', 'rename a tab of your own; repeat', collect, [])
      .option(
        '--move-tab <name=position>',
        'move a tab of your own (1 = first after the full picture); repeat',
        collect,
        [],
      )
      .option('--remove-tab <name>', 'remove a tab of your own; repeat', collect, [])
      .option(
        '--question-answer <markdown>',
        'the same as `agenda answer`: your answer to the owner, shown above its options; a resting item goes back to their list',
      )
      .option('--clear-question-answer', "take a stale answer to the owner's question off the item")
      .option('--stage <stage>', 'what it needs from the owner now: explainer, question, plan, tracker or test')
      .option(
        '--where <point>',
        'replace the main tab with points: where things stand now, one point each (repeat); or --where-file',
        collect,
        [],
      )
      .option('--detail <markdown>', 'replace the context explained from zero')
      .option('--blocking', 'you are stopped until the owner answers')
      .option('--not-blocking', 'you are no longer stopped')
      .option('--will-block <thing>', 'what this will block, in a few words')
      .option('--clear-will-block', 'drop what this will block')
      .option('--by <time>', 'when it is needed: ISO, "in 3h" or a clock time like 17:00')
      .option('--clear-by', 'drop when it is needed')
      .option('--now', 'it is urgent: wake the item even though the owner snoozed it (at most once an hour)')
      .addHelpText('after', `\n${AGENDA_BODY_RULE}`),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.edit(id, merged<AgendaEditOptions>(command));
  });

  scoped(
    agenda
      .command('answer')
      .description(
        'answer the owner on an item you raised: shown above its ask; one resting on their reply goes back to their list, in its old place',
      )
      .argument('<id>', 'the item reference, like !A3')
      .argument('<text...>', 'your answer, as Markdown'),
  ).action(async (id: string, words: string[], _flags: unknown, command: Command) => {
    await controller.answer(id, words, merged(command));
  });

  scoped(
    agenda
      .command('rest')
      .description(
        'take an item on without asking the owner anything yet: it rests as working, quiet and never nudged, until you answer on it or mark it done',
      )
      .argument('<id>', 'the item reference, like !A3')
      .option('-w, --why <line>', 'REQUIRED: what you are doing about it, in a line'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.rest(id, merged<AgendaRestOptions>(command));
  });

  scoped(
    agenda
      .command('log')
      .description(
        "keep what the owner said in chat on the item, word for word: you give YOUR words, the daemon copies theirs from this session's chat",
      )
      .argument('<id>', 'the item reference, like !A3')
      .option('--reply <text>', 'your answer to what they said; the item goes back to their list, in its old place')
      .option('--rest <text>', 'what you are doing about it; the item rests as working')
      .option('--message <id>', 'log this chat message of theirs instead of the latest')
      .addHelpText(
        'after',
        '\nOne of --reply or --rest. Their words are refused when they are not theirs, not from this session, or already logged.',
      ),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.log(id, merged<AgendaLogOptions>(command));
  });

  scoped(
    agenda
      .command('merge')
      .description(
        'merge a duplicate into an item: both conversations (by time), every card and link are kept; the duplicate closes as merged',
      )
      .argument('<into>', 'the item that stays, like !A2')
      .argument('<from>', 'the item that is absorbed, like !A5'),
  ).action(async (into: string, from: string, _flags: unknown, command: Command) => {
    await controller.merge(into, from, merged(command));
  });

  scoped(
    agenda
      .command('split')
      .description(
        'split a new item off one that grew two asks: written as an add is, linked both ways, named cards moved to it',
      )
      .argument('<id>', 'the item to split, like !A5')
      .argument('<ask...>', "the NEW item's ask: one line naming what the owner must decide or do")
      .option('-t, --title <text>', 'REQUIRED: what the new item is about, plain words')
      .option('--premise <point>', 'the situation (repeat for more points)', collect, [])
      .option('-c, --context <point>', 'the facts around it (repeat for more points)', collect, [])
      .option('--decided <point>', 'an earlier answer that bears on it (repeat)', collect, [])
      .option('--still-open <point>', 'what is still open to decide (repeat)', collect, [])
      .option(`-k, --kind <kind>`, `what the owner does: ${ASK_KIND_NAMES.join(', ')}`)
      .option('--stage <stage>', 'explainer, question, plan, tracker or test')
      .option('--move-cards <cards>', 'cards of the item that go to the new one, like F12,F13')
      .option('--body-file <path>', 'a Markdown file for the new item, or - for stdin')
      .option('--json-file <path>', 'read these fields as JSON from a file, or - for stdin'),
  ).action(async (id: string, words: string[], _flags: unknown, command: Command) => {
    await controller.split(id, words, merged<AgendaSplitOptions>(command));
  });

  scoped(
    agenda
      .command('step')
      .description('tick a step of an open item, counted from 1 as ls prints them')
      .argument('<id>', 'the item reference, like !A3')
      .argument('<n>', 'the step number')
      .option('--undo', 'untick the step instead'),
  ).action(async (id: string, number: string, _flags: unknown, command: Command) => {
    await controller.step(id, number, merged<AgendaStepOptions>(command));
  });

  scoped(
    agenda
      .command('show')
      .description('print one item in full — read-only')
      .argument('<id>', 'the item reference, like !A3')
      .option('--tab <name>', 'print only this tab, exactly as written: main, body, or a tab of your own')
      .option(
        '--yaml',
        'print the editable document `agenda patch` takes back: every field you may change, tabs by name',
      ),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.show(id, merged(command));
  });

  scoped(
    agenda
      .command('patch')
      .description(
        'change an open item you raised as ONE YAML or JSON document — premise, context, the main tab, every tab, the ask — in one atomic edit (read it with `agenda show <id> --yaml`)',
      )
      .argument('<id>', 'the item reference, like !A3')
      .option('-f, --file <path>', 'the YAML or JSON document; - (the default) reads standard input')
      .option('--now', 'it is urgent: an item the owner snoozed wakes too (at most once an hour)')
      .addHelpText(
        'after',
        `
${AGENDA_PATCH_RULE}`,
      ),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.patch(id, merged(command));
  });

  scoped(agenda.command('ls').alias('list').description('list open items, oldest first')).action(
    async (_flags: unknown, command: Command) => {
      await controller.list(merged(command));
    },
  );

  scoped(agenda.command('history').alias('resolved').description('show the resolution audit, newest first')).action(
    async (_flags: unknown, command: Command) => {
      await controller.history(merged(command));
    },
  );

  scoped(
    agenda
      .command('needs-info')
      .description('ask the ferret that raised an item for more information; the item stays open')
      .argument('<id>', 'the item reference, like !A3')
      .option('-n, --note <text>', 'what is missing, told to the ferret'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.needsInfo(id, merged<AgendaResolveOptions>(command));
  });

  scoped(
    agenda
      .command('discuss')
      .description('ask the ferret that raised an item to talk it through before you answer; the item stays open')
      .argument('<id>', 'the item reference, like !A3')
      .option('-n, --note <text>', 'what is unclear or wrong, told to the ferret'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.discuss(id, merged<AgendaResolveOptions>(command));
  });

  scoped(
    agenda
      .command('surface')
      .description(
        'hand an item back to the owner, or bring back one their reply parked: it is their turn again (never pings)',
      )
      .argument('<id>', 'the item reference, like !A3')
      .option('-w, --why <line>', 'one line on why the owner must look now, for example what is still open')
      .option('--now', 'it is urgent: wake the item even though the owner snoozed it (at most once an hour)'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.surface(id, merged<AgendaSurfaceOptions>(command));
  });

  scoped(
    agenda
      .command('snooze')
      .description('put an item away until later (owner): it leaves the list and comes back as new')
      .argument('<id>', 'the item reference, like !A3')
      .option('--for <time>', 'how long: like 4h, 90m or 1d')
      .option('--until <time>', 'until when: ISO, "in 3h" or a clock time like 17:00'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.snooze(id, merged<AgendaSnoozeOptions>(command));
  });

  scoped(
    agenda
      .command('unsnooze')
      .description('bring a snoozed or replied-to item back to the list now (owner)')
      .argument('<id>', 'the item reference, like !A3'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.unsnooze(id, merged<AgendaCommandOptions>(command));
  });

  scoped(
    agenda
      .command('clear')
      .description('clear the agent ferrets’ backlog: dismiss every open item on non-interactive sessions (owner)')
      .option('--agents', 'clear the boards of the agent ferrets (the only thing there is to clear yet)')
      .option('--yes', 'do not ask first'),
  ).action(async (_flags: unknown, command: Command) => {
    await controller.clearAgents(merged<AgendaClearOptions>(command));
  });

  scoped(
    agenda
      .command('send-now')
      .description('deliver the answers held for the ferret now, instead of after the quiet window'),
  ).action(async (_flags: unknown, command: Command) => {
    await controller.sendNow(merged(command));
  });

  scoped(
    agenda
      .command('done')
      .alias('resolve')
      .description('resolve an item, optionally answering its ask')
      .argument('<id>', 'the item reference, like !A3')
      .option('-n, --note <text>', 'a note recorded with the resolution')
      .option(
        '--reason <text>',
        'why you close a question the owner has not answered (required: the owner sees it as withdrawn)',
      )
      .option('--approve', 'answer a permission ask with approval')
      .option('--reject', 'answer a permission ask with a refusal')
      .option('--choice <label>', 'answer a multiple-choice ask with one option label')
      .option('--yes', 'answer a yes-or-no card with Yes')
      .option('--no', 'answer a yes-or-no card with No')
      .option('--good', 'answer an answer-review ask: the answer is good')
      .option('--clarify <text>', 'answer an answer-review ask: ask for a clarification')
      .option('--answer <text>', 'answer an open question')
      .option('--other <text>', 'answer with your own words instead of the options (any ask that offers options)'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.resolve(id, merged<AgendaResolveOptions>(command));
  });

  scoped(
    agenda
      .command('dismiss')
      .description('dismiss an item without answering it — recorded with who dismissed it')
      .argument('<id>', 'the item reference, like !A3')
      .option('-n, --note <text>', 'a note recorded with the dismissal')
      .addHelpText('after', `\n${DISMISS_POLICY}`),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.dismiss(id, merged<AgendaResolveOptions>(command));
  });

  if (notify === undefined) return;
  scoped(
    agenda
      .command('notify')
      .description('send the owner a plain notification — nothing to decide (the same as `fy notify`)')
      .argument('<summary...>', 'one line saying what the owner should know')
      .option('--body <markdown>', 'the longer reading behind the summary, as Markdown')
      .option('--ping', "buzz the owner's phone for this notice")
      .addHelpText(
        'after',
        '\nA notice is read, not answered. Put something on the agenda (add) when the owner must decide or do.',
      ),
  ).action(async (words: string[], _flags: unknown, command: Command) => {
    await notify(words, merged<AgendaCommandOptions & NotifyOptions>(command));
  });
}

/** Every verb `fy agenda` answers to, in the order its help lists them, aliases included. */
function verbNames(agenda: Command): string[] {
  return agenda.commands.flatMap(command => [command.name(), ...command.aliases()]);
}

/** Why a first word that names no verb is refused, and what to type instead. */
function unknownVerb(name: string, words: readonly string[], verbs: readonly string[]): string {
  const [first] = words;
  const offered = verbs.join(', ');
  if (first === undefined) return `${name} needs a command. Did you mean: ${offered}`;
  return `unknown command '${first}'. Did you mean: ${offered} — raise an item with \`${name} add --title "<what>" "<the ask>"\``;
}

/** commander's repeatable-option reducer: `--option a --option b` collects both. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
