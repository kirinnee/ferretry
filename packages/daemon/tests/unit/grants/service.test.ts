import { describe, it } from 'bun:test';
import {
  type CapabilityGrants,
  DAEMON_CAPABILITIES,
  GRANT_UNLOCK_LOCKOUT_SECONDS,
  GRANT_UNLOCK_MAX_ATTEMPTS,
  GRANT_UNLOCK_TTL_SECONDS,
} from '@ferretry/protocol';
import should from 'should';
import type { CapabilityPresentation } from '../../../src/lib/api/capability.ts';
import {
  CapabilityGrantService,
  DEFAULT_CAPABILITY_GRANTS,
  type GrantAuditEntry,
  GrantError,
} from '../../../src/lib/grants/index.ts';

const NOW = 1_700_000_000_000;

interface World {
  readonly service: CapabilityGrantService;
  readonly audit: GrantAuditEntry[];
  written(): CapabilityGrants | undefined;
  advance(milliseconds: number): void;
}

function world(options: { grants?: CapabilityGrants; password?: string; broken?: boolean } = {}): World {
  let recorded = options.grants ?? DEFAULT_CAPABILITY_GRANTS;
  let written: CapabilityGrants | undefined;
  let stored = options.password;
  let minted = 0;
  let now = NOW;
  const audit: GrantAuditEntry[] = [];
  const service = new CapabilityGrantService({
    document: {
      read: async () => {
        if (options.broken === true) throw new Error('the grant document is not readable');
        return recorded;
      },
      written: async () => (options.grants === undefined ? [] : DAEMON_CAPABILITIES),
      write: async next => {
        written = next;
        recorded = next;
      },
    },
    passwords: {
      isSet: async () => stored !== undefined,
      set: async password => {
        stored = password;
      },
      clear: async () => {
        stored = undefined;
      },
      verify: async candidate => stored !== undefined && candidate === stored,
    },
    tokens: {
      mint: () => {
        minted += 1;
        return `fy_unlock_${String(minted).padStart(22, 'a')}`;
      },
    },
    clock: { nowMs: () => now },
    audit: {
      record: async entry => {
        audit.push(entry);
      },
      recent: async limit => ({ entries: [...audit].reverse().slice(0, limit), unreadable: 0, truncated: false }),
    },
    clientName: 'fy',
  });
  return {
    service,
    audit,
    written: () => written,
    advance: milliseconds => {
      now += milliseconds;
    },
  };
}

const remote: CapabilityPresentation = { loopback: false, actor: 'device:phone-1' };
const local: CapabilityPresentation = { loopback: true, actor: 'admin-cli' };

describe('reading the operator decision', () => {
  it('should refuse every governed capability until the decision has been read', () => {
    // A service that has never read its document does not know what it may allow, and the safe
    // reading of "nobody can tell me" is that it is not allowed. This is the state the composition
    // root must leave behind before it binds an address.
    // Arrange
    const { service } = world();

    // Act
    const decision = service.decide({ capability: 'terminal', axis: 'use' }, remote);

    // Assert
    should(decision).deepEqual({ allowed: false, refusal: 'undetermined' });
  });

  it('should raise, and stop enforcing anything, when the document cannot be read', async () => {
    // Damaged state is not empty state. It must not be left serving from a decision that may no
    // longer be true, and it must say which document is broken rather than falling silent.
    // Arrange
    const { service } = world({ broken: true });

    // Act
    const raised = await service
      .refresh()
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Assert
    should(raised).be.instanceof(GrantError);
    should((raised as GrantError).failure).equal('unavailable');
    should(service.enforced()).be.undefined();
    should(service.decide({ capability: 'fleet', axis: 'use' }, remote).refusal).equal('undetermined');
    // A loopback caller is unaffected: they are not governed by this layer at all.
    should(service.decide({ capability: 'fleet', axis: 'use' }, local).allowed).be.true();
  });
});

