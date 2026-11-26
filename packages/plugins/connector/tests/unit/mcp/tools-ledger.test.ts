import { describe, it } from 'bun:test';
import should from 'should';
import { FleetGateway } from '../../../daemon/lib/mcp/gateway.ts';
import { ConnectorTextGuard } from '../../../daemon/lib/mcp/redaction.ts';
import { ConnectorToolbox } from '../../../daemon/lib/mcp/toolbox.ts';
import { CONNECTOR_TOOLS } from '../../../daemon/lib/mcp/tools/index.ts';
import {
  agendaItem,
  AuditSpy,
  FakeDelegate,
  ferretView,
  NOW,
  ok,
  snapshot,
  text,
  WRITE_ACCESS,
} from '../../support/mcp-fixtures.ts';
import { ALL_GRANTS, CallsSpy, rig, tool } from '../../support/mcp-harness.ts';
import { ferretsRoute, openRoute, posts } from '../../support/mcp-tools-routes.ts';

/** The rest of the tools' and the gateway's lines: each branch a person can hear, said once. */

describe('stateOf, as list_ferrets says it', () => {
  // 5.0 has four states and a declared wait; v4's rate_limited / retrying / awaiting_* / kill_failed / thinking /
  // tool_running / interrupted / needs-input statuses no longer exist, so those cases are gone with them.
  it('speaks every live state in plain words', async () => {
    const cases: [Parameters<typeof ferretView>[0]['state'], Record<string, unknown> | undefined, string][] = [
      ['working', { waiting: { since: '2026-11-24T11:00:00.000Z' } }, 'parked, waiting on something it declared'],
      ['idle', undefined, 'idle, waiting for a message'],
      ['working', undefined, 'working'],
      ['starting', undefined, 'starting'],
    ];
    const views = cases.map(([state, extra], index) =>
      ferretView({
        id: `s${index}000000-0000aaaa`,
        callsign: `ferret${'abcdefghijklmno'[index]}`,
        task: `Task ${index}`,
        state,
        ...(extra === undefined ? {} : { extra }),
      }),
    );
    const r = rig();
    r.delegate.on(ferretsRoute(views));
    const lines = (await tool(r, 'list_ferrets', {})).text.split('\n').slice(1);
    for (const [index, [, , said]] of cases.entries()) should(lines[index]).containEql(` — ${said} — `);
  });

  it('leaves a stopped ferret off the list and says "stopped" when asked about it', async () => {
    const stopped = ferretView({ id: 's9000000-0000aaaa', callsign: 'oldie', task: 'T', state: 'stopped' });
    const r = rig();
    r.delegate.on(ferretsRoute([stopped]));
    should((await tool(r, 'list_ferrets', {})).text).equal('No ferrets are running.');
    should((await tool(r, 'get_ferret', { ferret: 'oldie' })).text).containEql('State: stopped.');
  });
});

describe('get_ferret, in full', () => {
  // 5.0: no activity / needsHuman / contextPercent / reason / exitCode lines; the tool says the card, the declared wait,
  // why it ended (its cause) and the harness's own limit notice (tools/ferrets.ts `get_ferret`).
  it('says its card, what it waits for, how it ended and its last problem', async () => {
    const view = ferretView({
      id: 'mwuanehg-4531fa9e',
      callsign: 'lizzette',
      task: '[Lizzette] Build',
      state: 'working',
      extra: {
        task: 'F12',
        waiting: { since: '2026-11-24T11:00:00.000Z', condition: 'which database?' },
        quota: { limitNotice: 'Limit resets at 5pm' },
      },
    });
    const r = rig();
    r.delegate.on(ferretsRoute([view]));
    const reply = await tool(r, 'get_ferret', { ferret: 'lizzette' });
    should(reply.text).containEql('Task: &F12.');
    should(reply.text).containEql('Waiting for: which database?.');
    should(reply.text).containEql('Last problem: Limit resets at 5pm.');
    // The lines v4 said from fields 5.0 no longer has are gone for good.
    for (const gone of ['Doing:', 'Needs a person:', 'Context ']) should(reply.text).not.containEql(gone);
  });

  it('says why a stopped ferret ended, for every cause, and nothing when it has none', async () => {
    const causes: [Record<string, unknown>, string][] = [
      [{ kind: 'completed' }, 'it said it was done'],
      [{ kind: 'stopped' }, 'it was stopped'],
      [{ kind: 'clean_exit' }, 'its agent exited'],
      [{ kind: 'start_failed' }, 'it could not start'],
      [{ kind: 'agent_crashed', exitCode: 1 }, 'its agent crashed'],
      [{ kind: 'signal', signal: 9 }, 'its agent was killed'],
      [{ kind: 'terminal_gone' }, 'its terminal went away'],
      [{ kind: 'tmux_crashed' }, 'its terminal went away'],
    ];
    for (const [cause, said] of causes) {
      const r = rig();
      r.delegate.on(
        ferretsRoute([
          ferretView({ id: 'x1000000-0000aaaa', callsign: 'oldie', task: 'T', state: 'stopped', extra: { cause } }),
        ]),
      );
      should((await tool(r, 'get_ferret', { ferret: 'oldie' })).text).containEql(`Ended: ${said}.`);
    }
    // v4 said the bare status as "Last problem: failed."; 5.0 has no such fallback, so a stopped ferret with no cause says neither.
    const bare = rig();
    bare.delegate.on(
      ferretsRoute([ferretView({ id: 'x2000000-0000aaaa', callsign: 'oldie', task: 'T', state: 'stopped' })]),
    );
    const reply = (await tool(bare, 'get_ferret', { ferret: 'oldie' })).text;
    should(reply).not.containEql('Ended:');
    should(reply).not.containEql('Last problem');
  });

  it('reads the one ferret afresh, since the list answers as of its last move', async () => {
    const listed = ferretView({ id: 'mwuanehg-4531fa9e', callsign: 'lizzette', task: 'Build', state: 'working' });
    const fresh = ferretView({ id: 'mwuanehg-4531fa9e', callsign: 'lizzette', task: 'Build', state: 'idle' });
    const r = rig();
    r.delegate.on(call =>
      call.path === '/v1/ferrets' ? ok([listed]) : call.path === `/v1/ferrets/${fresh.id}` ? ok(fresh) : undefined,
    );
    should((await tool(r, 'get_ferret', { ferret: 'lizzette' })).text).containEql(
      'State: idle, waiting for a message.',
    );
  });
});

