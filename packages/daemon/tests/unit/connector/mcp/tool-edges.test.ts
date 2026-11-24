import { describe, it } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import should from 'should';
import type { ConnectorAccess } from '../../../../src/lib/connector/ports.ts';
import { ConnectorToolbox, type ConnectorToolSpec, shapeAnswer } from '../../../../src/lib/connector/mcp/tools.ts';
import type { FleetGateway } from '../../../../src/lib/connector/mcp/gateway.ts';
import { ConnectorTextGuard } from '../../../../src/lib/connector/mcp/redaction.ts';
import {
  agendaItem,
  NOW,
  ok,
  refuse,
  sessionView,
  snapshot,
  text,
  WRITE_ACCESS,
  AuditSpy,
} from '../../../support/connector/mcp-fixtures.ts';
import { ALL_GRANTS, CallsSpy, rig, tool } from '../../../support/connector/mcp-harness.ts';

const view = (status: string, extra: Record<string, unknown> = {}, more: { turnState?: 'working' } = {}) =>
  sessionView({
    id: 'mwuanehg-4531fa9e',
    callsign: 'lizzette',
    task: 'Build the thing',
    status,
    state: extra,
    ...more,
  });

const askingAbout = async (status: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const r = rig();
  r.dispatch.on(call => (call.path === '/v1/sessions' ? ok([view(status, extra)]) : undefined));
  const reply = await tool(r, 'get_ferret', { ferret: 'lizzette' });
  should(reply.isError).be.false();
  return reply.text;
};

describe('get_ferret — how a state is said aloud', () => {
  it('says each daemon status in plain words', async () => {
    const said: [string, string][] = [
      ['rate_limited', 'paused by a usage limit'],
      ['retrying', 'retrying'],
      ['awaiting_question', 'waiting for an answer'],
      ['awaiting_user', 'waiting for an answer'],
      ['kill_failed', 'stuck, could not be stopped'],
      ['created', 'starting'],
      ['starting', 'starting'],
      ['running', 'working'],
      ['thinking', 'working'],
      ['tool_running', 'working'],
      ['interrupted', 'interrupted'],
    ];
    for (const [status, words] of said) should(await askingAbout(status)).containEql(`State: ${words}.`);
  });

  it('puts a declared wait before everything else', async () => {
    const reply = await askingAbout('running', { waiting: { since: '2026-11-24T11:00:00.000Z' } });
    should(reply).containEql('State: parked, waiting on something it declared.');
  });

  it('says what it is doing, what it needs, how full its context is, and why it last failed', async () => {
    const reply = await askingAbout('failed', {
      activity: 'running the tests',
      needsHuman: 'the staging password',
      contextPercent: 71.6,
      reason: 'the harness exited with a crash',
    });
    should(reply).containEql('Doing: running the tests.');
    should(reply).containEql('Needs a person: the staging password.');
    should(reply).containEql('Context 72 percent full.');
    should(reply).containEql('Last problem: the harness exited with a crash.');
  });

  it("falls back to the harness's own limit notice, then to the bare status", async () => {
    const limited = await askingAbout('rate_limited', { quota: { limitNotice: 'You hit your five hour limit' } });
    should(limited).containEql('Last problem: You hit your five hour limit.');
    should(await askingAbout('stalled')).containEql('Last problem: stalled.');
    should(await askingAbout('completed', { exitCode: 0 })).containEql('Last problem: completed.');
  });
});

describe('restart_ferret — a ferret the daemon left alone', () => {
  it('says why in plain words', async () => {
    const r = rig();
    r.dispatch
      .on(call => (call.path === '/v1/sessions' ? ok([view('running')]) : undefined))
      .on(call =>
        call.path === '/v1/restarts'
          ? ok({ restarted: [], queued: [], failed: [], skipped: [{ id: 'mwuanehg-4531fa9e', reason: 'not-running' }] })
          : undefined,
      );
    should((await tool(r, 'restart_ferret', { ferret: 'lizzette' })).text).equal(
      'I left Lizzette alone (not running).',
    );
    const bare = rig();
    bare.dispatch
      .on(call => (call.path === '/v1/sessions' ? ok([view('running')]) : undefined))
      .on(call =>
        call.path === '/v1/restarts' ? ok({ restarted: [], queued: [], failed: [], skipped: [] }) : undefined,
      );
    should((await tool(bare, 'restart_ferret', { ferret: 'lizzette' })).text).equal('I left Lizzette alone.');
  });
});