describe('the grant view a UI reads', () => {
  it('should report every capability with both axes and the reason each reads that way', async () => {
    // The UI must be able to explain a limit BEFORE somebody clicks into it. One read, not a probe
    // per control — a UI that discovers its limits by watching calls fail can explain nothing.
    // Arrange
    const { service } = world({ grants: { ...DEFAULT_CAPABILITY_GRANTS, browser: { use: false, configure: false } } });
    await service.refresh();

    // Act
    const view = service.view(remote);

    // Assert
    should(view.capabilities).have.length(DAEMON_CAPABILITIES.length);
    const browser = view.capabilities.find(entry => entry.capability === 'browser');
    should(browser).deepEqual({
      capability: 'browser',
      use: false,
      configure: false,
      granted: { use: false, configure: false },
      useRefusal: 'not-granted',
      configureRefusal: 'not-granted',
      // No remote caller may widen anything, so this is false for every capability on this view.
      mayGrant: false,
      // The operator wrote this one down; `--print-config` draws the same distinction for every other
      // value, and a report that could not tell a choice from a default answers the wrong question.
      origin: 'config file',
    });
    // No password on this machine, so the configure axis passes and says nothing was standing behind
    // it — which is the honest disclosure, not a refusal.
    should(view.capabilities.find(entry => entry.capability === 'fleet')).have.property('configureRefusal', 'ungated');
    should(view.passwordSet).be.false();
    should(view.attemptsRemaining).be.undefined();
  });

  it('should never disclose the password, its length or its verifier', async () => {
    // The entire disclosure is one boolean. Anything more would be the first crack in "never
    // rendered back", and no client needs it.
    // Arrange
    const { service } = world({ password: 'correct horse battery' });
    await service.refresh();

    // Act
    const encoded = JSON.stringify(service.view(remote));

    // Assert
    should(encoded).not.match(/correct horse/u);
    should(encoded).match(/"passwordSet":true/u);
    should(service.hasPassword()).be.true();
  });
});

describe('unlocking', () => {
  it('should mint a bounded unlock for the right password and honour it', async () => {
    // Arrange
    const { service } = world({ password: 'operator-secret' });
    await service.refresh();

    // Act
    const outcome = await service.unlock('operator-secret');
    const held = outcome.kind === 'unlocked' ? outcome.token : '';

    // Assert
    should(outcome.kind).equal('unlocked');
    should(outcome.kind === 'unlocked' ? outcome.expiresAtMs : 0).equal(NOW + GRANT_UNLOCK_TTL_SECONDS * 1_000);
    should(service.decide({ capability: 'fleet', axis: 'configure' }, { ...remote, unlock: held }).allowed).be.true();
  });

  it('should stop honouring an unlock once it has expired', async () => {
    // An unlock is held while somebody changes a setting, not for a session: one that outlived the
    // tab it was minted in would be a standing configure grant nobody re-consented to.
    // Arrange
    const context = world({ password: 'operator-secret' });
    await context.service.refresh();
    const outcome = await context.service.unlock('operator-secret');
    const held = outcome.kind === 'unlocked' ? outcome.token : '';

    // Act
    context.advance(GRANT_UNLOCK_TTL_SECONDS * 1_000 + 1);

    // Assert
    should(
      context.service.decide({ capability: 'fleet', axis: 'configure' }, { ...remote, unlock: held }).refusal,
    ).equal('locked');
  });

  it('should refuse a blank or unknown unlock rather than matching anything', async () => {
    // Arrange
    const { service } = world({ password: 'operator-secret' });
    await service.refresh();

    // Act + Assert
    should(service.decide({ capability: 'fleet', axis: 'configure' }, { ...remote, unlock: '  ' }).refusal).equal(
      'locked',
    );
    should(
      service.decide({ capability: 'fleet', axis: 'configure' }, { ...remote, unlock: 'fy_unlock_forged' }).refusal,
    ).equal('locked');
  });

  it('should refuse to mint anything on a machine with no operator password', async () => {
    // Nothing is gated there, so an unlock would prove nothing — and handing one out would let a
    // client believe it had passed a check that never happened.
    // Arrange
    const { service } = world();
    await service.refresh();

    // Act
    const outcome = await service.unlock('anything');

    // Assert
    should(outcome.kind).equal('refused');
    should(outcome.kind === 'refused' ? outcome.refusal.reason : '').equal('no-password');
  });

  it('should stop checking passwords after too many wrong ones, correct ones included', async () => {
    // A limiter that let a correct guess through early would leak whether a guess was correct while
    // claiming to be closed.
    // Arrange
    const context = world({ password: 'operator-secret' });
    await context.service.refresh();

    // Act
    for (let attempt = 0; attempt < GRANT_UNLOCK_MAX_ATTEMPTS; attempt += 1) {
      await context.service.unlock('wrong');
    }
    const afterLockout = await context.service.unlock('operator-secret');

    // Assert
    should(afterLockout.kind).equal('refused');
    should(afterLockout.kind === 'refused' ? afterLockout.refusal.reason : '').equal('rate-limited');
    should(context.service.view(remote).lockedUntil).be.a.String();

    // And it resumes once the lockout lapses — a permanent lockout would deny the operator service
    // rather than defend against a guesser.
    context.advance(GRANT_UNLOCK_LOCKOUT_SECONDS * 1_000 + 1);
    should((await context.service.unlock('operator-secret')).kind).equal('unlocked');
  });
});

