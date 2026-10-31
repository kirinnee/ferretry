import { agendaShapeHelp } from '@ferretry/protocol';
import type { Command } from 'commander';
import type { NotifyOptions } from '../notify/commands.ts';
import { ASK_KIND_NAMES } from './ask.ts';
import type {
  AgendaAddOptions,
  AgendaClearOptions,
  AgendaCommandOptions,
  AgendaController,
  AgendaEditOptions,
  AgendaResolveOptions,
  AgendaSnoozeOptions,
  AgendaStepOptions,
  AgendaSurfaceOptions,
} from './controller.ts';

const SESSION_FLAG = '-s, --session <id>';
const SESSION_HELP =
  'target another session; an agent may mutate only its own session; a lead may also edit, surface, done or dismiss in a sub-ferret it started (defaults to the current session)';
const JSON_FLAG = '--json';
const JSON_HELP = 'print the protocol payload instead of the human rendering';

const WRITING_GUIDE = `The reader has NOT been following this session. Write for that reader, in point form:
  --title        REQUIRED. What this is about, in a few plain words (aim for 40 characters, 60 at most,
                 no IDs): it heads the card and is the notification's title — not the conversation's name
  <the ask>      the ASK: one plain sentence, 120 characters or fewer, answer first — not backstory;
                 it is the notification's body (\`--ask\` says the same when it is not given as words)
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
  --recommend    your suggested decision (an option label, or the answer in words); --recommend-why
  --impact       what happens if nobody answers; --urgency by when ("before the 14:00 deploy")
  --link         a PR, file or reference worth opening (repeat)
  --step         when the human must DO something: one Markdown step each, in order (repeat) — the
                 complete instructions (commands in code blocks, where to click, what to paste where;
                 never a secret value), so the item alone is enough
  --body-file    a Markdown file (- reads stdin) for instructions that are not a list
  --json-file    the same fields as JSON (- reads stdin); flags win over the file

THE RULE IS ISOLATION: could the owner answer with nothing else open? A card is read cold, so it
carries everything the answer needs. Premise and context are required because they are where a cold
reader starts — write them for that reader, not to fill a box.
Every field renders as markdown: short bullets, one idea each, no walls of text; a fence in --body
(fy-render) draws a chart or diagram when a picture beats words. Never use ticket or PR numbers,
internal codenames, file paths or unexplained capitals — say it in plain words, or define the term
with --term. The daemon warns when an item breaks these; fix it with
\`edit <id>\`. Agenda items never expire on a timer. Answering or dismissing on the agenda already
resolves it — but if the blocker clears some OTHER way (the human answers in chat, the work is no
longer needed), the raising agent must run \`done\` or \`dismiss\` itself, immediately. An item
whose reason is gone but is still open is a bug, not a safe default.

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
   "links": [{"label": "Plan", "target": "&F12"}],
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
  info         → Got it                     (also where the answer to the owner's question goes)
  reply        none: the reply box is the answer (the default)
(task, open, multiple-choice and answer-review are still accepted as older names.) --up-why "<line>" describes
the --up answer. Without --kind: steps alone are a todo, --option makes a choice (exactly Yes and No, a yesno),
one --question with options is a choice, and plain questions — one or several — are a reply.`;

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
      .description('raise something a human must decide or do')
      .argument('[ask...]', 'the ask: one line naming what the human must decide or do')
      .option('-t, --title <text>', 'REQUIRED: what this is about, plain words, aim for 40 characters, no IDs')
      .option('--ask <line>', 'the ask, when it is not given as words')
      .option('--summary <line>', 'the same as --ask (the older name)')
      .option(`-k, --kind <kind>`, `what the human does: ${ASK_KIND_NAMES.join(', ')}`)
      .option('--up <label>', 'the extra up-swipe answer of a todo (dismisses, e.g. "Skip") or a permission (approves)')
      .option('--up-why <line>', 'one line that describes the --up answer')
      .option(
        '--task [card]',
        'the board card this item belongs to (F18 or &F18; your focus card when omitted); a bare --task is the older --todo',
      )
      .option(
        '--offer-close',
        'give the owner a "Done · closes <card>" button: one tap resolves this item AND closes its card (needs --task, or your focus card; on by default for a to-do or review on a card waiting to be tried)',
      )
      .option('--todo', 'a to-do: the human does something; nothing to choose (steps with no question imply it)')
      .option(
        '-o, --option <label>',
        'a choice label, or "Label: why" to add its one-line detail; repeat for each option',
        collect,
        [],
      )
      .option('--option-detail <label=markdown>', "an option's longer explanation, in Markdown; repeat", collect, [])
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
      .option('-l, --link <target>', 'a PR, file or reference worth opening; repeat', collect, [])
      .option('--step <markdown>', 'one step the human follows, in order; repeat', collect, [])
      .option('--body-file <path>', 'a Markdown file of instructions, or - for stdin')
      .option('--blocking', 'you are stopped until the owner answers')
      .option('--will-block <thing>', 'what this will block, in a few words (e.g. "the 14:00 deploy")')
      .option('--by <time>', 'when it is needed: ISO, "in 3h" or a clock time like 17:00')
      .option(
        '--confirms <file>',
        "a config file with a change held for the owner (fy config status): the owner's Allow applies it; the card's answers are Allow, Deny, Discard change",
      )
      .option('--json-file <path>', 'read these fields as JSON from a file, or - for stdin')
      .addHelpText('after', `\n${askKinds(root.parent?.name() ?? 'fy')}`),
  ).action(async (words: string[], _flags: unknown, command: Command) => {
    await controller.add(words, merged<AgendaAddOptions>(command));
  });

  scoped(
    agenda
      .command('edit')
      .description(
        'reword an open item you raised — only the writing, never the ask; on your turn it hands the item back to the owner',
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
      .option('-o, --option <label-and-detail>', "give an existing option's detail; repeat", collect, [])
      .option('--option-detail <label=markdown>', "replace an option's longer explanation; repeat", collect, [])
      .option('--recommend <decision>', 'replace the recommendation')
      .option('--recommend-why <reason>', 'why you recommend it')
      .option(
        '--impact <point>',
        'replace what happens if nobody answers; a plain line, no leading "- " (repeat for more points)',
        collect,
        [],
      )
      .option('--urgency <when>', 'replace by when it matters')
      .option('-l, --link <target>', 'replace the links with these; repeat', collect, [])
      .option('--step <markdown>', 'replace the steps with these, in order; repeat (clears ticks)', collect, [])
      .option('--body-file <path>', 'replace the body with this Markdown file, or - for stdin')
      .option('--blocking', 'you are stopped until the owner answers')
      .option('--not-blocking', 'you are no longer stopped')
      .option('--will-block <thing>', 'what this will block, in a few words')
      .option('--clear-will-block', 'drop what this will block')
      .option('--by <time>', 'when it is needed: ISO, "in 3h" or a clock time like 17:00')
      .option('--clear-by', 'drop when it is needed')
      .option('--now', 'it is urgent: wake the item even though the owner snoozed it (at most once an hour)'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.edit(id, merged<AgendaEditOptions>(command));
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
      .argument('<id>', 'the item reference, like !A3'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.show(id, merged(command));
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
