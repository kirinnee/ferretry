import { describe, it } from 'bun:test';
import should from 'should';
import { credentialPlan, inPane, ownFerretId, paneCredential, paneCredentialWarnings } from '../../src/lib/credential.ts';

describe('credentialPlan', () => {
  it('P90 FY_TOKEN wins outright, over a ferret’s own credential', () => {
    const plan = credentialPlan({ FY_TOKEN: ' owner ', FY_SESSION_TOKEN: 'fys_abc' }, { asOwner: false });
    should(plan).deepEqual({ kind: 'explicit', token: 'owner' });
  });

  it('S52 a ferret presents its own fys_ credential, read from the documented name first', () => {
    should(paneCredential({ FY_SESSION_TOKEN: 'fys_first', FY_SESSION_BOARD_CAPABILITY: 'fys_second' })).equal('fys_first');
    should(paneCredential({ FY_SESSION_BOARD_CAPABILITY: 'fys_second' })).equal('fys_second');
    should(credentialPlan({ FY_SESSION_TOKEN: 'fys_first' }, { asOwner: false })).deepEqual({ kind: 'ferret', bearer: 'fys_first' });
  });

  it('S53 the choice is made from the credential alone: a ferret without FY_SESSION_ID is still on its own bearer, never the admin token', () => {
    const plan = credentialPlan({ FY_SESSION_TOKEN: 'fys_abc' }, { asOwner: false });
    should(plan.kind).equal('ferret');
    should(ownFerretId({ FY_SESSION_TOKEN: 'fys_abc' })).be.undefined();
  });

  it('S53 an unprefixed pane value is not a credential at all (no older spelling is read)', () => {
    should(paneCredential({ FY_SESSION_TOKEN: 'abc' })).be.undefined();
    should(credentialPlan({ FY_SESSION_TOKEN: 'abc' }, { asOwner: false })).deepEqual({ kind: 'admin', why: 'person' });
  });

  it('S58 --as-owner sets the ferret’s credential aside and says so through its reason', () => {
    should(credentialPlan({ FY_SESSION_TOKEN: 'fys_abc' }, { asOwner: true })).deepEqual({ kind: 'admin', why: 'as-owner' });
    should(credentialPlan({}, { asOwner: true })).deepEqual({ kind: 'admin', why: 'person' });
  });

  it('should treat a blank value as absent, never as an empty credential', () => {
    should(paneCredential({ FY_SESSION_TOKEN: '   ' })).be.undefined();
    should(credentialPlan({ FY_TOKEN: '  ' }, { asOwner: false })).deepEqual({ kind: 'admin', why: 'person' });
  });
});

describe('paneCredentialWarnings', () => {
  it('S60 should warn in a pane when FY_TOKEN is set, because it silently puts that ferret on the admin token', () => {
    const warnings = paneCredentialWarnings({ FY_SESSION_ID: 's1', FY_TOKEN: 'owner' });
    should(warnings.length).equal(1);
    should(warnings[0]).containEql('FY_TOKEN is set in this ferret’s environment');
  });

  it('S60 should say nothing outside a pane, and nothing about a credential from before the prefix (none exist)', () => {
    should(paneCredentialWarnings({ FY_TOKEN: 'owner' })).deepEqual([]);
    should(paneCredentialWarnings({ FY_SESSION_ID: 's1', FY_SESSION_TOKEN: 'abc' })).deepEqual([]);
  });

  it('should know a pane by its id or by its credential', () => {
    should(inPane({ FY_SESSION_ID: 's1' })).be.true();
    should(inPane({ FY_SESSION_TOKEN: 'fys_x' })).be.true();
    should(inPane({})).be.false();
  });
});
