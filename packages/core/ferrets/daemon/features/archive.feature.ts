import { milliseconds } from '@ferretry/std';
import { ArchiveConfigFile, ArchiveKeeps, type FerretId } from '../../contract/index.ts';
import { sessionArchiveRoutes } from '../lib/runtime/mounts/session-archive.ts';
import { ARCHIVE_PASS_JOB, ARCHIVE_TICK_MS, buildArchive } from '../modules/archive.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, hooks, registry, sessionStore, log, storeLoaded, agentPins } = f;
  // The archive (U6): finished autonomous ferrets leave the live set when `archive.yaml` says so and Board and Agenda have
  // both said what keeps a ferret live. Nothing moves, only a write revives, and the list below reads and writes nothing.
  const archive = buildArchive({
    storage: sessionStore,
    settings: () => kernel.config.file(ArchiveConfigFile),
    nowMs: () => kernel.clock.nowMs(),
    pinned: async () => await agentPins.pinnedAt(),
    keeps: () => hooks.contributions(ArchiveKeeps).map(contribution => contribution.item),
    // Kept by the record whatever the session document says: a ferret still running, and one the record does not say is
    // autonomous (a record with no `mode` is read as interactive, as the signal path reads it).
    isLive: ferret => {
      const record = registry.get(ferret as FerretId);
      return record !== undefined && (record.state !== 'stopped' || record.mode !== 'auto');
    },
    loaded: async () => await storeLoaded,
    yieldToLoop: async () => await kernel.clock.sleep(milliseconds(0)),
    // A view names its session's folder, and 5.0 names no state folder to any caller: the ferret's own id stands for it.
    directory: id => `sessions/${id}`,
    after: (delayMs, fire) => kernel.clock.after(milliseconds(delayMs), fire),
    log,
  });
  kernel.jobs.add({
    id: ARCHIVE_PASS_JOB,
    schedule: { every: milliseconds(ARCHIVE_TICK_MS) },
    run: async signal => await archive.tick(signal),
  });
  const archived = sessionArchiveRoutes(archive.subsystem);

  return { routes: archived };
}

export default { id: 'archive', register } satisfies FerretsFeature;
