import { describe, it } from 'bun:test';
import { BodyTooLargeError } from '@ferretry/kernel/contract';
import should from 'should';
import { CONNECTOR_TOOL_NAMES } from '../../../daemon/lib/mcp/demands.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { agendaItem, ferretView, ok, READ_ACCESS } from '../../support/mcp-fixtures.ts';
import { callTool, INIT, post, rig, rpc, TOKEN, tool } from '../../support/mcp-harness.ts';

interface ListedTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: Record<string, boolean>;
  readonly inputSchema: { readonly type: string; readonly properties: Record<string, Record<string, unknown>> };
}
interface RpcFailure {
  readonly error?: unknown;
}

const LIZ = ferretView({
  id: 'mwuanehg-4531fa9e',
  callsign: 'lizzette',
  task: '[Lizzette] Build MCP Connector',
  state: 'working',
});
const MARIN = ferretView({
  id: 'mxk2aa11-0001ffff',
  callsign: 'marin',
  task: 'Fix the login page',
  state: 'idle',
});
const ferretsRoute =
  (views = [LIZ, MARIN]) =>
  (call: { method: string; path: string }) =>
    call.method === 'GET' && call.path === '/v1/ferrets' ? ok(views) : undefined;

describe('/mcp — gates before any tool', () => {
  it('answers undefined for any other path', async () => {
    const r = rig();
    should(await post(r.endpoint, rpc('tools/list'), { path: '/other' })).be.undefined();
  });

  it('refuses GET and DELETE with 405 and Allow: POST', async () => {
    const r = rig();
    for (const method of ['GET', 'DELETE']) {
      const response = await post(r.endpoint, '', { method });
      should(response?.status).equal(405);
      should(response?.headers.get('allow')).equal('POST');
    }
  });

  it('401s a request with no token, through the injected builder, without verifying or calling a tool', async () => {
    const r = rig();
    r.delegate.on(ferretsRoute());
    const response = await post(r.endpoint, callTool('list_ferrets', {}), { token: null });
    should(response?.status).equal(401);
    should(response?.headers.get('www-authenticate')).equal('Bearer');
    should(r.state.verifications).equal(0);
    should(r.delegate.calls.length).equal(0);
  });

  it('401s a bad token as invalid_token and never reaches a tool', async () => {
    const r = rig();
    r.delegate.on(ferretsRoute());
    const response = await post(r.endpoint, callTool('list_ferrets', {}), { token: 'fyc_at_wrong' });
    should(response?.status).equal(401);
    should(response?.headers.get('www-authenticate')).containEql('invalid_token');
    should(r.delegate.calls.length).equal(0);
  });

  it('401s when the verifier finds no live access', async () => {
    const r = rig();
    r.state.access = undefined;
    should((await post(r.endpoint, INIT))?.status).equal(401);
  });

  it('403s a present Origin that is not allow-listed, even with a good token', async () => {
    const r = rig();
    should((await post(r.endpoint, INIT, { origin: 'https://evil.example' }))?.status).equal(403);
    const allowed = rig({ allowedOrigins: ['https://claude.ai'] });
    should((await post(allowed.endpoint, INIT, { origin: 'https://claude.ai' }))?.status).equal(200);
  });

  it('refuses non-JSON content types, unparseable bodies and batches', async () => {
    const r = rig();
    should((await post(r.endpoint, INIT, { contentType: 'text/plain' }))?.status).equal(415);
    should((await post(r.endpoint, '{not json'))?.status).equal(400);
    should((await post(r.endpoint, [INIT]))?.status).equal(400);
  });
});

