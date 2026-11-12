import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import {
  FerretFiles,
  type FerretRecord,
  FerretsChanged,
  FerretsPort,
  type FerretState,
  Harnesses,
  Runners,
} from '../../contract/index.ts';
import { FakeHarness, FakeRunner, ferretId, T0 } from '../../contract/testing/index.ts';
import ferrets from '../../daemon/index.ts';

/**
 * I108: Vault masks by what Ferrets says changed, so EVERY lifecycle path must publish the ferret's new state after its
 * durable write, and a removal must say `gone`. Each test reads the published events in order.
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

const planted = (id: string, state: FerretState): FerretRecord => ({
  format: 1,
  id: ferretId(id),
  name: id,
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  folder: `/work/${id}`,
  state,
  createdAt: T0,
  stateAt: T0,
});

async function host(records: readonly FerretRecord[] = [], runner = new FakeRunner()): Promise<TestHost> {
  const first = await testHost({
    everyDirectory: true,
    plugins: [ferrets, harnessPlugin(new FakeHarness()), runnerPlugin(runner)],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
  if (records.length === 0) return first;
  for (const each of records) first.state('ferrets').plant(FerretFiles, JSON.stringify(each), each.id);
  return await first.restart();
}

interface Change {
  readonly ferret: string;
  readonly state: FerretState;
  readonly gone?: true;
  readonly generation: number;
}
const changes = (h: TestHost, ferret?: string): Change[] =>
  h.published
    .filter(event => event.event === FerretsChanged.name)
    .map(event => event.payload as Change)
    .filter(change => ferret === undefined || change.ferret === ferret);
const states = (h: TestHost, ferret: string): FerretState[] => changes(h, ferret).map(change => change.state);

const start = async (h: TestHost): Promise<string> => {
  const answer = await h.request('POST', '/v1/ferrets', {
    body: { name: 'aniya', folder: '/work/a' },
    headers: { 'x-fy-request-id': randomUUID() },
  });
  expect(answer.status).toBe(201);
  return answer.json<{ id: string }>().id;
};

describe('every ferret lifecycle path publishes its state', () => {
  test('I108 a start publishes starting and then working, each carrying the ferret and a rising generation', async () => {
    const h = await host();
    const id = await start(h);
    expect(states(h, id)).toEqual(['starting', 'working']);
    const generations = changes(h, id).map(change => change.generation);
    expect(generations).toEqual([...generations].sort((a, b) => a - b));
    expect(new Set(generations).size).toBe(generations.length);
    expect(changes(h, id).every(change => change.gone === undefined)).toBe(true);
    await h.stop();
  });

  test('I108 a stop publishes stopped, and a stop of a stopped ferret publishes nothing more', async () => {
    const h = await host();
    const id = await start(h);
    const before = changes(h, id).length;
    await h.request('POST', `/v1/ferrets/${id}/stop`, { body: {} });
    expect(states(h, id).slice(before)).toEqual(['stopped']);
    const after = changes(h, id).length;
    await h.request('POST', `/v1/ferrets/${id}/stop`, { body: {} });
    expect(changes(h, id).length).toBe(after);
    await h.stop();
  });

  test('I108 a resume publishes starting and then working', async () => {
    const h = await host();
    const id = await start(h);
    await h.request('POST', `/v1/ferrets/${id}/stop`, { body: {} });
    const before = changes(h, id).length;
    const resumed = await h.request('POST', `/v1/ferrets/${id}/resume`, { body: {} });
    expect(resumed.status).toBe(200);
    expect(states(h, id).slice(before)).toEqual(['starting', 'working']);
    await h.stop();
  });

  test('I108 an attach publishes working', async () => {
    const runner = new FakeRunner();
    const h = await host([planted('lead', 'stopped')], runner);
    const before = changes(h, 'lead').length;
    const attached = await h.provided(FerretsPort).attach(ferretId('lead'), runner.adoptable(ferretId('lead')));
    expect(attached.ok).toBe(true);
    expect(states(h, 'lead').slice(before)).toEqual(['working']);
    await h.stop();
  });

  test('I108 a rename publishes the ferret with the state it is in', async () => {
    const h = await host([planted('lead', 'idle')]);
    const before = changes(h, 'lead').length;
    const renamed = await h.request('POST', '/v1/ferrets/lead/rename', { body: { name: 'piper' } });
    expect(renamed.status).toBe(200);
    expect(states(h, 'lead').slice(before)).toEqual(['idle']);
    await h.stop();
  });

  test('I108 a title change publishes too, because Vault reads the ferret’s summary on every change', async () => {
    const h = await host([planted('lead', 'working')]);
    const before = changes(h, 'lead').length;
    await h.request('POST', '/v1/ferrets/lead/rename', { body: { title: 'Ship it' } });
    expect(changes(h, 'lead').length).toBeGreaterThan(before);
    expect(states(h, 'lead').at(-1)).toBe('working');
    await h.stop();
  });

  test('I108 a daemon that boots with ferrets announces each one with the state it holds', async () => {
    const h = await host([planted('a', 'working'), planted('b', 'stopped')]);
    // The load is asynchronous; a read of the fleet waits for it.
    await h.request('GET', '/v1/ferrets');
    expect(states(h, 'a')).toContain('working');
    expect(states(h, 'b')).toContain('stopped');
    await h.stop();
  });

  test('I108 the event is published after the record is durable', async () => {
    const h = await host();
    const id = await start(h);
    const stored = JSON.parse(h.state('ferrets').raw(FerretFiles, id) as string) as FerretRecord;
    expect(stored.state).toBe(states(h, id).at(-1) as FerretState);
    await h.request('POST', `/v1/ferrets/${id}/stop`, { body: {} });
    expect((JSON.parse(h.state('ferrets').raw(FerretFiles, id) as string) as FerretRecord).state).toBe('stopped');
    expect(states(h, id).at(-1)).toBe('stopped');
    await h.stop();
  });
});