describe('changing the grants', () => {
  it('should let a governed caller narrow without any unlock at all', async () => {
    // Revoking must never be harder than granting: in an incident you want the fastest possible path
    // to "the UI can no longer do that", and a password prompt in the way is a liability.
    // Arrange
    const context = world({ password: 'operator-secret' });
    await context.service.refresh();

    // Act
    const view = await context.service.patch({ fleet: { configure: false } }, remote);

    // Assert
    should(context.written()?.fleet).deepEqual({ use: true, configure: false });
    should(view.capabilities.find(entry => entry.capability === 'fleet')).have.property('configure', false);
    should(context.audit).have.length(1);
    should(context.audit[0]).containDeep({ actor: 'device:phone-1', changes: ['fleet.configure=off'] });
  });

  it('should refuse a governed caller the grant it was not given permission to change', async () => {
    // Changing capability X's grant is a configure act ON X, which is what stops the layer being
    // self-defeating: a UI the operator excluded from warden configuration cannot quietly rewrite
    // the warden grant — not even to narrow it further.
    // Arrange
    const context = world({ grants: { ...DEFAULT_CAPABILITY_GRANTS, warden: { use: true, configure: false } } });
    await context.service.refresh();

    // Act
    const refused = await context.service
      .patch({ warden: { use: false } }, remote)
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Assert
    should(refused).be.instanceof(GrantError);
    should((refused as GrantError).message).match(/has not granted the UI permission to change the warden grant/u);
    should(context.written()).be.undefined();
  });

  it('should let the host widen without a password when the machine has none', async () => {
    // This is how a machine is set up at all. Nothing is gated on it, and the person doing it is
    // standing on the host — the output says plainly what that means.
    // Arrange
    const context = world({ grants: { ...DEFAULT_CAPABILITY_GRANTS, fleet: { use: false, configure: false } } });
    await context.service.refresh();

    // Act
    await context.service.patch({ fleet: { use: true, configure: true } }, local);

    // Assert
    should(context.written()?.fleet).deepEqual({ use: true, configure: true });
  });

  it('should refuse to change grants it could not read', async () => {
    // Arrange
    const { service } = world({ broken: true });
    await service.refresh().catch(() => undefined);

    // Act
    const refused = await service
      .patch({ fleet: { use: false } }, local)
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Assert
    should((refused as GrantError).failure).equal('unavailable');
  });

  it('should take effect immediately, with no restart', async () => {
    // The document is written and the in-memory answer moves in the same call, so the very next
    // request is decided by the new one. Only a document edited by hand needs a restart.
    // Arrange
    const context = world();
    await context.service.refresh();
    should(context.service.decide({ capability: 'terminal', axis: 'use' }, remote).allowed).be.true();

    // Act
    await context.service.patch({ terminal: { use: false } }, local);

    // Assert
    should(context.service.decide({ capability: 'terminal', axis: 'use' }, remote).refusal).equal('not-granted');
  });
});

describe('the operator password itself', () => {
  it('should drop every held unlock when the password changes', async () => {
    // Rotating a password after a device is lost achieves nothing if what the old one bought
    // survives it.
    // Arrange
    const context = world({ password: 'first-secret' });
    await context.service.refresh();
    const outcome = await context.service.unlock('first-secret');
    const held = outcome.kind === 'unlocked' ? outcome.token : '';

    // Act
    await context.service.setPassword('second-secret');

    // Assert
    should(
      context.service.decide({ capability: 'fleet', axis: 'configure' }, { ...remote, unlock: held }).refusal,
    ).equal('locked');
    should(context.service.hasPassword()).be.true();
  });

  it('should turn the security layer off when the password is cleared', async () => {
    // A real operation: an operator may decide their machine no longer needs one.
    // Arrange
    const context = world({ password: 'first-secret' });
    await context.service.refresh();

    // Act
    await context.service.setPassword(undefined);

    // Assert
    should(context.service.hasPassword()).be.false();
    should(context.service.decide({ capability: 'fleet', axis: 'configure' }, remote).refusal).equal('ungated');
  });
});

