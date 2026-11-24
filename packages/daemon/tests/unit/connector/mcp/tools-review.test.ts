import { describe, it } from 'bun:test';
import should from 'should';
import { matchExact } from '../../../../src/lib/connector/mcp/names.ts';
import type { FleetGateway } from '../../../../src/lib/connector/mcp/gateway.ts';
import { CONNECTOR_TOOLS, shapeAnswer } from '../../../../src/lib/connector/mcp/tools.ts';
import {
  agendaItem,
  NOW,
  ok,
  READ_ACCESS,
  refuse,
  sessionView,
  snapshot,
} from '../../../support/connector/mcp-fixtures.ts';
import { ConnectorMcpEndpoint } from '../../../../src/adapters/connector/mcp/mcp-endpoint.ts';
import { BodyTooLargeError, type ApiRequest } from '../../../../src/lib/api/http.ts';
import { callTool, post, rig, TOKEN, tool } from '../../../support/connector/mcp-harness.ts';

/** The first round of review findings on the nine tools, one behaviour at a time. */

const LIZ = sessionView({
  id: 'mwuanehg-4531fa9e',
  callsign: 'lizzette',
  task: '[Lizzette] Build MCP',
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
const openRoute = (boards: Record<string, ReturnType<typeof agendaItem>[]>) => (call: { path: string }) =>
  call.path === '/v1/agenda/open'
    ? ok({ sessions: Object.entries(boards).map(([sessionId, items]) => ({ sessionId, items })) })
    : undefined;
const posts = (r: ReturnType<typeof rig>) => r.dispatch.calls.filter(c => c.call.method === 'POST');
const answered = (sessionId: string) => (call: { method: string }) =>
  call.method === 'POST' ? ok(snapshot(sessionId)) : undefined;

const HEX = 'a'.repeat(32);
const CONFIRMS = { path: 'warden.yaml', etag: 'abc123', changes: ['Allow every command'] };
const ALLOW_DENY = {
  kind: 'multiple-choice',
  options: [{ label: 'Allow' }, { label: 'Deny' }, { label: 'Discard change' }],
};
const GATE = { cardId: 'c', laneId: 'l', laneName: 'L', entry: 1, projectId: 'p', options: [{ label: 'Done' }] };

describe('answer_attention refuses what only the owner may approve (finding 1)', () => {
  it('refuses a held configuration change with the passkey sentence, sends nothing and records the refusal', async () => {
    const r = rig();
    const item = agendaItem({
      id: 'A5',
      subject: 'Loosen warden',
      why: 'Allow it?',
      ask: ALLOW_DENY,
      extra: { confirms: CONFIRMS },
    });
    r.dispatch.on(sessionsRoute()).on(openRoute({ [LIZ.config.id]: [item] }));
    const reply = await tool(r, 'answer_attention', { item: 'A5', answer: 'allow' });
    should(reply.isError).be.true();
    should(reply.text).equal('That one needs your passkey in the Ferretry app.');
    should(posts(r).length).equal(0);
    should(r.calls.records[0]?.outcome).equal('refused');
    should(r.audit.events).eql([
      {
        kind: 'connector.tool',
        grantId: 'cg_aaaaaaaaaa',
        tool: 'answer_attention',
        sessionId: LIZ.config.id,
        outcome: 'refused',
      },
    ]);
  });

  it('refuses every other approval shape through shapeAnswer, whatever the ask says', () => {
    const base = agendaItem({ id: 'A6', subject: 's', why: 'w', ask: { kind: 'permission' } });
    const shapes: Record<string, unknown> = {
      confirms: CONFIRMS,
      gate: GATE,
      gateAttached: GATE,
      cardAsks: [{}],
      input: { requestId: HEX },
      copyPlan: { planId: HEX },
      taskPlan: { planId: HEX },
      phoneApproval: { id: 'pa_aaaaaaaaaaaaaaaaaaaaaaaa' },
      twoFactorSeed: {},
      signInRuleSuggestion: {},
      signInRuleSuspended: {},
      cards: [],
      fields: [],
    };
    for (const [field, value] of Object.entries(shapes)) {
      const shaped = shapeAnswer({ ...base, [field]: value }, 'approve');
      should(shaped.kind).equal('refuse');
      if (shaped.kind === 'refuse') {
        should(shaped.refused).be.true();
        should(shaped.sentence).equal('That one needs your passkey in the Ferretry app.');
      }
    }
    const typed = shapeAnswer({ ...base, kind: 'input' }, 'approve');
    should(typed.kind === 'refuse' && typed.sentence).equal(
      'That one asks for a value that can only be typed in the Ferretry app.',
    );
  });

  it('allows only the plain kinds: a form or typed input is refused, a note and a to-do close', () => {
    const base = agendaItem({ id: 'A7', subject: 's', why: 'w', ask: { kind: 'open-question' } });
    for (const kind of ['form', 'input'] as const) should(shapeAnswer({ ...base, kind }, 'x').kind).equal('refuse');
    for (const kind of ['reply', undefined] as const)
      should(shapeAnswer({ ...base, kind }, 'x').kind).equal('response');
    const note = { ...agendaItem({ id: 'A8', subject: 's', why: 'w' }), kind: 'info' as const };
    should(shapeAnswer(note, 'got it').kind).equal('done');
    const todo = agendaItem({ id: 'A9', subject: 's', why: 'w', ask: { kind: 'task' }, kind: 'task' });
    should(shapeAnswer(todo, 'done').kind).equal('done');
    // A wrong spoken answer is a plain refusal, not an owner-only one.
    const permission = agendaItem({ id: 'A10', subject: 's', why: 'w', ask: { kind: 'permission' } });
    const shaped = shapeAnswer(permission, 'maybe');
    should(shaped.kind === 'refuse' && shaped.refused).be.false();
  });

  it('tells the listener which items only the app can answer', async () => {
    const r = rig();
    const gated = agendaItem({
      id: 'A5',
      subject: 'Loosen warden',
      why: 'Allow it?',
      ask: ALLOW_DENY,
      extra: { confirms: CONFIRMS },
    });
    const plain = agendaItem({ id: 'A6', subject: 'Plain', why: 'Question?', ask: { kind: 'open-question' } });
    r.dispatch.on(sessionsRoute()).on(openRoute({ [LIZ.config.id]: [gated, plain] }));
    const lines = (await tool(r, 'list_attention', {})).text.split('\n');
    should(lines.find(line => line.startsWith('!A5'))).endWith('Only the Ferretry app can answer this one.');
    should(lines.find(line => line.startsWith('!A6'))).not.containEql('Only the Ferretry app');
  });
});

describe('answer_attention honours the ferret it was told (finding 2)', () => {
  const liz = agendaItem({ id: 'A1', subject: 's', why: 'w', ask: { kind: 'open-question' } });

  it("never falls back to another ferret's item when the named ferret has none", async () => {
    const r = rig();
    r.dispatch
      .on(sessionsRoute())
      .on(openRoute({ [LIZ.config.id]: [liz] }))
      .on(answered(LIZ.config.id));
    const reply = await tool(r, 'answer_attention', { item: 'A1', answer: 'yes', ferret: 'marin' });
    should(reply.isError).be.true();
    should(reply.text).equal('Marin has no open item A1.');
    should(posts(r).length).equal(0);
  });

  it('answers the named ferret when it has the item, and refuses an unknown ferret', async () => {
    const r = rig();
    r.dispatch
      .on(sessionsRoute())
      .on(openRoute({ [LIZ.config.id]: [liz] }))
      .on(answered(LIZ.config.id));
    should((await tool(r, 'answer_attention', { item: 'A1', answer: 'yes', ferret: 'lizzette' })).text).equal(
      'Answered A1 from Lizzette.',
    );
    should(posts(r)[0]?.call.path).equal('/v1/sessions/mwuanehg-4531fa9e/agenda');
    should((await tool(r, 'answer_attention', { item: 'A1', answer: 'yes', ferret: 'quetzalcoatl' })).text).startWith(
      'No ferret called',
    );
  });

  it('finds an item on the machine board by the ferret that raised it', async () => {
    const r = rig();
    r.dispatch
      .on(sessionsRoute())
      .on(openRoute({ 'machine-agenda': [liz] }))
      .on(answered('machine-agenda'));
    const reply = await tool(r, 'answer_attention', { item: 'A1', answer: 'yes', ferret: 'lizzette' });
    should(reply.isError).be.false();
  });
});

describe('a ferret is found by identity before anything looser (finding 3)', () => {
  const STOPPED = sessionView({ id: 'zzz00000-1111aaaa', callsign: 'lizzette', task: 'Old work', status: 'stopped' });
  const LOOKALIKE = sessionView({
    id: 'abc12345-0000aaaa',
    callsign: 'lizzette-two',
    task: 'Other work',
    turnState: 'working',
  });

  it('a retried stop finds the stopped ferret, never a live one whose name merely starts the same', async () => {
    const r = rig();
    r.dispatch
      .on(sessionsRoute([STOPPED, LOOKALIKE]))
      .on(call => (call.path.endsWith('/stop') ? ok(LOOKALIKE) : undefined));
    const reply = await tool(r, 'stop_ferret', { ferret: 'lizzette' });
    should(reply.text).equal('Lizzette is already stopped.');
    should(posts(r).length).equal(0);
  });

  it('a retried restart and send meet the same stopped ferret by exact callsign', async () => {
    const r = rig();
    r.dispatch
      .on(sessionsRoute([STOPPED, LOOKALIKE]))
      .on(call =>
        call.path === '/v1/restarts'
          ? ok({ restarted: [{ id: STOPPED.config.id }], queued: [], skipped: [], failed: [] })
          : undefined,
      )
      .on(call => (call.path.endsWith('/send') ? ok({ ...STOPPED, disposition: 'revived' }) : undefined));
    await tool(r, 'restart_ferret', { ferret: 'lizzette' });
    await tool(r, 'send_to_ferret', { ferret: 'lizzette', message: 'hi' });
    should(posts(r).map(c => c.call.path)).eql(['/v1/restarts', '/v1/sessions/zzz00000-1111aaaa/send']);
    should((posts(r)[0]?.call.body as { ids: string[] } | undefined)?.ids).eql([STOPPED.config.id]);
  });

  it('two exact matches of any state are a question for an act, and the running one for a look', async () => {
    const live = sessionView({ id: 'ccc00000-2222bbbb', callsign: 'lizzette', task: 'New work', turnState: 'working' });
    const r = rig();
    r.dispatch.on(sessionsRoute([STOPPED, live])).on(call => (call.path.endsWith('/stop') ? ok(live) : undefined));
    const asked = await tool(r, 'stop_ferret', { ferret: 'lizzette' });
    should(asked.isError).be.true();
    should(asked.text).containEql('More than one ferret matches "lizzette"');
    should(asked.text).containEql('Old work), stopped');
    should(posts(r).length).equal(0);
    should((await tool(r, 'get_ferret', { ferret: 'lizzette' })).text).startWith('Lizzette: New work.');
  });

  it('two exact matches that are both stopped are a question even for a look', async () => {
    const twin = sessionView({ id: 'ddd00000-3333cccc', callsign: 'lizzette', task: 'Twin', status: 'stopped' });
    const r = rig();
    r.dispatch.on(sessionsRoute([STOPPED, twin]));
    should((await tool(r, 'get_ferret', { ferret: 'lizzette' })).text).containEql('More than one ferret matches');
  });

  it('a partial name matches across every state, so it cannot slide from a stopped ferret to a live one', async () => {
    const liza = sessionView({ id: 'eee00000-4444dddd', callsign: 'liza', task: 'A', status: 'stopped' });
    const lizb = sessionView({ id: 'fff00000-5555eeee', callsign: 'lizb', task: 'B', turnState: 'working' });
    const r = rig();
    r.dispatch.on(sessionsRoute([liza, lizb])).on(call => (call.path.endsWith('/stop') ? ok(lizb) : undefined));
    const reply = await tool(r, 'stop_ferret', { ferret: 'liz' });
    should(reply.text).containEql('More than one ferret matches "liz"');
    should(posts(r).length).equal(0);
    // A unique partial still acts.
    const unique = rig();
    unique.dispatch.on(sessionsRoute([MARIN, LIZ])).on(call => (call.path.endsWith('/stop') ? ok(LIZ) : undefined));
    should((await tool(unique, 'stop_ferret', { ferret: 'lizz' })).text).equal('Stopped Lizzette.');
  });

  it('matches by exact short id, session id and exact task name', async () => {
    const r = rig();
    r.dispatch.on(sessionsRoute([LIZ, MARIN]));
    for (const query of ['mxk2aa11', 'mxk2aa11-0001ffff', 'Fix the login page']) {
      should((await tool(r, 'get_ferret', { ferret: query })).text).startWith('Marin:');
    }
  });

  it('matchExact finds identities only, never a prefix', () => {
    const keys = (name: string) => ({ exact: [], names: [name] });
    should(matchExact('lizzette', ['lizzette', 'lizzette two'], keys)).eql(['lizzette']);
    should(matchExact('   ', ['lizzette'], keys)).eql([]);
  });
});

describe('an answer carries the ask it was given to (finding 4)', () => {
  const item = (version: number, why: string) =>
    agendaItem({
      id: 'A12',
      subject: 'Pick',
      why,
      askVersion: version,
      ask: { kind: 'multiple-choice', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
    });
  const changed = { status: 409, body: JSON.stringify({ error: 'A12 asks something else now', code: 'ask_changed' }) };

  it('sends the version of the ask the item showed', async () => {
    const r = rig();
    r.dispatch
      .on(sessionsRoute())
      .on(openRoute({ [LIZ.config.id]: [item(3, 'Which?')] }))
      .on(answered(LIZ.config.id));
    await tool(r, 'answer_attention', { item: 'A12', answer: 'sqlite' });
    should((posts(r)[0]?.call.body as { askVersion?: number } | undefined)?.askVersion).equal(3);
  });

  it('says what the question is now when the ask changed, and records an error, not a success', async () => {
    const r = rig();
    let reads = 0;
    r.dispatch
      .on(sessionsRoute())
      .on(call =>
        call.path === '/v1/agenda/open'
          ? ok({
              sessions: [{ sessionId: LIZ.config.id, items: [item(++reads, reads === 1 ? 'Which?' : 'Which cache?')] }],
            })
          : undefined,
      )
      .on(call => (call.method === 'POST' ? changed : undefined));
    const reply = await tool(r, 'answer_attention', { item: 'A12', answer: 'sqlite' });
    should(reply.isError).be.true();
    should(reply.text).startWith(
      'That question changed, so nothing was sent; here it is now: !A12 — from Lizzette — Pick — Which cache?',
    );
    should(reply.text).containEql('Options: Postgres, SQLite.');
    should(r.calls.records[0]?.outcome).equal('error');
    should(r.audit.events[0]).eql({
      kind: 'connector.tool',
      grantId: 'cg_aaaaaaaaaa',
      tool: 'answer_attention',
      sessionId: LIZ.config.id,
      outcome: 'error',
    });
  });

  it('says so when the changed question is gone altogether', async () => {
    const r = rig();
    let reads = 0;
    r.dispatch
      .on(sessionsRoute())
      .on(call =>
        call.path === '/v1/agenda/open'
          ? ok({ sessions: reads++ === 0 ? [{ sessionId: LIZ.config.id, items: [item(1, 'Which?')] }] : [] })
          : undefined,
      )
      .on(call => (call.method === 'POST' ? changed : undefined));
    const reply = await tool(r, 'answer_attention', { item: 'A12', answer: 'sqlite' });
    should(reply.text).equal('That question changed and A12 is not open any more. Nothing was sent.');
  });

  it("passes any other daemon refusal through, aimed at the item's ferret", async () => {
    const r = rig();
    r.dispatch
      .on(sessionsRoute())
      .on(openRoute({ [LIZ.config.id]: [item(1, 'Which?')] }))
      .on(call => (call.method === 'POST' ? refuse(409, 'that item is closed') : undefined));
    const reply = await tool(r, 'answer_attention', { item: 'A12', answer: 'sqlite' });
    should(reply.text).equal('that item is closed');
    should(r.audit.events[0]).eql({
      kind: 'connector.tool',
      grantId: 'cg_aaaaaaaaaa',
      tool: 'answer_attention',
      sessionId: LIZ.config.id,
      outcome: 'error',
    });
  });

  it('lets a failure that is not a ToolFailure through untouched', async () => {
    const spec = CONNECTOR_TOOLS.find(candidate => candidate.name === 'answer_attention');
    const boom = new Error('socket closed');
    const gateway = {
      sessions: async () => [LIZ],
      openAgenda: async () => [{ sessionId: LIZ.config.id, item: item(1, 'Which?') }],
      resolveAgenda: async () => {
        throw boom;
      },
    } as unknown as FleetGateway;
    const run = spec?.run({ item: 'A12', answer: 'sqlite' }, { gateway, now: () => NOW, clean: async text => text });
    await should(run).be.rejectedWith(boom);
  });
});

describe('the record says how a write ended (finding 5)', () => {
  const sendTo = async (r: ReturnType<typeof rig>) =>
    await tool(r, 'send_to_ferret', { ferret: 'lizzette', message: 'hi' });

  it('records a failed send as an error in both logs', async () => {
    const r = rig();
    r.dispatch
      .on(sessionsRoute())
      .on(call => (call.path.endsWith('/send') ? refuse(409, 'not accepting messages') : undefined));
    await sendTo(r);
    should(r.calls.records[0]?.outcome).equal('error');
    should(r.audit.events[0]).containEql({ tool: 'send_to_ferret', outcome: 'error' });
  });

  it('records a daemon refusal (403 or 401, with or without its own sentence) as refused in both logs', async () => {
    for (const answer of [
      refuse(403, 'needs a passkey'),
      { status: 403, body: 'nope' },
      { status: 401, body: '{"error":"  "}' },
    ]) {
      const r = rig();
      r.dispatch.on(sessionsRoute()).on(call => (call.path.endsWith('/send') ? answer : undefined));
      const reply = await sendTo(r);
      should(reply.isError).be.true();
      should(r.calls.records[0]?.outcome).equal('refused');
      should(r.audit.events[0]).containEql({ outcome: 'refused' });
    }
    const plain = rig();
    plain.dispatch
      .on(sessionsRoute())
      .on(call => (call.path.endsWith('/send') ? { status: 403, body: 'nope' } : undefined));
    should((await sendTo(plain)).text).equal('The daemon refused that request.');
  });

  it('records a success as ok, and a refusal at the gate in the calls log only', async () => {
    const r = rig();
    r.dispatch
      .on(sessionsRoute())
      .on(call => (call.path.endsWith('/send') ? ok({ ...LIZ, disposition: 'delivered' }) : undefined));
    await sendTo(r);
    should(r.audit.events[0]).containEql({ outcome: 'ok' });
    const gated = rig();
    gated.state.grants = undefined;
    await tool(gated, 'stop_ferret', { ferret: 'lizzette' });
    should(gated.calls.records[0]?.outcome).equal('refused');
    should(gated.audit.events.length).equal(0);
  });

  it('keeps the other daemon statuses as plain failures', async () => {
    for (const [status, sentence] of [
      [404, 'The daemon does not know that.'],
      [429, 'The daemon is busy right now. Try again in a moment.'],
      [500, 'The daemon could not do that (status 500).'],
    ] as const) {
      const r = rig();
      r.dispatch.on(sessionsRoute()).on(call => (call.path.endsWith('/send') ? { status, body: '' } : undefined));
      const reply = await sendTo(r);
      should(reply.text).equal(sentence);
      should(r.calls.records[0]?.outcome).equal('error');
    }
  });
});

describe('the transport envelope is checked before a manual reply (finding 6)', () => {
  const unsupported = { 'mcp-protocol-version': '1999-01-01' };

  it('400s an unsupported protocol version on the read-only refusal path, and records nothing', async () => {
    const r = rig();
    r.state.access = READ_ACCESS;
    const response = await post(r.endpoint, callTool('stop_ferret', { ferret: 'lizzette' }), { headers: unsupported });
    should(response?.status).equal(400);
    should(response?.body).containEql('Unsupported protocol version: 1999-01-01');
    should(r.calls.records.length).equal(0);
    should(r.audit.events.length).equal(0);
  });

  it('still answers the read-only refusal as a tool error for a supported or absent version', async () => {
    for (const headers of [{ 'mcp-protocol-version': '2025-11-25' }, {}] as Record<string, string>[]) {
      const r = rig();
      r.state.access = READ_ACCESS;
      const response = await post(r.endpoint, callTool('stop_ferret', { ferret: 'lizzette' }), { headers });
      should(response?.status).equal(200);
      should(JSON.parse(response?.body ?? '{}').result.isError).be.true();
      should(r.calls.records[0]?.outcome).equal('refused');
    }
  });
});

describe('the endpoint around the SDK (lines its own gates leave)', () => {
  const requestOf = (text: () => Promise<string>): ApiRequest => ({
    method: 'POST',
    path: '/mcp',
    query: new Map(),
    headers: new Map([
      ['content-type', 'application/json'],
      ['authorization', `Bearer ${TOKEN}`],
    ]),
    loopback: false,
    text,
  });

  it('413s a body over the limit and 400s one that cannot be read', async () => {
    const r = rig();
    const big = await r.endpoint.handle(
      requestOf(async () => {
        throw new BodyTooLargeError(1024);
      }),
    );
    should(big?.status).equal(413);
    const broken = await r.endpoint.handle(
      requestOf(async () => {
        throw new Error('socket closed');
      }),
    );
    should(broken?.status).equal(400);
  });

  it('401s when the verifier throws, rather than failing open or loud', async () => {
    const r = rig();
    const endpoint = new ConnectorMcpEndpoint({
      verifier: {
        verify: async () => {
          throw new Error('store unreadable');
        },
      },
      unauthorized: () => ({ status: 401, headers: new Map(), body: '' }),
      dispatch: r.dispatch,
      toolbox: undefined as never,
      now: () => NOW,
      newRequestId: () => 'req-1',
      serverVersion: '0.0.0-test',
    });
    const response = await post(endpoint, callTool('list_ferrets', {}));
    should(response?.status).equal(401);
  });

  it('serves a client that did not say it accepts JSON and event streams', async () => {
    const r = rig();
    r.dispatch.on(sessionsRoute());
    const response = await post(r.endpoint, callTool('list_ferrets', {}), { headers: { accept: 'text/plain' } });
    should(response?.status).equal(200);
    should(JSON.parse(response?.body ?? '{}').result.isError).be.undefined();
  });
});