describe('restart_ferret, when nothing restarted', () => {
  it('says it left the ferret alone, with or without a reason', async () => {
    const view = ferretView({ id: 'mwuanehg-4531fa9e', callsign: 'lizzette', task: 'T', state: 'working' });
    for (const [skipped, said] of [
      [[{ id: view.id, reason: 'not-outdated' }], 'I left Lizzette alone (not outdated).'],
      [[], 'I left Lizzette alone.'],
    ] as const) {
      const r = rig();
      r.delegate
        .on(ferretsRoute([view]))
        .on(call =>
          call.path === '/v1/restarts' ? ok({ restarted: [], queued: [], skipped, failed: [] }) : undefined,
        );
      should((await tool(r, 'restart_ferret', { ferret: 'lizzette' })).text).equal(said);
    }
  });
});

describe('spawn_ferret, naming the project', () => {
  const project = (name: string, n: number) => ({
    id: `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`,
    name,
    path: `/work/${name}`,
    source: 'existing-folder',
    createdAt: '2026-11-01T00:00:00.000Z',
  });

  it('asks which when two projects match, and lists registered ones when none is named like it', async () => {
    const r = rig();
    r.delegate.on(call =>
      call.path === '/v1/projects' ? ok([project('web-app', 1), project('web-site', 2)]) : undefined,
    );
    should((await tool(r, 'spawn_ferret', { task: 'x', project: 'web' })).text).equal(
      'More than one project matches "web": web-app, web-site. Which one?',
    );
    should((await tool(r, 'spawn_ferret', { task: 'x', project: 'zzzzzzzz' })).text).equal(
      'No project called "zzzzzzzz". Projects: web-app, web-site.',
    );
    const none = rig();
    none.delegate.on(call => (call.path === '/v1/projects' ? ok([]) : undefined));
    should((await tool(none, 'spawn_ferret', { task: 'x', project: 'zzzzzzzz' })).text).equal(
      'No project called "zzzzzzzz". Projects: none registered.',
    );
  });
});

