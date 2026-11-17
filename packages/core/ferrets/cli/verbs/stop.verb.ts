import type { VerbInvocation } from '@ferretry/kernel/manifest';
import { BulkStopController } from '../lib/stop/controller.ts';
import type { BulkStopSelector } from '../lib/stop/types.ts';
import { on, text } from '../lib/verb-io.ts';
import { BINARY, defineVerbs, type VerbContext } from './context.ts';

/** Usage sentence `fy stop` prints when it is typed bare. */
const STOP_USAGE = [
  'stop ferrets, selected by lineage or ownership label:',
  `  ${BINARY} stop orphan <ferret>     stop one ferret and leave its helpers running`,
  `  ${BINARY} stop cascade <ferret>    stop a ferret and every helper under it`,
  `  ${BINARY} stop children <ferret>   stop every helper under a ferret and keep it running`,
  `  ${BINARY} stop label <label>       stop every ferret with that label, whatever its lineage`,
];

const stopBy = (kind: BulkStopSelector['kind'], { api, env, verb, first }: VerbContext) =>
  verb(async (invocation, _presenter, io) => {
    const reason = text(invocation, 'reason', 'r');
    const value = first(invocation, kind === 'label' ? 'label' : 'ferret');
    const selector: BulkStopSelector = kind === 'label' ? { kind, label: value } : { kind, rootId: value };
    const includeCaller = on(invocation, 'include-caller');
    // The ferret that typed the command (the shell passes FY_SESSION_ID): the plan keeps it out unless --include-caller.
    const callerId = env?.FY_SESSION_ID?.trim() || undefined;
    await new BulkStopController(
      api,
      io,
      { ask: async () => '' },
      { interactive: false, binaryName: BINARY, ...(callerId === undefined ? {} : { callerId }) },
    ).run(selector, {
      ...(reason === undefined ? {} : { reason }),
      ...(on(invocation, 'dry-run', 'n') ? { dryRun: true } : {}),
      ...(on(invocation, 'yes', 'y') ? { yes: true } : {}),
      ...(includeCaller ? { includeCaller: true } : {}),
    });
  });

export default defineVerbs(c => {
  const stopModes = {
    orphan: stopBy('orphan', c),
    cascade: stopBy('cascade', c),
    children: stopBy('children', c),
    label: stopBy('label', c),
  } as const;
  const stopUsage = c.usage(STOP_USAGE);
  // `stop -r why cascade wren`: the shell reads the `-r` before the mode as an option of the bare `stop`, so the mode
  // arrives as the first word. It runs that mode with the same options (a `-r` after the mode wins: the last is kept).
  const stop = async (invocation: VerbInvocation): Promise<number> => {
    const [mode, ...rest] = invocation.args;
    if (mode === undefined || rest.length === 0 || !Object.hasOwn(stopModes, mode)) return await stopUsage(invocation);
    return await stopModes[mode as keyof typeof stopModes]({ ...invocation, args: rest });
  };
  return {
    stop,
    'stop orphan <session>': stopModes.orphan,
    'stop cascade <session>': stopModes.cascade,
    'stop children <session>': stopModes.children,
    'stop label <label>': stopModes.label,
  };
});
