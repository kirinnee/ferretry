import type { Command } from 'commander';
import { ASK_KIND_NAMES } from './ask.ts';
import type {
  AttentionAddOptions,
  AttentionCommandOptions,
  AttentionController,
  AttentionNotifyOptions,
  AttentionResolveOptions,
} from './controller.ts';

const SESSION_FLAG = '-s, --session <id>';
const SESSION_HELP =
  'target another session; an agent may mutate only its own session (defaults to the current session)';
const JSON_FLAG = '--json';
const JSON_HELP = 'print the protocol payload instead of the human rendering';

const WRITING_GUIDE = `The reader has NOT been following this session. Write for that reader:
  <the ask>    one line: what the human must decide or do — not backstory
  --context    the background they need; expand every codename and term of art
  --why        why this needs them now (what is blocked or at risk)
  --resolve    the concrete action that clears it

Every field renders as markdown: short bullets, bold the key point, no walls of
text. Attention items never expire and never auto-clear.`;

const ASK_KINDS = `--kind says what the human DOES:
  permission   approve or reject
  choice       pick one --option (repeat --option; 2 or more required)
  review       say the answer is good, or ask for a clarification
  open         write a full answer (the default)`;

const DISMISS_POLICY = `Agents may dismiss only attention items they raised themselves.
A human may dismiss any attention item. Every dismissal remains in the resolution audit.`;

/** Add the shared flags every attention verb carries. */
function scoped(command: Command): Command {
  return command.option(SESSION_FLAG, SESSION_HELP).option(JSON_FLAG, JSON_HELP);
}

/**
 * Mounts `fy attention …` onto the program.
 *
 * `add` is the default verb, so `fy attention "the deploy needs approval"` reads the way an agent
 * raising a blocker expects, while `ls`/`done`/`dismiss`/`notify`/`history` stay explicit.
 */
export function registerAttentionCommands(program: Command, controller: AttentionController): void {
  const attention = scoped(
    program
      .command('attention')
      .description('raise, answer and audit the things a human has to decide')
      .addHelpText('after', `\n${WRITING_GUIDE}`),
  );

  const merged = <T extends AttentionCommandOptions>(command: Command): T => ({
    ...(attention.opts() as T),
    ...(command.opts() as T),
  });

  scoped(
    attention
      .command('add', { isDefault: true })
      .description('raise something a human must decide or do')
      .argument('<ask...>', 'one line naming what the human must decide or do')
      .option(`-k, --kind <kind>`, `what the human does: ${ASK_KIND_NAMES.join(', ')}`)
      .option('-o, --option <label>', 'a choice label; repeat for each option', collect, [])
      .option('-c, --context <background>', 'background the reader needs')
      .option('-w, --why <reason>', 'why this needs the human now (defaults to the ask)')
      .option('-r, --resolve <how>', 'the concrete action that clears it')
      .addHelpText('after', `\n${ASK_KINDS}`),
  ).action(async (words: string[], _flags: unknown, command: Command) => {
    await controller.add(words, merged<AttentionAddOptions>(command));
  });

  scoped(attention.command('ls').alias('list').description('list unresolved items, oldest first')).action(
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
      .command('done')
      .alias('resolve')
      .description('resolve an item, optionally answering its ask')
      .argument('<id>', 'the attention reference, like !A3')
      .option('-n, --note <text>', 'a note recorded with the resolution')
      .option('--approve', 'answer a permission ask with approval')
      .option('--reject', 'answer a permission ask with a refusal')
      .option('--choice <label>', 'answer a multiple-choice ask with one option label')
      .option('--good', 'answer an answer-review ask: the answer is good')
      .option('--clarify <text>', 'answer an answer-review ask: ask for a clarification')
      .option('--answer <text>', 'answer an open question'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.resolve(id, merged<AttentionResolveOptions>(command));
  });

  scoped(
    attention
      .command('dismiss')
      .description('dismiss an item without answering it — recorded with who dismissed it')
      .argument('<id>', 'the attention reference, like !A3')
      .option('-n, --note <text>', 'a note recorded with the dismissal')
      .addHelpText('after', `\n${DISMISS_POLICY}`),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.dismiss(id, merged<AttentionResolveOptions>(command));
  });

  scoped(
    attention
      .command('notify')
      .description('push a notification to the human — not an attention item, nothing to resolve')
      .argument('<message...>', 'the notification body')
      .option('-t, --title <title>', 'the notification title')
      .option('-k, --kind <kind>', 'completed or failed'),
  ).action(async (words: string[], _flags: unknown, command: Command) => {
    await controller.notify(words, merged<AttentionNotifyOptions>(command));
  });
}

/** commander's repeatable-option reducer: `--option a --option b` collects both. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
