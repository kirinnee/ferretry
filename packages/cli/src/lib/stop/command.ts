import type { Command } from 'commander';
import { inheritStopReason } from './controller.ts';
import type { BulkStopOptions, BulkStopSelector, IBulkStopRunner } from './types.ts';

interface StopMode {
  readonly name: string;
  readonly argument: string;
  readonly argumentHelp: string;
  readonly description: string;
  readonly selector: (value: string) => BulkStopSelector;
}

const MODES: readonly StopMode[] = [
  {
    name: 'orphan',
    argument: '<session>',
    argumentHelp: 'session to stop',
    description: 'stop one session and leave its descendants running',
    selector: rootId => ({ kind: 'orphan', rootId }),
  },
  {
    name: 'cascade',
    argument: '<session>',
    argumentHelp: 'root of the subtree to stop',
    description: 'stop a session and every transitive descendant',
    selector: rootId => ({ kind: 'cascade', rootId }),
  },
  {
    name: 'children',
    argument: '<session>',
    argumentHelp: 'root whose descendants are stopped',
    description: 'stop every transitive descendant and keep the root running',
    selector: rootId => ({ kind: 'children', rootId }),
  },
  {
    name: 'label',
    argument: '<label>',
    argumentHelp: 'exact label to match',
    description: 'stop every session carrying an exact label, independent of lineage',
    selector: label => ({ kind: 'label', label }),
  },
];

/**
 * Registers `stop <mode>`. Every mutation is the ordinary per-session stop call, so bulk stop adds
 * no authorization surface; the danger it does add — sweeping more than the operator meant — is
 * answered by a plan preview and a typed confirmation, not by a yes/no prompt.
 */
export function registerStopCommands(program: Command, controller: IBulkStopRunner): void {
  const stop = program
    .command('stop')
    .description('stop sessions in bulk, selected by lineage or label')
    .option('-r, --reason <text>', 'reason recorded against every stopped session');

  for (const mode of MODES) {
    stop
      .command(mode.name)
      .description(mode.description)
      .argument(mode.argument, mode.argumentHelp)
      .option('-r, --reason <text>', 'reason recorded against every stopped session')
      .option('-n, --dry-run', 'print the plan and stop nothing')
      .option('-y, --yes', 'skip the typed confirmation')
      .option('--include-caller', 'also stop the issuing session, last')
      .action(async (value: string, options: BulkStopOptions) => {
        const parentReason = stop.opts<{ reason?: string }>().reason;
        await controller.run(mode.selector(value), inheritStopReason(options, parentReason));
      });
  }
}
