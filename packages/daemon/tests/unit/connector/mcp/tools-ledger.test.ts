import { describe, it } from 'bun:test';
import should from 'should';
import { FleetGateway } from '../../../../src/lib/connector/mcp/gateway.ts';
import { ConnectorToolbox, CONNECTOR_TOOLS } from '../../../../src/lib/connector/mcp/tools.ts';
import { ConnectorTextGuard } from '../../../../src/lib/connector/mcp/redaction.ts';
import {
  agendaItem,
  AuditSpy,
  FakeDispatch,
  NOW,
  ok,
  sessionView,
  snapshot,
  WRITE_ACCESS,
} from '../../../support/connector/mcp-fixtures.ts';
import { ALL_GRANTS, CallsSpy, rig, tool } from '../../../support/connector/mcp-harness.ts';

/** The rest of the tools' and the gateway's lines: each branch a person can hear, said once. */

const sessionsOf =
  (...views: ReturnType<typeof sessionView>[]) =>
  (call: { method: string; path: string }) =>
    call.method === 'GET' && call.path === '/v1/sessions' ? ok(views) : undefined;

describe('stateOf, as list_ferrets says it', () => {
  it('speaks every state in plain words', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { status: 'running', state: { waiting: { since: '2026-11-24T11:00:00.000Z' } } },
        'parked, waiting on something it declared',
      ],
      [{ status: 'running', turnState: 'needs-input' }, 'blocked, needs a person'],
      [{ status: 'running', turnState: 'your-turn' }, 'idle, waiting for a message'],
      [{ status: 'running', turnState: 'working' }, 'working'],
      [{ status: 'rate_limited' }, 'paused by a usage limit'],
      [{ status: 'retrying' }, 'retrying'],
      [{ status: 'awaiting_question' }, 'waiting for an answer'],
      [{ status: 'awaiting_user' }, 'waiting for an answer'],
      [{ status: 'waiting' }, 'waiting'],
      [{ status: 'kill_failed' }, 'stuck, could not be stopped'],
      [{ status: 'created' }, 'starting'],
      [{ status: 'starting' }, 'starting'],
      [{ status: 'thinking' }, 'working'],
      [{ status: 'tool_running' }, 'working'],
      [{ status: 'running' }, 'working'],
      [{ status: 'interrupted' }, 'interrupted'],
    ];
    const views = cases.map(([spec], index) =>
      sessionView({
        id: `s${index}000000-0000aaaa`,
        callsign: `ferret${'abcdefghijklmno'[index]}`,
        task: `Task ${index}`,
        ...(spec as { status: string }),
      }),
    );
    const r = rig();
    r.dispatch.on(sessionsOf(...views));
    const lines = (await tool(r, 'list_ferrets', {})).text.split('\n').slice(1);
    for (const [index, [, said]] of cases.entries()) should(lines[index]).containEql(` — ${said} — `);
  });
});

describe('get_ferret, in full', () => {
  it('says what it is doing, who it needs, its context and its last problem', async () => {
    const view = sessionView({
      id: 'mwuanehg-4531fa9e',
      callsign: 'lizzette',
      task: '[Lizzette] Build',
      status: 'stalled',
      reason: 'no output for ten minutes',
      state: { activity: 'reading the spec', needsHuman: 'which database?', contextPercent: 41.6, exitCode: 1 },
    });
    const r = rig();
    r.dispatch.on(sessionsOf(view));
    const reply = await tool(r, 'get_ferret', { ferret: 'lizzette' });
    should(reply.text).containEql('Doing: reading the spec.');
    should(reply.text).containEql('Needs a person: which database?.');
    should(reply.text).containEql('Context 42 percent full.');
    should(reply.text).containEql('Last problem: no output for ten minutes.');
    const noReason = rig();
    noReason.dispatch.on(
      sessionsOf(sessionView({ id: 'x1000000-0000aaaa', callsign: 'oldie', task: 'T', status: 'failed' })),
    );
    should((await tool(noReason, 'get_ferret', { ferret: 'oldie' })).text).containEql('Last problem: failed.');
    const quota = rig();
    quota.dispatch.on(
      sessionsOf(
        sessionView({
          id: 'x2000000-0000aaaa',
          callsign: 'quota',
          task: 'T',
          status: 'rate_limited',
          state: { quota: { limitNotice: 'Limit resets at 5pm' } },
        }),
      ),
    );
    should((await tool(quota, 'get_ferret', { ferret: 'quota' })).text).containEql(
      'Last problem: Limit resets at 5pm.',
    );
  });
});

