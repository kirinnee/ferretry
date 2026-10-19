import { type Command, InvalidArgumentError, Option } from 'commander';
import type { ContinueSessionController, ImportController } from './controller.ts';
import { parseSinceDuration } from './controller.ts';

/** Both commands share one `--since` grammar: validated here, converted to an instant in the controller. */
function sinceArgument(value: string): string {
  try {
    parseSinceDuration(value);
  } catch (error) {
    throw new InvalidArgumentError((error as Error).message);
  }
  return value;
}

/** Both commands filter by harness the same way. */
function harnessOption(description: string): Option {
  return new Option('--harness <harness>', description).choices(['claude', 'codex']);
}

const SINCE_HELP = 'only conversations active within this long: <n>d, <n>h or <n>w (e.g. 7d)';

/** Mounts `fy import conversations` — list existing CLI conversations, or adopt named ones as ferrets. */
export function registerImportCommands(program: Command, controller: Pick<ImportController, 'list' | 'select'>): void {
  const group = program
    .command('import')
    .description('bring an existing Claude Code or Codex conversation on as a ferret');

  group
    .command('conversations')
    .description('list conversations already on this machine, or adopt chosen ones as ferrets')
    .argument('[query...]', 'search words; each must appear in the preview, latest message or project folder')
    .addOption(harnessOption('only this harness'))
    .option('--since <duration>', SINCE_HELP, sinceArgument)
    .option('--select <id...>', 'adopt these conversation ids instead of listing')
    .option('--runtime <name>', 'the runtime every adopted ferret runs on (required with --select)')
    .option('--start', 'launch every selected conversation now (at most 10 at once)')
    .option('--json', 'print the protocol payload instead of the human rendering')
    .action(
      async (
        words: string[],
        options: {
          harness?: 'claude' | 'codex';
          since?: string;
          select?: string[];
          runtime?: string;
          start?: boolean;
          json?: boolean;
        },
      ) => {
        const query = words.join(' ');
        if (options.select === undefined) {
          await controller.list({
            ...(query === '' ? {} : { query }),
            ...(options.harness === undefined ? {} : { harness: options.harness }),
            ...(options.since === undefined ? {} : { since: options.since }),
            json: options.json === true,
          });
          return;
        }
        await controller.select({
          select: options.select,
          ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
          ...(options.harness === undefined ? {} : { harness: options.harness }),
          start: options.start === true,
          json: options.json === true,
        });
      },
    );
}

/** Mounts `fy new` — continuing an existing conversation; a fresh session stays `fy start`. */
export function registerNewCommand(program: Command, controller: Pick<ContinueSessionController, 'run'>): void {
  program
    .command('new')
    .description('continue an existing Claude Code or Codex conversation as a ferret (fresh sessions: `fy start`)')
    .argument('[query...]', 'search words for --continue')
    .addOption(harnessOption('search only this harness'))
    .option('--continue', 'search existing conversations and continue one, instead of starting fresh')
    .option('--runtime <name>', 'the runtime to run it on')
    .option('--since <duration>', SINCE_HELP, sinceArgument)
    .action(
      async (
        words: string[],
        options: { continue?: boolean; harness?: 'claude' | 'codex'; runtime?: string; since?: string },
      ) => {
        const query = words.join(' ');
        await controller.run({
          continue: options.continue === true,
          ...(query === '' ? {} : { query }),
          ...(options.harness === undefined ? {} : { harness: options.harness }),
          ...(options.since === undefined ? {} : { since: options.since }),
          ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
        });
      },
    );
}
