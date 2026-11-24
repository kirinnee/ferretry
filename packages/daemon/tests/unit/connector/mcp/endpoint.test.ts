import { describe, it } from 'bun:test';
import should from 'should';
import { agendaItem, ok, refuse, sessionView, snapshot, text } from '../../../support/connector/mcp-fixtures.ts';
import { ALL_GRANTS, post, rig, rpc, TOKEN, tool } from '../../../support/connector/mcp-harness.ts';

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

describe('daemon-wide grants, per call', () => {
  it('lists tools but refuses a call when the grants cannot be determined', async () => {
    const r = rig();
    r.state.grants = undefined;
    r.dispatch.on(sessionsRoute());
    const list = JSON.parse((await post(r.endpoint, rpc('tools/list')))?.body ?? '{}');
    should(list.result.tools.length).equal(9);
    const reply = await tool(r, 'list_ferrets', {});
    should(reply.isError).be.true();
    should(reply.text).equal(
      'This machine cannot say what remote callers may do right now, so the connector is refusing.',
    );
    should(r.dispatch.calls.length).equal(0);
  });

  it('refuses every tool when fleet.use is off, and re-reads the grants on every call', async () => {
    const r = rig();
    r.dispatch.on(sessionsRoute());
    r.state.grants = { ...ALL_GRANTS, fleet: { use: false, configure: true } };
    const refused = await tool(r, 'list_ferrets', {});
    should(refused.text).equal('The machine owner has turned off remote fleet access (fleet.use).');
    r.state.grants = ALL_GRANTS;
    should((await tool(r, 'list_ferrets', {})).isError).be.false();
  });

  it('records a refused write in the calls log but not in the security log', async () => {
    const r = rig();
    r.state.grants = undefined;
    await tool(r, 'stop_ferret', { ferret: 'lizzette' });
    should(r.calls.records[0]?.outcome).equal('refused');
    should(r.audit.events.length).equal(0);
  });
});

describe('ferret naming', () => {
  it('lists close matches when nothing matches', async () => {
    const r = rig();
    r.dispatch.on(sessionsRoute());
    const reply = await tool(r, 'get_ferret', { ferret: 'lizzete deploy' });
    should(reply.isError).be.true();
    should(reply.text).startWith('No ferret called "lizzete deploy".');
  });

  it('names a close match for a misheard callsign without acting on it', async () => {
    const r = rig();
    r.dispatch.on(sessionsRoute());
    const reply = await tool(r, 'stop_ferret', { ferret: 'lisette' });
    should(reply.isError).be.true();
    should(reply.text).containEql('Did you mean Lizzette ([Lizzette] Build MCP Connector)?');
    should(r.dispatch.calls.some(c => c.call.path.endsWith('/stop'))).be.false();
  });

  it('says nothing matches and points at the list when it is far from everything', async () => {
    const r = rig();
    r.dispatch.on(sessionsRoute());
    const reply = await tool(r, 'get_ferret', { ferret: 'quetzalcoatl' });
    should(reply.text).equal('No ferret called "quetzalcoatl". Ask me to list the ferrets.');
  });

  it('asks which when several match', async () => {
    const r = rig();
    r.dispatch.on(
      sessionsRoute([
        LIZ,
        sessionView({ id: 'abc12345-0000aaaa', callsign: 'liza', task: 'Other', turnState: 'working' }),
        sessionView({ id: 'abd12345-0000aaaa', callsign: 'lizb', task: 'Another', turnState: 'working' }),
      ]),
    );
    const reply = await tool(r, 'get_ferret', { ferret: 'liz' });
    should(reply.isError).be.true();
    should(reply.text).containEql('More than one ferret matches "liz"');
    should(reply.text).endWith('Which one do you mean?');
  });

  it('matches by callsign, session id, short id and task name', async () => {
    const r = rig();
    r.dispatch.on(sessionsRoute());
    for (const query of [
      'Lizzette',
      ':lizzette',
      'mwuanehg-4531fa9e',
      'mwuanehg',
      'build mcp connector',
      'Mwuanehg 4531fa9e',
    ]) {
      const reply = await tool(r, 'get_ferret', { ferret: query });
      should(reply.isError).be.false();
      should(reply.text).startWith('Lizzette:');
    }
  });
});