describe('the toolbox around a tool', () => {
  const toolbox = (options: Partial<ConstructorParameters<typeof ConnectorToolbox>[0]> = {}) => {
    const calls = new CallsSpy();
    const audit = new AuditSpy();
    return {
      calls,
      audit,
      box: new ConnectorToolbox({
        daemonGrants: () => ALL_GRANTS,
        guard: new ConnectorTextGuard(async value => value),
        callsLog: calls,
        audit,
        now: () => NOW,
        ...options,
      }),
    };
  };
  const spec = CONNECTOR_TOOLS.find(candidate => candidate.name === 'stop_ferret');
  const gateway = (delegate: FakeDelegate) =>
    new FleetGateway(
      delegate,
      'cg_aaaaaaaaaa',
      () => 'req-1',
      () => true,
    );

  it('treats a grants source that throws as undetermined, and says so', async () => {
    const { box } = toolbox({
      daemonGrants: () => {
        throw new Error('unreadable');
      },
    });
    const result = await box.execute(spec as never, { ferret: 'x' }, WRITE_ACCESS, gateway(new FakeDelegate()));
    should(result.isError).be.true();
    should(result.text).containEql('cannot say what remote callers may do');
  });

  it('reports an argument the schema refuses as a failure, in plain words', async () => {
    const { box, calls, audit } = toolbox();
    const result = await box.execute(spec as never, { ferret: '' }, WRITE_ACCESS, gateway(new FakeDelegate()));
    should(result.text).equal('Something went wrong on the machine, so I did not do that.');
    should(calls.records[0]?.outcome).equal('error');
    should(audit.events[0]).containEql({ outcome: 'error' });
  });

  it('never fails a call because a log could not be written', async () => {
    const delegate = new FakeDelegate().on(
      ferretsRoute([ferretView({ id: 'mwuanehg-4531fa9e', callsign: 'lizzette', task: 'T', state: 'stopped' })]),
    );
    const { box } = toolbox({
      callsLog: {
        append: async () => {
          throw new Error('disk full');
        },
      },
      audit: {
        record: async () => {
          throw new Error('disk full');
        },
      },
    });
    const result = await box.execute(spec as never, { ferret: 'lizzette' }, WRITE_ACCESS, gateway(delegate));
    should(result.text).equal('Lizzette is already stopped.');
    should(result.isError).be.false();
  });
});

