import { describe, it } from 'bun:test';
import { BodyTooLargeError } from '../../../../src/lib/api/http.ts';
import should from 'should';
import { CONNECTOR_TOOL_NAMES } from '../../../../src/lib/connector/mcp/demands.ts';
import { ok, READ_ACCESS, sessionView } from '../../../support/connector/mcp-fixtures.ts';
import { callTool, INIT, post, rig, rpc, tool } from '../../../support/connector/mcp-harness.ts';

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

const LIZ = sessionView({
  id: 'mwuanehg-4531fa9e',
  callsign: 'lizzette',
  task: '[Lizzette] Build MCP Connector',
  turnState: 'working',
});
const MARIN = sessionView({
  id: 'mxk2aa11-0001ffff',
  callsign: 'marin',
  task: 'Fix the login page',
  turnState: 'your-turn',
});
const sessionsRoute =
  (views = [LIZ, MARIN]) =>
  (call: { method: string; path: string }) =>
    call.method === 'GET' && call.path === '/v1/sessions' ? ok(views) : undefined;

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
    r.dispatch.on(sessionsRoute());
    const response = await post(r.endpoint, callTool('list_ferrets', {}), { token: null });
    should(response?.status).equal(401);
    should(response?.headers.get('www-authenticate')).equal('Bearer');
    should(r.state.verifications).equal(0);
    should(r.dispatch.calls.length).equal(0);
  });

  it('401s a bad token as invalid_token and never reaches a tool', async () => {
    const r = rig();
    r.dispatch.on(sessionsRoute());
    const response = await post(r.endpoint, callTool('list_ferrets', {}), { token: 'fyc_at_wrong' });
    should(response?.status).equal(401);
    should(response?.headers.get('www-authenticate')).containEql('invalid_token');
    should(r.dispatch.calls.length).equal(0);
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
    r.dispatch.on(sessionsRoute());
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
    for (const read of ['list_ferrets', 'get_ferret', 'get_ferret_output', 'list_attention'])
      should(listed(read).annotations).containEql({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    for (const destructive of ['restart_ferret', 'stop_ferret'])
      should(listed(destructive).annotations).containEql({ readOnlyHint: false, destructiveHint: true });
    for (const write of ['send_to_ferret', 'answer_attention', 'spawn_ferret'])
      should(listed(write).annotations).containEql({ readOnlyHint: false, destructiveHint: false });
    should(listed('get_ferret_output').inputSchema.properties.lines?.maximum).equal(100_000);
    should(listed('send_to_ferret').inputSchema.properties.message?.maxLength).equal(8000);
  });

  it('does not offer write tools to a read-only token, and says so as a tool error when one is called', async () => {
    const r = rig();
    r.state.access = READ_ACCESS;
    r.dispatch.on(sessionsRoute());
    const list = JSON.parse((await post(r.endpoint, rpc('tools/list')))?.body ?? '{}');
    should(list.result.tools.map((t: { name: string }) => t.name).sort()).eql(
      ['get_ferret', 'get_ferret_output', 'list_attention', 'list_ferrets'].sort(),
    );
    const stop = await tool(r, 'stop_ferret', { ferret: 'lizzette' });
    should(stop.isError).be.true();
    should(stop.text).containEql('only look');
    should(r.dispatch.calls.length).equal(0);
    should(r.calls.records.map(c => [c.tool, c.outcome])).eql([['stop_ferret', 'refused']]);
    should(r.audit.events.length).equal(0);
  });

  it('answers an unsupported MCP-Protocol-Version with a 400 before refusing a read-only token a write tool', async () => {
    const r = rig();
    r.state.access = READ_ACCESS;
    const reply = await tool(r, 'stop_ferret', { ferret: 'lizzette' }, { protocolVersion: '1999-01-01' });
    should(reply.status).equal(400);
    should(JSON.stringify(reply.raw)).containEql('Unsupported protocol version: 1999-01-01');
    should(r.dispatch.calls.length).equal(0);
    should(r.calls.records.length).equal(0);
    const supported = await tool(r, 'stop_ferret', { ferret: 'lizzette' }, { protocolVersion: '2025-11-25' });
    should(supported.status).equal(200);
    should(supported.text).containEql('only look');
  });

  it('refuses an invalid argument as a protocol error, never reaching the daemon', async () => {
    const r = rig();
    const reply = await tool(r, 'get_ferret_output', { ferret: 'x', lines: 0 });
    should(reply.isError || (reply.raw as RpcFailure).error !== undefined).be.true();
    should(r.dispatch.calls.length).equal(0);
  });
});

describe('/mcp — rate limits', () => {
  it('429s the 61st call in a minute with Retry-After, and frees up as the window slides', async () => {
    const r = rig();
    r.dispatch.on(sessionsRoute());
    for (let n = 0; n < 60; n += 1) should((await post(r.endpoint, callTool('list_ferrets', {})))?.status).equal(200);
    const over = await post(r.endpoint, callTool('list_ferrets', {}));
    should(over?.status).equal(429);
    should(Number(over?.headers.get('retry-after'))).be.above(0);
    r.state.now += 61_000;
    should((await post(r.endpoint, callTool('list_ferrets', {})))?.status).equal(200);
  });

  it('429s the 11th write in a minute but lets reads through; initialize and list are free', async () => {
    const r = rig();
    r.dispatch.on(sessionsRoute()).on(call => (call.path.endsWith('/stop') ? ok(LIZ) : undefined));
    for (let n = 0; n < 10; n += 1)
      should((await post(r.endpoint, callTool('stop_ferret', { ferret: 'lizzette' })))?.status).equal(200);
    should((await post(r.endpoint, callTool('stop_ferret', { ferret: 'lizzette' })))?.status).equal(429);
    should((await post(r.endpoint, callTool('list_ferrets', {})))?.status).equal(200);
    should((await post(r.endpoint, rpc('tools/list')))?.status).equal(200);
    should((await post(r.endpoint, INIT))?.status).equal(200);
  });

  it('counts per grant, not per client', async () => {
    const r = rig();
    r.dispatch.on(sessionsRoute());
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
    should(r.dispatch.calls.length).equal(0);
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
