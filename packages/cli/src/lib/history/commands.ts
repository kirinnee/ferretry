import { HISTORY_CLAIM_HELD_EXIT_CODE } from '@ferretry/fleet';
import { type Command, InvalidArgumentError, Option } from 'commander';
import type { HistoryController } from './controller.ts';

function positivePid(value: string): number {
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new InvalidArgumentError('a pid is a positive whole number');
  return pid;
}

interface ClaimOptions {
  readonly harness: 'claude' | 'codex';
  readonly pid: number;
  readonly fromArguments?: boolean;
}

/** Mounts `fy history`: the shared conversation history every runtime of a harness reads (account model H1–H4). */
export function registerHistoryCommands(program: Command, controller: Pick<HistoryController, 'claim'>): void {
  const history = program.command('history').description('the conversation history every runtime of a harness shares');
  history
    .command('claim')
    .description('claim a conversation for one writer before a harness resumes it; refused while another is writing it')
    .argument('[words...]', 'the conversation id, or with --from-arguments the harness arguments to read it from')
    .addOption(
      new Option('--harness <harness>', 'the harness the conversation belongs to')
        .choices(['claude', 'codex'])
        .makeOptionMandatory(),
    )
    .requiredOption('--pid <pid>', 'the process that will write the conversation (a wrapper passes $$)', positivePid)
    .option('--from-arguments', 'read the conversation id from the harness arguments that follow')
    .addHelpText(
      'after',
      `\nExit status ${HISTORY_CLAIM_HELD_EXIT_CODE}: another session is writing this conversation, so do not start it.\nA wrapper stops only on that status; any other failure lets the harness launch anyway.`,
    )
    .action(async (words: readonly string[], options: ClaimOptions) => {
      await controller.claim({
        harness: options.harness,
        pid: options.pid,
        ...(options.fromArguments === true
          ? { arguments: words }
          : words[0] === undefined
            ? {}
            : { conversation: words[0] }),
      });
    });
}