describe('get_ferret_output caps', () => {
  const manyLines = Array.from({ length: 500 }, (_, n) => `line ${n + 1}`).join('\n');

  it('defaults to 40 lines, keeps the TAIL and says it cut', async () => {
    const r = rig();
    r.dispatch.on(sessionsRoute()).on(call => (call.path.endsWith('/logs') ? text(manyLines) : undefined));
    const reply = await tool(r, 'get_ferret_output', { ferret: 'lizzette' });
    const lines = reply.text.split('\n');
    should(lines[0]).containEql('Older output was cut; this is the last 40 lines.');
    should(lines.slice(1).length).equal(40);
    should(lines[lines.length - 1]).equal('line 500');
    should(lines[1]).equal('line 461');
  });

  it('honours lines up to 200 and the 8000-character hard cap, keeping the newest text', async () => {
    const wide = Array.from({ length: 300 }, (_, n) => `row ${n + 1} ${'x'.repeat(90)}`).join('\n');
    const r = rig();
    r.dispatch.on(sessionsRoute()).on(call => (call.path.endsWith('/logs') ? text(wide) : undefined));
    const reply = await tool(r, 'get_ferret_output', { ferret: 'lizzette', lines: 200 });
    const body = reply.text.slice(reply.text.indexOf('\n') + 1);
    should(body.length).be.belowOrEqual(8000);
    should(reply.text).containEql('Older output was cut');
    should(body.endsWith(`row 300 ${'x'.repeat(90)}`)).be.true();
  });

  it('says nothing was cut when the output fits, and handles empty output', async () => {
    const r = rig();
    r.dispatch.on(sessionsRoute()).on(call => (call.path.endsWith('/logs') ? text('only line') : undefined));
    const reply = await tool(r, 'get_ferret_output', { ferret: 'lizzette' });
    should(reply.text).equal('Lizzette recent output:\nonly line');
    const empty = rig();
    empty.dispatch.on(sessionsRoute()).on(call => (call.path.endsWith('/logs') ? text('') : undefined));
    should((await tool(empty, 'get_ferret_output', { ferret: 'lizzette' })).text).equal('Lizzette has no output yet.');
  });

  it('masks secrets in output before the tail is taken, and withholds when redaction fails', async () => {
    const secret = `${'sk'}-ant-${'api03-AbCdEfGhIjKlMnOp'}`;
    const r = rig({ redact: async t => t.replaceAll('stored-value-123', '[secret]') });
    r.dispatch
      .on(sessionsRoute())
      .on(call => (call.path.endsWith('/logs') ? text(`a ${secret}\nb stored-value-123`) : undefined));
    const reply = await tool(r, 'get_ferret_output', { ferret: 'lizzette' });
    should(reply.text).not.containEql(secret);
    should(reply.text).not.containEql('stored-value-123');
    should(reply.text).containEql('[secret]');
    const broken = rig({
      redact: async () => {
        throw new Error('vault');
      },
    });
    broken.dispatch.on(sessionsRoute()).on(call => (call.path.endsWith('/logs') ? text('anything') : undefined));
    should((await tool(broken, 'get_ferret_output', { ferret: 'lizzette' })).text).containEql('[output withheld]');
  });
});

