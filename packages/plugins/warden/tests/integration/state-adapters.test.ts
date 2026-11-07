import { describe, it } from 'bun:test';
import should from 'should';
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import { ConfigWardenConfigStore } from '../../daemon/adapters/config-store.ts';
import { StateWardenJevCheckLog } from '../../daemon/adapters/jev-checks.ts';
import { FileWardenArtifacts } from '../../daemon/adapters/artifacts.ts';
import { StateWardenReportFiles, reportInstantMs } from '../../daemon/adapters/report-files.ts';
import { WardenReportReader } from '../../daemon/adapters/report-reader.ts';
import { StateAutoMoveLedger, StateWardenStateStore } from '../../daemon/adapters/state-store.ts';
import { WARDEN_STATE } from '../../contract/index.ts';
import { wardenConfig, wardenState } from '../support/kernel.ts';

describe('the sweep memory and the move ledger', () => {
  it('should keep the ledger when the sweep writes and the sweep when the ledger writes', async () => {
    // Arrange
    const state = wardenState();
    const store = new StateWardenStateStore(state);
    const ledger = new StateAutoMoveLedger(state);

    // Act
    await ledger.write({ moves: [{ sessionId: 'f1', at: '2026-11-06T09:00:00.000Z' }] } as never);
    await store.write({ lastSweepAt: '2026-11-06T09:00:00.000Z' } as never);
    await ledger.write({ moves: [] } as never);

    // Assert
    should(((await store.read()) as { lastSweepAt: string }).lastSweepAt).equal('2026-11-06T09:00:00.000Z');
    should(await ledger.read()).eql({ moves: [] });
  });

  it('should read nothing before the first sweep, and never the format stamp', async () => {
    // Arrange
    const store = new StateWardenStateStore(wardenState());

    // Act
    const first = await store.read();
    await store.write({ lastSweepAt: '2026-11-06T09:00:00.000Z' } as never);
    const later = (await store.read()) as Record<string, unknown>;

    // Assert
    should(first).be.undefined();
    should(later).not.have.property('format');
  });

  it('should refuse to write over a damaged file instead of starting from nothing', async () => {
    // Arrange
    const state = wardenState();
    state.folder.plant(WARDEN_STATE, '{not json');
    const store = new StateWardenStateStore(state);

    // Act
    const writing = store.write({ lastSweepAt: '2026-11-06T09:00:00.000Z' } as never);

    // Assert
    await writing.then(
      () => should.fail('', '', 'the write should have been refused'),
      (error: Error) => should(error.name).equal('WardenStateDamaged'),
    );
  });
});

describe('Jev checks by day', () => {
  const check = (at: string, sessionId = 's1') =>
    ({ at, sessionId, anomalyKind: 'sus_thinking', verdict: 'healthy', confidence: 0.9, costUsd: 0 }) as never;

  it('should hand back the newest checks first across days', async () => {
    // Arrange
    const now = Date.parse('2026-11-06T12:00:00.000Z');
    const log = new StateWardenJevCheckLog(wardenState(), () => now);
    await log.append(check('2026-11-05T10:00:00.000Z', 'a'));
    await log.append(check('2026-11-06T10:00:00.000Z', 'b'));
    await log.append(check('2026-11-06T11:00:00.000Z', 'c'));

    // Act
    const recent = await log.recent(10);

    // Assert
    should(recent.map(entry => entry.sessionId)).eql(['c', 'b', 'a']);
  });

  it('should keep no more than the retention window of days', async () => {
    // Arrange
    const state = wardenState();
    const old = Date.parse('2026-10-01T12:00:00.000Z');
    await new StateWardenJevCheckLog(state, () => old).append(check('2026-10-01T10:00:00.000Z'));

    // Act
    await new StateWardenJevCheckLog(state, () => Date.parse('2026-11-06T12:00:00.000Z')).append(
      check('2026-11-06T10:00:00.000Z'),
    );

    // Assert
    should([...state.folder.files.keys()].filter(path => path.startsWith('jev-checks/'))).eql([
      'jev-checks/2026-11-06.json',
    ]);
  });
});

describe('reports as state files', () => {
  const NAME = '2026-11-06T09-00-00-000Z-f1.md';

  it('should age a report by the instant in its name', () => {
    // Arrange / Act / Assert
    should(reportInstantMs(NAME)).equal(Date.parse('2026-11-06T09:00:00.000Z'));
    should(reportInstantMs('notes.md')).equal(0);
  });

  it('should read a written report back with its provenance on top and list it newest first', async () => {
    // Arrange
    const files = new StateWardenReportFiles(wardenState());
    const reader = new WardenReportReader(files, 'reports');
    const artifacts = new FileWardenArtifacts(files, reader, 'reports');
    const path = artifacts.reportPath('2026-11-06T09:00:00.000Z', 'f1');
    await files.writeTextAtomic(path, 'VERDICT: cleared\n\nit was fine\n');
    await files.writeTextAtomic(artifacts.reportPath('2026-11-06T10:00:00.000Z', 'f2'), 'VERDICT: nudged\n');

    // Act
    const latest = await artifacts.latest();
    const text = await reader.readReportAt(path);

    // Assert
    should(latest?.reportId).equal('2026-11-06T10-00-00-000Z-f2.md');
    should(text).containEql('it was fine');
    should(await reader.readReportAt('reports/../../elsewhere.md')).be.undefined();
  });

  it('should read a missing report as nothing', async () => {
    // Arrange
    const files = new StateWardenReportFiles(wardenState());

    // Act / Assert
    should(await files.readText('reports/absent.md')).be.undefined();
  });
});

describe('warden.yaml through the kernel config write port', () => {
  const door = (applied: unknown[], result: unknown) => {
    return Object.assign(wardenConfig({ caps: { jevDaily: 5 } }), {
      write: async (_def: unknown, _name: unknown, edit: unknown) => {
        applied.push(edit);
        return result as ConfigWriteOutcome;
      },
      remove: async (): Promise<ConfigWriteOutcome> => ({ kind: 'written', etag: 'fixture', loosened: [] }),
    });
  };

  it('should read the effective settings with the defaults under what the file says', async () => {
    // Arrange
    const store = new ConfigWardenConfigStore(wardenConfig({ enabled: false }));

    // Act
    const read = (await store.read()) as { enabled: boolean; caps: unknown };

    // Assert
    should(read.enabled).equal(false);
    should(read.caps).be.an.Object();
  });

  it('should merge a nested patch into the file section it changes and say what was held', async () => {
    // Arrange
    const applied: unknown[] = [];
    const store = new ConfigWardenConfigStore(
      door(applied, { kind: 'held', etag: 'e', id: 'warden.yaml@e', sentences: ['a bigger cap waits for you'] }),
    );

    // Act
    const held = await store.write({} as never, { caps: { llmDaily: 3 } } as never);

    // Assert
    should(applied[0]).eql({ patch: { caps: { jevDaily: 5, llmDaily: 3 } } });
    should(held).eql(['a bigger cap waits for you']);
  });

  it('should carry a refusal with the reasons the kernel gave', async () => {
    // Arrange
    const store = new ConfigWardenConfigStore(
      door([], { kind: 'refused', reason: 'schema', issues: [{ message: 'caps.jevDaily must be positive' }] }),
    );

    // Act
    const writing = store.write({} as never, { caps: { jevDaily: -1 } } as never);

    // Assert
    await writing.then(
      () => should.fail('', '', 'should have been refused'),
      (error: unknown) => should((error as Error).message).containEql('caps.jevDaily'),
    );
  });
});
