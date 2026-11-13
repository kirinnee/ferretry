import { describe, expect, it } from 'bun:test';
import {
  type ClearPort,
  type ClearTarget,
  clearAgentsEverywhere,
  previewClearAgents,
} from '../../../app/lib/agenda-clear-agents.ts';
import { daemonConnection } from '../../../app/shell.ts';
import { callFromFetch } from '../../support/app/call-from-fetch.ts';

const target = (id: string, name: string): ClearTarget => {
  const connection = daemonConnection({ daemonId: id });
  return { daemonId: connection.daemonId, name, connection };
};

interface Call {
  readonly url: string;
  readonly body: unknown;
}

/** A port whose machines answer by host: `reply` is what the clear route returns. */
const portFor = (
  reply: (host: string, dryRun: boolean) => Response | Error,
): { readonly port: ClearPort; readonly calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    port: {
      // Each machine is reached through its own client; the test names it by host.
      clientFor: target =>
        callFromFetch(async (url, init) => {
          const body = JSON.parse(String(init.body ?? '{}')) as { dryRun?: boolean };
          calls.push({ url, body });
          const answer = reply(new URL(url).hostname, body.dryRun === true);
          if (answer instanceof Error) throw answer;
          return answer;
        }, `https://${target.daemonId}.example.test`),
    },
  };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('previewClearAgents', () => {
  it('counts each machine with a dry run and sums them', async () => {
    const { port, calls } = portFor(host =>
      json({ cleared: host.startsWith('a') ? 3 : 4, ferrets: host.startsWith('a') ? 2 : 1 }),
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

  it('lists a machine that did not answer, or whose clear route refused, as unreachable', async () => {
    const { port } = portFor(host => (host.startsWith('b') ? json({ error: 'nope' }, 500) : new Error('offline')));
    const preview = await previewClearAgents([target('a', 'A'), target('b', 'B')], port);
    expect(preview.total).toBe(0);
    expect(preview.rows.map(row => row.kind)).toEqual(['unreachable', 'unreachable']);
  });
});

describe('clearAgentsEverywhere', () => {
  it('clears only the machines that answered, adds up what they dismissed and passes the others along', async () => {
    const { port, calls } = portFor((host, dryRun) => {
      if (host.startsWith('b')) return new Error('offline');
      if (host.startsWith('d') && !dryRun) return json({ error: 'gone' }, 503);
      return json({ cleared: host.startsWith('a') ? 3 : 2, ferrets: 1 });
    });
    const targets = [target('a', 'Workshop'), target('b', 'Old box'), target('c', 'Laptop'), target('d', 'Flaky')];
    const preview = await previewClearAgents(targets, port);
    calls.length = 0;
    const outcome = await clearAgentsEverywhere(preview, port);
    expect(calls.map(call => [new URL(call.url).hostname, call.body])).toEqual([
      ['a.example.test', {}],
      ['c.example.test', {}],
      ['d.example.test', {}],
    ]);
    expect(outcome).toEqual({ cleared: 5, ferrets: 2, unreachable: ['Old box', 'Flaky'] });
  });

  it('says what it could not reach before the clear as well', async () => {
    const { port } = portFor(() => new Error('offline'));
    const outcome = await clearAgentsEverywhere(await previewClearAgents([target('a', 'Slow')], port), port);
    expect(outcome).toEqual({ cleared: 0, ferrets: 0, unreachable: ['Slow'] });
  });
});

describe('a machine this half has no client for', () => {
  it('is listed as unreachable and is never asked through another machine’s client', async () => {
    const { port, calls } = portFor(() => json({ cleared: 1, ferrets: 1 }));
    const only: ClearPort = { clientFor: each => (each.daemonId === 'a' ? port.clientFor(each) : undefined) };
    const preview = await previewClearAgents([target('a', 'Here'), target('b', 'Elsewhere')], only);
    expect(preview.rows.map(row => [row.kind, row.name])).toEqual([
      ['ready', 'Here'],
      ['unreachable', 'Elsewhere'],
    ]);
    expect(calls.map(call => new URL(call.url).hostname)).toEqual(['a.example.test']);
  });
});
