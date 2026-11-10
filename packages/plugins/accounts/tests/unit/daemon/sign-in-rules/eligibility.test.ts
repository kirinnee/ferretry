import { describe, it } from 'bun:test';
import should from 'should';
import { ineligibleBecause, tappedCount, tappedIdentities } from '../../../../daemon/lib/sign-in-rules/index.ts';
import { signIn, tappedFact } from './support.ts';

/**
 * WHO MAY HAVE A RULE AT ALL (r3c-plan §6, invariants 13, 14, 24): history counts only the owner's own tapped facts at
 * the sign-in's own places. That the observer writes `tapped` for a `device` fill alone is the Vault's (its tests).
 */
describe('who may have a rule at all', () => {
  it('should read history only at the sign-in’s own domains, masked and moved on', () => {
    should(tappedIdentities(signIn({ observed: [tappedFact('gitlab.com')] }))).eql([]);
    should(tappedIdentities(signIn({ observed: [tappedFact('github.com', 1)] }))).eql([]);
    should(
      tappedIdentities(
        signIn({ observed: [{ ...tappedFact('github.com'), masked: { value: false, observedAt: '', count: 2 } }] }),
      ),
    ).eql([]);
    should(tappedIdentities(signIn())).eql(['0123456789abcdef']);
  });

  it('S114 should count a sign-in as the owner’s own only from a tapped fact: a verified, masked or moved-on one is not', () => {
    const owner = tappedFact('github.com');
    // Without the `tapped` fact (a plan fill, a rule fill or an admin-token delivery writes none) nothing qualifies.
    const others = { ...owner, tapped: undefined };
    should(tappedIdentities(signIn({ observed: [others] }))).eql([]);
    should(tappedCount(signIn({ observed: [others] }))).equal(0);
    should(
      tappedIdentities(signIn({ observed: [{ ...owner, tapped: { ...owner.tapped, value: false } }] } as never)),
    ).eql([]);
    // A terminal fact counts only with the owner's tap: the proof is the gate, not a page move.
    const terminalFact = { ...owner, at: 'sudo@kirin-box', surface: 'terminal', navigatedAway: undefined };
    const place = { kind: 'terminal', tool: 'sudo', host: 'kirin-box' };
    should(tappedIdentities(signIn({ place, observed: [terminalFact] } as never))).have.length(1);
    should(tappedIdentities(signIn({ place, observed: [{ ...terminalFact, tapped: undefined }] } as never))).eql([]);
  });

  it('should count the owner’s own hand sign-ins at the sign-in’s own places, the most of them, and none otherwise', () => {
    should(
      tappedCount(signIn({ observed: [tappedFact('github.com', 5), tappedFact('github.com', 3, 'other')] })),
    ).equal(5);
    should(tappedCount(signIn({ observed: [tappedFact('gitlab.com', 9)] }))).equal(0);
    should(tappedCount(signIn({ observed: [tappedFact('github.com', 1)] }))).equal(0);
    should(tappedCount(signIn({ observed: undefined }))).equal(0);
    should(tappedCount(signIn({ observed: [tappedFact('github.com', 2_000_000)] }))).equal(1_000_000);
  });

  it('should refuse a terminal sign-in for any program but sudo, su or doas, a provider one and one with no password', () => {
    for (const place of [
      { kind: 'terminal', tool: 'ssh', host: 'kirin-box', dest: 'prod.example.com' },
      { kind: 'terminal', tool: 'npm', host: 'kirin-box' },
      { kind: 'terminal', tool: 'passwd', host: 'kirin-box' },
    ])
      should(
        ineligibleBecause(
          signIn({ place, observed: [{ ...tappedFact(`${place.tool}@kirin-box`), surface: 'terminal' }] } as never),
        ),
      ).equal('tool-not-covered');
    // sudo with the owner's tapped history can have one: what was refused before !A197.
    should(
      ineligibleBecause(
        signIn({
          place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' },
          observed: [{ ...tappedFact('sudo@kirin-box'), surface: 'terminal', navigatedAway: undefined }],
        } as never),
      ),
    ).be.undefined();
    should(ineligibleBecause(signIn({ method: { kind: 'google', via: 'GOOGLE' } } as never))).equal('via-provider');
    should(ineligibleBecause(signIn({ method: { kind: 'passkey' } } as never))).equal('not-password');
  });
});
