import type { SessionResult, SessionView } from '@ferretry/protocol';
import { DEFAULT_COMPLETION_SUMMARY } from '../../lib/session/signal/policy.ts';

/** Statuses after which a ferret will report nothing more until it is launched again. */
const FINISHED: ReadonlySet<string> = new Set(['completed', 'failed', 'stalled', 'stopped']);

/**
 * What a ferret reported when it finished: its `signal done` message, read back from the summary the
 * signal wrote in its own directory. The default sentence a done with no message writes is not a
 * result, so it reads as none.
 */
export async function readSessionResult(
  view: SessionView,
  readSummary: () => Promise<string | undefined>,
): Promise<SessionResult> {
  const finished = FINISHED.has(view.state.status);
  const text = finished ? await readSummary() : undefined;
  const summary = text === undefined || text === DEFAULT_COMPLETION_SUMMARY ? undefined : text.replace(/\n$/u, '');
  return {
    id: view.config.id,
    status: view.state.status,
    finished,
    ...(view.state.finishedAt === undefined ? {} : { finishedAt: view.state.finishedAt }),
    ...(summary === undefined ? {} : { summary }),
  };
}
