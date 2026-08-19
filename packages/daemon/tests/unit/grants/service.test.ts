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

const remote: CapabilityPresentation = { loopback: false, adminToken: false, actor: 'device:phone-1' };
/** The host's COMMAND LINE: on the machine and holding the admin token, so ungoverned unconditionally. */
const local: CapabilityPresentation = { loopback: true, adminToken: true, actor: 'admin-cli' };
/**
 * A browser ON the machine — local arrival, a DEVICE credential.
 *
 * The caller the whole gate exists for, and the one a single `loopback` boolean could not tell apart from
 * the command line above.
 */
const localBrowser: CapabilityPresentation = { loopback: true, adminToken: false, actor: 'device:this-browser' };

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
    // The host command line is unaffected: it holds the admin token and is not governed by this layer at
    // all, whatever the document says or fails to say.
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
    await context.service.setPassword('second-secret', local);

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
    await context.service.setPassword(undefined, local);

    // Assert
    should(context.service.hasPassword()).be.false();
    should(context.service.decide({ capability: 'fleet', axis: 'configure' }, remote).refusal).equal('ungated');
  });

  it('should let the HOST replace a password nobody knows, which is the escape hatch', async () => {
    // THE TEST THAT KEEPS THIS FEATURE FROM BEING A LOCKOUT.
    //
    // A local browser needs the current password to move it, so a forgotten password would brick the
    // machine forever if the command line needed one too — no remote path, no local path, nothing. It
    // does not: the admin token is ungoverned, so `fy daemon password set` replaces an UNKNOWN password
    // without presenting it or any unlock. Recovery is asserted from exactly that state.
    // Arrange — a machine whose password this caller cannot produce, and holds no unlock for.
    const context = world({ password: 'the-one-nobody-remembers' });
    await context.service.refresh();

    // Act — no password, no unlock, no header of any kind.
    await context.service.setPassword('a-brand-new-one', local);

    // Assert — and the new one works, so this is recovery rather than merely an accepted call.
    const outcome = await context.service.unlock('a-brand-new-one');
    should(outcome.kind).equal('unlocked');
    should(context.service.hasPassword()).be.true();
  });

  it('should refuse a LOCAL BROWSER that has not unlocked, so the gate is not one tap wide', async () => {
    // Local arrival is not the whole answer: a browser is a paired device, and one that could replace
    // the password it cannot prove would make every sentence about deliberateness false. The refusal
    // names the way back for the reader who does not have it either — that is the point of it being a
    // sentence rather than a status.
    // Arrange
    const context = world({ password: 'operator-secret' });
    await context.service.refresh();

    // Act
    const raised = await context.service
      .setPassword('something-else', localBrowser)
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Assert
    should(raised).be.instanceof(GrantError);
    should((raised as GrantError).failure).equal('forbidden');
    should((raised as GrantError).message).match(/fy daemon password set/u);
    should(await context.service.unlock('operator-secret')).have.property('kind', 'unlocked');
  });

  it('should let a local browser move the password once it holds an unlock', async () => {
    // One gate at the door, then full authority. The unlock the browser already spent is what proves it,
    // rather than a second concept with its own lifetime.
    // Arrange
    const context = world({ password: 'operator-secret' });
    await context.service.refresh();
    const outcome = await context.service.unlock('operator-secret');
    const held = outcome.kind === 'unlocked' ? outcome.token : '';

    // Act
    await context.service.setPassword('a-newer-secret', { ...localBrowser, unlock: held });

    // Assert
    should(await context.service.unlock('a-newer-secret')).have.property('kind', 'unlocked');
  });

  it('should let a local browser set the FIRST password with nothing to prove', async () => {
    // The state every new user starts in, and the one required at first pairing. There is no password to
    // unlock with, so demanding one would make the requirement impossible to satisfy from the browser
    // that is being asked to satisfy it.
    // Arrange — a fresh machine.
    const context = world();
    await context.service.refresh();

    // Act
    await context.service.setPassword('the-first-one', localBrowser);

    // Assert
    should(context.service.hasPassword()).be.true();
  });
});

