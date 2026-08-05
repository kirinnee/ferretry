import { describe, it } from 'bun:test';
import { DAEMON_CAPABILITIES, GRANT_UNLOCK_LOCKOUT_SECONDS, GRANT_UNLOCK_MAX_ATTEMPTS } from '@ferretry/protocol';
import should from 'should';
import {
  applyGrantPatch,
  capabilityNoun,
  DEFAULT_CAPABILITY_GRANTS,
  decideCapability,
  describeDemand,
  describeGrantRefusal,
  grantChanges,
  INITIAL_UNLOCK_ATTEMPTS,
  isGovernedCaller,
  isUnlockLocked,
  NO_PASSWORD_DISCLOSURE,
  patchedCapabilities,
  recordUnlockFailure,
  recordUnlockSuccess,
  unlockAttemptsRemaining,
  widenedBy,
} from '../../../src/lib/grants/index.ts';
import { tunnelApiRequest } from '../../../src/lib/relay/tunnel.ts';

const evaluation = (overrides: Partial<Parameters<typeof decideCapability>[1]> = {}) => ({
  grants: DEFAULT_CAPABILITY_GRANTS,
  passwordSet: false,
  unlockHeld: false,
  rateLimited: false,
  governed: true,
  ...overrides,
});

describe('who the grants govern', () => {
  it('should govern a caller that did not arrive over loopback, and exempt one that did', () => {
    // Somebody on the machine already HAS the machine. Gating them would be friction with no safety,
    // and it would make a document that refuses everything one nobody could ever edit back.
    // Act + Assert
    should(isGovernedCaller(true)).be.false();
    should(isGovernedCaller(false)).be.true();
  });

  it('should treat a RELAYED request as remote even though the relay terminates on this host', () => {
    // THE TEST THAT DECIDES WHETHER THIS DESIGN IS SOUND RATHER THAN A HOLE.
    //
    // The rendezvous socket is opened by the daemon and terminates inside this very host, so a check
    // that read a peer address, a `Host` header or a URL would see loopback for a phone on the other
    // side of the world and hand it the machine. The carrier answers instead, and it answers `false`
    // unconditionally — which is what makes every restriction in this feature real.
    // Arrange — a relayed request that presents every loopback-looking signal it possibly could.
    const relayed = tunnelApiRequest(
      {
        t: 'req',
        id: 1,
        method: 'POST',
        path: '/v1/fleet/apply',
        headers: {
          host: '127.0.0.1:7432',
          'x-forwarded-for': '127.0.0.1',
          origin: 'http://localhost:7432',
        },
        query: [['token', 'anything']],
      },
      'device-token',
    );

    // Act
    const governed = isGovernedCaller(relayed.loopback);

    // Assert — the address it claims changes nothing.
    should(relayed.loopback).be.false();
    should(governed).be.true();
    should(decideCapability({ capability: 'fleet', axis: 'configure' }, evaluation({ passwordSet: true })))
      .have.property('refusal', 'locked');
  });
});

