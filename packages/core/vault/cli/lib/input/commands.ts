import type { TerminalIo, VerbHandler } from '@ferretry/kernel/manifest';
import { type ExitStatus, type ReadVerb, type VerbShape, verbHandler } from '../../shell.ts';
import type { InputAnswerOptions, InputCommandOptions, InputController } from './controller.ts';

const SESSION = { values: ['session'], aliases: { s: 'session' } } as const;

/**
 * `fy input ls|answer|cancel`, as the 5.0 shell hands them over: today's `input/commands.ts` with commander's option
 * declarations turned into one {@link VerbShape} per verb, the same flags and the same controller calls. There is no
 * flag, argument, environment variable or pipe that carries the value: it is typed at a hidden prompt.
 */
export function inputVerbs(
  controller: InputController,
  io: Pick<TerminalIo, 'err'>,
  exit: ExitStatus,
): Readonly<Record<'input ls' | 'input answer' | 'input cancel', VerbHandler>> {
  const verb = (shape: VerbShape, run: (read: ReadVerb) => Promise<void>): VerbHandler =>
    verbHandler(io, exit, shape, run);
  const options = <T extends InputCommandOptions>(read: ReadVerb): T => read.options as unknown as T;
  return {
    'input ls': verb({ command: 'ls', args: [], ...SESSION, switches: ['json'] }, async read =>
      controller.list(options(read)),
    ),
    'input answer': verb(
      {
        command: 'answer',
        args: ['reference'],
        ...SESSION,
        values: ['session', 'account', 'save-as', 'label'],
        switches: ['json', 'enter', 'no-enter'],
      },
      async read => controller.answer(read.args[0] ?? '', options<InputAnswerOptions>(read)),
    ),
    'input cancel': verb({ command: 'cancel', args: ['reference'], ...SESSION, switches: ['json'] }, async read =>
      controller.cancel(read.args[0] ?? '', options(read)),
    ),
  };
}
