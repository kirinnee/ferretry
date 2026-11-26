import { describe, it } from 'bun:test';
import type { AgendaItem } from '@ferretry/core-asks/contract';
import should from 'should';
import type { FleetGateway } from '../../../daemon/lib/mcp/gateway.ts';
import { ConnectorTextGuard } from '../../../daemon/lib/mcp/redaction.ts';
import { ConnectorToolbox } from '../../../daemon/lib/mcp/toolbox.ts';
import { type ConnectorToolSpec, shapeAnswer } from '../../../daemon/lib/mcp/tools/index.ts';
import type { ConnectorAccess } from '../../../daemon/lib/ports.ts';
import {
  agendaItem,
  AuditSpy,
  ferretView,
  NOW,
  ok,
  READ_ACCESS,
  refuse,
  snapshot,
  text,
  WRITE_ACCESS,
} from '../../support/mcp-fixtures.ts';
import { ALL_GRANTS, CallsSpy, rig, tool } from '../../support/mcp-harness.ts';
import { ferretsRoute } from '../../support/mcp-tools-routes.ts';

const view = (state: 'starting' | 'working' | 'idle' | 'stopped', extra: Record<string, unknown> = {}) =>
  ferretView({ id: 'mwuanehg-4531fa9e', callsign: 'lizzette', task: 'Build the thing', state, extra });

const askingAbout = async (state: Parameters<typeof view>[0], extra: Record<string, unknown> = {}): Promise<string> => {
  const r = rig();
  r.delegate.on(ferretsRoute([view(state, extra)]));
  const reply = await tool(r, 'get_ferret', { ferret: 'lizzette' });
  should(reply.isError).be.false();
  return reply.text;
};

describe('get_ferret — how a state is said aloud', () => {
  // 5.0 has four states (v4's rate_limited, retrying, awaiting_*, kill_failed, thinking, tool_running, interrupted are gone).
  it('says each ferret state in plain words', async () => {
    const said: [Parameters<typeof view>[0], string][] = [
      ['starting', 'starting'],
      ['working', 'working'],
      ['idle', 'idle, waiting for a message'],
      ['stopped', 'stopped'],
    ];
    for (const [state, words] of said) should(await askingAbout(state)).containEql(`State: ${words}.`);
  });

  it('puts a declared wait before everything else', async () => {
    const reply = await askingAbout('working', { waiting: { since: '2026-11-24T11:00:00.000Z' } });
    should(reply).containEql('State: parked, waiting on something it declared.');
  });

  // 5.0: no activity / needsHuman / contextPercent / reason lines; it says the card, the wait, the cause and the limit notice.
  it('says its card, what it waits for, and how it ended', async () => {
    const reply = await askingAbout('stopped', {
      task: 'F40',
      waiting: { since: '2026-11-24T11:00:00.000Z', condition: 'the staging password' },
      cause: { kind: 'agent_crashed', exitCode: 2 },
    });
    should(reply).containEql('Task: &F40.');
    should(reply).containEql('Waiting for: the staging password.');
    should(reply).containEql('Ended: its agent crashed.');
    for (const gone of ['Doing:', 'Needs a person:', 'Context ']) should(reply).not.containEql(gone);
  });

  it("says the harness's own limit notice as its last problem, and nothing for a bare stop", async () => {
    const limited = await askingAbout('working', { quota: { limitNotice: 'You hit your five hour limit' } });
    should(limited).containEql('Last problem: You hit your five hour limit.');
    // v4 fell back to the bare status ("Last problem: stalled."); 5.0 says no problem it was not told of.
    should(await askingAbout('stopped')).not.containEql('Last problem');
    should(await askingAbout('stopped', { cause: { kind: 'completed' } })).containEql('Ended: it said it was done.');
  });
});

