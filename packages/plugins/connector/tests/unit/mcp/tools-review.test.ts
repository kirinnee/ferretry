import { describe, it } from 'bun:test';
import { type ApiRequest, BodyTooLargeError } from '@ferretry/kernel/contract';
import should from 'should';
import { ConnectorMcpEndpoint } from '../../../daemon/adapters/mcp/mcp-endpoint.ts';
import type { FleetGateway } from '../../../daemon/lib/mcp/gateway.ts';
import { matchExact } from '../../../daemon/lib/mcp/names.ts';
import { CONNECTOR_TOOLS, shapeAnswer } from '../../../daemon/lib/mcp/tools/index.ts';
import { OWN_DOOR } from '../../support/door.ts';
import { agendaItem, ferretView, NOW, ok, READ_ACCESS, refuse } from '../../support/mcp-fixtures.ts';
import { callTool, post, rig, TOKEN, tool } from '../../support/mcp-harness.ts';
import { answered, ferretsRoute, openRoute, posts, raw } from '../../support/mcp-tools-routes.ts';

/** The first round of review findings on the nine tools, one behaviour at a time. */

const LIZ = ferretView({
  id: 'mwuanehg-4531fa9e',
  callsign: 'lizzette',
  task: '[Lizzette] Build MCP',
  state: 'working',
});
const MARIN = ferretView({
  id: 'mxk2aa11-0001ffff',
  callsign: 'marin',
  task: 'Fix the login page',
  state: 'idle',
});

const HEX = 'a'.repeat(32);
const CONFIRMS = { path: 'warden.yaml', etag: 'abc123', changes: ['Allow every command'] };
const ALLOW_DENY = {
  kind: 'multiple-choice',
  options: [{ label: 'Allow' }, { label: 'Deny' }, { label: 'Discard change' }],
};

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
    r.delegate.on(ferretsRoute([LIZ, MARIN])).on(openRoute({ [LIZ.id]: [item] }));
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
        sessionId: LIZ.id,
        outcome: 'refused',
      },
    ]);
  });

  it('refuses every other approval shape through shapeAnswer, whatever the ask says', () => {
    const base = agendaItem({ id: 'A6', subject: 's', why: 'w', ask: { kind: 'permission' } });
    // 5.0: there is no top-level `gate`/`gateAttached`; a task ask rides `cardAsks` (the OWNER_ONLY set changed).
    const shapes: Record<string, unknown> = {
      confirms: CONFIRMS,
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
      // Cast: the fixture schema would refuse some of these half-shapes; only `!== undefined` matters to the guard.
      const shaped = shapeAnswer({ ...base, [field]: value } as typeof base, 'approve');
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
    for (const kind of ['form', 'input'] as const)
      should(shapeAnswer({ ...base, kind } as typeof base, 'x').kind).equal('refuse');
    for (const kind of ['reply', undefined] as const)
      should(shapeAnswer({ ...base, kind } as typeof base, 'x').kind).equal('response');
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
    r.delegate.on(ferretsRoute([LIZ, MARIN])).on(openRoute({ [LIZ.id]: [gated, plain] }));
    const lines = (await tool(r, 'list_attention', {})).text.split('\n');
    should(lines.find(line => line.startsWith('^A5'))).endWith('Only the Ferretry app can answer this one.');
    should(lines.find(line => line.startsWith('^A6'))).not.containEql('Only the Ferretry app');
  });
});

describe('answer_attention honours the ferret it was told (finding 2)', () => {
  const liz = agendaItem({ id: 'A1', subject: 's', why: 'w', ask: { kind: 'open-question' } });

  it("never falls back to another ferret's item when the named ferret has none", async () => {
    const r = rig();
    r.delegate
      .on(ferretsRoute([LIZ, MARIN]))
      .on(openRoute({ [LIZ.id]: [liz] }))
      .on(answered(LIZ.id));
    const reply = await tool(r, 'answer_attention', { item: 'A1', answer: 'yes', ferret: 'marin' });
    should(reply.isError).be.true();
    should(reply.text).equal('Marin has no open item A1.');
    should(posts(r).length).equal(0);
  });

  it('answers the named ferret when it has the item, and refuses an unknown ferret', async () => {
    const r = rig();
    r.delegate
      .on(ferretsRoute([LIZ, MARIN]))
      .on(openRoute({ [LIZ.id]: [liz] }))
      .on(answered(LIZ.id));
    should((await tool(r, 'answer_attention', { item: 'A1', answer: 'yes', ferret: 'lizzette' })).text).equal(
      'Answered A1 from Lizzette.',
    );
    should(posts(r)[0]?.call.path).equal('/v1/ferrets/mwuanehg-4531fa9e/agenda');
    should((await tool(r, 'answer_attention', { item: 'A1', answer: 'yes', ferret: 'quetzalcoatl' })).text).startWith(
      'No ferret called',
    );
  });

  it('finds an item on the machine board by the ferret that raised it', async () => {
    const r = rig();
    r.delegate
      .on(ferretsRoute([LIZ, MARIN]))
      .on(openRoute({ 'machine-agenda': [liz] }))
      .on(answered('machine-agenda'));
    const reply = await tool(r, 'answer_attention', { item: 'A1', answer: 'yes', ferret: 'lizzette' });
    // Found (it is not "no open item"), and then refused: the machine's own list takes no decision, so none is dropped silently.
    should(reply.isError).be.true();
    should(reply.text).equal("That one is on the machine's own list, and only the Ferretry app can answer it.");
    should(posts(r).length).equal(0);
  });
});

