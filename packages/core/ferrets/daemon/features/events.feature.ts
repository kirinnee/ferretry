import { milliseconds } from '@ferretry/std';
import { COMPACTION_HISTORY_KEY, CompactionHistoryHook, type FerretId, Runners } from '../../contract/index.ts';
import { fleetEventsAccept, followableFerret } from '../modules/fleet-events.ts';
import { buildLiveEvents } from '../modules/live-events.ts';
import { tryParseSessionId } from '../lib/session-id.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, hooks, registry, sessionStore, storeLoaded, transcripts, eventSource, mayAct } = f;
  // Today's `findSession` also found archived ferrets, whose journals are untouched, so their streams replay.
  // `?live=1` and `?transcript=1` (U5, G161): the live readout and the transcript signal, each read through its owner and
  // masked on the way out (`modules/live-events.ts`).
  const liveEvents = buildLiveEvents({
    readState: async id => await sessionStore.readState(id),
    record: ferret => registry.get(ferret),
    runner: () => {
      const found = hooks.provider(Runners, 'tmux');
      return found === 'unavailable' ? undefined : found;
    },
    transcript: transcripts,
    clock: { now: () => kernel.clock.now() },
    every: (intervalMs, tick) => kernel.clock.every(milliseconds(intervalMs), tick),
    redaction: kernel.redaction,
    history: () => {
      const found = hooks.provider(CompactionHistoryHook, COMPACTION_HISTORY_KEY);
      return found === 'unavailable' ? undefined : found;
    },
  });
  const eventsAccept = fleetEventsAccept(
    eventSource,
    { after: (delay, action) => ({ cancel: kernel.clock.after(milliseconds(delay), action) }) },
    followableFerret({
      live: id => registry.get(id as FerretId) !== undefined,
      archived: id => {
        const session = tryParseSessionId(id);
        return session !== undefined && sessionStore.findSession(session) !== undefined;
      },
    }),
    {
      ...liveEvents,
      // A ferret's own token follows its own live readout and its helpers', never another's (G161).
      mayFollow: (call, id) => mayAct(call, id as FerretId),
    },
  );

  return {
    sockets: {
      'GET /v1/events': async call => {
        // The archive is read once at open; a stream asked for before that must not 404 an archived ferret.
        await storeLoaded.catch(() => undefined);
        return await eventsAccept(call);
      },
    },
  };
}

export default { id: 'events', register } satisfies FerretsFeature;
