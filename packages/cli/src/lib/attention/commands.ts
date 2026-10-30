import type { Command } from 'commander';
import type { NotifyOptions } from '../notify/commands.ts';
import { ASK_KIND_NAMES } from './ask.ts';
import type {
  AttentionAddOptions,
  AttentionCommandOptions,
  AttentionController,
  AttentionEditOptions,
  AttentionResolveOptions,
  AttentionStepOptions,
  AttentionSurfaceOptions,
} from './controller.ts';

const SESSION_FLAG = '-s, --session <id>';
const SESSION_HELP =
  'target another session; an agent may mutate only its own session (defaults to the current session)';
const JSON_FLAG = '--json';
const JSON_HELP = 'print the protocol payload instead of the human rendering';

const WRITING_GUIDE = `The reader has NOT been following this session. Write for that reader, in point form:
  --title        REQUIRED. What this is about, in a few plain words (aim for 40 characters, 60 at most,
                 no IDs): it heads the card and is the notification's title — not the conversation's name
  <the ask>      the ASK: one plain sentence, 120 characters or fewer, answer first — not backstory;
                 it is the notification's body (\`--ask\` says the same when it is not given as words)
  --premise      the SITUATION: what is going on, so a cold reader starts here; repeat for one bullet each
  --context      WHY IT MATTERS NOW and the supporting facts (not the situation); repeat for bullets
  --decided      earlier answers that bear on this item, one bullet each (repeat)
  --still-open   what is still open to decide, one bullet each (repeat); update it as the talk goes on
  --term         TERM=meaning for every codename or term of art you use (repeat)
  --question     each thing they must answer (repeat); --option gives a lone question its choices
  --recommend    your suggested decision (an option label, or the answer in words); --recommend-why
  --impact       what happens if nobody answers; --urgency by when ("before the 14:00 deploy")
  --link         a PR, file or reference worth opening (repeat)
  --step         when the human must DO something: one Markdown step each, in order (repeat) — the
                 complete instructions (commands in code blocks, where to click, what to paste where;
                 never a secret value), so the item alone is enough
  --body-file    a Markdown file (- reads stdin) for instructions that are not a list
  --json-file    the same fields as JSON (- reads stdin); flags win over the file

THE RULE IS ISOLATION: could the owner answer with nothing else open? A card is read cold, so it
carries everything the answer needs — premise and context are guides to that, not boxes to tick.
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
   "links": [{"label": "Plan", "target": "#F12"}],
   "steps": ["Open **Settings** and choose Logins", "Run \`fy login work\` and paste the code it prints"],
   "body": "Anything longer than a list, as Markdown"}`;

const ASK_KINDS = `--kind says what the human DOES, and the answers the card swipes with (left · up · right):
  task         do something: ← Need more info · → Done      (--up "Skip" adds ↑ Skip)
  yesno        a yes-or-no question: ← No · → Yes            (it brings its own options)
  permission   approve or reject: ← Deny · → Allow          (--up "Always allow" adds ↑, which approves)
  choice       pick one of 2 or 3 --option labels; the --recommend option (else the first) is →
  review       say the answer is good, or ask for a clarification: ← Needs changes · → Looks good
  info         nothing to decide, only to read: → Got it
  reply        write a full answer (the default); no swipes
(open, multiple-choice and answer-review are still accepted as older names.) More than 3 options is
refused: split the item, or use --kind reply. --up-why "<line>" describes the --up answer.
Without --kind, steps with no question are a task, --option makes a choice (exactly Yes and No, a yesno),
one --question with options is a choice, and several questions are answered in words.`;

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
export type AttentionNotifier = (words: readonly string[], options: NotifyOptions) => Promise<void>;

