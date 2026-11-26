import { describe, it } from 'bun:test';
import { MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import { DELEGATE_ROUTES } from '@ferretry/kernel/contract';
import should from 'should';
import manifest from '../../../manifest.ts';
import { agendaItem, ferretView, ok, snapshot, text } from '../../support/mcp-fixtures.ts';
import { callTool, post, rig, tool } from '../../support/mcp-harness.ts';

/** What the connector may reach, and the one way it reaches it (docs/mcp-connector.md "What a tool may do"). */

const LIZ = ferretView({ id: 'mwuanehg-4531fa9e', callsign: 'lizzette', task: 'Build', state: 'working' });
const MACHINE = MACHINE_AGENDA_ID;

describe('the delegate fence', () => {
  it('names exactly the twelve routes the tools call, a subset of the kernel allow-list', () => {
    const declared = manifest.permissions?.delegate ?? [];
    should([...declared].sort()).eql([...DELEGATE_ROUTES].sort());
    should(declared.length).equal(12);
  });

  // These four routes read the caller's identity from the credential's token class and treat anything that is not a device or
  // the warden as the host or "local": a connector principal reaching them would be recorded as this computer (§3 S10).
  it('never reaches the pulls post route, the git-accounts routes, the terminals controller or the board lanes', () => {
    // A package's routes are not read from its manifest (a test reaches another package only through its contract): the
    // whole path families are refused, so a route added there later is refused too.
    for (const key of manifest.permissions?.delegate ?? [])
      for (const family of ['/v1/pulls', '/v1/git-accounts', '/v1/terminals', '/v1/board'])
        should(key.split(' ')[1]?.startsWith(family)).be.false();
  });

  it('declares no route that carries a passkey act or is a door', () => {
    for (const route of manifest.actions?.routes ?? []) {
      if (route.key.startsWith('POST /v1/connector') || route.key === 'PUT /v1/connector')
        should((manifest.permissions?.delegate as readonly string[] | undefined)?.includes(route.key)).not.be.true();
    }
  });
});

describe('what the tools send', () => {
  const everyCall = async () => {
    const r = rig();
    const item = agendaItem({
      id: 'A7',
      subject: 'Pick',
      why: 'Which?',
      ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
    });
    const machineItem = agendaItem({
      id: 'A8',
      subject: 'A notice',
      why: 'Read it',
      raisedBySession: MACHINE,
      extra: { notice: true },
    });
    r.delegate
      .on(call => (call.path === '/v1/ferrets' && call.method === 'GET' ? ok([LIZ]) : undefined))
      .on(call => (call.path === `/v1/ferrets/${LIZ.id}` && call.method === 'GET' ? ok(LIZ) : undefined))
      .on(call => (call.path.endsWith('/logs') ? text('a line') : undefined))
      .on(call =>
        call.path === '/v1/projects'
          ? ok([
              {
                id: '11111111-1111-4111-8111-111111111111',
                name: 'p',
                path: '/work/p',
                source: 'existing-folder',
                createdAt: '2026-11-01T00:00:00.000Z',
              },
            ])
          : undefined,
      )
      .on(call =>
        call.path === '/v1/agenda/open'
          ? ok({
              sessions: [
                { sessionId: LIZ.id, items: [item] },
                { sessionId: MACHINE, items: [machineItem] },
              ],
            })
          : undefined,
      )
      .on(call => (call.method === 'POST' && call.path.endsWith('/agenda') ? ok(snapshot(LIZ.id)) : undefined))
      .on(call => (call.path === '/v1/machine/agenda' && call.method === 'POST' ? ok(snapshot(MACHINE)) : undefined))
      .on(call => (call.path.endsWith('/send') ? ok({ ferret: LIZ.id, disposition: 'delivered' }) : undefined))
      .on(call => (call.path.endsWith('/stop') ? ok({ id: LIZ.id, state: 'stopped' }) : undefined))
      .on(call =>
        call.path === '/v1/restarts'
          ? ok({ restarted: [{ id: LIZ.id }], queued: [], skipped: [], failed: [] })
          : undefined,
      )
      .on(call => (call.method === 'POST' && call.path === '/v1/ferrets' ? ok({ id: LIZ.id }) : undefined));
    for (const [name, args] of [
      ['list_ferrets', {}],
      ['get_ferret', { ferret: 'lizzette' }],
      ['get_ferret_output', { ferret: 'lizzette' }],
      ['list_attention', { snoozed: true }],
      ['get_attention', { item: 'A7' }],
      ['send_to_ferret', { ferret: 'lizzette', message: 'hi' }],
      ['answer_attention', { item: 'A7', answer: 'yes' }],
      ['answer_attention', { item: 'A8', answer: 'read' }],
      ['snooze_attention', { item: 'A7', duration: '1h' }],
      ['snooze_attention', { item: 'A8', duration: '1h' }],
      ['restart_ferret', { ferret: 'lizzette' }],
      ['stop_ferret', { ferret: 'lizzette' }],
      ['spawn_ferret', { task: 'x' }],
    ] as const)
      await tool(r, name, args);
    return r;
  };

  it('uses only the declared keys, and as this grant', async () => {
    const r = await everyCall();
    const allowed = new Set<string>(manifest.permissions?.delegate ?? []);
    const templated = (path: string): string => path.replace(/^\/v1\/ferrets\/[^/]+/u, '/v1/ferrets/:ferretId');
    for (const { grant, call } of r.delegate.calls) {
      should(grant).equal('cg_aaaaaaaaaa');
      should(allowed.has(`${call.method} ${templated(call.path)}`)).be.true();
    }
  });

  it('sends only resolve and snooze to either agenda route (never dismiss, unsnooze, edit or add)', async () => {
    const r = await everyCall();
    const bodies = r.delegate.calls
      .filter(entry => entry.call.method === 'POST' && /\/agenda$/u.test(entry.call.path))
      .map(entry => entry.call.body as { action: string });
    should(bodies.length).equal(4);
    for (const body of bodies) should(['resolve', 'snooze']).containEql(body.action);
  });

  it('sends the machine ledger a bare resolve and a bare snooze, which are all its route accepts', async () => {
    const r = await everyCall();
    const machine = r.delegate.calls.filter(
      entry => entry.call.path === '/v1/machine/agenda' && entry.call.method === 'POST',
    );
    should(machine.map(entry => entry.call.body)).eql([
      { action: 'resolve', id: 'A8', note: 'read' },
      { action: 'snooze', id: 'A8', until: new Date(Date.parse('2026-11-24T12:00:00.000Z') + 3_600_000).toISOString() },
    ]);
  });

  it("never drops a decision on the machine's own list: a choice or permission there is refused, not sent as a bare resolve", async () => {
    const r = rig();
    const asks = agendaItem({
      id: 'A9',
      subject: 'Allow it?',
      why: 'The daemon asks',
      raisedBySession: MACHINE,
      ask: { kind: 'permission' },
    });
    r.delegate
      .on(call => (call.path === '/v1/ferrets' ? ok([LIZ]) : undefined))
      .on(call =>
        call.path === '/v1/agenda/open' ? ok({ sessions: [{ sessionId: MACHINE, items: [asks] }] }) : undefined,
      );
    const reply = await tool(r, 'answer_attention', { item: 'A9', answer: 'approve' });
    should(reply.isError).be.true();
    should(reply.text).equal("That one is on the machine's own list, and only the Ferretry app can answer it.");
    should(r.delegate.calls.some(entry => entry.call.method === 'POST')).be.false();
    should(r.calls.records[0]?.outcome).equal('refused');
  });

  it("lists an item that only the machine's own list holds (the roll-up leaves that list out), and refuses a decision on it", async () => {
    const r = rig();
    const only = agendaItem({
      id: 'A4',
      subject: 'Allow it?',
      why: 'The daemon asks',
      raisedBySession: MACHINE,
      ask: { kind: 'permission' },
    });
    r.delegate
      .on(call => (call.path === '/v1/ferrets' ? ok([LIZ]) : undefined))
      .on(call => (call.path === '/v1/agenda/open' ? ok({ sessions: [] }) : undefined))
      .on(call =>
        call.path === '/v1/machine/agenda' && call.method === 'GET'
          ? ok({ ...snapshot(MACHINE), items: [only], count: 1 })
          : undefined,
      );
    should((await tool(r, 'list_attention', {})).text).containEql('A4');
    const reply = await tool(r, 'answer_attention', { item: 'A4', answer: 'approve' });
    should(reply.isError).be.true();
    should(reply.text).containEql('only the Ferretry app can answer it');
    should(r.delegate.calls.some(entry => entry.call.method === 'POST')).be.false();
  });

  it('puts a request id on every send, start and restart and on nothing else', async () => {
    const r = await everyCall();
    const writes = r.delegate.calls.filter(
      ({ call }) =>
        call.method === 'POST' &&
        (call.path.endsWith('/send') || call.path === '/v1/restarts' || call.path === '/v1/ferrets'),
    );
    should(writes.length).equal(3);
    for (const { call } of writes) should(call.requestId).match(/^req-\d+$/u);
    for (const { call } of r.delegate.calls.filter(entry => !writes.includes(entry)))
      should(call.requestId).be.undefined();
  });

  it("answers a ferret name through an id the daemon listed, never a path built from the caller's words", async () => {
    const r = rig();
    r.delegate.on(call => (call.path === '/v1/ferrets' ? ok([LIZ]) : undefined));
    const hostile = await post(r.endpoint, callTool('stop_ferret', { ferret: '../../v1/restarts' }));
    should(hostile?.status).equal(200);
    for (const { call } of r.delegate.calls) should(call.path).equal('/v1/ferrets');
  });

  it("a daemon refusal of a step-up act or a person-only route reaches Claude as a refusal, in the daemon's own words", async () => {
    const r = rig();
    r.delegate
      .on(call => (call.path === '/v1/ferrets' ? ok([LIZ]) : undefined))
      .on(() => ({
        status: 403,
        headers: new Map(),
        body: JSON.stringify({ error: 'needs a passkey', code: 'grant_step_up_required' }),
      }));
    const reply = await tool(r, 'stop_ferret', { ferret: 'lizzette' });
    should(reply.isError).be.true();
    should(reply.text).equal('needs a passkey');
    should(r.calls.records[0]?.outcome).equal('refused');
  });
});