describe('the gateway', () => {
  const gateway = (delegate: FakeDelegate): FleetGateway =>
    new FleetGateway(
      delegate,
      'cg_aaaaaaaaaa',
      () => 'req-1',
      () => true,
    );

  it('pages through the open agenda until the daemon says there is no more', async () => {
    const item = agendaItem({ id: 'A1', subject: 's', why: 'w', ask: { kind: 'open-question' } });
    const pages: Record<string, unknown> = {
      first: { sessions: [{ sessionId: 'mwuanehg-4531fa9e', items: [item] }], next: 'p2' },
      p2: { sessions: [{ sessionId: 'mxk2aa11-0001ffff', items: [{ ...item, id: 'A2' }] }] },
    };
    // 5.0: a delegated query is a map of lists, not a record of strings.
    const delegate = new FakeDelegate().on(call => ok(pages[call.query?.get('after')?.[0] ?? 'first']));
    const found = await gateway(delegate).openAgenda();
    should(found.map(entry => entry.item.id)).eql(['A1', 'A2']);
    should(delegate.calls[0]?.call.query).be.undefined();
    should(delegate.calls[1]?.call.query?.get('after')).eql(['p2']);
  });

  it('says so when the daemon is unreachable, or answers in something that is not JSON', async () => {
    const down = new FleetGateway(
      {
        call: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
      'cg_aaaaaaaaaa',
      () => 'req-1',
      () => true,
    );
    await should(down.ferrets()).be.rejectedWith({
      message: 'The daemon could not be reached just now.',
    });
    const garbled = new FakeDelegate().on(() => text('not json'));
    await should(gateway(garbled).ferrets()).be.rejectedWith({
      message: 'The daemon answered in a form I could not read.',
    });
  });

  // 5.0 deliberately changed the machine ledger's wire: POST /v1/machine/agenda takes only `resolve {id, note?}` and
  // `snooze {id, until}` — no askVersion, no response — so v4's `askVersion: 2` is no longer sent.
  it('resolves a machine-board item through the machine route, with only an id and a note', async () => {
    const delegate = new FakeDelegate().on(() => ok(snapshot('machine-agenda')));
    await gateway(delegate).resolveAgenda('machine-agenda', 'A1', 2, undefined, 'done');
    should(delegate.calls[0]?.call.path).equal('/v1/machine/agenda');
    should(delegate.calls[0]?.call.body).eql({ action: 'resolve', id: 'A1', note: 'done' });
    await gateway(delegate).resolveAgenda('machine-agenda', 'A2', 7);
    should(delegate.calls[1]?.call.body).eql({ action: 'resolve', id: 'A2' });
  });

  it('snoozes a machine-board item through the machine route, with only an id and the wake time', async () => {
    const delegate = new FakeDelegate().on(() => ok(snapshot('machine-agenda')));
    await gateway(delegate).snoozeAgenda('machine-agenda', 'A3', '2026-11-24T14:00:00.000Z');
    should(delegate.calls[0]?.call.path).equal('/v1/machine/agenda');
    should(delegate.calls[0]?.call.body).eql({ action: 'snooze', id: 'A3', until: '2026-11-24T14:00:00.000Z' });
  });

  it('puts a ferret-board act on that ferret route, carrying the ask version it answered', async () => {
    const delegate = new FakeDelegate().on(() => ok(snapshot('mwuanehg-4531fa9e')));
    await gateway(delegate).resolveAgenda('mwuanehg-4531fa9e', 'A1', 2, undefined, 'done');
    should(delegate.calls[0]?.call.path).equal('/v1/ferrets/mwuanehg-4531fa9e/agenda');
    should(delegate.calls[0]?.call.body).eql({ action: 'resolve', id: 'A1', askVersion: 2, note: 'done' });
  });
});

describe('what the tools can do to the agenda', () => {
  // The two acts the connector may make are resolve and snooze; dismiss, unsnooze, edit and add are never sent, on any
  // board, by any of the eleven tools.
  it('only ever sends resolve and snooze, across a full run of all eleven tools', async () => {
    const liz = ferretView({ id: 'mwuanehg-4531fa9e', callsign: 'lizzette', task: 'Build', state: 'working' });
    const marin = ferretView({ id: 'mxk2aa11-0001ffff', callsign: 'marin', task: 'Fix the login page', state: 'idle' });
    const question = (id: string, raisedBySession: string) =>
      agendaItem({ id, subject: `Item ${id}`, why: 'Which way?', ask: { kind: 'open-question' }, raisedBySession });
    const project = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'web-app',
      path: '/work/web-app',
      source: 'existing-folder',
      createdAt: '2026-11-01T00:00:00.000Z',
    };
    const r = rig();
    r.delegate
      .on(ferretsRoute([liz, marin]))
      .on(
        openRoute({
          [liz.id]: [question('A1', liz.id), question('A4', liz.id)],
          'machine-agenda': [
            question('A2', liz.id),
            agendaItem({ id: 'A3', subject: 'Notice A3', why: 'Seen it?', raisedBySession: liz.id }),
          ],
        }),
      )
      .on(call => (call.path.endsWith('/logs') ? text('a line of output') : undefined))
      .on(call => (call.path === '/v1/projects' ? ok([project]) : undefined))
      .on(call => (call.path === '/v1/ferrets' && call.method === 'POST' ? ok({ id: marin.id }) : undefined))
      .on(call => (call.path.endsWith('/send') ? ok({ ferret: liz.id, disposition: 'delivered' }) : undefined))
      .on(call => (call.path.endsWith('/stop') ? ok({ id: liz.id, state: 'stopped' }) : undefined))
      .on(call =>
        call.path === '/v1/restarts'
          ? ok({ restarted: [{ id: marin.id }], queued: [], skipped: [], failed: [] })
          : undefined,
      )
      .on(call =>
        call.path.endsWith('/agenda') && call.method === 'POST'
          ? ok(snapshot(call.path === '/v1/machine/agenda' ? 'machine-agenda' : liz.id))
          : undefined,
      );

    const runs: [string, Record<string, unknown>][] = [
      ['list_ferrets', {}],
      ['get_ferret', { ferret: 'lizzette' }],
      ['get_ferret_output', { ferret: 'lizzette' }],
      ['list_attention', {}],
      ['get_attention', { item: 'A1' }],
      ['send_to_ferret', { ferret: 'lizzette', message: 'hi' }],
      ['answer_attention', { item: 'A1', answer: 'yes please' }],
      ['answer_attention', { item: 'A3', answer: 'ok then', ferret: 'lizzette' }],
      ['snooze_attention', { item: 'A2', duration: '2h' }],
      ['snooze_attention', { item: 'A4', duration: '3h' }],
      ['restart_ferret', { ferret: 'marin' }],
      ['stop_ferret', { ferret: 'lizzette' }],
      ['spawn_ferret', { task: 'Do the thing' }],
    ];
    should(new Set(runs.map(([name]) => name)).size).equal(11);
    for (const [name, args] of runs) {
      const reply = await tool(r, name, args);
      should({ name, error: reply.isError ? reply.text : false }).eql({ name, error: false });
    }

    const agendaActs = posts(r).filter(entry => entry.call.path.endsWith('/agenda'));
    const bodies = agendaActs.map(entry => entry.call.body as { action: string });
    should(bodies.length).equal(4);
    should(bodies.map(body => body.action).sort()).eql(['resolve', 'resolve', 'snooze', 'snooze']);
    for (const body of bodies) should(['resolve', 'snooze']).containEql(body.action);

    // And what the machine ledger is sent is exactly the two bodies it accepts.
    const machine = agendaActs.filter(entry => entry.call.path === '/v1/machine/agenda').map(entry => entry.call.body);
    should(machine).eql([
      { action: 'resolve', id: 'A3', note: 'ok then' },
      { action: 'snooze', id: 'A2', until: new Date(NOW + 2 * 3_600_000).toISOString() },
    ]);
  });
});