describe('write tools', () => {
  it('send_to_ferret posts the message with a request id and records the call (args cut and redacted)', async () => {
    const r = rig();
    r.dispatch
      .on(sessionsRoute())
      .on(call => (call.path.endsWith('/send') ? ok({ ...LIZ, disposition: 'delivered' }) : undefined));
    const message = `please use password=hunter22 ${'z'.repeat(900)}`;
    const reply = await tool(r, 'send_to_ferret', { ferret: 'lizzette', message });
    should(reply.text).equal('Sent to Lizzette.');
    const sent = r.dispatch.calls.find(c => c.call.path.endsWith('/send'));
    should(sent?.grantId).equal('cg_aaaaaaaaaa');
    should(sent?.call.path).equal('/v1/sessions/mwuanehg-4531fa9e/send');
    should((sent?.call.body as { message?: string } | undefined)?.message).equal(message);
    should(sent?.call.headers?.['x-fy-request-id']).equal('req-1');
    const record = r.calls.records[0];
    should(record?.tool).equal('send_to_ferret');
    should(record?.tokenId).equal('0123456789ab');
    should(record?.outcome).equal('ok');
    should(String(record?.args.message).length).be.belowOrEqual(500);
    should(JSON.stringify(record)).not.containEql('hunter22');
    should(JSON.stringify(record)).not.containEql(TOKEN);
    should(r.audit.events).eql([
      { kind: 'connector.tool', grantId: 'cg_aaaaaaaaaa', tool: 'send_to_ferret', sessionId: 'mwuanehg-4531fa9e' },
    ]);
  });

  it('send_to_ferret reports queued and rejects an over-long message', async () => {
    const r = rig();
    r.dispatch
      .on(sessionsRoute())
      .on(call => (call.path.endsWith('/send') ? ok({ ...LIZ, disposition: 'queued' }) : undefined));
    should((await tool(r, 'send_to_ferret', { ferret: 'lizzette', message: 'hi' })).text).containEql(
      'Queued for Lizzette',
    );
    const long = await tool(r, 'send_to_ferret', { ferret: 'lizzette', message: 'x'.repeat(8001) });
    should(long.isError || (long.raw as RpcFailure).error !== undefined).be.true();
  });

  it("passes the daemon's own refusal sentence through", async () => {
    const r = rig();
    r.dispatch
      .on(sessionsRoute())
      .on(call => (call.path.endsWith('/send') ? refuse(409, 'that ferret is not accepting messages') : undefined));
    const reply = await tool(r, 'send_to_ferret', { ferret: 'lizzette', message: 'hi' });
    should(reply.isError).be.true();
    should(reply.text).equal('that ferret is not accepting messages');
    should(r.calls.records[0]?.outcome).equal('error');
  });

  it('refuses a daemon answer that is not the shape the protocol says', async () => {
    const r = rig();
    r.dispatch.on(() => ok({ not: 'sessions' }));
    const reply = await tool(r, 'list_ferrets', {});
    should(reply.isError).be.true();
    should(reply.text).containEql('did not expect');
  });

  it('stop_ferret stops a live ferret and notes an already-stopped one', async () => {
    const stopped = sessionView({ id: 'zzz00000-1111aaaa', callsign: 'oldie', task: 'Done thing', status: 'stopped' });
    const r = rig();
    r.dispatch.on(sessionsRoute([LIZ, stopped])).on(call => (call.path.endsWith('/stop') ? ok(LIZ) : undefined));
    should((await tool(r, 'stop_ferret', { ferret: 'lizzette' })).text).equal('Stopped Lizzette.');
    should((await tool(r, 'stop_ferret', { ferret: 'oldie' })).text).equal('Oldie is already stopped.');
    should(r.dispatch.calls.filter(c => c.call.path.endsWith('/stop')).length).equal(1);
  });

  it('restart_ferret restarts, queues, or says why not', async () => {
    const r = rig();
    const answer = { restarted: [{ id: LIZ.config.id }], queued: [], skipped: [], failed: [] };
    r.dispatch.on(sessionsRoute()).on(call => (call.path === '/v1/restarts' ? ok(answer) : undefined));
    should((await tool(r, 'restart_ferret', { ferret: 'lizzette' })).text).equal('Restarted Lizzette.');
    const restart = r.dispatch.calls.find(c => c.call.path === '/v1/restarts');
    should(restart?.call.body).eql({ scope: 'ids', ids: ['mwuanehg-4531fa9e'] });
    should(restart?.call.headers?.['x-fy-request-id']).be.a.String();
    const queued = rig();
    queued.dispatch
      .on(sessionsRoute())
      .on(call =>
        call.path === '/v1/restarts'
          ? ok({ restarted: [], queued: [{ id: LIZ.config.id, reason: 'mid-turn' }], skipped: [], failed: [] })
          : undefined,
      );
    should((await tool(queued, 'restart_ferret', { ferret: 'lizzette' })).text).containEql('queued the restart');
    const failed = rig();
    failed.dispatch
      .on(sessionsRoute())
      .on(call =>
        call.path === '/v1/restarts'
          ? ok({ restarted: [], queued: [], skipped: [], failed: [{ id: LIZ.config.id, reason: 'pane gone' }] })
          : undefined,
      );
    const reply = await tool(failed, 'restart_ferret', { ferret: 'lizzette' });
    should(reply.isError).be.true();
    should(reply.text).containEql('pane gone');
  });
});

