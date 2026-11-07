import { describe, it } from 'bun:test';
import { deviceStanding, ferretStanding, ownerStanding, wardenStanding } from '@ferretry/core-gate/contract/testing';
import type { CallContext, FerretId, RevealGrant, TargetKind, TargetRef } from '@ferretry/kernel/contract';
import should from 'should';
import { InputHoldsOverService } from '../../../../daemon/adapters/inputs/holds.ts';
import type { InputAuditEntry } from '../../../../daemon/lib/inputs/ports.ts';
import { QuarantineRegistry } from '../../../../daemon/lib/inputs/quarantine.ts';
import { grantTerminalReveal, REVEAL_GRANT_MS, RevealGrants } from '../../../../daemon/lib/inputs/reveals.ts';
import { inputRequestService, SESSION } from './support.ts';

/**
 * "Show anyway" as `VaultApi.grantTerminalReveal` serves it (I72, I77, I83): the owner gate, the audit record and the
 * mint, run against the real input service and the real holds, so a grant is proved by what `decide` answers.
 */

const FERRET = SESSION as FerretId;
const DEV: TargetRef = { kind: 'terminal' as TargetKind, key: 'dev' };
const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const noCards = {
  openSessions: () => [],
  pendingOn: () => undefined,
  pageHeld: () => undefined,
  pageDocument: async () => undefined,
};

const callOf = (standing: object): CallContext =>
  ({
    request: { method: 'GET', path: '/', query: new Map(), headers: new Map(), arrival: { kind: 'remote' } },
    params: new Map(),
    ...standing,
  }) as unknown as CallContext;

function world(options: { readonly auditFails?: boolean; readonly locked?: boolean } = {}) {
  let now = NOW;
  const clock = { now: () => now };
  const audits: InputAuditEntry[] = [];
  const { service } = inputRequestService({
    audit: {
      record: async entry => {
        if (options.auditFails === true) throw new Error('the security log cannot be written');
        audits.push(entry);
      },
      saved: async () => undefined,
      stored: async () => undefined,
    },
  });
  const quarantine = new QuarantineRegistry(clock);
  quarantine.begin(SESSION, ['dev'], 'host');
  // The replay lock holds every terminal until it is lifted, whatever the time: a hold that outlives any reveal.
  if (options.locked === true) quarantine.lock();
  const grants = new RevealGrants(() => now);
  const holds = new InputHoldsOverService(noCards, quarantine, () => now, undefined, grants);
  const grant = async (standing: object, key = 'dev') =>
    await grantTerminalReveal(service, grants, FERRET, key, callOf(standing));
  return {
    audits,
    grants,
    holds,
    grant,
    pass: (ms: number) => {
      now += ms;
    },
  };
}

const minted = (result: Awaited<ReturnType<ReturnType<typeof world>['grant']>>): RevealGrant => {
  if (!result.ok) throw new Error(`expected a grant, got ${result.error.refused}`);
  return result.value;
};

describe('VaultApi.grantTerminalReveal ("Show anyway")', () => {
  it('I77 should give the owner a recorded reveal the holds honour for the owner’s viewer on that terminal alone', async () => {
    for (const standing of [ownerStanding(), deviceStanding('phone')]) {
      const w = world();
      const grant = minted(await w.grant(standing));

      should(w.audits.map(entry => entry.event)).eql(['input.quarantine_revealed']);
      should(w.audits[0]?.sessionId).equal(SESSION);
      should(w.audits[0]?.detail).eql({ targetKind: 'terminal', sensitivity: 'secret', surface: 'dev' });
      should(w.holds.decide(DEV, 'stream', 'owner-viewer', grant)).equal('allow');
      should(w.holds.decide(DEV, 'stream', 'owner-viewer')).deepEqual({ refused: 'quarantined' });
      should(w.holds.decide(DEV, 'read', 'ferret', grant)).deepEqual({ refused: 'quarantined' });
      should(w.holds.decide(DEV, 'read', 'warden', grant)).deepEqual({ refused: 'quarantined' });
      const other = minted(await w.grant(standing, 'other'));
      should(w.holds.decide(DEV, 'stream', 'owner-viewer', other)).deepEqual({ refused: 'quarantined' });
    }
  });

  it('I77 should refuse a ferret, the warden and a call with no credential, recording nothing and minting nothing', async () => {
    for (const standing of [ferretStanding(FERRET), wardenStanding('warden-1' as FerretId), {}]) {
      const w = world();
      const result = await w.grant(standing);

      should(result.ok).be.false();
      if (!result.ok) should(result.error.refused).equal('owner_only');
      should(w.audits).be.empty();
    }
  });

  it('I83 should refuse a reveal the daemon cannot record, and mint nothing', async () => {
    const w = world({ auditFails: true });
    const result = await w.grant(ownerStanding());

    should(result.ok).be.false();
    if (!result.ok) {
      should(result.error.refused).equal('unrecorded');
      should(result.error.sentence).match(/could not record/u);
    }
    should(w.audits).be.empty();
  });

  it('I77 should keep a second connection that did not choose "Show anyway" behind the notice', async () => {
    const w = world();
    const first = minted(await w.grant(ownerStanding()));
    const second = minted(await w.grant(ownerStanding()));

    should(first).not.equal(second);
    should(w.audits.map(entry => entry.event)).eql(['input.quarantine_revealed', 'input.quarantine_revealed']);
    should(w.holds.decide(DEV, 'stream', 'owner-viewer', first)).equal('allow');
    // The other viewer connection holds no grant of its own: it is asked without one.
    should(w.holds.decide(DEV, 'stream', 'owner-viewer')).deepEqual({ refused: 'quarantined' });
  });

  it('I77 should honour no reveal this Vault did not mint: a cast shape, a copy, or another Vault’s', async () => {
    const w = world();
    const grant = minted(await w.grant(ownerStanding()));
    const forged = { target: DEV, until: new Date(NOW + 60_000).toISOString() } as unknown as RevealGrant;
    const copy = { ...grant } as RevealGrant;
    const foreign = new RevealGrants(() => NOW).mint('dev');

    should(Object.isFrozen(grant)).be.true();
    for (const reveal of [forged, copy, foreign])
      should(w.holds.decide(DEV, 'stream', 'owner-viewer', reveal)).deepEqual({ refused: 'quarantined' });
    should(w.holds.decide(DEV, 'stream', 'owner-viewer', grant)).equal('allow');
  });

  it('I77 should end a reveal when it runs out', async () => {
    const w = world({ locked: true });
    const grant = minted(await w.grant(ownerStanding()));

    w.pass(REVEAL_GRANT_MS - 1);
    should(w.holds.decide(DEV, 'stream', 'owner-viewer', grant)).equal('allow');
    w.pass(1);
    should(w.holds.decide(DEV, 'stream', 'owner-viewer', grant)).deepEqual({ refused: 'quarantined' });
  });

  it('I72 should leave the owner’s ordinary terminal tools refused under a reveal', async () => {
    const w = world();
    const grant = minted(await w.grant(ownerStanding()));

    for (const op of ['read', 'wait'] as const)
      should(w.holds.decide(DEV, op, 'owner-tools', grant)).deepEqual({ refused: 'quarantined' });
    should(w.holds.decide(DEV, 'keys', 'ferret')).equal('allow');
  });
});
