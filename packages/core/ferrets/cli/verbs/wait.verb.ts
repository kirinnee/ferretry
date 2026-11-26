import { SessionCommandError } from '../lib/session/errors.ts';
import { count, on, text } from '../lib/verb-io.ts';
import { WaitController } from '../lib/wait/controller.ts';
import { BINARY, defineVerbs } from './context.ts';

/**
 * Whether a failed read lost the daemon (as against the daemon answering no): the shell's transport failures carry no
 * HTTP status. A wait that loses the daemon ends with its own exit code instead of looking like a ferret that ended.
 */
function transportFailure(error: unknown): 'unavailable' | 'unresponsive' | undefined {
  if (!(error instanceof Error)) return undefined;
  const fields = error as { status?: unknown; exitCode?: unknown; timedOut?: unknown; name: string };
  if (typeof fields.status === 'number' || typeof fields.exitCode === 'number') return undefined;
  if (fields.timedOut === true) return 'unresponsive';
  return /Transport/.test(fields.name) ? 'unavailable' : undefined;
}

export default defineVerbs(({ api, clock, sleep, exists, verb, first }) => ({
  'wait <id>': verb(async (invocation, _presenter, io) => {
    const timeout = count(invocation, 'timeout');
    const interval = count(invocation, 'interval');
    const marker = text(invocation, 'until-marker');
    // A wait needs a clock and a way to sleep, and a deliverable gate an existence check: the shell fills them in.
    if (clock === undefined || sleep === undefined)
      throw new SessionCommandError('wait needs the shell’s clock, which this fy does not give a verb yet', 1);
    if (marker !== undefined && exists === undefined)
      throw new SessionCommandError(
        '--until-marker needs the shell’s existence check, which this fy does not give a verb yet',
        1,
      );
    const controller = new WaitController(
      {
        get: async (reference, signal) => await api.get(reference, signal),
        events: async (reference, after, signal) => await api.eventsAfter(reference, after, signal),
        // The deadline is the shell's cancellable sleep: its signal aborts when the time is up, and a finished wait drops it.
        startDeadline: milliseconds => {
          const timer = new AbortController();
          const passed = new AbortController();
          void sleep(milliseconds as never, timer.signal).then(
            () => passed.abort(),
            () => undefined,
          );
          return { signal: passed.signal, cancel: () => timer.abort() };
        },
        markerExists: async path => await (exists?.(path) ?? Promise.resolve(false)).catch(() => false),
        nowMs: () => clock.nowMs(),
        sleep: async milliseconds => await sleep(milliseconds as never),
        transport: transportFailure,
      },
      io,
      BINARY,
    );
    await controller.wait(first(invocation, 'ferret id'), {
      ...(on(invocation, 'json') ? { json: true } : {}),
      ...(timeout === undefined ? {} : { timeout }),
      ...(interval === undefined ? {} : { interval }),
      ...(marker === undefined ? {} : { untilMarker: marker }),
    });
  }),
}));
