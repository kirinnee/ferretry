import { describe, expect, it } from 'bun:test';
import { DAEMON_FEATURES } from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import {
  agendaClearPort,
  CLEAR_NEEDS_UPDATE,
  type ClearPort,
  type ClearTarget,
  clearAgentsEverywhere,
  previewClearAgents,
} from '../../src/lib/agenda-clear-agents.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { DaemonHealthRead } from '../../src/lib/daemon-health.ts';
import { healthOf } from '../support/health.ts';

const FEATURE = DAEMON_FEATURES.agendaClearAgents;

const target = (id: string, name: string): ClearTarget => {
  const connection = daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceId: `token-${id}` });
  return { daemonId: connection.daemonId, name, connection };
};

const OFFERS: DaemonHealthRead = { kind: 'read', health: healthOf('5.0.0', [FEATURE]) };
const OLD: DaemonHealthRead = { kind: 'read', health: healthOf('4.9.0', []) };

interface Call {
  readonly url: string;
  readonly body: unknown;
}

/** A port whose machines answer by host: `health` for each, `reply` for what the clear route returns. */
const portFor = (
  health: Readonly<Record<string, DaemonHealthRead>>,
  reply: (host: string, dryRun: boolean) => Response | Error,
): { readonly port: ClearPort; readonly calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    port: {
      readHealth: async connection => health[new URL(connection.baseUrl).hostname] ?? { kind: 'failed' },
      fetcher: async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body ?? '{}')) as { dryRun?: boolean };
        calls.push({ url, body });
        const answer = reply(new URL(url).hostname, body.dryRun === true);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('agendaClearPort', () => {
  const connection = target('a', 'Workshop').connection;
  const fetcher: ClearPort['fetcher'] = async () => json({});

  it("reads a machine's health through the client the app builds for it", async () => {
    const health = healthOf('5.0.0', [FEATURE]);
    const port = agendaClearPort(
      { client: async () => ({ request: async () => health }) as unknown as Pick<FyApiClient, 'request'> },
      fetcher,
    );
    expect(port.fetcher).toBe(fetcher);
    expect(await port.readHealth(connection)).toEqual({ kind: 'read', health });
  });

  it('calls a machine it could not read failed, never old', async () => {
    const port = agendaClearPort({ client: async () => Promise.reject(new Error('offline')) }, fetcher);
    expect(await port.readHealth(connection)).toEqual({ kind: 'failed' });
  });
});

describe('previewClearAgents', () => {
  it('counts each machine that offers the feature with a dry run and sums them', async () => {
    const { port, calls } = portFor({ 'a.example.test': OFFERS, 'b.example.test': OFFERS }, host =>
      json({ cleared: host.startsWith('a') ? 3 : 4, sessions: host.startsWith('a') ? 2 : 1 }),
    );
    const preview = await previewClearAgents([target('a', 'Workshop'), target('b', 'Laptop')], port);
    expect(preview.total).toBe(7);
    expect(preview.rows.map(row => [row.kind, row.name])).toEqual([
      ['ready', 'Workshop'],
      ['ready', 'Laptop'],
    ]);
    expect(calls.map(call => [call.url, call.body])).toEqual([
      ['https://a.example.test/v1/agenda/clear-agents', { dryRun: true }],
      ['https://b.example.test/v1/agenda/clear-agents', { dryRun: true }],
    ]);
  });

  it('sends nothing to a machine without the feature and lists it as needing an update', async () => {
    const { port, calls } = portFor({ 'a.example.test': OFFERS, 'b.example.test': OLD }, () =>
      json({ cleared: 2, sessions: 1 }),
    );
    const preview = await previewClearAgents([target('a', 'Workshop'), target('b', 'Old box')], port);
    expect(preview.total).toBe(2);
    expect(preview.rows[1]).toEqual({ kind: 'needs-update', name: 'Old box' });
    expect(calls).toHaveLength(1);
  });

  it('lists a machine whose health did not answer, or whose clear route refused, as unreachable', async () => {
    const { port } = portFor(
      { 'a.example.test': { kind: 'failed' }, 'b.example.test': OFFERS, 'c.example.test': OFFERS },
      host => (host.startsWith('b') ? json({ error: 'nope' }, 500) : new Error('offline')),
    );
    const preview = await previewClearAgents([target('a', 'A'), target('b', 'B'), target('c', 'C')], port);
    expect(preview.total).toBe(0);
    expect(preview.rows.map(row => row.kind)).toEqual(['unreachable', 'unreachable', 'unreachable']);
  });
});

describe('clearAgentsEverywhere', () => {
  it('clears only the machines that can, adds up what they dismissed and passes the others along', async () => {
    const { port, calls } = portFor(
      { 'a.example.test': OFFERS, 'b.example.test': OLD, 'c.example.test': OFFERS, 'd.example.test': OFFERS },
      (host, dryRun) => {
        if (host.startsWith('d') && !dryRun) return json({ error: 'gone' }, 503);
        return json({ cleared: host.startsWith('a') ? 3 : 2, sessions: 1 });
      },
    );
    const targets = [target('a', 'Workshop'), target('b', 'Old box'), target('c', 'Laptop'), target('d', 'Flaky')];
    const preview = await previewClearAgents(targets, port);
    calls.length = 0;
    const outcome = await clearAgentsEverywhere(preview, port);
    expect(calls.map(call => [new URL(call.url).hostname, call.body])).toEqual([
      ['a.example.test', {}],
      ['c.example.test', {}],
      ['d.example.test', {}],
    ]);
    expect(outcome).toEqual({ cleared: 5, sessions: 2, needsUpdate: ['Old box'], unreachable: ['Flaky'] });
  });

  it('says what it could not reach before the clear as well', async () => {
    const { port } = portFor({ 'a.example.test': { kind: 'loading' } }, () => json({ cleared: 0, sessions: 0 }));
    const outcome = await clearAgentsEverywhere(await previewClearAgents([target('a', 'Slow')], port), port);
    expect(outcome).toEqual({ cleared: 0, sessions: 0, needsUpdate: [], unreachable: ['Slow'] });
  });

  it('words the update hint the way snoozing does', () => {
    expect(CLEAR_NEEDS_UPDATE).toStartWith('needs an update to clear: ');
  });
});
