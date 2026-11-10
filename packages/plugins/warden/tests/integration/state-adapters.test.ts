import { describe, it } from 'bun:test';
import should from 'should';
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import { ConfigWardenConfigStore } from '../../daemon/adapters/config-store.ts';
import { StateWardenJevCheckLog } from '../../daemon/adapters/jev-checks.ts';
import { FileWardenArtifacts } from '../../daemon/adapters/artifacts.ts';
import { StateWardenReportFiles, reportInstantMs } from '../../daemon/adapters/report-files.ts';
import { WardenReportReader } from '../../daemon/adapters/report-reader.ts';
import { StateAutoMoveLedger, StateMachineMembers, StateWardenStateStore } from '../../daemon/adapters/state-store.ts';
import { WARDEN_STATE, effectiveWardenConfig } from '../../contract/index.ts';
import { applyWardenConfigPatch, type WardenConfigPatch } from '../../daemon/lib/index.ts';
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

describe('B187 the members a machine notice listed', () => {
  it('B187 each notice keeps its own members beside the sweep memory and the move ledger', async () => {
    // Arrange
    const state = wardenState();
    const input = new StateMachineMembers(state, 'warden:input-stuck');
    const inbox = new StateMachineMembers(state, 'warden:inbox-stuck');
    const store = new StateWardenStateStore(state);
    const ledger = new StateAutoMoveLedger(state);

    // Act: every writer in turn, so each must keep what the others wrote.
    should(await input.read()).eql({});
    await input.write({ nelly: ['nelly', 'a line', '2026-11-06T09:00:00.000Z'] });
    await inbox.write({ ryu: ['ryu', 'another line', '2026-11-06T09:05:00.000Z'] });
    await store.write({ lastSweepAt: '2026-11-06T09:10:00.000Z' } as never);
    await ledger.write({ moves: [] } as never);

    // Assert
    should(await input.read()).eql({ nelly: ['nelly', 'a line', '2026-11-06T09:00:00.000Z'] });
    should(await inbox.read()).eql({ ryu: ['ryu', 'another line', '2026-11-06T09:05:00.000Z'] });
    const sweep = (await store.read()) as Record<string, unknown>;
    should(sweep.lastSweepAt).equal('2026-11-06T09:10:00.000Z');
    should(sweep).not.have.property('machineNotices');
    should(await ledger.read()).eql({ moves: [] });
  });

  it('B187 a damaged file is never read as no members, and never written over', async () => {
    // Arrange
    const state = wardenState();
    state.folder.plant(WARDEN_STATE, '{not json');
    const members = new StateMachineMembers(state, 'warden:input-stuck');

    // Act, Assert
    await members.read().then(
      () => should.fail('', '', 'the read should have been refused'),
      (error: Error) => should(error.name).equal('WardenStateDamaged'),
    );
    await members.write({}).then(
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
    return Object.assign(wardenConfig({ caps: { jevUsdPerDay: 5 } }), {
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

  it('should write the whole settings, the file section it changes merged with the patch, and say what was held', async () => {
    // Arrange: the save carries the settings as they will be (the ones in effect plus the owner's patch), as the sweep hands it
    const applied: unknown[] = [];
    const store = new ConfigWardenConfigStore(
      door(applied, { kind: 'held', etag: 'e', id: 'warden.yaml@e', sentences: ['a bigger cap waits for you'] }),
    );
    const patch = { caps: { investigationUsdPerDay: 3 } } as WardenConfigPatch;
    const next = applyWardenConfigPatch(effectiveWardenConfig({ caps: { jevUsdPerDay: 5 } } as never), patch);

    // Act
    const held = await store.write(next, patch);

    // Assert: the section keeps what the file said and gains the patch; a key neither states stays out of the file
    const written = (applied[0] as { patch: Record<string, unknown> }).patch;
    should(written.caps).eql({ jevUsdPerDay: 5, investigationUsdPerDay: 3 });
    should(written.enabled).be.undefined();
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