describe('the per-capability decision', () => {
  it('should default every axis of every capability to enabled', () => {
    // Permissive by default, restrictive by choice: the product should let a person do as much as
    // possible from the UI, and the security layer is something a cautious operator turns on.
    // Assert
    for (const capability of DAEMON_CAPABILITIES) {
      should(DEFAULT_CAPABILITY_GRANTS[capability]).deepEqual({ use: true, configure: true });
    }
  });

  it('should serve an ungoverned caller whatever the document says', () => {
    // Arrange — the operator has switched everything off for remote callers.
    const shut = Object.fromEntries(
      DAEMON_CAPABILITIES.map(capability => [capability, { use: false, configure: false }]),
    ) as typeof DEFAULT_CAPABILITY_GRANTS;

    // Act
    const decision = decideCapability(
      { capability: 'warden', axis: 'configure' },
      evaluation({ grants: shut, governed: false }),
    );

    // Assert
    should(decision).deepEqual({ allowed: true, refusal: 'granted' });
  });

  it('should refuse every capability when the grants could not be determined', () => {
    // Permissive DEFAULTS settle what silence means. They say nothing about damage, and unknown is
    // never permitted — a daemon that cannot say what it may do must stop doing it.
    // Act
    const use = decideCapability({ capability: 'terminal', axis: 'use' }, evaluation({ grants: undefined }));
    const configure = decideCapability({ capability: 'terminal', axis: 'configure' }, evaluation({ grants: undefined }));

    // Assert
    should(use).deepEqual({ allowed: false, refusal: 'undetermined' });
    should(configure).deepEqual({ allowed: false, refusal: 'undetermined' });
  });

  it('should refuse configure when use itself is refused', () => {
    // A capability the UI may not exercise but may reconfigure is incoherent: it would let a browser
    // change how a shell spawns while being unable to open one.
    // Arrange
    const grants = { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: false, configure: true } };

    // Act
    const decision = decideCapability({ capability: 'terminal', axis: 'configure' }, evaluation({ grants }));

    // Assert
    should(decision).deepEqual({ allowed: false, refusal: 'not-granted' });
  });

  it('should allow configure with no password, and report that nothing was gating it', () => {
    // The honest cost of permissive defaults, reported rather than hidden: `ungated` is what lets a
    // UI say once, beside the control, that this machine has nothing standing behind it.
    // Act
    const decision = decideCapability({ capability: 'fleet', axis: 'configure' }, evaluation({ passwordSet: false }));

    // Assert
    should(decision).deepEqual({ allowed: true, refusal: 'ungated' });
    should(NO_PASSWORD_DISCLOSURE).match(/any paired device can change/u);
  });

  it('should demand an unlock once an operator password exists, and honour a held one', () => {
    // Act
    const locked = decideCapability({ capability: 'fleet', axis: 'configure' }, evaluation({ passwordSet: true }));
    const unlocked = decideCapability(
      { capability: 'fleet', axis: 'configure' },
      evaluation({ passwordSet: true, unlockHeld: true }),
    );

    // Assert
    should(locked).deepEqual({ allowed: false, refusal: 'locked' });
    should(unlocked).deepEqual({ allowed: true, refusal: 'granted' });
  });

  it('should refuse a held unlock while the daemon is rate-limited', () => {
    // The limiter is checked BEFORE the unlock is honoured: a daemon that stopped checking passwords
    // must not keep serving on the strength of the last one it accepted.
    // Act
    const decision = decideCapability(
      { capability: 'warden', axis: 'configure' },
      evaluation({ passwordSet: true, unlockHeld: true, rateLimited: true }),
    );

    // Assert
    should(decision).deepEqual({ allowed: false, refusal: 'rate-limited' });
  });

  it('should still serve the use axis while configure is locked', () => {
    // Watching is not changing. A cautious operator gates the host-changing half without making the
    // product unusable from a phone.
    // Act
    const decision = decideCapability(
      { capability: 'warden', axis: 'use' },
      evaluation({ passwordSet: true, rateLimited: true }),
    );

    // Assert
    should(decision).deepEqual({ allowed: true, refusal: 'granted' });
  });

  it('should never turn a refused capability into a served one', () => {
    // The invariant, stated as a test: across every input combination this function can be given, a
    // capability the operator switched off is refused. A grant only ever narrows.
    // Arrange
    const off = { ...DEFAULT_CAPABILITY_GRANTS, browser: { use: false, configure: false } };

    // Act + Assert
    for (const passwordSet of [true, false]) {
      for (const unlockHeld of [true, false]) {
        for (const rateLimited of [true, false]) {
          const decision = decideCapability(
            { capability: 'browser', axis: 'use' },
            evaluation({ grants: off, passwordSet, unlockHeld, rateLimited }),
          );
          should(decision.allowed).be.false();
        }
      }
    }
  });
});

describe('what a refused caller is told', () => {
  it('should name the next step for every refusal, and explain nothing for the two that passed', () => {
    // A denial that says only "forbidden" is a dead end: the person cannot tell a mistake from a
    // password from a decision somebody made on purpose.
    // Act
    const demand = { capability: 'warden', axis: 'configure' } as const;
    const said = (['not-granted', 'locked', 'rate-limited', 'undetermined'] as const).map(refusal => ({
      refusal,
      sentence: describeGrantRefusal(demand, refusal, 'fy'),
    }));

    // Assert — the next step differs by refusal, and that is the point: three of these are repaired
    // at the host with a named command, and `locked` is repaired by the person in front of the UI.
    for (const { refusal, sentence } of said) {
      should(sentence).match(refusal === 'locked' ? /Unlock first/u : /fy /u);
    }
    should(describeGrantRefusal({ capability: 'warden', axis: 'use' }, 'granted', 'fy')).be.undefined();
    should(describeGrantRefusal({ capability: 'warden', axis: 'use' }, 'ungated', 'fy')).be.undefined();
    // The `use` refusal names the use flag rather than the configure one.
    should(describeGrantRefusal({ capability: 'terminal', axis: 'use' }, 'not-granted', 'fy')).match(/--use/u);
  });

  it('should name each capability as a person reads it', () => {
    // Assert
    should(capabilityNoun('fleet')).equal('the agent fleet');
    should(capabilityNoun('filesystem')).equal('session working trees');
    should(describeDemand('fleet', 'configure')).equal('fleet.configure');
  });
});