describe('restart_ferret, when nothing restarted', () => {
  it('says it left the ferret alone, with or without a reason', async () => {
    const view = sessionView({ id: 'mwuanehg-4531fa9e', callsign: 'lizzette', task: 'T', turnState: 'working' });
    for (const [skipped, said] of [
      [[{ id: view.config.id, reason: 'not-outdated' }], 'I left Lizzette alone (not outdated).'],
      [[], 'I left Lizzette alone.'],
    ] as const) {
      const r = rig();
      r.dispatch
        .on(sessionsOf(view))
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
    r.dispatch.on(call =>
      call.path === '/v1/projects' ? ok([project('web-app', 1), project('web-site', 2)]) : undefined,
    );
    should((await tool(r, 'spawn_ferret', { task: 'x', project: 'web' })).text).equal(
      'More than one project matches "web": web-app, web-site. Which one?',
    );
    should((await tool(r, 'spawn_ferret', { task: 'x', project: 'zzzzzzzz' })).text).equal(
      'No project called "zzzzzzzz". Projects: web-app, web-site.',
    );
    const none = rig();
    none.dispatch.on(call => (call.path === '/v1/projects' ? ok([]) : undefined));
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
        guard: new ConnectorTextGuard({ redact: async text => text }),
        callsLog: calls,
        audit,
        now: () => NOW,
        ...options,
      }),
    };
  };
  const spec = CONNECTOR_TOOLS.find(candidate => candidate.name === 'stop_ferret');
  const gateway = (dispatch: FakeDispatch) => new FleetGateway(dispatch, 'cg_aaaaaaaaaa', () => 'req-1');

  it('treats a grants source that throws as undetermined, and says so', async () => {
    const { box } = toolbox({
      daemonGrants: () => {
        throw new Error('unreadable');
      },
    });
    const result = await box.execute(spec as never, { ferret: 'x' }, WRITE_ACCESS, gateway(new FakeDispatch()));
    should(result.isError).be.true();
    should(result.text).containEql('cannot say what remote callers may do');
  });

  it('reports an argument the schema refuses as a failure, in plain words', async () => {
    const { box, calls, audit } = toolbox();
    const result = await box.execute(spec as never, { ferret: '' }, WRITE_ACCESS, gateway(new FakeDispatch()));
    should(result.text).equal('Something went wrong on the machine, so I did not do that.');
    should(calls.records[0]?.outcome).equal('error');
    should(audit.events[0]).containEql({ outcome: 'error' });
  });

  it('never fails a call because a log could not be written', async () => {
    const dispatch = new FakeDispatch().on(
      sessionsOf(sessionView({ id: 'mwuanehg-4531fa9e', callsign: 'lizzette', task: 'T', status: 'stopped' })),
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
    const result = await box.execute(spec as never, { ferret: 'lizzette' }, WRITE_ACCESS, gateway(dispatch));
    should(result.text).equal('Lizzette is already stopped.');
    should(result.isError).be.false();
  });
});

describe('the gateway', () => {
  it('pages through the open agenda until the daemon says there is no more', async () => {
    const item = agendaItem({ id: 'A1', subject: 's', why: 'w', ask: { kind: 'open-question' } });
    const pages: Record<string, unknown> = {
      first: { sessions: [{ sessionId: 'mwuanehg-4531fa9e', items: [item] }], next: 'p2' },
      p2: { sessions: [{ sessionId: 'mxk2aa11-0001ffff', items: [{ ...item, id: 'A2' }] }] },
    };
    const dispatch = new FakeDispatch().on(call => ok(pages[call.query?.after ?? 'first']));
    const found = await gateway(dispatch).openAgenda();
    should(found.map(entry => entry.item.id)).eql(['A1', 'A2']);
    should(dispatch.calls[1]?.call.query).eql({ after: 'p2' });
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
    );
    await should(down.sessions()).be.rejectedWith({
      message: 'The daemon could not be reached just now.',
    });
    const garbled = new FakeDispatch().on(() => ({ status: 200, body: 'not json' }));
    await should(gateway(garbled).sessions()).be.rejectedWith({
      message: 'The daemon answered in a form I could not read.',
    });
  });

  it('resolves a machine-board item through the machine route', async () => {
    const dispatch = new FakeDispatch().on(() => ok(snapshot('machine-agenda')));
    await gateway(dispatch).resolveAgenda('machine-agenda', 'A1', 2, undefined, 'done');
    should(dispatch.calls[0]?.call.path).equal('/v1/machine/agenda');
    should(dispatch.calls[0]?.call.body).eql({ action: 'resolve', id: 'A1', askVersion: 2, note: 'done' });
  });

  function gateway(dispatch: FakeDispatch): FleetGateway {
    return new FleetGateway(dispatch, 'cg_aaaaaaaaaa', () => 'req-1');
  }
});
