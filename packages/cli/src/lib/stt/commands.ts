import type { Command } from 'commander';
import type {
  SttCommandOptions,
  SttController,
  SttEnhanceOptions,
  SttInstallOptions,
  SttTranscribeOptions,
} from './controller.ts';

const JSON_FLAG = '--json';
const JSON_HELP = 'print the protocol payload instead of the human rendering';

const OVERVIEW = `Dictation runs on this host: the daemon owns the model and the decoder process,
and nothing is sent to a third party unless you ask for --enhance.

Audio must be 16 kHz mono 16-bit — a .wav file, or headerless samples named
.pcm. Clips are limited to two minutes.`;

/** Add the shared flags every dictation verb carries. */
function scoped(command: Command): Command {
  return command.option(JSON_FLAG, JSON_HELP);
}

/** commander's repeatable-option reducer: `--term a --term b` collects both. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** The enhancement flags shared by `transcribe --enhance` and `enhance`. */
function enhancement(command: Command): Command {
  return command
    .option('-m, --model <model>', 'the enhancement model to use instead of the provider default')
    .option('-t, --term <term>', 'a proper noun the model keeps mangling; repeat for each', collect, [])
    .option('-c, --context <text>', 'what the dictation is about, to disambiguate homophones');
}

/**
 * Mounts `fy stt …` onto the program.
 *
 * `status` is the default verb: the first question anyone has of this group is whether dictation
 * works at all on this host, and the answer names the model that is missing when it does not.
 */
export function registerSttCommands(program: Command, controller: SttController): void {
  const stt = scoped(
    program
      .command('stt')
      .description('transcribe audio with the on-host speech-to-text model')
      .addHelpText('after', `\n${OVERVIEW}`),
  );

  const merged = <T extends SttCommandOptions>(command: Command): T => ({
    ...(stt.opts() as T),
    ...(command.opts() as T),
  });

  scoped(
    stt
      .command('status', { isDefault: true })
      .description('whether dictation is available, and what is missing when it is not'),
  ).action(async (_flags: unknown, command: Command) => {
    await controller.status(merged(command));
  });

  scoped(stt.command('models').alias('ls').description('the daemon and browser models, installed or not')).action(
    async (_flags: unknown, command: Command) => {
      await controller.models(merged(command));
    },
  );

  scoped(
    stt
      .command('install')
      .description('download and verify a model')
      .argument('<model>', 'the model id, as listed by "models"')
      .option('--wait', 'block until the model is usable instead of returning once the download starts'),
  ).action(async (model: string, _flags: unknown, command: Command) => {
    await controller.install(model, merged<SttInstallOptions>(command));
  });

  scoped(
    enhancement(
      stt
        .command('transcribe')
        .description('transcribe one audio file; the text is printed on its own first line')
        .argument('<file>', 'a 16 kHz mono .wav file, or raw 16-bit samples named .pcm')
        .option('--enhance', 'clean the transcript up through the enhancement provider'),
    ),
  ).action(async (file: string, _flags: unknown, command: Command) => {
    await controller.transcribe(file, merged<SttTranscribeOptions>(command));
  });

  scoped(
    enhancement(
      stt
        .command('enhance')
        .description('clean up dictated text — punctuation, casing and proper nouns')
        .argument('<text...>', 'the text to clean up'),
    ),
  ).action(async (words: string[], _flags: unknown, command: Command) => {
    await controller.enhance(words, merged<SttEnhanceOptions>(command));
  });
}
