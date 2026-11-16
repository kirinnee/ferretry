import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import { ApiError } from '@ferretry/kernel/contract';
import type { FerretResult } from '../../contract/index.ts';

/** The ferret state after which a ferret will report nothing more until it is started again. */
const FINISHED = 'stopped';

/** Why a finished ferret's result is withheld: it could not be masked, so it is not handed back unchecked. */
export const RESULT_UNCHECKED = 'the result could not be checked for secrets, so it is withheld';

/** A result whose masking failed (fail closed): a route answers 503 with the sentence; Clean up settles `failed`. */
export class ResultUncheckedError extends ApiError {
  constructor() {
    super(503, RESULT_UNCHECKED, 'redaction_unavailable');
  }
}

/**
 * What a ferret reported when it finished: its `signal done` message, read back from the summary the signal wrote
 * in its own folder (`readSummary`). The default sentence a done with no message writes (`defaultSummary`) is not a
 * result, so it reads as none. The text is as written: the daemon half masks it before anything keeps or serves it.
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
