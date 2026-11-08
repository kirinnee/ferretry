/**
 * THE SESSION ARCHIVE, MOUNTED (U6): finished autonomous ferrets leave the live set, and the people who asked can still
 * read them (docs/session-archive.md). Today's `createSessionArchive` over `DaemonStorage`, run by one kernel job.
 *
 * FAIL SAFE, because archiving hides sessions:
 *   - It is OFF until `archive.yaml` names an age (`afterHours`); what is already archived stays readable either way.
 *   - Board and Agenda each say what keeps a ferret live (`ArchiveKeeps`, a hook Ferrets offers because core imports no
 *     plugin). While EITHER has not contributed its half, no pass runs; and a source that fails keeps every ferret it was
 *     asked about. An absent answer is "keep live", never "archive".
 *   - A ferret the daemon still holds running is never archived, and the rule itself keeps every interactive ferret, every
 *     unfinished one, every one with no end time and every lead with a child still live.
 *   - Nothing moves: archiving writes one registry document, and only a WRITE to a session revives it. A read here
 *     (`list`, `count`) writes nothing.
 *
 * THE TIMER is no timer of ours: the kernel job ticks every 60 s and a pass runs only when it is DUE: an hour after the
 * last one, or a minute after a pass that left qualifying sessions behind (the per-pass bound), as today. No dynamic timer.
 */
import type { Log } from '@ferretry/kernel/contract';
import type { ArchiveCardStanding, ArchiveKeepSource, ArchiveSettings, FerretId } from '../../contract/index.ts';
import { createSessionArchive, type SessionArchive } from '../adapters/session/archive/session-archive.ts';
import type { DaemonStorage } from '../adapters/storage/session-storage.ts';
import type { SessionArchiveSubsystem } from '../lib/runtime/mounts/session-archive.ts';
import { ARCHIVE_PASS_LIMIT_DEFAULT } from '../lib/session/archive/index.ts';
import type { LaneCategory, OpenCardStanding } from '../lib/session/peers/board.ts';
import type { SessionId } from '../lib/session-id.ts';

/** The kernel job that runs a pass when one is due. */
export const ARCHIVE_PASS_JOB = 'ferrets.archive-pass';
/** How often the job looks at whether a pass is due. */
export const ARCHIVE_TICK_MS = 60_000;
/** The gap after a pass that finished everything that qualified. */
export const ARCHIVE_PASS_EVERY_MS = 60 * 60_000;

const HOUR_MS = 60 * 60_000;
const LANES: ReadonlySet<string> = new Set<LaneCategory>([
  'backlog',
  'active',
  'review',
  'shipped',
  'verify',
  'closed',
]);

/** The setting as milliseconds, or `undefined` for "off" (absent, `off`, or no key). */
export function archiveAfterMs(settings: ArchiveSettings | undefined): number | undefined {
  const hours = settings?.afterHours;
  return typeof hours === 'number' ? hours * HOUR_MS : undefined;
}

/** A card as the keep rule reads it. A lane category Ferrets does not know reads as unknown, which is "in flight". */
const standing = (card: ArchiveCardStanding): OpenCardStanding => ({
  owner: card.owner,
  assignee: card.assignee,
  dropped: card.dropped ? 'dropped' : null,
  category: card.category !== undefined && LANES.has(card.category) ? (card.category as LaneCategory) : undefined,
});

export interface ArchiveDeps {
  readonly storage: DaemonStorage;
  /** The one setting (`kernel.config.file(ArchiveConfigFile)`), read at each tick. */
  readonly settings: () => ArchiveSettings | undefined;
  readonly nowMs: () => number;
  /** The ferrets the owner pinned. */
  readonly pinned: () => Promise<ReadonlyMap<string, string>>;
  /** What Board and Agenda contributed (`ArchiveKeeps`), asked afresh each time: a plugin may stop. */
  readonly keeps: () => readonly ArchiveKeepSource[];
  /** Whether the daemon still holds this ferret as running. */
  readonly isLive: (ferret: string) => boolean;
  /** Settles when the store's archive registry is loaded; a pass never runs before it. */
  readonly loaded: () => Promise<unknown>;
  readonly yieldToLoop: () => Promise<void>;
  readonly directory: (id: SessionId) => string;
  readonly log: Log;
  /** The most ferrets one pass archives; default {@link ARCHIVE_PASS_LIMIT_DEFAULT}. */
  readonly passLimit?: number;
}

