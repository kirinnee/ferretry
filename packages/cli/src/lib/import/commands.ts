import { type Command, InvalidArgumentError, Option } from 'commander';
import type { PackNewOptions } from '../pack/controller.ts';
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
export function registerImportCommands(
  program: Command,
  controller: Pick<ImportController, 'keep' | 'list' | 'select'>,
): void {
  const group = program
    .command('import')
    .description('bring an existing Claude Code or Codex conversation on as a ferret');

  group
    .command('conversations')
    .description(
      'list conversations on this machine, adopt chosen ones, or import a window with --all or --since <1d|3d|7d|14d|30d> --runtime <name>',
    )
    .argument('[query...]', 'search words; each must appear in the name, first or latest message or project folder')
    .addOption(harnessOption('only this harness'))
    .option('--since <duration>', SINCE_HELP, sinceArgument)
    .option('--select <id...>', 'adopt these conversation ids instead of listing')
    .option('--runtime <name>', 'the runtime every adopted ferret runs on (required with --select)')
    .option('--all', 'import every conversation as a stopped ferret (needs --runtime; hard-linked, never copied)')
    .option('--start', 'launch every selected conversation now (at most 10 at once)')
    .option('--json', 'print the protocol payload instead of the human rendering')
    .action(
      async (
        words: string[],
        options: {
          harness?: 'claude' | 'codex';
          since?: string;
          select?: string[];
          all?: boolean;
          runtime?: string;
          start?: boolean;
          json?: boolean;
        },
      ) => {
        const keeping = options.all === true || (options.since !== undefined && options.runtime !== undefined);
        if (keeping && options.select === undefined) {
          await controller.keep({
            ...(options.all === true ? { all: true } : {}),
            ...(options.since === undefined ? {} : { since: options.since }),
            ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
            ...(options.harness === undefined ? {} : { harness: options.harness }),
            json: options.json === true,
          });
          return;
        }
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

/** `fy new` without `--continue`: a sub-ferret on a chosen model (Pack mode, docs/pack-mode.md). */
export interface FreshSubFerret {
  newChild(words: readonly string[], options: PackNewOptions): Promise<void>;
}

/**
 * Mounts `fy new`: with `--continue`, continuing an existing conversation; without it, a sub-ferret on a
 * chosen model after a "reply OK" check (Pack mode). A plain fresh session stays `fy start`.
 */
export function registerNewCommand(
  program: Command,
  controller: Pick<ContinueSessionController, 'run'>,
  fresh?: FreshSubFerret,
): void {
  const bin = program.name();
  program
    .command('new')
    .description(
      `start a sub-ferret on a chosen model (Pack mode; \`${bin} wait <id>\` collects its result), or --continue an existing conversation`,
    )
    .argument('[words...]', 'the complete brief for a sub-ferret, or search words for --continue')
    .addOption(harnessOption('search only this harness'))
    .option('--continue', 'search existing conversations and continue one, instead of starting fresh')
    .option('--runtime <name>', `the runtime to run it on (\`${bin} recommend\` lists them)`)
    .option('--since <duration>', SINCE_HELP, sinceArgument)
    .option('--model <model>', 'the model, as the runtime lists it')
    .option('--effort <level>', 'the reasoning effort')
    .option(
      '--auto',
      'let Ferretry choose: the models the routing prompt names, in its order (or Jev, when Jev decides)',
    )
    .option('--cwd <dir>', "its folder (defaults to its parent ferret's; a person's start runs here)")
    .option('--name <title>', 'its task title')
    .option('--allow-scratch', 'run it in a temporary or scratch folder anyway (refused otherwise)')
    .addOption(new Option('--mode <mode>', 'auto (default) or interactive').choices(['auto', 'interactive']))
    .option('--prompt-file <file>', 'read the brief from a file')
    .option('--json', 'print the outcome as JSON')
    .action(
      async (
        words: string[],
        options: {
          continue?: boolean;
          harness?: 'claude' | 'codex';
          runtime?: string;
          since?: string;
        } & PackNewOptions,
      ) => {
        if (options.continue !== true && fresh !== undefined) {
          const { continue: _continue, harness: _harness, since: _since, ...pack } = options;
          await fresh.newChild(words, pack);
          return;
        }
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