describe('a browser standing on the machine', () => {
  it('should be governed until it unlocks, and ungoverned afterwards', async () => {
    // The whole change, in one assertion: `configure` on a local browser is refused with `locked` rather
    // than served, and the unlock — not a second gate — is what opens it.
    // Arrange
    const context = world({ password: 'operator-secret' });
    await context.service.refresh();

    // Act
    const before = context.service.decide({ capability: 'fleet', axis: 'configure' }, localBrowser);
    const outcome = await context.service.unlock('operator-secret');
    const held = outcome.kind === 'unlocked' ? outcome.token : '';
    const after = context.service.decide({ capability: 'fleet', axis: 'configure' }, { ...localBrowser, unlock: held });

    // Assert
    should(before).deepEqual({ allowed: false, refusal: 'locked' });
    should(after).deepEqual({ allowed: true, refusal: 'granted' });
  });

  it('should stay ungoverned on a machine with no password at all', async () => {
    // A fresh install is useful immediately: there is nothing to unlock with, so there is no gate.
    // Arrange
    const context = world();
    await context.service.refresh();

    // Act
    const decided = context.service.decide({ capability: 'fleet', axis: 'configure' }, localBrowser);

    // Assert
    should(decided).deepEqual({ allowed: true, refusal: 'granted' });
  });

  it('should report itself as ON THIS HOST while still governed, and may widen after unlocking', async () => {
    // `governed` and `hostLocal` came apart here, and a view that collapsed them would tell somebody
    // standing at the machine they were remote — and call a switch they can reopen a one-way door.
    // Arrange
    const context = world({ password: 'operator-secret' });
    await context.service.refresh();

    // Act
    const view = context.service.view(localBrowser);

    // Assert
    should(view.governed).be.true();
    should(view.hostLocal).be.true();
    should(view.capabilities.every(entry => entry.mayGrant)).be.true();
    // And the remote caller is unmoved by any of it.
    should(context.service.view(remote)).containDeep({ governed: true, hostLocal: false });
  });

  it('should refuse a widening patch until it unlocks, naming the password rather than the machine', async () => {
    // The remote sentence ("only from the machine itself") is the wrong one here: this caller IS at the
    // machine, and sending them to the host to do what they are already doing is the dead end this
    // surface exists to remove.
    // Arrange — a capability switched off, on a machine with a password.
    const context = world({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, browser: { use: false, configure: false } },
      password: 'operator-secret',
    });
    await context.service.refresh();

    // Act
    const raised = await context.service
      .patch({ browser: { use: true } }, localBrowser)
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Assert
    should(raised).be.instanceof(GrantError);
    should((raised as GrantError).message).match(/operator password/u);
    should((raised as GrantError).message).not.match(/no remote caller/u);
    should(context.written()).be.undefined();
  });

  it('should name the PASSWORD, not the document, when a local browser is refused a restricted grant', async () => {
    // Two readers, two remedies. Off the host, the document is the answer and the operator is somebody
    // else. On the host the reader IS the operator: telling them their own document refuses them — when
    // the password they already have would let it through — sends them to edit a file for a limit that was
    // never theirs.
    // Arrange — a capability the operator excluded the UI from configuring, on a machine with a password.
    const context = world({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, warden: { use: true, configure: false } },
      password: 'operator-secret',
    });
    await context.service.refresh();

    // Act
    const locally = await context.service
      .patch({ warden: { use: false } }, localBrowser)
      .then(() => undefined)
      .catch((error: unknown) => error);
    const remotely = await context.service
      .patch({ warden: { use: false } }, remote)
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Assert
    should((locally as GrantError).message).match(/operator password/u);
    should((locally as GrantError).message).match(/fy daemon password set/u);
    should((remotely as GrantError).message).match(/has not granted the UI permission/u);
    should((remotely as GrantError).message).not.match(/operator password/u);
    should(context.written()).be.undefined();
  });

  it('should let a local browser NARROW without unlocking, because revoking is never gated', async () => {
    // A prompt between a person and shutting a door is a liability during the incident that made them
    // reach for it. The gate is on widening and on the password, never on a revoke.
    // Arrange
    const context = world({ password: 'operator-secret' });
    await context.service.refresh();

    // Act
    await context.service.patch({ terminal: { use: false } }, localBrowser);

    // Assert
    should(context.written()).containDeep({ terminal: { use: false } });
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

describe('where a caller stands, for a route that must add one step', () => {
  it('should tell an ungoverned caller it owes nothing, whatever the machine has set', async () => {
    // THE OWNER'S CASE. The host's command line, and a browser on this machine that has unlocked,
    // are past the gate — `isGovernedCaller` says so — and the fleet's per-change confirmation must
    // not reintroduce a second one behind it. `#358` established that shape: unlock once, then full
    // authority, exactly as `sudo` behaves.
    // Arrange
    const context = world({ password: 'the operator knows this' });
    await context.service.refresh();

    // Act
    const commandLine = context.service.governance(local);
    const unlocked = await context.service.unlock('the operator knows this');
    const browser = context.service.governance({
      ...localBrowser,
      unlock: unlocked.kind === 'unlocked' ? unlocked.token : '',
    });

    // Assert
    should(commandLine).match({ governed: false, passwordSet: true, confirmChange: false });
    should(browser).match({ governed: false, passwordSet: true, confirmChange: false });
  });

  it('should ask a governed caller on a machine with a password to confirm each change', async () => {
    // Arrange
    const context = world({ password: 'the operator knows this' });
    await context.service.refresh();

    // Act
    const actual = context.service.governance(remote);

    // Assert
    should(actual).match({ governed: true, passwordSet: true, confirmChange: true });
  });

  it('should ask a governed caller on a machine with NO password for nothing at all', async () => {
    // A control that cannot refuse is theatre. There is no secret to bind a change to here, so
    // there is deliberately no prompt — and the capability layer already reports the state as
    // `ungated` rather than `granted` so a surface can say once, beside the control, that nothing
    // is standing behind it.
    // Arrange
    const context = world();
    await context.service.refresh();

    // Act
    const actual = context.service.governance(remote);

    // Assert
    should(actual).match({ governed: true, passwordSet: false, confirmChange: false });
  });

  it('should answer for an axis its own route never demanded, and never disagree with the boundary', async () => {
    // A read route asking "and would `configure` be allowed?" is how a panel explains a limit BEFORE
    // somebody clicks into it. It is the same `decide` the boundary just used, over the same
    // evaluation, so the two can never come to different answers about one request.
    // Arrange
    const context = world({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, fleet: { use: true, configure: false } },
    });
    await context.service.refresh();

    // Act
    const governance = context.service.governance(remote);
    const reported = governance.decide({ capability: 'fleet', axis: 'configure' });
    const enforced = context.service.decide({ capability: 'fleet', axis: 'configure' }, remote);

    // Assert
    should(reported).deepEqual({ allowed: false, refusal: 'not-granted' });
    should(reported).deepEqual(enforced);
    should(governance.decide({ capability: 'fleet', axis: 'use' })).deepEqual({ allowed: true, refusal: 'granted' });
  });
});

describe('confirming one change against the operator password', () => {
  it('should accept the password and mint nothing, so the proof cannot outlive the request', async () => {
    // THE DIFFERENCE FROM `unlock`. An unlock is a bearer value good for five minutes and any number
    // of `configure` demands; this is spent inside the one request that carries it and leaves
    // nothing behind, which is what binds it to a single change rather than opening a window.
    // Arrange
    const context = world({ password: 'the operator knows this' });
    await context.service.refresh();

    // Act
    const actual = await context.service.confirmChange('the operator knows this');

    // Assert — no unlock was minted, so a later request presenting nothing is still governed.
    should(actual).deepEqual({ kind: 'confirmed' });
    should(context.service.view(remote).unlocked).be.false();
    should(context.service.governance(remote).governed).be.true();
  });

  it('should refuse a wrong password and spend one of the SAME five tries an unlock spends', async () => {
    // A separate budget here would hand an attacker a fresh five for every surface that asked, which
    // is the exact reasoning the unlock ledger is already keyed per daemon for.
    // Arrange
    const context = world({ password: 'the operator knows this' });
    await context.service.refresh();

    // Act
    const wrong = await context.service.confirmChange('not it');

    // Assert
    should(wrong).deepEqual({ kind: 'refused', reason: 'wrong-password' });
    should(context.service.view(remote).attemptsRemaining).equal(GRANT_UNLOCK_MAX_ATTEMPTS - 1);
  });

  it('should lock out after the shared budget and refuse even a correct password', async () => {
    // THE RATE LIMIT IS CHECKED FIRST and applies to a caller that would have got it right: a
    // limiter that let correct guesses through early would leak whether a guess was correct while
    // claiming to be closed.
    // Arrange
    const context = world({ password: 'the operator knows this' });
    await context.service.refresh();
    for (let attempt = 0; attempt < GRANT_UNLOCK_MAX_ATTEMPTS - 1; attempt += 1) {
      await context.service.confirmChange('not it');
    }

    // Act
    const last = await context.service.confirmChange('not it');
    const correct = await context.service.confirmChange('the operator knows this');

    // Assert
    should(last).deepEqual({ kind: 'refused', reason: 'rate-limited' });
    should(correct).deepEqual({ kind: 'refused', reason: 'rate-limited' });
  });

  it('should clear the ledger when the password is right, exactly as an unlock does', async () => {
    // Arrange
    const context = world({ password: 'the operator knows this' });
    await context.service.refresh();
    await context.service.confirmChange('not it');

    // Act
    const confirmed = await context.service.confirmChange('the operator knows this');

    // Assert — the holder proved who they are, so a mistyped attempt does not follow them around.
    should(confirmed).deepEqual({ kind: 'confirmed' });
    should(context.service.view(remote).attemptsRemaining).equal(GRANT_UNLOCK_MAX_ATTEMPTS);
  });

  it('should report a machine with no password as itself rather than as a wrong password', async () => {
    // `fy daemon password clear` can run while a change is staged, so the boundary's `passwordSet`
    // and this check can genuinely disagree. Reporting it as a wrong password would send somebody
    // hunting for a secret the machine no longer has.
    // Arrange
    const context = world();
    await context.service.refresh();

    // Act
    const actual = await context.service.confirmChange('anything at all');

    // Assert
    should(actual).deepEqual({ kind: 'refused', reason: 'no-password' });
  });
});