export function registerAttentionCommands(
  program: Command,
  controller: AttentionController,
  notify?: AttentionNotifier,
): void {
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
  controller: AttentionController,
  notify: AttentionNotifier | undefined,
): void {
  const attention = root.argument('[verb...]', 'what to do: one of the commands below').action((words: string[]) => {
    throw new Error(unknownVerb(name, words, verbNames(attention)));
  });

  const merged = <T extends AttentionCommandOptions>(command: Command): T => ({
    ...(attention.opts() as T),
    ...(command.opts() as T),
  });

  scoped(
    attention
      .command('add')
      .description('raise something a human must decide or do')
      .argument('[ask...]', 'the ask: one line naming what the human must decide or do')
      .option('-t, --title <text>', 'REQUIRED: what this is about, plain words, aim for 40 characters, no IDs')
      .option('--ask <line>', 'the ask, when it is not given as words')
      .option('--summary <line>', 'the same as --ask (the older name)')
      .option(`-k, --kind <kind>`, `what the human does: ${ASK_KIND_NAMES.join(', ')}`)
      .option('--up <label>', 'the extra up-swipe answer of a task (dismisses, e.g. "Skip") or a permission (approves)')
      .option('--up-why <line>', 'one line that describes the --up answer')
      .option(
        '--task [card]',
        'the board card this item belongs to (F18 or &F18; your focus card when omitted); a bare --task is the older --todo',
      )
      .option('--todo', 'a to-do: the human does something; nothing to choose (steps with no question imply it)')
      .option('-o, --option <label>', 'a choice label; repeat for each option', collect, [])
      .option('--premise <point>', 'the situation: what is going on; repeat for bullet points', collect, [])
      .option(
        '-c, --context <point>',
        'why it matters now and the supporting facts; repeat for bullet points',
        collect,
        [],
      )
      .option('--decided <point>', 'an earlier answer that bears on this; repeat for bullet points', collect, [])
      .option('--still-open <point>', 'what is still open to decide; repeat for bullet points', collect, [])
      .option('-w, --why <reason>', 'why this needs the human now (defaults to the ask)')
      .option('-r, --resolve <how>', 'the concrete action that clears it')
      .option('--term <TERM=meaning>', 'spell out one piece of jargon; repeat', collect, [])
      .option('-q, --question <text>', 'one thing the human must answer; repeat', collect, [])
      .option('--recommend <decision>', 'your suggested decision: an option label, or the answer in words')
      .option('--recommend-why <reason>', 'why you recommend it')
      .option('--impact <point>', 'what happens if nobody answers; repeat for bullet points', collect, [])
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
      .addHelpText('after', `\n${ASK_KINDS}`),
  ).action(async (words: string[], _flags: unknown, command: Command) => {
    await controller.add(words, merged<AttentionAddOptions>(command));
  });

  scoped(
    attention
      .command('edit')
      .description(
        'reword an open item you raised — only the writing, never the ask; on your turn it hands the item back to the owner',
      )
      .argument('<id>', 'the item reference, like !A3')
      .option('-t, --title <text>', 'the new title: what this is about, aim for 40 characters')
      .option('--summary <line>', 'the new one-line ask')
      .option('--premise <point>', 'replace the premise (the situation); repeat for bullet points', collect, [])
      .option('-c, --context <point>', 'replace the context; repeat for bullet points', collect, [])
      .option('--decided <point>', 'replace the earlier answers; repeat for bullet points', collect, [])
      .option('--still-open <point>', 'replace what is still open; repeat for bullet points', collect, [])
      .option('--term <TERM=meaning>', 'replace the terms with these; repeat', collect, [])
      .option('-q, --question <text>', "reword the item's questions, in order, one per question; repeat", collect, [])
      .option('--recommend <decision>', 'replace the recommendation')
      .option('--recommend-why <reason>', 'why you recommend it')
      .option('--impact <point>', 'replace what happens if nobody answers; repeat for bullet points', collect, [])
      .option('--urgency <when>', 'replace by when it matters')
      .option('-l, --link <target>', 'replace the links with these; repeat', collect, [])
      .option('--step <markdown>', 'replace the steps with these, in order; repeat (clears ticks)', collect, [])
      .option('--body-file <path>', 'replace the body with this Markdown file, or - for stdin')
      .option('--blocking', 'you are stopped until the owner answers')
      .option('--not-blocking', 'you are no longer stopped')
      .option('--will-block <thing>', 'what this will block, in a few words')
      .option('--clear-will-block', 'drop what this will block')
      .option('--by <time>', 'when it is needed: ISO, "in 3h" or a clock time like 17:00')
      .option('--clear-by', 'drop when it is needed'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.edit(id, merged<AttentionEditOptions>(command));
  });

  scoped(
    attention
      .command('step')
      .description('tick a step of an open item, counted from 1 as ls prints them')
      .argument('<id>', 'the item reference, like !A3')
      .argument('<n>', 'the step number')
      .option('--undo', 'untick the step instead'),
  ).action(async (id: string, number: string, _flags: unknown, command: Command) => {
    await controller.step(id, number, merged<AttentionStepOptions>(command));
  });

  scoped(
    attention
      .command('show')
      .description('print one item in full — read-only')
      .argument('<id>', 'the item reference, like !A3'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.show(id, merged(command));
  });

  scoped(attention.command('ls').alias('list').description('list open items, oldest first')).action(
    async (_flags: unknown, command: Command) => {
      await controller.list(merged(command));
    },
  );

  scoped(attention.command('history').alias('resolved').description('show the resolution audit, newest first')).action(
    async (_flags: unknown, command: Command) => {
      await controller.history(merged(command));
    },
  );

  scoped(
    attention
      .command('needs-info')
      .description('ask the ferret that raised an item for more information; the item stays open')
      .argument('<id>', 'the item reference, like !A3')
      .option('-n, --note <text>', 'what is missing, told to the ferret'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.needsInfo(id, merged<AttentionResolveOptions>(command));
  });

  scoped(
    attention
      .command('discuss')
      .description('ask the ferret that raised an item to talk it through before you answer; the item stays open')
      .argument('<id>', 'the item reference, like !A3')
      .option('-n, --note <text>', 'what is unclear or wrong, told to the ferret'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.discuss(id, merged<AttentionResolveOptions>(command));
  });

  scoped(
    attention
      .command('surface')
      .description('hand an item back to the owner: it is their turn again, with nothing changed (never pings)')
      .argument('<id>', 'the item reference, like !A3')
      .option('-w, --why <line>', 'one line on why the owner must look now, for example what is still open'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.surface(id, merged<AttentionSurfaceOptions>(command));
  });

  scoped(
    attention
      .command('send-now')
      .description('deliver the answers held for the ferret now, instead of after the quiet window'),
  ).action(async (_flags: unknown, command: Command) => {
    await controller.sendNow(merged(command));
  });

  scoped(
    attention
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
    await controller.resolve(id, merged<AttentionResolveOptions>(command));
  });

  scoped(
    attention
      .command('dismiss')
      .description('dismiss an item without answering it — recorded with who dismissed it')
      .argument('<id>', 'the item reference, like !A3')
      .option('-n, --note <text>', 'a note recorded with the dismissal')
      .addHelpText('after', `\n${DISMISS_POLICY}`),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.dismiss(id, merged<AttentionResolveOptions>(command));
  });

  if (notify === undefined) return;
  scoped(
    attention
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
    await notify(words, merged<AttentionCommandOptions & NotifyOptions>(command));
  });
}

/** Every verb `fy agenda` answers to, in the order its help lists them, aliases included. */
function verbNames(attention: Command): string[] {
  return attention.commands.flatMap(command => [command.name(), ...command.aliases()]);
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
