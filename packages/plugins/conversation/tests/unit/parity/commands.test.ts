/**
 * Parity rows V-0057, V-0285, V-0367, V-0368, V-0369, V-0372, V-0373, V-0396, V-0430 (docs/design/rebuild-parity.tsv):
 * every `fy` verb Conversation owns, by today's spelling, reaching the route that serves it. The alias rows are removed
 * by design (§1.4), `fy import` is `fy link` (§1.4: imports are links), and `fy fs`, `fy pin` and `fy history` are
 * Ferrets' (its manifest declares their routes and holds the conversation lease).
 */
import { describe, expect, test } from 'bun:test';
import type { CliHalf, PluginClient, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import cli from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';

interface Call {
  readonly route: string;
  readonly init?: { readonly params?: Record<string, string>; readonly body?: unknown; readonly query?: unknown };
}

function run(answers: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const client: PluginClient = {
    call: async (route, init) => {
      calls.push({ route, ...(init === undefined ? {} : { init: init as Call['init'] }) });
      const answer = answers[route];
      if (answer instanceof Error) throw answer;
      return answer as never;
    },
    subscribe: () => () => {},
  };
  const io: TerminalIo = { out: text => out.push(text), err: text => err.push(text), isTty: false };
  const half = cli.build?.({ manifest, client, io }) as CliHalf<typeof manifest>;
  const verb = async (name: string, args: string[] = [], options: VerbInvocation['options'] = {}) =>
    await (half.verbs as Record<string, (invocation: VerbInvocation) => Promise<number>>)[name]?.({ args, options });
  return { calls, out, err, verb };
}

const AT = '2026-11-07T09:00:00.000Z';
const QUEUED = {
  v: 1,
  id: 'm1',
  sender: 'human',
  text: 'hello',
  attachmentIds: [],
  enqueuedAt: AT,
  state: 'queued',
  stateAt: AT,
  revision: 1,
};

describe('the verbs Conversation owns', () => {
  test('V-0430 fy send <id> [message...] sends the words to that ferret', async () => {
    const t = run({ 'POST /v1/ferrets/:ferretId/send': { sendId: 's1', state: 'delivered' } });
    await t.verb('send', ['lead', 'hello', 'there']);
    const sent = t.calls.find(call => call.route === 'POST /v1/ferrets/:ferretId/send');
    expect(sent?.init?.params).toEqual({ ferretId: 'lead' });
    expect(sent?.init?.body).toMatchObject({ message: 'hello there' });
  });

  test('V-0057 fy answer <id> [labels...] reads the pending question of that ferret first', async () => {
    const t = run({ 'GET /v1/ferrets/:ferretId/question': null });
    await t.verb('answer', ['lead', 'Yes']);
    expect(t.calls[0]).toMatchObject({
      route: 'GET /v1/ferrets/:ferretId/question',
      init: { params: { ferretId: 'lead' } },
    });
  });

  test('V-0367 fy queue <ferret> lists its queued messages', async () => {
    const t = run({ 'GET /v1/ferrets/:ferretId/queue': { messages: [QUEUED] } });
    expect(await t.verb('queue', ['lead'])).toBe(0);
    expect(t.calls[0]).toMatchObject({
      route: 'GET /v1/ferrets/:ferretId/queue',
      init: { params: { ferretId: 'lead' } },
    });
  });

  test('V-0368 fy queue cancel <ferret> <id> withdraws one queued message', async () => {
    const t = run({ 'DELETE /v1/ferrets/:ferretId/queue/:messageId': QUEUED });
    await t.verb('queue cancel', ['lead', 'm1']);
    expect(t.calls[0]).toMatchObject({
      route: 'DELETE /v1/ferrets/:ferretId/queue/:messageId',
      init: { params: { ferretId: 'lead', messageId: 'm1' } },
    });
  });

  test('V-0369 fy queue edit <ferret> <id> <text...> rewrites one queued message', async () => {
    const t = run({ 'PATCH /v1/ferrets/:ferretId/queue/:messageId': { ...QUEUED, text: 'new words' } });
    await t.verb('queue edit', ['lead', 'm1', 'new', 'words']);
    expect(t.calls[0]).toMatchObject({
      route: 'PATCH /v1/ferrets/:ferretId/queue/:messageId',
      init: { params: { ferretId: 'lead', messageId: 'm1' }, body: { text: 'new words' } },
    });
  });

  test('V-0372 V-0373 fy render and fy render guide are declared, and the guide is said without the daemon', async () => {
    expect(manifest.actions.cli.map(declared => declared.verb)).toEqual(
      expect.arrayContaining(['render', 'render guide']),
    );
    const t = run();
    expect(await t.verb('render guide')).toBe(0);
    expect(t.calls).toEqual([]);
    expect(t.out.join('').length).toBeGreaterThan(0);
  });

  test('V-0396 fy search <text...> searches work by what it says', async () => {
    const t = run({ 'GET /v1/search': { hits: [], total: 0, indexed: { cards: 0, asks: 0 } } });
    await t.verb('search', ['relay', 'carrier']);
    expect(t.calls[0]).toMatchObject({ route: 'GET /v1/search', init: { query: { q: 'relay carrier' } } });
  });

  test('V-0285 fy import conversations is fy link: it lists the conversations the harnesses hold', async () => {
    const t = run({ 'GET /v1/links/conversations': { conversations: [], total: 0 } });
    await t.verb('link');
    expect(t.calls[0]?.route).toBe('GET /v1/links/conversations');
  });
});
