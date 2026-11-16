import { describe, it } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import should from 'should';
import {
  FerretHistoryFiles,
  HealthEventSchema,
  HealthEventsFile,
  SelfRestartFile,
} from '../../../../../contract/index.ts';
import { buildHealth } from '../../../../../daemon/modules/health.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import {
  memoryStorage,
  RecordingLog,
  SESSION_STORE_FILES,
  sessionState,
  T0,
} from '../../../../support/daemon/storage.ts';

/**
 * The daemon's self-check as the `ferrets.self-check` job runs it (parity rows F-0203 `health.jsonl`, F-0209
 * `self-restart.json`, J-0032 and J-0118 the timer): the real adapters over the kernel test host's memory state. A
 * session whose journal vanished is the one finding no reindex can heal, so it is what walks the check through an
 * `index_incoherent` line, three passes, and a restart request the daemon has no lever to grant.
 */

const NOW_MS = Date.parse(T0);

async function world() {
  const opened = await memoryStorage();
  const port = opened.folder.port([HealthEventsFile, SelfRestartFile]);
  const stampWrites: unknown[] = [];
  const state: StatePort = {
    ...port,
    write: async (file, value, name) => {
      if (file === SelfRestartFile) stampWrites.push(value);
      await port.write(file, value, name);
    },
  };
  const warnings: string[] = [];
  const health = buildHealth({
    state,
    storage: opened.storage,
    clock: { now: () => T0, nowMs: () => NOW_MS },
    loop: { blockedMs: () => 0 },
    version: '5.0.0',
    bootstrap: { finished: () => true, errors: () => [] },
    log: { warn: message => void warnings.push(message) },
  });
  const events = async () => (await port.records(HealthEventsFile)).records.map(line => HealthEventSchema.parse(line));
  return { ...opened, port, health, stampWrites, warnings, events };
}

/** A session whose indexed journal has vanished: nothing a reindex does brings it back. */
async function lostJournal(w: Awaited<ReturnType<typeof world>>, id: string): Promise<void> {
  const session = parseSessionId(id);
  await w.storage.writeState(session, sessionState(id));
  await w.storage.append(session, 'first', {});
  await w.folder.port(SESSION_STORE_FILES).remove(FerretHistoryFiles, id);
}

describe('the daemon self-check job', () => {
  it('should write nothing for a healthy fleet', async () => {
    // Arrange
    const w = await world();
    await w.storage.writeState(parseSessionId('well'), sessionState('well'));

    // Act
    const outcome = await w.health.tick();

    // Assert
    should(outcome?.escalated).be.false();
    should(await w.events()).deepEqual([]);
    should(w.folder.raw(HealthEventsFile)).be.undefined();
    should(w.folder.raw(SelfRestartFile)).be.undefined();
  });

  it('should append a line to health.jsonl, stamped and typed, when the index cannot be healed', async () => {
    // Arrange
    const w = await world();
    await lostJournal(w, 'gone');

    // Act
    await w.health.tick();

    // Assert
    const [line, ...rest] = await w.events();
    should(rest).deepEqual([]);
    should(line?.type).equal('fleet.index_incoherent');
    should(line?.at).equal(T0);
    should(line?.data).match({ unhealable: ['gone'], consecutive: 1, recovered: false });
  });

  it('should stamp self-restart.json before it asks, and take the stamp back when nothing can restart the daemon', async () => {
    // Arrange
    const w = await world();
    await lostJournal(w, 'gone');

    // Act
    await w.health.tick();
    await w.health.tick();
    const third = await w.health.tick();

    // Assert — the stamp was written for the request, then cleared because the handler answered false.
    should(third?.escalated).be.false();
    should(w.stampWrites).deepEqual([{ format: 1, at: T0, sessions: ['gone'] }]);
    should(w.folder.raw(SelfRestartFile)).be.undefined();
    const restart = (await w.events()).find(line => line.type === 'fleet.daemon_self_restart');
    should(restart?.data).match({ outcome: 'unsupervised', sessions: ['gone'], consecutive: 3 });
    should(String(restart?.data.message)).containEql(
      'this daemon is not under a service manager — restart it yourself',
    );
  });

  it('should stay report-only: no ferret file is changed, removed or recreated, whatever the check finds', async () => {
    // Arrange
    const w = await world();
    await lostJournal(w, 'gone');
    await w.storage.writeState(parseSessionId('other'), sessionState('other', { status: 'stopped' }));
    const ferretFiles = (): string =>
      JSON.stringify([...w.folder.files].filter(([path]) => /^(gone|other)\//.test(path)).sort());
    const before = ferretFiles();

    // Act
    for (let pass = 0; pass < 4; pass += 1) await w.health.tick();

    // Assert
    should(ferretFiles()).equal(before);
  });

  it('should warn and answer nothing when a check fails, so the job never throws and is not restarted with backoff', async () => {
    // Arrange
    const w = await world();
    w.storage.close();

    // Act
    const outcome = await w.health.tick();

    // Assert
    should(outcome).be.undefined();
    should(w.warnings).deepEqual(['the daemon self-check failed']);
  });

  it('should use the self-check cadence the settings name, and a wedge threshold above it', async () => {
    // Arrange
    const w = await world();

    // Assert
    should(w.health.settings.selfCheckIntervalMs).equal(60_000);
    should(w.health.settings.wedgeGapMs).be.above(w.health.settings.selfCheckIntervalMs);
  });
});

describe('the session store a failed load leaves', () => {
  it('should be named in the report rather than hidden', async () => {
    // Arrange
    const opened = await memoryStorage({ log: new RecordingLog() });
    const health = buildHealth({
      state: opened.folder.port([HealthEventsFile, SelfRestartFile]),
      storage: opened.storage,
      clock: { now: () => T0, nowMs: () => NOW_MS },
      loop: { blockedMs: () => 0 },
      version: '5.0.0',
      bootstrap: { finished: () => true, errors: () => ['the archive did not load'] },
      log: { warn: () => undefined },
    });

    // Act
    const report = await health.service.report();

    // Assert
    should(JSON.stringify(report)).containEql('the archive did not load');
  });
});