describe('spawn_ferret — a project name that fits two projects', () => {
  it('asks which one and starts nothing', async () => {
    const entry = (id: string, name: string) => ({
      id,
      name,
      path: `/work/${name}`,
      source: 'existing-folder',
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    const r = rig();
    r.dispatch.on(call =>
      call.path === '/v1/projects'
        ? ok([
            entry('11111111-1111-4111-8111-111111111111', 'web-app'),
            entry('22222222-2222-4222-8222-222222222222', 'web-api'),
          ])
        : undefined,
    );
    const reply = await tool(r, 'spawn_ferret', { task: 'Do it', project: 'web' });
    should(reply.isError).be.true();
    should(reply.text).containEql('More than one project matches "web"');
    should(reply.text).containEql('web-app, web-api');
    should(r.dispatch.calls.some(c => c.call.method === 'POST')).be.false();
  });
});

describe('what the daemon says back', () => {
  const failing = async (answer: { status: number; body: string }): Promise<string> => {
    const r = rig();
    r.dispatch.on(() => answer);
    const reply = await tool(r, 'list_ferrets', {});
    should(reply.isError).be.true();
    return reply.text;
  };

  it('says it could not be reached when the in-process call throws', async () => {
    const r = rig();
    r.dispatch.on(() => {
      throw new Error('boom');
    });
    const reply = await tool(r, 'list_ferrets', {});
    should(reply.isError).be.true();
    should(reply.text).equal('The daemon could not be reached just now.');
  });

  it('says it could not read an answer that is not JSON', async () => {
    const r = rig();
    r.dispatch.on(() => text('<html>not json</html>'));
    should((await tool(r, 'list_ferrets', {})).text).equal('The daemon answered in a form I could not read.');
  });

  it('turns a refusal without a sentence into one by status', async () => {
    should(await failing({ status: 404, body: 'gone' })).equal('The daemon does not know that.');
    should(await failing({ status: 403, body: '' })).equal('The daemon refused that request.');
    should(await failing({ status: 401, body: '{}' })).equal('The daemon refused that request.');
    should(await failing({ status: 429, body: '' })).equal('The daemon is busy right now. Try again in a moment.');
    should(await failing({ status: 500, body: '' })).equal('The daemon could not do that (status 500).');
    // A sentence that is only whitespace is not a sentence.
    should(await failing({ status: 500, body: refuse(500, '   ').body })).equal(
      'The daemon could not do that (status 500).',
    );
  });
});

describe('answer_attention — beyond the first page, and the machine board', () => {
  it('follows the cursor until the daemon stops sending one', async () => {
    const r = rig();
    const target = agendaItem({ id: 'A7', subject: 's', why: 'w', ask: { kind: 'open-question' } });
    const other = agendaItem({
      id: 'A1',
      subject: 'o',
      why: 'w',
      ask: { kind: 'open-question' },
      raisedBySession: 'mxk2aa11-0001ffff',
    });
    r.dispatch
      .on(call => (call.path === '/v1/sessions' ? ok([view('running')]) : undefined))
      .on(call => {
        if (call.path !== '/v1/agenda/open') return undefined;
        const after = call.query?.after;
        return after === undefined
          ? ok({ sessions: [{ sessionId: 'mxk2aa11-0001ffff', items: [other] }], next: 'page-2' })
          : ok({ sessions: [{ sessionId: 'mwuanehg-4531fa9e', items: [target] }] });
      })
      .on(call => (call.method === 'POST' ? ok(snapshot('mwuanehg-4531fa9e')) : undefined));
    const reply = await tool(r, 'answer_attention', { item: 'A7', answer: 'yes please' });
    should(reply.isError).be.false();
    const pages = r.dispatch.calls.filter(c => c.call.path === '/v1/agenda/open');
    should(pages.length).equal(2);
    should(pages[1]?.call.query).eql({ after: 'page-2' });
  });

  it('answers an item on the machine board through the machine route', async () => {
    const r = rig();
    const target = agendaItem({ id: 'A3', subject: 's', why: 'w', ask: { kind: 'open-question' } });
    r.dispatch
      .on(call => (call.path === '/v1/sessions' ? ok([view('running')]) : undefined))
      .on(call =>
        call.path === '/v1/agenda/open'
          ? ok({ sessions: [{ sessionId: 'machine-agenda', items: [target] }] })
          : undefined,
      )
      .on(call => (call.method === 'POST' ? ok(snapshot('machine-agenda')) : undefined));
    should((await tool(r, 'answer_attention', { item: 'A3', answer: 'ok then' })).isError).be.false();
    should(r.dispatch.calls.find(c => c.call.method === 'POST')?.call.path).equal('/v1/machine/agenda');
  });
});

describe('shapeAnswer — what cannot be answered by voice', () => {
  const item = (fields: Record<string, unknown>): AgendaItem => fields as unknown as AgendaItem;

  it('refuses an item that asks for a typed-in value', () => {
    const shaped = shapeAnswer(item({ kind: 'input' }), 'hunter2');
    should(shaped.kind).equal('refuse');
    if (shaped.kind === 'refuse') should(shaped.sentence).containEql('can only be typed in the Ferretry app');
  });

  it('refuses a card review gate', () => {
    const shaped = shapeAnswer(item({ gate: { cardId: 'c1' }, ask: { kind: 'task' } }), 'approve');
    should(shaped.kind).equal('refuse');
    if (shaped.kind === 'refuse') should(shaped.sentence).containEql('card review');
  });

  it('refuses a permission answer that is neither a yes nor a no', () => {
    const shaped = shapeAnswer(item({ ask: { kind: 'permission' } }), 'maybe later');
    should(shaped).eql({ kind: 'refuse', sentence: 'That is a permission request. Say approve or reject.' });
  });

  it('only marks a task ask or an item with no ask as done', () => {
    should(shapeAnswer(item({ ask: { kind: 'task' } }), 'did it')).eql({ kind: 'done' });
    should(shapeAnswer(item({}), 'did it')).eql({ kind: 'done' });
  });
});

describe('ConnectorToolbox — a tool that fails in ways its author did not plan for', () => {
  const access: ConnectorAccess = WRITE_ACCESS;
  const spec = (run: ConnectorToolSpec['run']): ConnectorToolSpec => ({
    name: 'stop_ferret',
    title: 't',
    description: 'd',
    scope: 'fleet:write',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    input: {},
    run,
  });
  const toolbox = (options: {
    grants?: () => typeof ALL_GRANTS | undefined;
    calls?: CallsSpy;
    audit?: { record: AuditSpy['record'] };
  }) =>
    new ConnectorToolbox({
      daemonGrants: options.grants ?? (() => ALL_GRANTS),
      guard: new ConnectorTextGuard({ redact: async value => value }),
      callsLog: options.calls ?? new CallsSpy(),
      audit: options.audit ?? new AuditSpy(),
      now: () => NOW,
    });
  const gateway = {} as FleetGateway;

  it('treats a grants source that throws as grants it cannot determine, and refuses', async () => {
    let ran = false;
    const calls = new CallsSpy();
    const result = await toolbox({
      calls,
      grants: () => {
        throw new Error('config unreadable');
      },
    }).execute(
      spec(async () => {
        ran = true;
        return { text: 'done' };
      }),
      {},
      access,
      gateway,
    );
    should(result.isError).be.true();
    should(ran).be.false();
    should(calls.records[0]?.outcome).equal('refused');
  });

  it('says only that something went wrong when a tool throws something that is not its own refusal', async () => {
    const calls = new CallsSpy();
    const result = await toolbox({ calls }).execute(
      spec(async () => {
        throw new TypeError('secret internal detail');
      }),
      {},
      access,
      gateway,
    );
    should(result).eql({ text: 'Something went wrong on the machine, so I did not do that.', isError: true });
    should(calls.records[0]?.outcome).equal('error');
  });

  it('still answers when the calls log or the security log cannot be written', async () => {
    const audit = {
      record: async () => {
        throw new Error('disk full');
      },
    };
    const calls = new CallsSpy();
    calls.append = async () => {
      throw new Error('disk full');
    };
    const result = await toolbox({ calls, audit }).execute(
      spec(async () => ({ text: 'Stopped.' })),
      {},
      access,
      gateway,
    );
    should(result).eql({ text: 'Stopped.', isError: false });
  });
});
