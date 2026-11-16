import { describe, it } from 'bun:test';
import should from 'should';
import type { Instant } from '@ferretry/std';
import { ferretId } from '../../../../../contract/testing/index.ts';
import type { FerretId } from '../../../../../contract/index.ts';
import { KeyedSerialExecutor } from '../../../../../daemon/adapters/storage/keyed-serial-executor.ts';
import { StorageResumeRepository } from '../../../../../daemon/adapters/session/resume/storage-resume-repository.ts';
import { buildInterruptedLaunches } from '../../../../../daemon/modules/interrupted-launches.ts';
import { INTERRUPTED_LAUNCH_REASON } from '../../../../../daemon/lib/session/resume/index.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import { memoryStorage, RecordingLog, sessionConfig, sessionState, T0 } from '../../../../support/daemon/storage.ts';

const BOOT = Date.parse('2026-11-16T10:00:00.000Z');
const BEFORE_BOOT = '2026-11-16T09:00:00.000Z';
const AFTER_BOOT = '2026-11-16T10:00:05.000Z';

const sid = (n: number): string => `mw7bp88g-${n.toString(16).padStart(8, '0')}`;

/** A world with one document per `[id, status, stateAt]`, every pane gone unless `alive` names it. */
async function world(
  sessions: readonly (readonly [string, string, string])[],
  options: { alive?: readonly string[]; gone?: boolean | 'unavailable'; cap?: number } = {},
) {
  const opened = await memoryStorage();
  for (const [id, status] of sessions) {
    await opened.storage.writeConfig(parseSessionId(id), sessionConfig(id, { name: id, cwd: '/work', mode: 'auto' }));
    await opened.storage.writeState(parseSessionId(id), sessionState(id, { status, turn: 1 }));
  }
  const records = new Map(sessions.map(([id, , stateAt]) => [id, { stateAt: stateAt as Instant }]));
  const history: { ferret: string; type: string; data: Readonly<Record<string, unknown>> }[] = [];
  const log = new RecordingLog();
  const launching = new Set<string>();
  const pass = buildInterruptedLaunches({
    repository: new StorageResumeRepository(opened.storage),
    serial: new KeyedSerialExecutor(),
    gate: { launching: id => launching.has(id) },
    record: ferret => records.get(ferret),
    bootedAtMs: BOOT,
    gone: async ferret => {
      if (options.gone === 'unavailable') return undefined;
      return options.alive?.includes(ferret) === true ? false : (options.gone ?? true);
    },
    history: async (ferret: FerretId, type, data) => void history.push({ ferret, type, data }),
    clock: { now: () => T0 },
    log,
    ...(options.cap === undefined ? {} : { cap: options.cap }),
  });
  const statusOf = async (id: string): Promise<unknown> =>
    ((await opened.storage.readState(parseSessionId(id))) as { status?: unknown } | undefined)?.status;
  return { pass, statusOf, history, log, launching, opened };
}

describe('the interrupted-launch pass after a restart', () => {
  it('should record a launch the restart interrupted as failed, say why, and say it was said', async () => {
    // Arrange
    const a = sid(1);
    const w = await world([[a, 'starting', BEFORE_BOOT]]);

    // Act
    const outcome = await w.pass.run();

    // Assert
    should(await w.statusOf(a)).equal('failed');
    should(outcome.failed).deepEqual([a]);
    should(w.history).deepEqual([
      { ferret: ferretId(a), type: 'session.launch_interrupted', data: { reason: INTERRUPTED_LAUNCH_REASON } },
    ]);
    should(w.log.lines.some(line => line.level === 'warn' && line.message.includes('interrupted'))).equal(true);
  });

  it('should leave a launch this process began after it booted, which no record of the restart can speak for', async () => {
    // Arrange
    const a = sid(2);
    const w = await world([[a, 'starting', AFTER_BOOT]]);

    // Act
    const outcome = await w.pass.run();

    // Assert
    should(await w.statusOf(a)).equal('starting');
    should(outcome.kept).deepEqual([{ id: a, why: 'launching' }]);
    should(w.history).deepEqual([]);
  });

  it('should leave a launch the launch gate holds', async () => {
    // Arrange
    const a = sid(3);
    const w = await world([[a, 'created', BEFORE_BOOT]]);
    w.launching.add(a);

    // Act
    await w.pass.run();

    // Assert
    should(await w.statusOf(a)).equal('created');
  });

  it('should leave a launch whose pane the terminal does not prove gone, and one it cannot ask about', async () => {
    // Arrange
    const live = sid(4);
    const kept = await world([[live, 'starting', BEFORE_BOOT]], { alive: [live] });
    const unasked = await world([[live, 'starting', BEFORE_BOOT]], { gone: 'unavailable' });

    // Act
    const keptOutcome = await kept.pass.run();
    const unaskedOutcome = await unasked.pass.run();

    // Assert
    should(await kept.statusOf(live)).equal('starting');
    should(keptOutcome.kept).deepEqual([{ id: live, why: 'pane-alive' }]);
    should(await unasked.statusOf(live)).equal('starting');
    should(unaskedOutcome.kept).deepEqual([{ id: live, why: 'unobservable' }]);
  });

  it('should never touch a session that is not mid-launch', async () => {
    // Arrange
    const a = sid(5);
    const b = sid(6);
    const w = await world([
      [a, 'running', BEFORE_BOOT],
      [b, 'stopped', BEFORE_BOOT],
    ]);

    // Act
    const outcome = await w.pass.run();

    // Assert
    should(outcome).deepEqual({ failed: [], kept: [] });
    should([await w.statusOf(a), await w.statusOf(b)]).deepEqual(['running', 'stopped']);
  });

  it('should settle at most one pass cap of launches and name how many it left for the next boot', async () => {
    // Arrange
    const ids = Array.from({ length: 5 }, (_, n) => sid(10 + n));
    const w = await world(
      ids.map(id => [id, 'starting', BEFORE_BOOT] as const),
      { cap: 3 },
    );

    // Act
    const outcome = await w.pass.run();

    // Assert
    should(outcome.failed).have.length(3);
    should(outcome.kept.map(each => each.why)).deepEqual(['over-cap', 'over-cap']);
    should((await Promise.all(ids.map(w.statusOf))).filter(status => status === 'starting')).have.length(2);
    should(w.history).have.length(3);
    should(JSON.stringify(w.log.lines)).containEql('"left":2');
  });
});