describe('restart_ferret — a ferret the daemon left alone', () => {
  it('says why in plain words', async () => {
    const r = rig();
    r.delegate
      .on(ferretsRoute([view('working')]))
      .on(call =>
        call.path === '/v1/restarts'
          ? ok({ restarted: [], queued: [], failed: [], skipped: [{ id: 'mwuanehg-4531fa9e', reason: 'not-running' }] })
          : undefined,
      );
    should((await tool(r, 'restart_ferret', { ferret: 'lizzette' })).text).equal(
      'Lizzette is stopped, so there is nothing to restart. To bring it back, send it a message with send_to_ferret and it will wake up for it.',
    );
    const bare = rig();
    bare.delegate
      .on(ferretsRoute([view('working')]))
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
    r.delegate.on(call =>
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
    should(r.delegate.calls.some(c => c.call.method === 'POST')).be.false();
  });
});

describe('what the daemon says back', () => {
  const failing = async (answer: { status: number; body: string }): Promise<string> => {
    const r = rig();
    r.delegate.on(() => ({ ...answer, headers: new Map() }));
    const reply = await tool(r, 'list_ferrets', {});
    should(reply.isError).be.true();
    return reply.text;
  };

  it('says it could not be reached when the in-process call throws', async () => {
    const r = rig();
    r.delegate.on(() => {
      throw new Error('boom');
    });
    const reply = await tool(r, 'list_ferrets', {});
    should(reply.isError).be.true();
    should(reply.text).equal('The daemon could not be reached just now.');
  });

  it('says it could not read an answer that is not JSON', async () => {
    const r = rig();
    r.delegate.on(() => text('<html>not json</html>'));
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
    r.delegate
      .on(ferretsRoute([view('working')]))
      .on(call => {
        if (call.path !== '/v1/agenda/open') return undefined;
        const after = call.query?.get('after')?.[0];
        return after === undefined
          ? ok({ sessions: [{ sessionId: 'mxk2aa11-0001ffff', items: [other] }], next: 'page-2' })
          : ok({ sessions: [{ sessionId: 'mwuanehg-4531fa9e', items: [target] }] });
      })
      .on(call => (call.method === 'POST' ? ok(snapshot('mwuanehg-4531fa9e')) : undefined));
    const reply = await tool(r, 'answer_attention', { item: 'A7', answer: 'yes please' });
    should(reply.isError).be.false();
    const pages = r.delegate.calls.filter(c => c.call.path === '/v1/agenda/open');
    should(pages.length).equal(2);
    should(pages[1]?.call.query?.get('after')).eql(['page-2']);
  });

  it('answers an item on the machine board through the machine route, sending only the resolve', async () => {
    const r = rig();
    // A note (no ask) is what the machine ledger holds; its answer rides as the resolve's note.
    const target = agendaItem({ id: 'A3', subject: 's', why: 'w' });
    r.delegate
      .on(ferretsRoute([view('working')]))
      .on(call =>
        call.path === '/v1/agenda/open'
          ? ok({ sessions: [{ sessionId: 'machine-agenda', items: [target] }] })
          : undefined,
      )
      .on(call => (call.method === 'POST' ? ok(snapshot('machine-agenda')) : undefined));
    should((await tool(r, 'answer_attention', { item: 'A3', answer: 'ok then' })).isError).be.false();
    const sent = r.delegate.calls.find(c => c.call.method === 'POST')?.call;
    should(sent?.path).equal('/v1/machine/agenda');
    should(sent?.body).eql({ action: 'resolve', id: 'A3', note: 'ok then' });
  });
});

describe('shapeAnswer — what cannot be answered by voice', () => {
  const item = (fields: Record<string, unknown>): AgendaItem => fields as unknown as AgendaItem;

  it('refuses an item that asks for a typed-in value', () => {
    const shaped = shapeAnswer(item({ kind: 'input' }), 'hunter2');
    should(shaped.kind).equal('refuse');
    if (shaped.kind === 'refuse') should(shaped.sentence).containEql('can only be typed in the Ferretry app');
  });

  // 5.0: a card's task ask rides `cardAsks` (v4 had a top-level `gate`).
  it('refuses a card review gate', () => {
    const shaped = shapeAnswer(item({ cardAsks: [{ cardId: 'c1' }], ask: { kind: 'task' } }), 'approve');
    should(shaped.kind).equal('refuse');
    if (shaped.kind === 'refuse') should(shaped.sentence).containEql('passkey in the Ferretry app');
  });

  it('refuses a permission answer that is neither a yes nor a no', () => {
    const shaped = shapeAnswer(item({ ask: { kind: 'permission' } }), 'maybe later');
    should(shaped).eql({
      kind: 'refuse',
      sentence: 'That is a permission request. Say approve or reject.',
      refused: false,
    });
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
      guard: new ConnectorTextGuard(async value => value),
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

describe('ConnectorToolbox — a connection approved to look and not to change', () => {
  it('refuses a write tool before it runs, and records the refusal', async () => {
    let ran = false;
    const calls = new CallsSpy();
    const audit = new AuditSpy();
    const toolbox = new ConnectorToolbox({
      daemonGrants: () => ALL_GRANTS,
      guard: new ConnectorTextGuard(async value => value),
      callsLog: calls,
      audit,
      now: () => NOW,
    });
    const write: ConnectorToolSpec = {
      name: 'stop_ferret',
      title: 't',
      description: 'd',
      scope: 'fleet:write',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      input: {},
      run: async () => {
        ran = true;
        return { text: 'Stopped.' };
      },
    };
    const result = await toolbox.execute(write, {}, READ_ACCESS, {} as FleetGateway);
    should(result.isError).be.true();
    should(result.text).containEql('only look');
    should(ran).be.false();
    should(calls.records.map(record => record.outcome)).eql(['refused']);
    should(audit.events).eql([]);
  });
});