describe('/mcp — the real SDK round trip', () => {
  it('initialize → tools/list → tools/call over JSON', async () => {
    const r = rig();
    r.delegate.on(ferretsRoute());
    const init = await post(r.endpoint, INIT);
    should(init?.status).equal(200);
    const initBody = JSON.parse(init?.body ?? '{}');
    should(initBody.result.serverInfo.name).equal('ferretry');
    should(initBody.result.protocolVersion).equal('2025-11-25');
    should(init?.headers.get('cache-control')).equal('no-store');

    const list = JSON.parse((await post(r.endpoint, rpc('tools/list')))?.body ?? '{}');
    const names: string[] = list.result.tools.map((t: { name: string }) => t.name);
    should(names.sort()).eql([...CONNECTOR_TOOL_NAMES].sort());

    const called = await tool(r, 'list_ferrets', {});
    should(called.isError).be.false();
    should(called.text).containEql('2 ferrets running:');
    should(called.text).containEql('Lizzette — [Lizzette] Build MCP Connector — working — 5 min ago');
    should(called.text).containEql('Marin — Fix the login page — idle, waiting for a message');
  });

  it('lists titles, descriptions and the right annotations on every tool', async () => {
    const r = rig();
    const list = JSON.parse((await post(r.endpoint, rpc('tools/list')))?.body ?? '{}');
    const byName = new Map<string, ListedTool>(list.result.tools.map((t: ListedTool) => [t.name, t]));
    const listed = (name: string): ListedTool => byName.get(name) as ListedTool;
    for (const tl of byName.values()) {
      should(tl.title).be.a.String();
      should(tl.description.length).be.above(30);
      should(tl.annotations.openWorldHint).be.false();
      should(tl.inputSchema.type).equal('object');
    }
    for (const read of ['list_ferrets', 'get_ferret', 'get_ferret_output', 'list_attention', 'get_attention'])
      should(listed(read).annotations).containEql({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    for (const destructive of ['restart_ferret', 'stop_ferret'])
      should(listed(destructive).annotations).containEql({ readOnlyHint: false, destructiveHint: true });
    for (const write of ['send_to_ferret', 'answer_attention', 'snooze_attention', 'spawn_ferret'])
      should(listed(write).annotations).containEql({ readOnlyHint: false, destructiveHint: false });
    should(listed('get_ferret_output').inputSchema.properties.lines?.maximum).equal(100_000);
    should(listed('send_to_ferret').inputSchema.properties.message?.maxLength).equal(8000);
  });

  it('does not offer write tools to a read-only token, and says so as a tool error when one is called', async () => {
    const r = rig();
    r.state.access = READ_ACCESS;
    r.delegate.on(ferretsRoute());
    const list = JSON.parse((await post(r.endpoint, rpc('tools/list')))?.body ?? '{}');
    should(list.result.tools.map((t: { name: string }) => t.name).sort()).eql(
      ['get_ferret', 'get_ferret_output', 'get_attention', 'list_attention', 'list_ferrets'].sort(),
    );
    const stop = await tool(r, 'stop_ferret', { ferret: 'lizzette' });
    should(stop.isError).be.true();
    should(stop.text).containEql('only look');
    should(r.delegate.calls.length).equal(0);
    should(r.calls.records.map(c => [c.tool, c.outcome])).eql([['stop_ferret', 'refused']]);
    should(r.audit.events.length).equal(0);
  });

  it('answers an unsupported MCP-Protocol-Version with a 400 before refusing a read-only token a write tool', async () => {
    const r = rig();
    r.state.access = READ_ACCESS;
    const reply = await tool(r, 'stop_ferret', { ferret: 'lizzette' }, { protocolVersion: '1999-01-01' });
    should(reply.status).equal(400);
    should(JSON.stringify(reply.raw)).containEql('Unsupported protocol version: 1999-01-01');
    should(r.delegate.calls.length).equal(0);
    should(r.calls.records.length).equal(0);
    const supported = await tool(r, 'stop_ferret', { ferret: 'lizzette' }, { protocolVersion: '2025-11-25' });
    should(supported.status).equal(200);
    should(supported.text).containEql('only look');
  });

  it('refuses an invalid argument as a protocol error, never reaching the daemon', async () => {
    const r = rig();
    const reply = await tool(r, 'get_ferret_output', { ferret: 'x', lines: 0 });
    should(reply.isError || (reply.raw as RpcFailure).error !== undefined).be.true();
    should(r.delegate.calls.length).equal(0);
  });
});

describe('/mcp — rate limits', () => {
  it('429s the 61st call in a minute with Retry-After, and frees up as the window slides', async () => {
    const r = rig();
    r.delegate.on(ferretsRoute());
    for (let n = 0; n < 60; n += 1) should((await post(r.endpoint, callTool('list_ferrets', {})))?.status).equal(200);
    const over = await post(r.endpoint, callTool('list_ferrets', {}));
    should(over?.status).equal(429);
    should(Number(over?.headers.get('retry-after'))).be.above(0);
    r.state.now += 61_000;
    should((await post(r.endpoint, callTool('list_ferrets', {})))?.status).equal(200);
  });

  it('429s the 11th write in a minute but lets reads through; initialize and list are free', async () => {
    const r = rig();
    r.delegate
      .on(ferretsRoute())
      .on(call => (call.path.endsWith('/stop') ? ok({ id: LIZ.id, state: 'stopped' }) : undefined));
    for (let n = 0; n < 10; n += 1)
      should((await post(r.endpoint, callTool('stop_ferret', { ferret: 'lizzette' })))?.status).equal(200);
    should((await post(r.endpoint, callTool('stop_ferret', { ferret: 'lizzette' })))?.status).equal(429);
    should((await post(r.endpoint, callTool('list_ferrets', {})))?.status).equal(200);
    should((await post(r.endpoint, rpc('tools/list')))?.status).equal(200);
    should((await post(r.endpoint, INIT))?.status).equal(200);
  });

  it('lets an agenda clean-up burst of 30 answers and snoozes through beside the 10 other writes, and 429s the 31st', async () => {
    const r = rig();
    r.delegate
      .on(ferretsRoute())
      .on(call => (call.path.endsWith('/stop') ? ok({ id: LIZ.id, state: 'stopped' }) : undefined));
    for (let n = 0; n < 10; n += 1)
      should((await post(r.endpoint, callTool('stop_ferret', { ferret: 'lizzette' })))?.status).equal(200);
    for (let n = 0; n < 15; n += 1) {
      should((await post(r.endpoint, callTool('answer_attention', { item: `A${n}`, answer: 'done' })))?.status).equal(
        200,
      );
      should((await post(r.endpoint, callTool('snooze_attention', { item: `B${n}`, duration: '1h' })))?.status).equal(
        200,
      );
    }
    const over = await post(r.endpoint, callTool('answer_attention', { item: 'A99', answer: 'done' }));
    should(over?.status).equal(429);
    should(over?.body).containEql('Too many changes in a minute');
    should(Number(over?.headers.get('retry-after'))).be.above(0);
    // The other writes keep their own, tighter budget.
    should((await post(r.endpoint, callTool('stop_ferret', { ferret: 'lizzette' })))?.status).equal(429);
    r.state.now += 61_000;
    should((await post(r.endpoint, callTool('answer_attention', { item: 'A100', answer: 'done' })))?.status).equal(200);
  });

  it('counts agenda acts toward the 60 calls a minute', async () => {
    const r = rig();
    r.delegate.on(ferretsRoute());
    for (let n = 0; n < 40; n += 1) await post(r.endpoint, callTool('list_ferrets', {}));
    for (let n = 0; n < 20; n += 1)
      should((await post(r.endpoint, callTool('answer_attention', { item: `A${n}`, answer: 'done' })))?.status).equal(
        200,
      );
    const over = await post(r.endpoint, callTool('answer_attention', { item: 'A99', answer: 'done' }));
    should(over?.status).equal(429);
    should(over?.body).containEql('Too many calls in a minute');
  });

  it('counts per grant, not per client', async () => {
    const r = rig();
    r.delegate.on(ferretsRoute());
    for (let n = 0; n < 60; n += 1) await post(r.endpoint, callTool('list_ferrets', {}));
    r.state.access = { ...READ_ACCESS, grantId: 'cg_bbbbbbbbbb' };
    should((await post(r.endpoint, callTool('list_ferrets', {})))?.status).equal(200);
  });
});

describe('/mcp — a request the transport cannot take, and one it must still answer', () => {
  it('413s a body over the limit and 400s one that cannot be read, saying nothing of why', async () => {
    const r = rig();
    const tooLarge = await post(r.endpoint, INIT, {
      readBody: async () => {
        throw new BodyTooLargeError(1);
      },
    });
    should(tooLarge?.status).equal(413);
    const unreadable = await post(r.endpoint, INIT, {
      readBody: async () => {
        throw new Error('socket reset at 10.0.0.7');
      },
    });
    should(unreadable?.status).equal(400);
    should(unreadable?.body).not.containEql('10.0.0.7');
  });

  it('treats a token store that cannot answer as a token that is not valid', async () => {
    const r = rig();
    r.state.verifierFails = true;
    const response = await post(r.endpoint, callTool('list_ferrets', {}));
    should(response?.status).equal(401);
    should(r.delegate.calls.length).equal(0);
  });

  it('answers a client that sent no Accept header, or only part of it', async () => {
    const r = rig();
    for (const accept of [null, 'application/json']) {
      const response = await post(r.endpoint, INIT, { accept });
      should(response?.status).equal(200);
      should(JSON.parse(response?.body ?? '{}').result.serverInfo.name).equal('ferretry');
    }
  });

  it('answers a generic 500, and leaks nothing, when the request cannot be handed to the transport', async () => {
    const r = rig();
    const response = await post(r.endpoint, INIT, { protocolVersion: 'bad\nvalue' });
    should(response?.status).equal(500);
    should(JSON.parse(response?.body ?? '{}').error.message).equal('The connector could not answer that.');
  });
});

describe('/mcp — get_attention through the official MCP SDK client', () => {
  const TABLE = ['| Option | Cost |', '| --- | --- |', '| Postgres | high |', '| SQLite | low |'].join('\n');
  const item = agendaItem({
    id: 'A12',
    subject: 'Pick a database',
    why: 'Which database should the connector use?',
    ask: { kind: 'multiple-choice', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
    extra: {
      title: 'Database choice',
      context: 'The key is sk-ant-ABCDEFGH12345678 for now.',
      tabs: [{ id: 'costs', name: 'Costs', body: `Costs compared:\n\n${TABLE}` }],
    },
  });

  /** The SDK client's own fetch, pointed at the endpoint: every byte goes through the real /mcp route. */
  const connect = async (r: ReturnType<typeof rig>): Promise<Client> => {
    const viaEndpoint = (async (_url, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      const reply = await post(r.endpoint, body, { method: init?.method ?? 'POST' });
      if (reply === undefined) return new Response('', { status: 404 });
      return new Response(reply.body === '' ? null : reply.body, {
        status: reply.status,
        headers: Object.fromEntries(reply.headers),
      });
    }) as typeof fetch;
    const client = new Client({ name: 'integration', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://connector.invalid/mcp'), {
        fetch: viaEndpoint,
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );
    return client;
  };

  it('is advertised as a read tool, and reads an item whole with its table and a masked secret', async () => {
    const r = rig();
    r.state.access = READ_ACCESS;
    r.delegate
      .on(ferretsRoute())
      .on(call =>
        call.path === '/v1/agenda/open' ? ok({ sessions: [{ sessionId: LIZ.id, items: [item] }] }) : undefined,
      );
    const client = await connect(r);
    try {
      const listed = (await client.listTools()).tools;
      const found = listed.find(entry => entry.name === 'get_attention');
      should(found?.annotations).containEql({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
      should(Object.keys(found?.inputSchema.properties ?? {}).sort()).eql(['ferret', 'from', 'item', 'tab']);
      should(found?.inputSchema.required).eql(['item']);
      const called = await client.callTool({ name: 'get_attention', arguments: { item: '!A12' } });
      const text = (called.content as { type: string; text: string }[]).map(part => part.text).join('\n');
      should(called.isError).not.be.true();
      should(text).containEql('!A12 — Database choice — from Lizzette');
      should(text).containEql(`Costs compared:\n\n${TABLE}`);
      should(text).not.containEql('sk-ant-ABCDEFGH12345678');
      const one = await client.callTool({ name: 'get_attention', arguments: { item: 'A12', tab: 'costs' } });
      should((one.content as { text: string }[])[0]?.text).containEql(TABLE);
      const missing = await client.callTool({ name: 'get_attention', arguments: { item: 'A99' } });
      should(missing.isError).be.true();
      should((missing.content as { text: string }[])[0]?.text).containEql('There is no open item A99.');
    } finally {
      await client.close();
    }
  });

  it('snoozes an item over the wire, in Pacific time, as a write tool a read-only token never sees', async () => {
    const r = rig();
    const posted: unknown[] = [];
    r.delegate
      .on(ferretsRoute())
      .on(call =>
        call.path === '/v1/agenda/open' ? ok({ sessions: [{ sessionId: LIZ.id, items: [item] }] }) : undefined,
      )
      .on(call => {
        if (call.method !== 'POST') return undefined;
        posted.push(call.body);
        return ok({
          v: 1,
          sessionId: LIZ.id,
          items: [],
          resolved: [],
          count: 0,
          parseErrors: 0,
          updatedAt: '2026-11-24T12:00:00.000Z',
        });
      });
    const client = await connect(r);
    try {
      const listed = (await client.listTools()).tools.find(entry => entry.name === 'snooze_attention');
      should(listed?.annotations).containEql({ readOnlyHint: false, destructiveHint: false });
      should(listed?.inputSchema.required).eql(['item']);
      const done = await client.callTool({
        name: 'snooze_attention',
        arguments: { item: 'A12', until: '2026-11-25T09:00' },
      });
      should(done.isError).not.be.true();
      should((done.content as { text: string }[])[0]?.text).startWith(
        'Snoozed !A12 (Database choice) until Wed, Nov 25, 9:00 AM PST',
      );
      should(posted).eql([{ action: 'snooze', id: 'A12', until: '2026-11-25T17:00:00.000Z' }]);
      should(r.calls.records.map(entry => entry.tool)).eql(['snooze_attention']);
    } finally {
      await client.close();
    }
    r.state.access = READ_ACCESS;
    const readOnly = await connect(r);
    try {
      const names = (await readOnly.listTools()).tools.map(entry => entry.name);
      should(names).not.containEql('snooze_attention');
      should(names).containEql('get_attention');
    } finally {
      await readOnly.close();
    }
  });
});

// The plan's named budget test (U4, "agenda budget 30/min inside 60"): the three limits are separate counters and a grant's
// agenda acts count toward all-calls as well.
describe('agenda budget 30/min inside 60', () => {
  const boot = () => {
    const r = rig();
    r.delegate
      .on(ferretsRoute())
      .on(call => (call.path.endsWith('/send') ? ok({ ferret: LIZ.id, disposition: 'delivered' }) : undefined));
    return r;
  };
  const snooze = (r: ReturnType<typeof rig>, n: number) =>
    post(r.endpoint, callTool('snooze_attention', { item: `A${n + 1}`, duration: '1h' }));
  const send = (r: ReturnType<typeof rig>) =>
    post(r.endpoint, callTool('send_to_ferret', { ferret: 'lizzette', message: 'hi' }));

  it('30 snoozes pass and the 31st is 429', async () => {
    const r = boot();
    for (let n = 0; n < 30; n += 1) should((await snooze(r, n))?.status).equal(200);
    const over = await snooze(r, 30);
    should(over?.status).equal(429);
    should(Number(over?.headers.get('retry-after'))).be.above(0);
  });

  it('10 sends pass and the 11th is 429 while snoozes still pass', async () => {
    const r = boot();
    for (let n = 0; n < 10; n += 1) should((await send(r))?.status).equal(200);
    should((await send(r))?.status).equal(429);
    for (let n = 0; n < 20; n += 1) should((await snooze(r, n))?.status).equal(200);
  });

  it('60 calls in all cap everything, whichever budget they spent', async () => {
    const r = boot();
    for (let n = 0; n < 10; n += 1) should((await send(r))?.status).equal(200);
    for (let n = 0; n < 30; n += 1) should((await snooze(r, n))?.status).equal(200);
    for (let n = 0; n < 20; n += 1) should((await post(r.endpoint, callTool('list_ferrets', {})))?.status).equal(200);
    // 60 spent: the next read is over the all-calls limit though no read budget exists.
    const over = await post(r.endpoint, callTool('list_ferrets', {}));
    should(over?.status).equal(429);
    should(over?.body).containEql('Too many calls in a minute');
    // …and a call over a per-kind budget is refused without being counted against the other budgets.
    r.state.now += 61_000;
    should((await send(r))?.status).equal(200);
  });

  it('a refused call spends nothing: the agenda budget does not move on a 429', async () => {
    const r = boot();
    for (let n = 0; n < 10; n += 1) await send(r);
    for (let n = 0; n < 5; n += 1) should((await send(r))?.status).equal(429);
    for (let n = 0; n < 30; n += 1) should((await snooze(r, n))?.status).equal(200);
    should((await snooze(r, 30))?.status).equal(429);
  });
});

// S17 (docs/mcp-connector.md "Turning it off"): a request already inside the endpoint cannot reach a fleet route after an off.
describe('an off in the middle of a request', () => {
  it('stops the next delegated call of a tool that had already begun, and reaches no route', async () => {
    const r = rig();
    r.delegate.on(call => {
      if (call.path === '/v1/ferrets') r.state.serving = false;
      return call.path === '/v1/ferrets' ? ok([LIZ]) : undefined;
    });
    const reply = await tool(r, 'stop_ferret', { ferret: 'lizzette' });
    should(reply.isError).be.true();
    should(reply.text).equal('The connector is switched off.');
    should(r.delegate.calls.map(entry => entry.call.path)).eql(['/v1/ferrets']);
    should(r.calls.records.map(entry => entry.outcome)).eql(['refused']);
  });
});