describe('spawn_ferret', () => {
  const projects = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'ferretry',
      path: '/work/ferretry',
      source: 'existing-folder',
      createdAt: '2026-11-01T00:00:00.000Z',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'website',
      path: '/work/website',
      source: 'existing-folder',
      createdAt: '2026-11-01T00:00:00.000Z',
    },
  ];
  const routes = (r: ReturnType<typeof rig>, list = projects) =>
    r.dispatch
      .on(call => (call.path === '/v1/projects' ? ok(list) : undefined))
      .on(call => (call.method === 'POST' && call.path === '/v1/sessions' ? ok(LIZ) : undefined));

  it('starts an auto ferret in the matched registered project and never passes a path from the caller', async () => {
    const r = rig();
    routes(r);
    const reply = await tool(r, 'spawn_ferret', { task: 'Fix the flaky test', project: 'Ferretry', name: 'Flaky' });
    should(reply.isError).be.false();
    should(reply.text).equal('Started Lizzette on "Fix the flaky test" in ferretry.');
    const start = r.dispatch.calls.find(c => c.call.method === 'POST');
    should(start?.call.body).eql({ mode: 'auto', prompt: 'Fix the flaky test', cwd: '/work/ferretry', name: 'Flaky' });
    should(start?.call.headers?.['x-fy-request-id']).be.a.String();
  });

  it('refuses an unknown project by listing the registered ones, and starts nothing', async () => {
    const r = rig();
    routes(r);
    const reply = await tool(r, 'spawn_ferret', { task: 'x', project: '/etc' });
    should(reply.isError).be.true();
    should(reply.text).containEql('Projects: ferretry, website');
    should(r.dispatch.calls.some(c => c.call.method === 'POST')).be.false();
  });

  it('requires a project when there is more than one, and uses the only one when there is one', async () => {
    const many = rig();
    routes(many);
    const ask = await tool(many, 'spawn_ferret', { task: 'x' });
    should(ask.text).containEql('Which project? Choose one of: ferretry, website.');
    const one = rig();
    routes(one, [projects[0] as (typeof projects)[number]]);
    should((await tool(one, 'spawn_ferret', { task: 'x' })).isError).be.false();
    const none = rig();
    routes(none, []);
    should((await tool(none, 'spawn_ferret', { task: 'x' })).text).containEql('No projects are registered');
  });
});

