import type { Command } from 'commander';
import type { VoiceCommandOptions, VoiceController } from './controller.ts';

const JSON_FLAG = '--json';
const JSON_HELP = 'print the protocol payload instead of the human rendering';

const OVERVIEW = `The speech engine on this machine transcribes voice chat and dictation here instead of on
your device. Nothing is downloaded until you ask: "install" fetches the native runtime and one model,
pinned by hash, and keeps what it has fetched if you cancel so the next install resumes.`;

function scoped(command: Command): Command {
  return command.option(JSON_FLAG, JSON_HELP);
}

/** Mounts `fy voice …` onto the program. */
export function registerVoiceCommands(program: Command, controller: VoiceController): void {
  const voice = scoped(
    program
      .command('voice')
      .description("this machine's speech engine: models, install, remove, choose")
      .addHelpText('after', `\n${OVERVIEW}`),
  );

  const merged = (command: Command): VoiceCommandOptions => ({
    ...(voice.opts() as VoiceCommandOptions),
    ...(command.opts() as VoiceCommandOptions),
  });

  scoped(
    voice
      .command('status', { isDefault: true })
      .description('the catalog, what is installed, free disk, and any install under way'),
  ).action(async (_flags: unknown, command: Command) => {
    await controller.status(merged(command));
  });

  scoped(
    voice
      .command('install')
      .description('download and verify the runtime and a model, resuming a part-downloaded one')
      .argument('<id>', 'the model id from "voice status"'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.install(id, merged(command));
  });

  scoped(voice.command('cancel').description('stop the install under way; what was downloaded is kept')).action(
    async (_flags: unknown, command: Command) => {
      await controller.cancel(merged(command));
    },
  );

  scoped(
    voice
      .command('remove')
      .description('delete a model and any part-downloaded archive of it')
      .argument('<id>', 'the model id'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.remove(id, merged(command));
  });

  scoped(
    voice
      .command('use')
      .description('make an installed model the one its role uses (writes voice.yaml)')
      .argument('<id>', 'the model id'),
  ).action(async (id: string, _flags: unknown, command: Command) => {
    await controller.use(id, merged(command));
  });
}