describe('applying a change', () => {
  it('should leave every axis the patch does not name exactly as it was', () => {
    // A stale tab restating answers it never looked at must not revert a decision made in another.
    // Arrange
    const current = { ...DEFAULT_CAPABILITY_GRANTS, warden: { use: true, configure: false } };

    // Act
    const next = applyGrantPatch(current, { terminal: { configure: false } });

    // Assert
    should(next.warden).deepEqual({ use: true, configure: false });
    should(next.terminal).deepEqual({ use: true, configure: false });
    should(patchedCapabilities({ terminal: { configure: false } })).deepEqual(['terminal']);
  });

  it('should report which axes a change turns ON, and report none for a change that only revokes', () => {
    // Widening needs the password; narrowing never does, because revoking must never be harder than
    // granting — in an incident you want the fastest possible path to "the UI can no longer do that".
    // Arrange
    const shut = { ...DEFAULT_CAPABILITY_GRANTS, fleet: { use: false, configure: false } };

    // Act
    const widened = widenedBy(shut, DEFAULT_CAPABILITY_GRANTS);
    const narrowed = widenedBy(DEFAULT_CAPABILITY_GRANTS, shut);

    // Assert
    should(widened).deepEqual(['fleet.use', 'fleet.configure']);
    should(narrowed).be.empty();
    should(grantChanges(DEFAULT_CAPABILITY_GRANTS, shut)).deepEqual(['fleet.use=off', 'fleet.configure=off']);
    should(grantChanges(DEFAULT_CAPABILITY_GRANTS, DEFAULT_CAPABILITY_GRANTS)).be.empty();
  });
});

describe('the wrong-password ledger', () => {
  it('should lock the daemon out after the declared number of attempts', () => {
    // A local gate that counts is worth little; one that does not is worth nothing.
    // Arrange
    const now = 1_700_000_000_000;

    // Act
    let state = INITIAL_UNLOCK_ATTEMPTS;
    for (let attempt = 0; attempt < GRANT_UNLOCK_MAX_ATTEMPTS; attempt += 1) state = recordUnlockFailure(state, now);

    // Assert
    should(isUnlockLocked(state, now)).be.true();
    should(unlockAttemptsRemaining(state, now)).equal(0);
    should(state.lockedUntilMs).equal(now + GRANT_UNLOCK_LOCKOUT_SECONDS * 1_000);
  });

  it('should count down the attempts a caller has left', () => {
    // A limiter a person cannot see looks like a broken daemon.
    // Arrange
    const now = 1_700_000_000_000;

    // Act
    const once = recordUnlockFailure(INITIAL_UNLOCK_ATTEMPTS, now);

    // Assert
    should(unlockAttemptsRemaining(once, now)).equal(GRANT_UNLOCK_MAX_ATTEMPTS - 1);
    should(isUnlockLocked(once, now)).be.false();
  });

  it('should give a full budget back once a lockout has lapsed', () => {
    // Keeping the failures forever would turn a fifteen-minute lockout into a permanent one after a
    // single further mistake — denial of service against the operator, not defence against a guesser.
    // Arrange
    const now = 1_700_000_000_000;
    let state = INITIAL_UNLOCK_ATTEMPTS;
    for (let attempt = 0; attempt < GRANT_UNLOCK_MAX_ATTEMPTS; attempt += 1) state = recordUnlockFailure(state, now);
    const after = now + GRANT_UNLOCK_LOCKOUT_SECONDS * 1_000 + 1;

    // Act
    const remaining = unlockAttemptsRemaining(state, after);
    const next = recordUnlockFailure(state, after);

    // Assert
    should(isUnlockLocked(state, after)).be.false();
    should(remaining).equal(GRANT_UNLOCK_MAX_ATTEMPTS);
    should(next).deepEqual({ failures: 1 });
  });

  it('should clear the ledger and the lockout when the password is finally right', () => {
    // Assert
    should(recordUnlockSuccess()).deepEqual(INITIAL_UNLOCK_ATTEMPTS);
    should(isUnlockLocked(INITIAL_UNLOCK_ATTEMPTS, 1)).be.false();
  });
});