describe('the sentence a refusal carries', () => {
  it('should compose it here, because only this layer knows the command a person types', () => {
    // The authorization boundary has no business knowing what this product's client is called, so it
    // asks the guard — which is what lets a refusal name the next step instead of saying "forbidden".
    // Arrange
    const { service } = world();

    // Act
    const said = service.explain({ capability: 'warden', axis: 'configure' }, 'not-granted');
    const nothing = service.explain({ capability: 'warden', axis: 'configure' }, 'granted');

    // Assert
    should(said).match(/fy daemon config set warden --configure/u);
    should(nothing).be.undefined();
  });
});

describe('widening is a local act and there is no remote path to it', () => {
  it('should refuse a remote widen even with a valid unlock, because no password buys it', async () => {
    // THE RULE. Locality is the boundary, not the password: the security of the model rests on where
    // the socket came from, which nothing a caller sends can move, rather than on a secret a person
    // chose. A stolen phone cannot grant itself anything.
    // Arrange — the caller holds a genuine, unexpired unlock.
    const context = world({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: false, configure: false } },
      password: 'operator-secret',
    });
    await context.service.refresh();
    const outcome = await context.service.unlock('operator-secret');
    const unlock = outcome.kind === 'unlocked' ? outcome.token : '';

    // Act
    const refused = await context.service
      .patch({ terminal: { use: true } }, { ...remote, unlock })
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Assert
    should(refused).be.instanceof(GrantError);
    should((refused as GrantError).message).match(/only be turned on from the machine itself/u);
    should((refused as GrantError).message).match(/with or without the operator password/u);
    should(context.written()).be.undefined();
  });

  it('should refuse the WHOLE patch when it both widens and narrows', async () => {
    // A half-applied widen is worse than either outcome: the operator is left with a machine in a
    // state they did not ask for and were not told about, and the refusal they saw is
    // indistinguishable from a total one.
    // Arrange
    const context = world({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: false, configure: false } },
    });
    await context.service.refresh();

    // Act — one on, one off, in a single patch.
    const refused = await context.service
      .patch({ terminal: { use: true }, fleet: { use: false } }, remote)
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Assert — NEITHER half reached the document, and the enforced answer did not move either.
    should(refused).be.instanceof(GrantError);
    should(context.written()).be.undefined();
    should(context.service.decide({ capability: 'fleet', axis: 'use' }, remote).allowed).be.true();
    should(context.service.decide({ capability: 'terminal', axis: 'use' }, remote).refusal).equal('not-granted');
    should(context.audit).be.empty();
  });

  it('should still let a remote caller turn something off', async () => {
    // Revoking stays easier than granting — that was already the principle, and this rule is its
    // conclusion rather than a departure from it.
    // Arrange
    const context = world();
    await context.service.refresh();

    // Act
    await context.service.patch({ warden: { configure: false } }, remote);

    // Assert
    should(context.written()?.warden).deepEqual({ use: true, configure: false });
  });

  it('should let the machine itself turn something on with no password at all', async () => {
    // The other half of the rule: local may do both, unconditionally. This is the only path back
    // after a remote caller has switched something off.
    // Arrange
    const context = world({ grants: { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: false, configure: false } } });
    await context.service.refresh();

    // Act
    await context.service.patch({ terminal: { use: true, configure: true } }, local);

    // Assert
    should(context.written()?.terminal).deepEqual({ use: true, configure: true });
  });

  it('should tell a UI which callers may widen, so it never offers a control that always fails', async () => {
    // `mayGrant` is on the wire so the browser is TOLD rather than encoding the rule a second time —
    // and so a remote caller can be warned BEFORE switching something off that this door is one-way.
    // Arrange
    const context = world();
    await context.service.refresh();

    // Act
    const fromAway = context.service.view(remote);
    const fromHere = context.service.view(local);

    // Assert
    should(fromAway.capabilities.every(entry => !entry.mayGrant)).be.true();
    should(fromHere.capabilities.every(entry => entry.mayGrant)).be.true();
  });
});
