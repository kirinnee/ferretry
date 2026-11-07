import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import type { FerretResult } from '../../contract/index.ts';

/** The ferret state after which a ferret will report nothing more until it is started again. */
const FINISHED = 'stopped';

/**
 * What a ferret reported when it finished: its `signal done` message, read back from the summary the signal wrote
 * in its own folder (`readSummary`). The default sentence a done with no message writes (`defaultSummary`) is not a
 * result, so it reads as none.
 */
export async function readFerretResult(
  ferret: FerretSummary,
  readSummary: () => Promise<string | undefined>,
  defaultSummary: string,
): Promise<FerretResult> {
  const finished = ferret.state === FINISHED;
  const text = finished ? await readSummary() : undefined;
  const summary = text === undefined || text === defaultSummary ? undefined : text.replace(/\n$/u, '');
  return {
    id: ferret.id,
    state: ferret.state,
    finished,
    ...(finished ? { finishedAt: ferret.stateAt } : {}),
    ...(summary === undefined ? {} : { summary }),
  };
}
