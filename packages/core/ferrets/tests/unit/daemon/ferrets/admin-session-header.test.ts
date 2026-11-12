import { expect, test } from 'bun:test';
import { ferretActor } from '@ferretry/core-gate/contract';
import { ferretStanding, ownerStanding, wardenStanding } from '@ferretry/core-gate/contract/testing';
import type { ApiRequest, CallContext, CallStanding } from '@ferretry/kernel/contract';
import type { FerretId } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner, ferretId } from '../../../../contract/testing/index.ts';
import { callerFerret } from '../../../../daemon/index.ts';
import { as, host, record } from './route-fixture.ts';

/**
 * G12: the admin token with `x-ferretry-session-id` naming a ferret IS that ferret to the daemon (today's
 * `agentSessionOf`), so a start through it is that ferret's helper and may name no other parent. The header is read by
 * Gate, which stamps the call's actor; a plain admin token (no header) is the owner.
 */

const viaHeader = 'x-test-admin-as';
/** The owner's admin token; with the header, the actor Gate gives a call that names a ferret. */
const standing = (request: ApiRequest): CallStanding => {
  const token = request.headers.get('x-test-caller');
  if (token?.startsWith('ferret:') === true) return ferretStanding(token.slice(7) as FerretId);
  const named = request.headers.get(viaHeader);
  if (named === undefined) return ownerStanding();
  const actor = ferretActor(named);
  const owner = ownerStanding();
  return {
    ...owner,
    actor,
    presentation: { ...owner.presentation, local: true, adminToken: true, stepUp: false, actor },
  };
};
const adminAs = (ferret: string) => ({ headers: { [viaHeader]: ferret } });

const start = async (h: Awaited<ReturnType<typeof host>>, init: object, body: object) =>
  await h.request('POST', '/v1/ferrets', { ...init, body } as never);

const call = (standingOf: CallStanding): CallContext => standingOf as unknown as CallContext;

test('G12 the ferret behind a call: its own token, or the admin token naming it; a plain admin token and the Warden name none', () => {
  const owner = ownerStanding();
  const named = { ...owner, actor: ferretActor('lead') };
  expect(callerFerret(call(named))).toBe(ferretId('lead'));
  expect(callerFerret(call(owner))).toBeUndefined();
  expect(callerFerret(call(wardenStanding(ferretId('w1'))))).toBeUndefined();
});

test('G12 admin token + header naming ferret F starting a child is F’s helper: a helper start is not the owner’s', async () => {
  const h = await host([record('lead')], { harness: new FakeHarness(), runner: new FakeRunner(), standing });
  // An agent's start passes the kernel's state-home fence (a project folder), then waits on Packs' admission as a
  // helper (the same answer a ferret's own token gets), for the parent left out and for the caller's own id alike —
  // never the owner's path.
  for (const [n, body] of [{ folder: '/work/b' }, { folder: '/work/b', parent: 'lead' }].entries()) {
    const answer = await start(
      h,
      { headers: { ...adminAs('lead').headers, 'x-fy-request-id': `admin-${String(n)}` } },
      body,
    );
    expect(answer.status).toBe(503);
    expect(answer.json<{ code: string }>().code).toBe('helper_admission_unavailable');
  }
});

test('G12 admin token + header naming ferret F naming another parent is refused parent_mismatch', async () => {
  const h = await host([record('lead'), record('other')], {
    harness: new FakeHarness(),
    runner: new FakeRunner(),
    standing,
  });
  for (const parent of ['other', 'ghost']) {
    const answer = await start(h, adminAs('lead'), { folder: '/work/c', parent });
    expect(answer.status).toBe(403);
    expect(answer.json<{ code: string }>().code).toBe('parent_mismatch');
  }
  // The ferret's own token is answered the same.
  const own = await start(h, as('lead'), { folder: '/work/c', parent: 'other' });
  expect(own.json<{ code: string }>().code).toBe('parent_mismatch');
});

test('G12 a plain admin token (no header) is the owner: it may name any parent, and an unknown one is not found', async () => {
  const h = await host([record('lead'), record('other')], {
    harness: new FakeHarness(),
    runner: new FakeRunner(),
    standing,
  });
  const missing = await start(h, {}, { folder: '/work/e', parent: 'ghost' });
  expect(missing.status).toBe(404);
  expect(missing.json<{ code: string }>().code).toBe('unknown_parent');
  const other = await start(h, {}, { folder: '/work/d', parent: 'other' });
  expect(other.json<{ code: string }>().code).not.toBe('parent_mismatch');
});
