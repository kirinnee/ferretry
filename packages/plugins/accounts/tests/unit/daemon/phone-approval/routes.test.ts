import { describe, it } from 'bun:test';
import { ferretStanding } from '@ferretry/core-gate/contract/testing';
import should from 'should';
import type { FerretId } from '@ferretry/kernel/contract';
import { accountless, phoneApprovalRoutes } from '../../../../daemon/lib/runtime/mounts/phone-approvals.ts';
import { allowedDevice, driverOf, machine, without } from '../mounts/driver.ts';
import { FERRET, OTHER_FERRET, phoneWorld } from './world.ts';

/** The owner's three phone-approval routes, driven the way the spine drives a route table. */

const ONE = '/v1/ferrets/:ferretId/phone-approvals/:approvalId';

async function world() {
  const built = await phoneWorld({ saved: true });
  return { ...built, call: driverOf(phoneApprovalRoutes(built.service)) };
}

const params = (id: string, ferretId = FERRET) => ({ ferretId, approvalId: id });

describe('G90 phone approvals omit account, username and via unless the caller has secrets.use', () => {
  it('G90 should strip the account, its username and the provider for a device without secrets.use, and keep where and how', async () => {
    const w = await world();
    const view = await w.raiseBrowser();

    const list = await w.call('GET', '/v1/phone-approvals', { standing: without(['secrets']) });
    const one = await w.call('GET', ONE, { params: params(view.id), standing: without(['secrets']) });
    const refused = await w.call('POST', `${ONE}/refuse`, { params: params(view.id), standing: without(['secrets']) });

    for (const answer of [one, refused]) {
      should(answer.status).equal(200);
      const approval = answer.body as Record<string, unknown>;
      for (const hidden of ['account', 'username', 'via']) should(approval).not.have.property(hidden);
      should(approval.origin).equal('https://company.okta.com');
      should(approval.surface).equal('browser');
    }
    const listed = (list.body as { approvals: Record<string, unknown>[] }).approvals;
    should(listed).have.length(1);
    should(listed[0]).not.have.property('account');
    should(listed[0]).not.have.property('username');
    should(JSON.stringify([list.body, one.body, refused.body])).not.match(/me@company\.test|Okta"/u);
  });

  it('G90 should name the account for the machine and for a device that holds secrets.use', async () => {
    const w = await world();
    const view = await w.raiseBrowser();

    const atMachine = await w.call('GET', ONE, { params: params(view.id), standing: machine() });
    const device = await w.call('GET', ONE, { params: params(view.id), standing: allowedDevice() });

    for (const answer of [atMachine, device]) {
      const approval = answer.body as { account?: { label: string }; username?: string };
      should(approval.account?.label).equal('Okta');
      should(approval.username).equal('me@company.test');
    }
  });

  it('G90 should strip only the three names and nothing the card needs', () => {
    const approval = {
      id: 'pa_000000000000000000000001',
      sessionId: FERRET,
      agentName: FERRET,
      surface: 'browser',
      origin: 'https://company.okta.com',
      account: { id: 'OKTA', label: 'Okta' },
      username: 'me@company.test',
      via: { id: 'GOOGLE', label: 'Google' },
      factor: { id: 'tfk_1', label: 'Okta Verify' },
      raisedAt: '2026-11-10T12:00:00.000Z',
      expiresAt: '2026-11-10T12:02:00.000Z',
      state: 'waiting',
    } as never;

    const bare = accountless(approval) as Record<string, unknown>;

    should(Object.keys(bare).sort()).eql(
      ['agentName', 'expiresAt', 'factor', 'id', 'origin', 'raisedAt', 'sessionId', 'state', 'surface'].sort(),
    );
  });
});

describe('the approval routes are the owner’s: a ferret is refused before anything is read', () => {
  it('should refuse a ferret’s credential on all three routes as owner only, and leave the approval waiting', async () => {
    const w = await world();
    const view = await w.raiseBrowser();
    const ferret = ferretStanding(FERRET as FerretId);

    for (const [method, path, extra] of [
      ['GET', '/v1/phone-approvals', {}],
      ['GET', ONE, { params: params(view.id) }],
      ['POST', `${ONE}/refuse`, { params: params(view.id) }],
    ] as const) {
      const answer = await w.call(method, path, { ...extra, standing: ferret });
      should(answer.status).equal(403);
      should(answer.code).equal('owner_only');
    }
    should(w.seen(view.id).state).equal('waiting');
  });

  it('should mount no route that approves an approval or sets moved-on: the owner’s only act is Not me', async () => {
    const w = await world();

    should(phoneApprovalRoutes(w.service).map(route => `${route.method} ${route.path}`)).eql([
      'GET /v1/phone-approvals',
      `GET ${ONE}`,
      `POST ${ONE}/refuse`,
    ]);
  });

  it('should read an approval only under the ferret that raised it, and refuse a made-up id before the service', async () => {
    const w = await world();
    const view = await w.raiseBrowser();

    const wrongFerret = await w.call('GET', ONE, { params: params(view.id, OTHER_FERRET), standing: machine() });
    const badId = await w.call('GET', ONE, { params: params('nope'), standing: machine() });
    const badFerret = await w.call('GET', ONE, { params: params(view.id, '../x'), standing: machine() });
    const missing = await w.call('POST', `${ONE}/refuse`, {
      params: params('pa_ffffffffffffffffffffffff'),
      standing: machine(),
    });

    should(wrongFerret.status).equal(404);
    should(badId.status).equal(400);
    should(badFerret.status).equal(400);
    should(missing.status).equal(404);
  });

  it('should refuse "Not me" once and leave a settled approval as it ended', async () => {
    const w = await world();
    const view = await w.raiseBrowser();

    const first = await w.call('POST', `${ONE}/refuse`, { params: params(view.id), standing: machine() });
    const again = await w.call('POST', `${ONE}/refuse`, { params: params(view.id), standing: machine() });
    const listed = await w.call('GET', '/v1/phone-approvals', { standing: machine() });

    should((first.body as { state: string }).state).equal('refused');
    should((again.body as { state: string }).state).equal('refused');
    should((listed.body as { approvals: unknown[] }).approvals).eql([]);
    should(w.audit.filter(entry => entry.event === 'phone-approval.refused')).have.length(1);
  });
});
