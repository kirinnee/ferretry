import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { FerretFiles, FerretHistoryFiles, type FerretRecord, Harnesses, Runners } from '../../../../contract/index.ts';
import { createSessionEvent, encodeSessionEvent } from '../../../../daemon/lib/storage/journal.ts';
import { FakeHarness, FakeRunner, ferretId, T0 } from '../../../../contract/testing/index.ts';
import ferrets from '../../../../daemon/index.ts';
import { SessionConfigSchema } from '../../../../daemon/lib/protocol/session.ts';

/**
 * RULING #31b, through the real daemon half: a ferret started by the ordinary start route gets its session document
 * (config.json) with its spawn stamp, the daemon restarts, and the next starts are still stamped, because the strict
 * spawn-ancestry rule (unchanged: an indexed ferret with no document refuses every stamp) finds a document for every
 * ferret the fleet holds, including one that ran before the writer existed and holds only its journal.
 *
 * A CHILD start through this route is refused by Packs' helper admission (`helper_admission_unavailable`) before the
 * stamp is reached, because that admission is not bound in this build; the test pins that it is refused by THAT and
 * by nothing in the stamp. The child's stamp itself is proved on the service (unit test `deliver-turns.test.ts`, "a
 * ferret that ran before the writer … so a child of it is stamped").
 *
 * CI only (integration tier). Fixture values only.
 */

const harnessPlugin = (harness: FakeHarness) =>
  implementDaemon(
    definePlugin({
      id: 'claude-code',
      title: 'Claude Code (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Harnesses, key: 'claude-code' }] },
    }),
    { build: () => ({ hooks: { 'harnesses:claude-code': harness } }) },
  );
const runnerPlugin = (runner: FakeRunner) =>
  implementDaemon(
    definePlugin({
      id: 'terminals',
      title: 'Terminals (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
    }),
    { build: () => ({ hooks: { 'runners:tmux': runner } }) },
  );

async function boot(): Promise<TestHost> {
  return await testHost({
    plugins: [ferrets, harnessPlugin(new FakeHarness()), runnerPlugin(new FakeRunner())],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
}

const start = async (h: TestHost, body: Record<string, unknown>) =>
  await h.request('POST', '/v1/ferrets', { headers: { 'x-fy-request-id': randomUUID() }, body });

/** The ferret's session document as it is on disk, parsed with the protocol's own schema. */
const document = (h: TestHost, id: string) => {
  const raw = h.state('ferrets').files.get(`${id}/config.json`);
  return raw === undefined ? undefined : SessionConfigSchema.parse(JSON.parse(raw as string));
};

describe('ruling #31b: the session-document writer, across a daemon restart', () => {
  test('a started ferret is documented and stamped; after a restart the fleet still stamps, and a child is refused only by helper admission', async () => {
    // Arrange: a lead started through the real start route, then stopped (its journal is written).
    const first = await boot();
    const started = await start(first, { folder: '/work/a', prompt: 'Lead the work.' });
    expect(started.status).toBeLessThan(300);
    const { id: lead } = started.json<{ id: string }>();
    await first.settle();
    expect(document(first, lead)?.provenance).toBeDefined();
    expect((await first.request('POST', `/v1/ferrets/${lead}/stop?how=now`, { body: {} })).status).toBeLessThan(300);

    // A ferret from before the writer: its record and journal, no document.
    const older: FerretRecord = {
      format: 1,
      id: ferretId('mw7bp88g-01d00001'),
      name: 'older',
      role: 'lead',
      harness: 'claude-code',
      runner: 'tmux',
      folder: '/work/older',
      state: 'stopped',
      createdAt: T0,
      stateAt: T0,
    };
    first.state('ferrets').plant(FerretFiles, JSON.stringify(older), older.id);
    first
      .state('ferrets')
      .plant(
        FerretHistoryFiles,
        `${encodeSessionEvent(createSessionEvent(older.id as never, 0, T0, 'session.stopped', { reason: 'fixture' }))}\n`,
        older.id,
      );

    // Act: restart the daemon, then start again.
    const second = await first.restart();
    await second.settle();
    const next = await start(second, { folder: '/work/b', prompt: 'Another lead.' });
    const child = await start(second, { folder: '/work/a', prompt: 'Help.', parent: lead });

    // Assert: the backfill documented the older ferret; the strict ancestry accepted the fleet and stamped the start.
    expect(document(second, older.id)).toMatchObject({ id: older.id, name: 'older', cwd: '/work/older' });
    expect(next.status).toBeLessThan(300);
    const { id: other } = next.json<{ id: string }>();
    expect(document(second, other)?.provenance).toBeDefined();
    // The child reaches Packs' admission, which is not bound, and is refused there, not by its stamp.
    expect(child.status).toBe(503);
    expect(child.json<{ code: string }>().code).toBe('helper_admission_unavailable');
  });
});