describe('a ferret is found by identity before anything looser (finding 3)', () => {
  const STOPPED = ferretView({
    id: 'zzz00000-1111aaaa',
    callsign: 'lizzette',
    task: 'Old work',
    state: 'stopped',
    extra: { cause: { kind: 'stopped' } },
  });
  const LOOKALIKE = ferretView({
    id: 'abc12345-0000aaaa',
    callsign: 'lizzette-two',
    task: 'Other work',
    state: 'working',
  });
  const stopRoute = (id: string) => (call: { path: string }) =>
    call.path.endsWith('/stop') ? ok({ id, state: 'stopped' }) : undefined;

  it('a retried stop finds the stopped ferret, never a live one whose name merely starts the same', async () => {
    const r = rig();
    r.delegate.on(ferretsRoute([STOPPED, LOOKALIKE])).on(stopRoute(LOOKALIKE.id));
    const reply = await tool(r, 'stop_ferret', { ferret: 'lizzette' });
    should(reply.text).equal('Lizzette is already stopped.');
    should(posts(r).length).equal(0);
  });

  it('a retried restart and send meet the same stopped ferret by exact callsign', async () => {
    const r = rig();
    r.delegate
      .on(ferretsRoute([STOPPED, LOOKALIKE]))
      .on(call =>
        call.path === '/v1/restarts'
          ? ok({ restarted: [{ id: STOPPED.id }], queued: [], skipped: [], failed: [] })
          : undefined,
      )
      .on(call => (call.path.endsWith('/send') ? ok({ ferret: STOPPED.id, disposition: 'revived' }) : undefined));
    await tool(r, 'restart_ferret', { ferret: 'lizzette' });
    await tool(r, 'send_to_ferret', { ferret: 'lizzette', message: 'hi' });
    should(posts(r).map(c => c.call.path)).eql(['/v1/restarts', '/v1/ferrets/zzz00000-1111aaaa/send']);
    should((posts(r)[0]?.call.body as { ids: string[] } | undefined)?.ids).eql([STOPPED.id]);
  });

  it('two exact matches of any state are a question for an act, and the running one for a look', async () => {
    const live = ferretView({ id: 'ccc00000-2222bbbb', callsign: 'lizzette', task: 'New work', state: 'working' });
    const r = rig();
    r.delegate.on(ferretsRoute([STOPPED, live])).on(stopRoute(live.id));
    const asked = await tool(r, 'stop_ferret', { ferret: 'lizzette' });
    should(asked.isError).be.true();
    should(asked.text).containEql('More than one ferret matches "lizzette"');
    should(asked.text).containEql('Old work), stopped');
    should(posts(r).length).equal(0);
    should((await tool(r, 'get_ferret', { ferret: 'lizzette' })).text).startWith('Lizzette: New work.');
  });

  it('two exact matches that are both stopped are a question even for a look', async () => {
    const twin = ferretView({ id: 'ddd00000-3333cccc', callsign: 'lizzette', task: 'Twin', state: 'stopped' });
    const r = rig();
    r.delegate.on(ferretsRoute([STOPPED, twin]));
    should((await tool(r, 'get_ferret', { ferret: 'lizzette' })).text).containEql('More than one ferret matches');
  });

  it('a partial name matches across every state, so it cannot slide from a stopped ferret to a live one', async () => {
    const liza = ferretView({ id: 'eee00000-4444dddd', callsign: 'liza', task: 'A', state: 'stopped' });
    const lizb = ferretView({ id: 'fff00000-5555eeee', callsign: 'lizb', task: 'B', state: 'working' });
    const r = rig();
    r.delegate.on(ferretsRoute([liza, lizb])).on(stopRoute(lizb.id));
    const reply = await tool(r, 'stop_ferret', { ferret: 'liz' });
    should(reply.text).containEql('More than one ferret matches "liz"');
    should(posts(r).length).equal(0);
    // A unique partial still acts.
    const unique = rig();
    unique.delegate.on(ferretsRoute([MARIN, LIZ])).on(stopRoute(LIZ.id));
    should((await tool(unique, 'stop_ferret', { ferret: 'lizz' })).text).equal('Stopped Lizzette.');
  });

  it('matches by exact short id, ferret id and exact task name', async () => {
    const r = rig();
    r.delegate.on(ferretsRoute([LIZ, MARIN]));
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
  const changed = refuse(409, 'A12 asks something else now', 'ask_changed');

  it('sends the version of the ask the item showed', async () => {
    const r = rig();
    r.delegate
      .on(ferretsRoute([LIZ, MARIN]))
      .on(openRoute({ [LIZ.id]: [item(3, 'Which?')] }))
      .on(answered(LIZ.id));
    await tool(r, 'answer_attention', { item: 'A12', answer: 'sqlite', version: 3 });
    should((posts(r)[0]?.call.body as { askVersion?: number } | undefined)?.askVersion).equal(3);
  });

  it('refuses an answer that names no version, or an older one, for a question that has been revised, and sends nothing', async () => {
    const r = rig();
    r.delegate
      .on(ferretsRoute([LIZ, MARIN]))
      .on(openRoute({ [LIZ.id]: [item(2, 'May I force-push main?')] }))
      .on(answered(LIZ.id));
    for (const args of [
      { item: 'A12', answer: 'sqlite' },
      { item: 'A12', answer: 'sqlite', version: 1 },
    ]) {
      const reply = await tool(r, 'answer_attention', args);
      should(reply.isError).be.true();
      should(reply.text).startWith(
        'That question changed, so nothing was sent; here it is now: ^A12 (revised: say version 2 when you answer)',
      );
      should(reply.text).containEql('May I force-push main?');
    }
    should(posts(r).length).equal(0);
  });

  it('says what the question is now when the ask changed, and records an error, not a success', async () => {
    const r = rig();
    let reads = 0;
    r.delegate
      .on(ferretsRoute([LIZ, MARIN]))
      .on(call =>
        call.path === '/v1/agenda/open'
          ? ok({
              sessions: [{ sessionId: LIZ.id, items: [item(++reads, reads === 1 ? 'Which?' : 'Which cache?')] }],
            })
          : undefined,
      )
      .on(call => (call.method === 'POST' ? changed : undefined));
    const reply = await tool(r, 'answer_attention', { item: 'A12', answer: 'sqlite' });
    should(reply.isError).be.true();
    should(reply.text).startWith(
      'That question changed, so nothing was sent; here it is now: ^A12 (revised: say version 2 when you answer) — from Lizzette — Pick — Which cache?',
    );
    should(reply.text).containEql('Options: Postgres, SQLite.');
    should(r.calls.records[0]?.outcome).equal('error');
    should(r.audit.events[0]).eql({
      kind: 'connector.tool',
      grantId: 'cg_aaaaaaaaaa',
      tool: 'answer_attention',
      sessionId: LIZ.id,
      outcome: 'error',
    });
  });

  it('says so when the changed question is gone altogether', async () => {
    const r = rig();
    let reads = 0;
    r.delegate
      .on(ferretsRoute([LIZ, MARIN]))
      .on(call =>
        call.path === '/v1/agenda/open'
          ? ok({ sessions: reads++ === 0 ? [{ sessionId: LIZ.id, items: [item(1, 'Which?')] }] : [] })
          : undefined,
      )
      .on(call => (call.method === 'POST' ? changed : undefined));
    const reply = await tool(r, 'answer_attention', { item: 'A12', answer: 'sqlite' });
    should(reply.text).equal('That question changed and A12 is not open any more. Nothing was sent.');
  });

  it("passes any other daemon refusal through, aimed at the item's ferret", async () => {
    const r = rig();
    r.delegate
      .on(ferretsRoute([LIZ, MARIN]))
      .on(openRoute({ [LIZ.id]: [item(1, 'Which?')] }))
      .on(call => (call.method === 'POST' ? refuse(409, 'that item is closed') : undefined));
    const reply = await tool(r, 'answer_attention', { item: 'A12', answer: 'sqlite' });
    should(reply.text).equal('that item is closed');
    should(r.audit.events[0]).eql({
      kind: 'connector.tool',
      grantId: 'cg_aaaaaaaaaa',
      tool: 'answer_attention',
      sessionId: LIZ.id,
      outcome: 'error',
    });
  });

  it('lets a failure that is not a ToolFailure through untouched', async () => {
    const spec = CONNECTOR_TOOLS.find(candidate => candidate.name === 'answer_attention');
    const boom = new Error('socket closed');
    const gateway = {
      ferrets: async () => [LIZ],
      openAgenda: async () => [{ sessionId: LIZ.id, item: item(1, 'Which?') }],
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
    r.delegate
      .on(ferretsRoute([LIZ, MARIN]))
      .on(call => (call.path.endsWith('/send') ? refuse(409, 'not accepting messages') : undefined));
    await sendTo(r);
    should(r.calls.records[0]?.outcome).equal('error');
    should(r.audit.events[0]).containEql({ tool: 'send_to_ferret', outcome: 'error' });
  });

  it('records a daemon refusal (403 or 401, with or without its own sentence) as refused in both logs', async () => {
    for (const answer of [refuse(403, 'needs a passkey'), raw(403, 'nope'), raw(401, '{"error":"  "}')]) {
      const r = rig();
      r.delegate.on(ferretsRoute([LIZ, MARIN])).on(call => (call.path.endsWith('/send') ? answer : undefined));
      const reply = await sendTo(r);
      should(reply.isError).be.true();
      should(r.calls.records[0]?.outcome).equal('refused');
      should(r.audit.events[0]).containEql({ outcome: 'refused' });
    }
    const plain = rig();
    plain.delegate
      .on(ferretsRoute([LIZ, MARIN]))
      .on(call => (call.path.endsWith('/send') ? raw(403, 'nope') : undefined));
    should((await sendTo(plain)).text).equal('The daemon refused that request.');
  });

  it('records a success as ok, and a refusal at the gate in the calls log only', async () => {
    const r = rig();
    r.delegate
      .on(ferretsRoute([LIZ, MARIN]))
      .on(call => (call.path.endsWith('/send') ? ok({ ferret: LIZ.id, disposition: 'delivered' }) : undefined));
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
      r.delegate.on(ferretsRoute([LIZ, MARIN])).on(call => (call.path.endsWith('/send') ? raw(status, '') : undefined));
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
  // 5.0: a request carries the door it arrived on (`arrival`), not a `loopback` flag.
  const requestOf = (text: () => Promise<string>): ApiRequest =>
    ({
      method: 'POST',
      path: '/mcp',
      query: new Map(),
      headers: new Map([
        ['content-type', 'application/json'],
        ['authorization', `Bearer ${TOKEN}`],
      ]),
      arrival: OWN_DOOR,
      clientAddress: '203.0.113.7',
      text,
    }) as unknown as ApiRequest;

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
      delegate: r.delegate,
      serving: () => true,
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
    r.delegate.on(ferretsRoute([LIZ, MARIN]));
    const response = await post(r.endpoint, callTool('list_ferrets', {}), { headers: { accept: 'text/plain' } });
    should(response?.status).equal(200);
    should(JSON.parse(response?.body ?? '{}').result.isError).be.undefined();
  });
});

describe('what a spoken answer may pick, and what the log may hold of a refused call', () => {
  const numbered = agendaItem({
    id: 'A20',
    subject: 'How many?',
    why: 'Pick a number',
    ask: { kind: 'multiple-choice', options: [{ label: '10' }, { label: '50' }] },
  });

  it('never lets "100" pick "10": a digit in the answer or the label only matches exactly', async () => {
    const r = rig();
    r.delegate
      .on(ferretsRoute([LIZ, MARIN]))
      .on(openRoute({ [LIZ.id]: [numbered] }))
      .on(answered(LIZ.id));
    const reply = await tool(r, 'answer_attention', { item: 'A20', answer: '100' });
    should(reply.isError).be.true();
    should(reply.text).containEql('Pick one of these: 10, 50.');
    should(posts(r).length).equal(0);
    const exact = await tool(r, 'answer_attention', { item: 'A20', answer: ' 50 ' });
    should(exact.isError).be.false();
  });

  it('writes no nested or oversized argument of a refused call to the log', async () => {
    const r = rig();
    r.state.access = READ_ACCESS;
    const huge = { ['fyc_at_' + 'z'.repeat(43)]: 'x'.repeat(200_000), more: ['y'.repeat(200_000)] };
    await tool(r, 'send_to_ferret', { ferret: huge, message: 'hello' });
    const line = JSON.stringify(r.calls.records);
    should(line.length).be.below(2_000);
    should(line).not.containEql('fyc_at_');
    should(r.calls.records[0]?.outcome).equal('refused');
  });
});
