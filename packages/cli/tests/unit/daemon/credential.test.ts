import { describe, it } from 'bun:test';
import { DAEMON_FEATURES } from '@ferretry/protocol';
import should from 'should';
import {
  credentialPlan,
  mayFallBackAfterRefusal,
  paneCredential,
  paneCredentialValue,
  paneCredentialWarnings,
  presentsSessionBearer,
} from '../../../src/lib/daemon/credential.ts';

const BEARER = 'fys_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OFFERS = { pid: 41, features: [DAEMON_FEATURES.sessionCredential] };
const OLDER = { pid: 41, features: [] };

describe("a ferret's own credential, as its pane carries it", () => {
  it('should read the documented name before the older one', () => {
    // Arrange — a hand-built environment where the two disagree; the daemon always writes one value.
    const environment = { FY_SESSION_TOKEN: BEARER, FY_SESSION_BOARD_CAPABILITY: 'fys_other' };

    // Act + Assert
    should(paneCredential(environment)).deepEqual({ kind: 'bearer', value: BEARER });
  });

  it('should still find it under the older name alone', () => {
    should(paneCredential({ FY_SESSION_BOARD_CAPABILITY: ` ${BEARER} ` })).deepEqual({ kind: 'bearer', value: BEARER });
  });

  it('should call an unprefixed value legacy, so it is never offered as a bearer', () => {
    // Arrange — a pane started before RF-1 minted the `fys_` prefix.
    const environment = { FY_SESSION_BOARD_CAPABILITY: 'k3y-from-before-the-prefix' };

    // Act + Assert
    should(paneCredential(environment)).deepEqual({ kind: 'legacy', value: 'k3y-from-before-the-prefix' });
    should(paneCredentialValue(environment)).equal('k3y-from-before-the-prefix');
  });

  it('should treat a blank value as no credential at all', () => {
    should(paneCredential({ FY_SESSION_TOKEN: '  ', FY_SESSION_BOARD_CAPABILITY: '' })).deepEqual({ kind: 'none' });
    should(paneCredentialValue({})).be.undefined();
  });
});

describe('which credential an invocation presents', () => {
  it('should keep FY_TOKEN as the explicit override, even inside a ferret', () => {
    should(credentialPlan({ FY_TOKEN: ' script ', FY_SESSION_TOKEN: BEARER }, { asOwner: false })).deepEqual({
      kind: 'explicit',
      token: 'script',
    });
  });

  it("should present the ferret's own bearer whenever its pane has one, with or without FY_SESSION_ID", () => {
    // leylani's rule (b): a ferret that runs `fy` without its session id must not become the owner.
    should(credentialPlan({ FY_SESSION_TOKEN: BEARER }, { asOwner: false })).deepEqual({
      kind: 'session',
      bearer: BEARER,
    });
    should(credentialPlan({ FY_SESSION_TOKEN: BEARER, FY_SESSION_ID: 'mvx-1' }, { asOwner: false })).deepEqual({
      kind: 'session',
      bearer: BEARER,
    });
  });

  it('should call --as-owner at a plain shell what it is: no ferret credential to set aside', () => {
    should(credentialPlan({}, { asOwner: true })).deepEqual({ kind: 'admin', why: 'no-session' });
  });

  it('should skip the ferret credential for --as-owner', () => {
    should(credentialPlan({ FY_SESSION_TOKEN: BEARER }, { asOwner: true })).deepEqual({
      kind: 'admin',
      why: 'as-owner',
    });
  });

  it('should use the admin token for a pane from before the prefix, and at a plain shell', () => {
    should(credentialPlan({ FY_SESSION_BOARD_CAPABILITY: 'unprefixed' }, { asOwner: false })).deepEqual({
      kind: 'admin',
      why: 'legacy-session',
    });
    should(credentialPlan({}, { asOwner: false })).deepEqual({ kind: 'admin', why: 'no-session' });
  });
});

describe('when a daemon is answered with the bearer, and the one way off it', () => {
  it('should decide from the advertised feature alone', () => {
    should(presentsSessionBearer(OFFERS)).be.true();
    should(presentsSessionBearer(OLDER)).be.false();
  });

  it('should never fall back while the daemon still offers the credential, whatever it answered', () => {
    for (const status of [401, 403, 404, 500, 503]) should(mayFallBackAfterRefusal(status, OFFERS)).be.false();
  });

  it('should fall back only on a 401 from a daemon that no longer offers it', () => {
    should(mayFallBackAfterRefusal(401, OLDER)).be.true();
    should(mayFallBackAfterRefusal(403, OLDER)).be.false();
    should(mayFallBackAfterRefusal(404, OLDER)).be.false();
  });
});

describe('what fy doctor says about a pane’s credential', () => {
  it('should say nothing at a person’s own shell, FY_TOKEN or not', () => {
    should(paneCredentialWarnings({ FY_TOKEN: 'script' })).be.empty();
    should(paneCredentialWarnings({})).be.empty();
  });

  it('should say nothing for a ferret that presents its own credential', () => {
    should(paneCredentialWarnings({ FY_SESSION_ID: 'mvx-1', FY_SESSION_TOKEN: BEARER })).be.empty();
  });

  it('should warn when FY_TOKEN is set inside a pane, by its credential or its session id alone', () => {
    should(paneCredentialWarnings({ FY_SESSION_TOKEN: BEARER, FY_TOKEN: 'leaked-in' })).have.length(1);
    should(paneCredentialWarnings({ FY_SESSION_ID: 'mvx-1', FY_TOKEN: 'leaked-in' })[0]).match(/FY_TOKEN is set/u);
  });

  it('should tell a pane from before the prefix to restart', () => {
    should(paneCredentialWarnings({ FY_SESSION_BOARD_CAPABILITY: 'unprefixed' })[0]).match(/fy restart/u);
  });
});
