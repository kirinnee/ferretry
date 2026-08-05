import type { Command } from 'commander';
import type { SttCommandOptions, SttController, SttEnhanceOptions } from './controller.ts';

const JSON_FLAG = '--json';
const JSON_HELP = 'print the protocol payload instead of the human rendering';

const OVERVIEW = `Dictation runs in the browser: this command only sends already-transcribed text to
the configured enhancement provider for punctuation, casing and proper-noun cleanup.`;

/** Add the shared flags every dictation verb carries. */
function scoped(command: Command): Command {
  return command.option(JSON_FLAG, JSON_HELP);
}

/** commander's repeatable-option reducer: `--term a --term b` collects both. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Mounts `fy stt …` onto the program. */
export function registerSttCommands(program: Command, controller: SttController): void {
  const stt = scoped(
    program
      .command('stt')
      .description('clean up dictated text through the enhancement provider')
      .addHelpText('after', `\n${OVERVIEW}`),
  );

  const merged = <T extends SttCommandOptions>(command: Command): T => ({
    ...(stt.opts() as T),
    ...(command.opts() as T),
  });

  scoped(
    stt
      .command('enhance', { isDefault: true })
      .description('clean up dictated text — punctuation, casing and proper nouns')
      .argument('<text...>', 'the text to clean up')
      .option('-m, --model <model>', 'the enhancement model to use instead of the provider default')
      .option('-t, --term <term>', 'a proper noun the model keeps mangling; repeat for each', collect, [])
      .option('-c, --context <text>', 'what the dictation is about, to disambiguate homophones'),
  ).action(async (words: string[], _flags: unknown, command: Command) => {
    await controller.enhance(words, merged<SttEnhanceOptions>(command));
  });
}