describe('attention', () => {
  const open = (items: ReturnType<typeof agendaItem>[]) => ({ sessions: [{ sessionId: LIZ.config.id, items }] });

  it('lists open items: id, who asks, title, question, options; skips parked and input items', async () => {
    const r = rig();
    const items = [
      agendaItem({
        id: 'A12',
        subject: 'Pick a database',
        why: 'Which database should the connector use?',
        ask: { kind: 'multiple-choice', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
      }),
      agendaItem({ id: 'A13', subject: 'Looks good?', why: 'Review the plan', ask: { kind: 'answer-review' } }),
    ];
    r.dispatch.on(sessionsRoute()).on(call => (call.path === '/v1/agenda/open' ? ok(open(items)) : undefined));
    const reply = await tool(r, 'list_attention', {});
    should(reply.text).containEql('2 waiting on you:');
    should(reply.text).containEql(
      '!A12 — from Lizzette — Pick a database — Which database should the connector use? Options: Postgres, SQLite.',
    );
    should(reply.text).containEql('!A13 — from Lizzette');
  });

  it('says nothing is waiting', async () => {
    const r = rig();
    r.dispatch.on(sessionsRoute()).on(call => (call.path === '/v1/agenda/open' ? ok({ sessions: [] }) : undefined));
    should((await tool(r, 'list_attention', {})).text).equal('Nothing is waiting on you.');
  });

  it('answers a multiple-choice item by option, accepting "!A12", "A12" and "12"', async () => {
    const items = [
      agendaItem({
        id: 'A12',
        subject: 'Pick',
        why: 'Which?',
        ask: { kind: 'multiple-choice', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
      }),
    ];
    for (const ref of ['!A12', 'A12', '12', ' a 12 ']) {
      const r = rig();
      r.dispatch
        .on(sessionsRoute())
        .on(call => (call.path === '/v1/agenda/open' ? ok(open(items)) : undefined))
        .on(call =>
          call.method === 'POST' && call.path.endsWith('/agenda') ? ok(snapshot(LIZ.config.id)) : undefined,
        );
      const reply = await tool(r, 'answer_attention', { item: ref, answer: 'sqlite' });
      should(reply.text).equal('Answered A12 from Lizzette.');
      const post = r.dispatch.calls.find(c => c.call.method === 'POST');
      should(post?.call.path).equal('/v1/sessions/mwuanehg-4531fa9e/agenda');
      should(post?.call.body).eql({
        action: 'resolve',
        id: 'A12',
        response: { kind: 'multiple-choice', choice: 'SQLite' },
      });
    }
  });

  it('refuses an answer that is not one of the options, listing them', async () => {
    const items = [
      agendaItem({
        id: 'A12',
        subject: 'Pick',
        why: 'Which?',
        ask: { kind: 'multiple-choice', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
      }),
    ];
    const r = rig();
    r.dispatch.on(sessionsRoute()).on(call => (call.path === '/v1/agenda/open' ? ok(open(items)) : undefined));
    const reply = await tool(r, 'answer_attention', { item: 'A12', answer: 'mongodb' });
    should(reply.isError).be.true();
    should(reply.text).equal('Pick one of these: Postgres, SQLite.');
    should(r.dispatch.calls.some(c => c.call.method === 'POST')).be.false();
  });

  it('answers open questions, permissions and reviews in the shape their ask takes', async () => {
    const cases: [Record<string, unknown>, string, unknown][] = [
      [{ kind: 'open-question' }, 'use the cache', { kind: 'open-question', answer: 'use the cache' }],
      [{ kind: 'permission' }, 'approve', { kind: 'permission', decision: 'approve' }],
      [{ kind: 'permission' }, 'No', { kind: 'permission', decision: 'reject' }],
      [{ kind: 'answer-review' }, 'good', { kind: 'answer-review', verdict: 'good' }],
      [
        { kind: 'answer-review' },
        'needs more tests',
        { kind: 'answer-review', verdict: 'clarify', clarification: 'needs more tests' },
      ],
    ];
    for (const [ask, answer, expected] of cases) {
      const r = rig();
      r.dispatch
        .on(sessionsRoute())
        .on(call =>
          call.path === '/v1/agenda/open'
            ? ok(open([agendaItem({ id: 'A1', subject: 's', why: 'w', ask })]))
            : undefined,
        )
        .on(call => (call.method === 'POST' ? ok(snapshot(LIZ.config.id)) : undefined));
      should((await tool(r, 'answer_attention', { item: 'A1', answer })).isError).be.false();
      const posted = r.dispatch.calls.find(c => c.call.method === 'POST')?.call.body as
        | { response: unknown }
        | undefined;
      should(posted?.response).eql(expected);
    }
  });

  it('refuses an unknown item, and asks which ferret when two boards have the same id', async () => {
    const r = rig();
    const two = {
      sessions: [
        {
          sessionId: LIZ.config.id,
          items: [agendaItem({ id: 'A1', subject: 's', why: 'w', ask: { kind: 'open-question' } })],
        },
        {
          sessionId: MARIN.config.id,
          items: [
            agendaItem({
              id: 'A1',
              subject: 's2',
              why: 'w2',
              ask: { kind: 'open-question' },
              raisedBySession: MARIN.config.id,
            }),
          ],
        },
      ],
    };
    r.dispatch
      .on(sessionsRoute())
      .on(call => (call.path === '/v1/agenda/open' ? ok(two) : undefined))
      .on(call => (call.method === 'POST' ? ok(snapshot(MARIN.config.id)) : undefined));
    should((await tool(r, 'answer_attention', { item: 'A99', answer: 'x' })).text).containEql(
      'There is no open item A99',
    );
    const ambiguous = await tool(r, 'answer_attention', { item: 'A1', answer: 'x' });
    should(ambiguous.text).containEql('open for more than one ferret (Lizzette and Marin)');
    const chosen = await tool(r, 'answer_attention', { item: 'A1', answer: 'x', ferret: 'marin' });
    should(chosen.isError).be.false();
    should(r.dispatch.calls.find(c => c.call.method === 'POST')?.call.path).equal(
      '/v1/sessions/mxk2aa11-0001ffff/agenda',
    );
    should((await tool(r, 'answer_attention', { item: 'banana', answer: 'x' })).text).containEql('is not an item id');
  });
});

describe('what leaks', () => {
  it('masks credentials in names and daemon errors too', async () => {
    const leaky = `${'gh'}p_${'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'}`;
    const r = rig();
    r.dispatch
      .on(sessionsRoute())
      .on(call => (call.path.endsWith('/send') ? refuse(500, `failed with token ${leaky}`) : undefined));
    const reply = await tool(r, 'send_to_ferret', { ferret: 'lizzette', message: 'hi' });
    should(reply.text).not.containEql(leaky);
  });

  it('never reaches the daemon for anything the tools do not build from fixed templates', async () => {
    const r = rig();
    r.dispatch
      .on(sessionsRoute())
      .on(call => ok(call.path.endsWith('/send') ? { ...LIZ, disposition: 'delivered' } : {}));
    await tool(r, 'send_to_ferret', { ferret: 'mwuanehg-4531fa9e', message: 'hi' });
    for (const { call } of r.dispatch.calls)
      should(call.path).match(/^\/v1\/(sessions|restarts|projects|agenda\/open)/u);
  });
});