export interface MountedArchive {
  /** The routes' view: count and list always, and `run` only while a pass may run. */
  readonly subsystem: SessionArchiveSubsystem;
  /** What the kernel job calls every {@link ARCHIVE_TICK_MS}: runs a pass only when one is due. */
  tick(): Promise<void>;
}

export function buildArchive(deps: ArchiveDeps): MountedArchive {
  const boards = () => deps.keeps().filter(source => source.kind === 'board');
  const agendas = () => deps.keeps().filter(source => source.kind === 'agenda');
  const sources = {
    pinned: deps.pinned,
    board: async (): Promise<readonly OpenCardStanding[]> => {
      const asked = boards();
      // Nobody answers for the cards: the archive reads that as "board unreadable" and keeps every ferret.
      if (asked.length === 0) throw new Error('no board is wired to say which ferrets are on an open card');
      return (await Promise.all(asked.map(async source => await source.cards()))).flat().map(standing);
    },
    hasOpenAgendaItem: async (id: string): Promise<boolean> => {
      const asked = agendas();
      if (asked.length === 0) throw new Error('no agenda is wired to say which ferrets have an open item');
      const answers = await Promise.all(asked.map(async source => await source.hasOpenItem(id as FerretId)));
      return answers.some(open => open);
    },
    isLive: deps.isLive,
  };
  const build = (afterMs: number | undefined): SessionArchive =>
    createSessionArchive({
      directory: deps.directory,
      storage: deps.storage,
      clock: { nowMs: deps.nowMs },
      afterMs,
      passLimit: deps.passLimit ?? ARCHIVE_PASS_LIMIT_DEFAULT,
      sources,
      yieldToLoop: deps.yieldToLoop,
    });
  // The read side never archives: it is built with archiving off, so the routes can neither start nor revive a thing.
  const reading = build(undefined).subsystem;
  let running: { readonly afterMs: number; readonly archive: SessionArchive } | undefined;
  // A pass is due at once the first time, then by what the last one left behind.
  let dueAtMs = 0;

  const archiving = (afterMs: number): SessionArchive => {
    if (running?.afterMs !== afterMs) running = { afterMs, archive: build(afterMs) };
    return running.archive;
  };
  /** Whether Board AND Agenda have both answered for their half: the only condition a pass may run under. */
  const answered = (): boolean => boards().length > 0 && agendas().length > 0;

  return {
    subsystem: reading,
    tick: async () => {
      const afterMs = archiveAfterMs(deps.settings());
      if (afterMs === undefined) return;
      if (deps.nowMs() < dueAtMs) return;
      if (!answered()) {
        deps.log.debug('the archive pass waits: Board and Agenda have not both said what keeps a ferret live');
        return;
      }
      await deps.loaded();
      const run = archiving(afterMs).subsystem.run;
      if (run === undefined) return;
      try {
        const result = await run();
        // Another pass is still running: its own end decides the next one.
        if (result === undefined) return;
        dueAtMs = deps.nowMs() + (result.deferred > 0 ? ARCHIVE_TICK_MS : ARCHIVE_PASS_EVERY_MS);
        if (result.archived > 0)
          deps.log.info('finished ferrets left the live set', { archived: result.archived, deferred: result.deferred });
      } catch (error) {
        // A failed pass tries again at the next hour, never in a loop; every session it did not finish stays live.
        dueAtMs = deps.nowMs() + ARCHIVE_PASS_EVERY_MS;
        deps.log.warn('the archive pass failed; every ferret stays live until the next one', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
