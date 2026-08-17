import { describe, it } from 'bun:test';
import { DAEMON_CAPABILITIES, GRANT_UNLOCK_LOCKOUT_SECONDS, GRANT_UNLOCK_MAX_ATTEMPTS } from '@ferretry/protocol';
import should from 'should';
import {
  applyGrantPatch,
  type CallerArrival,
  capabilityNoun,
  DEFAULT_CAPABILITY_GRANTS,
  decideCapability,
  describeDemand,
  describeGrantRefusal,
  grantChanges,
  INITIAL_UNLOCK_ATTEMPTS,
  isGovernedCaller,
  isUnlockLocked,
  mayChangeOperatorPassword,
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
  hostLocal: false,
  ...overrides,
});

/** One caller, as the four facts governance reads about it. The default is a remote device. */
const arrival = (overrides: Partial<CallerArrival> = {}): CallerArrival => ({
  loopback: false,
  adminToken: false,
  passwordSet: false,
  unlockHeld: false,
  ...overrides,
});

describe('who the grants govern', () => {
  it('should govern every caller that did not arrive over loopback, whatever it holds', () => {
    // Arrival is still the first question, and no credential answers it: a remote caller holding the
    // host's admin token, a live unlock, or both is governed all the same.
    // Act + Assert
    should(isGovernedCaller(arrival({ loopback: false }))).be.true();
    should(isGovernedCaller(arrival({ loopback: false, adminToken: true, unlockHeld: true }))).be.true();
  });

  it('should exempt the host command line, which holds the admin token', () => {
    // Reading that token file already requires being on the machine, so gating it would be friction with
    // no safety — and it would close the one door a FORGOTTEN password is repaired through. This is the
    // escape hatch, asserted rather than assumed.
    // Act + Assert
    should(isGovernedCaller(arrival({ loopback: true, adminToken: true, passwordSet: true }))).be.false();
    should(mayChangeOperatorPassword(arrival({ loopback: true, adminToken: true, passwordSet: true }))).be.true();
  });

  it('should govern a LOCAL BROWSER until it presents an unlock, then stop', () => {
    // A browser is a paired device wherever it runs, and an unattended tab on the machine was one tap
    // from provisioning it. So local arrival alone is no longer an exemption: one gate at the door, then
    // full authority. It is friction rather than a boundary — somebody at the keyboard can open a
    // terminal — and what it buys is that a destructive change is deliberate.
    // Arrange
    const local = { loopback: true, adminToken: false, passwordSet: true };

    // Act + Assert
    should(isGovernedCaller(arrival({ ...local, unlockHeld: false }))).be.true();
    should(isGovernedCaller(arrival({ ...local, unlockHeld: true }))).be.false();
  });

  it('should leave a local browser ungoverned while this machine has no password at all', () => {
    // The state every new user starts in. There is nothing to unlock with and no gate to pass, so a
    // fresh install is useful immediately and nobody is asked to invent a secret before their first run.
    // The first password is required when the first DEVICE is paired, which is where remote access
    // begins — not at startup and not for local use.
    // Act + Assert
    should(isGovernedCaller(arrival({ loopback: true, passwordSet: false }))).be.false();
    should(mayChangeOperatorPassword(arrival({ loopback: true, passwordSet: false }))).be.true();
  });

  it('should refuse a local browser the password itself until it unlocks', () => {
    // Otherwise the gate would be one tap wide: a locked browser could simply replace the password it
    // could not prove, and every sentence about deliberateness would be false. The way back for somebody
    // who has genuinely forgotten it is the admin token above, never this.
    // Act + Assert
    should(mayChangeOperatorPassword(arrival({ loopback: true, passwordSet: true, unlockHeld: false }))).be.false();
    should(mayChangeOperatorPassword(arrival({ loopback: true, passwordSet: true, unlockHeld: true }))).be.true();
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
      'rendezvous-session',
    );

    // Act — and it presents the host's own token class too, which changes nothing off the host.
    const governed = isGovernedCaller(arrival({ loopback: relayed.loopback, adminToken: true }));

    // Assert — the address it claims changes nothing.
    should(relayed.loopback).be.false();
    should(governed).be.true();
    should(
      decideCapability({ capability: 'fleet', axis: 'configure' }, evaluation({ passwordSet: true })),
    ).have.property('refusal', 'locked');
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
    const configure = decideCapability(
      { capability: 'terminal', axis: 'configure' },
      evaluation({ grants: undefined }),
    );

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

    // Assert — EVERY refusal now names a runnable command, `locked` included. That one used to say
    // only "unlock first", which is a dead end for the person who does not HAVE the password: the
    // axis is granted, nothing is broken, and no instruction applied to them.
    for (const { sentence } of said) should(sentence).match(/`fy [^`]+`/u);
    should(describeGrantRefusal({ capability: 'warden', axis: 'use' }, 'granted', 'fy')).be.undefined();
    should(describeGrantRefusal({ capability: 'warden', axis: 'use' }, 'ungated', 'fy')).be.undefined();
    // The `use` refusal names the use flag rather than the configure one.
    should(describeGrantRefusal({ capability: 'terminal', axis: 'use' }, 'not-granted', 'fy')).match(/--use/u);
  });

  it('should name each capability as a person reads it', () => {
    // Assert
    should(capabilityNoun('fleet')).equal('the agent fleet');
    should(capabilityNoun('filesystem')).equal('the project filesystem');
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

describe('the one refusal whose reader may not be the operator', () => {
  it('should give `locked` a remedy for somebody who does not have the password', () => {
    // The axis is GRANTED and nothing is broken — the caller simply cannot prove they are the
    // operator. "Unlock first, then try again" is a complete instruction for the person holding the
    // password and no instruction at all for the person who is not. Both readers now get a step.
    // Act
    const said = describeGrantRefusal({ capability: 'fleet', axis: 'configure' }, 'locked', 'fy') ?? '';

    // Assert
    should(said).match(/Enter it to unlock/u);
    should(said).match(/fy daemon password set/u);
    should(said).match(/fy daemon password clear/u);
    // And it never implies the operator refused something they in fact allowed.
    should(said).not.match(/has not granted/u);
  });
});
