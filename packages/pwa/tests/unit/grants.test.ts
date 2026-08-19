import { describe, expect, it } from 'bun:test';
import {
  CAPABILITY_AXES,
  type CapabilityGrantView,
  DAEMON_CAPABILITIES,
  GRANT_REFUSALS,
  type GrantRefusal,
  type GrantsView,
  OPERATOR_PASSWORD_MIN_LENGTH,
} from '@ferretry/protocol';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import {
  axisAllowed,
  axisChangeLocked,
  axisGuidance,
  axisLabel,
  axisQuestion,
  axisRefusal,
  capabilityLabel,
  capabilityNoun,
  capabilityReach,
  connectionPosture,
  grantAlreadyReads,
  grantChangeNeedsUnlock,
  grantGuidance,
  grantPatch,
  grantRefusalNotice,
  grantScopeKey,
  grantScopeNote,
  NO_PASSWORD_DISCLOSURE,
  OPERATOR_PASSWORD_RULE_NOTE,
  operatorPasswordMismatch,
  operatorPasswordProblem,
  operatorUnlockFailure,
  originNote,
  PAIRING_PASSWORD_REQUIREMENT,
  PAIRING_PASSWORD_REQUIREMENT_REMOTE,
  PASSWORD_ARRIVAL_VS_CREDENTIAL,
  PASSWORD_HOST_SET_COMMAND,
  PASSWORD_ONE_WAY_NOTE,
  PASSWORD_RECOVERY_NOTE,
  PASSWORD_REMOTE_UNAVAILABLE,
  pairingGate,
  pairingNeedsPassword,
  passwordControlState,
  UNLOCK_LIMIT_NOTE,
  unlockSecondsRemaining,
  usableUnlock,
} from '../../src/lib/grants.ts';

const daemonId = (id: string) =>
  daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceToken: `token-${id}` }).daemonId;

const entry = (overrides: Partial<CapabilityGrantView> = {}): CapabilityGrantView => ({
  capability: 'fleet',
  use: true,
  configure: true,
  granted: { use: true, configure: true },
  useRefusal: 'granted',
  configureRefusal: 'granted',
  origin: 'default',
  mayGrant: false,
  ...overrides,
});

const view = (overrides: Partial<GrantsView> = {}): GrantsView => ({
  capabilities: DAEMON_CAPABILITIES.map(capability => entry({ capability })),
  // Governed by default, and NOT on the host: these fixtures stand for a paired device somewhere else.
  // The two are separate facts now — a browser ON the machine is governed too until it unlocks.
  governed: true,
  hostLocal: false,
  passwordSet: false,
  unlocked: false,
  ...overrides,
});

/** An error shaped like the two the daemon's failures actually arrive as. */
const httpError = (status: number, code: string, message = 'the daemon said so') =>
  Object.assign(new Error(message), { status, code });

describe('grant vocabulary', () => {
  it('names every capability the protocol declares, so a row can never render a bare key', () => {
    for (const capability of DAEMON_CAPABILITIES) {
      expect(capabilityNoun(capability).length).toBeGreaterThan(0);
      expect(capabilityLabel(capability).length).toBeGreaterThan(0);
      expect(capabilityReach(capability).length).toBeGreaterThan(0);
    }
    // The drift that would matter: a capability added to the enum with no prose here.
    expect(new Set(DAEMON_CAPABILITIES.map(capabilityNoun)).size).toBe(DAEMON_CAPABILITIES.length);
  });

  it('asks both axes as questions rather than restating the wire spelling', () => {
    for (const axis of CAPABILITY_AXES) {
      expect(axisLabel(axis).length).toBeGreaterThan(0);
      expect(axisQuestion(axis)).toContain('?');
    }
  });

  it('has guidance for every declared refusal, so a new reason cannot render as a generic failure', () => {
    for (const refusal of GRANT_REFUSALS) {
      const guidance = grantGuidance(refusal);
      expect(guidance.explanation.length).toBeGreaterThan(0);
      expect(guidance.badge.length).toBeGreaterThan(0);
    }
  });

  it('offers an unlock for `locked` alone — never while the daemon has stopped checking', () => {
    expect(grantGuidance('locked').offersUnlock).toBe(true);
    for (const refusal of GRANT_REFUSALS.filter(candidate => candidate !== 'locked'))
      expect(grantGuidance(refusal).offersUnlock).toBe(false);
  });

  it('marks `ungated` as a disclosure rather than reporting a plain success', () => {
    const guidance = grantGuidance('ungated');
    expect(guidance.tone).toBe('disclosure');
    expect(guidance.explanation).toContain('no operator password');
    // It does NOT restate the full disclosure: that sentence is owed once, and five capabilities ×
    // the configure axis would print it five times on one screen.
    expect(guidance.explanation).not.toContain(NO_PASSWORD_DISCLOSURE);
  });

  it('never claims the operator password stood behind an answer that did not need one', () => {
    // `granted` is what a `use` axis reads on every machine, password or not, so a sentence naming the
    // password would be false on the common setup — beside a header saying none is set, at that.
    expect(grantGuidance('granted').explanation).not.toContain('password');
  });

  it('names the capability in the two refusals a person acts on per capability', () => {
    expect(grantGuidance('not-granted', 'terminal').explanation).toContain(capabilityNoun('terminal'));
    expect(grantGuidance('locked', 'warden').explanation).toContain(capabilityNoun('warden'));
    // And leaves the machine-wide facts alone: five rows repeating one sentence five times is noise.
    expect(grantGuidance('undetermined', 'fleet').explanation).toBe(grantGuidance('undetermined').explanation);
    expect(grantGuidance('granted', 'fleet').explanation).toBe(grantGuidance('granted').explanation);
    expect(grantGuidance('rate-limited', 'fleet').explanation).toBe(grantGuidance('rate-limited').explanation);
  });

  it('reads each axis and its reason off the view rather than re-deriving them', () => {
    const refused = entry({ use: true, configure: false, useRefusal: 'granted', configureRefusal: 'locked' });
    expect(axisAllowed(refused, 'use')).toBe(true);
    expect(axisAllowed(refused, 'configure')).toBe(false);
    expect(axisRefusal(refused, 'use')).toBe('granted');
    expect(axisRefusal(refused, 'configure')).toBe('locked');
  });

  /**
   * The case a naive version gets silently wrong. An axis can be allowed AND immovable, and reusing
   * the `configure` refusal there tells somebody their access is switched off when it is on — which
   * sends them to the host to turn on something that is already on.
   */
  it('does not tell a reader an allowed axis is switched off just because they cannot change it', () => {
    const allowedButFixed = entry({
      capability: 'warden',
      use: true,
      configure: false,
      granted: { use: true, configure: false },
      useRefusal: 'granted',
      configureRefusal: 'not-granted',
    });
    const guidance = axisGuidance(allowedButFixed, 'use', false);
    expect(guidance.explanation).toContain('may use');
    expect(guidance.explanation).not.toContain('switched off');
    expect(guidance.offersUnlock).toBe(false);

    // A genuinely refused axis keeps the refusal's own words.
    const refused = entry({ use: false, useRefusal: 'not-granted' });
    expect(axisGuidance(refused, 'use', false).explanation).toContain('switched off');
    // And a changeable axis always reads its own reason.
    expect(axisGuidance(allowedButFixed, 'use', true).explanation).toBe(grantGuidance('granted').explanation);
  });

  it('reports provenance without dressing a default up as a problem', () => {
    expect(originNote(entry({ origin: 'config file' }))).toContain('operator');
    expect(originNote(entry({ origin: 'default' }))).toContain('default');
  });

  it('states the limiter before anybody has spent a try', () => {
    expect(UNLOCK_LIMIT_NOTE).toContain('5');
    expect(UNLOCK_LIMIT_NOTE).toContain('per machine');
  });
});

describe('grantPatch', () => {
  it('names one capability and one axis, so a stale tab cannot revert what it never read', () => {
    expect(grantPatch('warden', 'configure', false)).toEqual({ warden: { configure: false } });
    expect(grantPatch('fleet', 'use', true)).toEqual({ fleet: { use: true } });
  });
});

describe('grantChangeNeedsUnlock', () => {
  it('never demands one for a revoke — a password between a person and shutting a door is a liability', () => {
    expect(grantChangeNeedsUnlock(view({ passwordSet: true }), 'fleet', false)).toBe(false);
  });

  it('demands one to widen on a machine with the layer turned on', () => {
    expect(grantChangeNeedsUnlock(view({ passwordSet: true }), 'fleet', true)).toBe(true);
  });

  it('demands none where there is nothing to unlock: widening is then a host act', () => {
    expect(grantChangeNeedsUnlock(view({ passwordSet: false }), 'fleet', true)).toBe(false);
  });

  it('demands none for a capability the view never mentioned', () => {
    expect(grantChangeNeedsUnlock(view({ passwordSet: true, capabilities: [] }), 'fleet', true)).toBe(false);
  });
});

describe('grantAlreadyReads', () => {
  it('is true when the document already records the value a change would set', () => {
    expect(grantAlreadyReads(view(), 'fleet', 'use', true)).toBe(true);
    expect(grantAlreadyReads(view(), 'fleet', 'use', false)).toBe(false);
  });

  it('is false for a capability the view does not carry', () => {
    expect(grantAlreadyReads(view({ capabilities: [] }), 'fleet', 'use', true)).toBe(false);
  });
});

describe('grantRefusalNotice', () => {
  it('recognises every code the dispatcher composes from a refusal', () => {
    const codes: ReadonlyArray<readonly [string, GrantRefusal]> = [
      ['grant_not_granted', 'not-granted'],
      ['grant_locked', 'locked'],
      ['grant_rate_limited', 'rate-limited'],
      ['grant_undetermined', 'undetermined'],
      ['grants_undetermined', 'undetermined'],
      ['grant_forbidden', 'not-granted'],
    ];
    for (const [code, refusal] of codes) {
      const notice = grantRefusalNotice(httpError(403, code));
      expect(notice?.refusal).toBe(refusal);
      expect(notice?.guidance.explanation.length).toBeGreaterThan(0);
    }
  });

  it('keeps the daemon’s own sentence whole, because it names the command a human runs', () => {
    const notice = grantRefusalNotice(
      httpError(403, 'grant_not_granted', 'grant it on the host with `fy daemon config set terminal --use`.'),
    );
    expect(notice?.detail).toContain('fy daemon config set terminal --use');
  });

  it('accepts the 429 an unlock refusal arrives as and the 503 a lost decision does', () => {
    expect(grantRefusalNotice(httpError(429, 'grant_rate_limited'))?.refusal).toBe('rate-limited');
    expect(grantRefusalNotice(httpError(503, 'grants_undetermined'))?.refusal).toBe('undetermined');
  });

  it('is null for everything that is not a grant refusal, so ordinary failures read normally', () => {
    expect(grantRefusalNotice(httpError(403, 'fleet_apply_refused'))).toBeNull();
    expect(grantRefusalNotice(httpError(404, 'grant_locked'))).toBeNull();
    expect(grantRefusalNotice(new Error('the daemon is unreachable'))).toBeNull();
    expect(grantRefusalNotice(null)).toBeNull();
    expect(grantRefusalNotice('a string')).toBeNull();
    expect(grantRefusalNotice({ status: 403 })).toBeNull();
  });

  it('carries an empty detail rather than inventing one when the daemon said nothing', () => {
    expect(grantRefusalNotice(Object.assign(new Error(''), { status: 403, code: 'grant_locked' }))?.detail).toBe('');
  });
});

describe('usableUnlock', () => {
  const alpha = daemonId('alpha');
  const beta = daemonId('beta');
  const held = { daemonId: alpha, token: 'fy_unlock_aaaaaaaaaaaaaaaaaaaaaaaa', expiresAtMs: 1_000 };

  it('hands the token to the daemon that minted it, while it is live', () => {
    expect(usableUnlock(held, alpha, 500)).toBe(held.token);
  });

  it('refuses it for another daemon — a token is proof against exactly one machine', () => {
    expect(usableUnlock(held, beta, 500)).toBeUndefined();
  });

  it('refuses it at and after its expiry, so a screen left open stops believing it', () => {
    expect(usableUnlock(held, alpha, 1_000)).toBeUndefined();
    expect(usableUnlock(held, alpha, 1_001)).toBeUndefined();
  });

  it('holds nothing when nothing was minted', () => {
    expect(usableUnlock(null, alpha, 0)).toBeUndefined();
  });

  it('counts down in whole seconds and never below zero', () => {
    expect(unlockSecondsRemaining(held, alpha, 0)).toBe(1);
    expect(unlockSecondsRemaining(held, alpha, 2_000)).toBe(0);
    expect(unlockSecondsRemaining(held, beta, 0)).toBe(0);
    expect(unlockSecondsRemaining(null, alpha, 0)).toBe(0);
  });
});

describe('operatorUnlockFailure', () => {
  it('shows attempts remaining, because a limiter a person cannot see looks like a broken daemon', () => {
    const failure = operatorUnlockFailure(
      httpError(401, 'grant_wrong_password', 'that is not this machine’s operator password; 3 attempts remaining'),
    );
    expect(failure.attemptsRemaining).toBe(3);
    expect(failure.retryable).toBe(true);
  });

  it('reads a singular attempt too', () => {
    expect(
      operatorUnlockFailure(httpError(401, 'grant_wrong_password', 'wrong; 1 attempt remaining')).attemptsRemaining,
    ).toBe(1);
  });

  it('guesses no count when the daemon named none', () => {
    const failure = operatorUnlockFailure(httpError(401, 'grant_wrong_password', 'that is not the password'));
    expect(failure.attemptsRemaining).toBeUndefined();
    expect(failure.retryable).toBe(true);
  });

  it('stops offering a retry once the daemon has stopped checking', () => {
    const failure = operatorUnlockFailure(httpError(429, 'grant_rate_limited', 'too many wrong passwords'));
    expect(failure.retryable).toBe(false);
    expect(failure.attemptsRemaining).toBe(0);
  });

  it('says there is nothing to unlock on a machine with no password', () => {
    const failure = operatorUnlockFailure(httpError(409, 'grant_no_password', 'this machine has no operator password'));
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain('no operator password');
  });

  it('falls back to its own words when the daemon supplied none', () => {
    expect(operatorUnlockFailure(httpError(429, 'grant_rate_limited', '')).message.length).toBeGreaterThan(0);
    expect(operatorUnlockFailure(httpError(409, 'grant_no_password', '')).message).toContain('nothing to unlock');
    expect(operatorUnlockFailure(httpError(401, 'grant_wrong_password', '')).message).toContain('operator password');
    expect(operatorUnlockFailure(new Error('')).message).toContain('could not be completed');
    expect(operatorUnlockFailure(null).message).toContain('could not be completed');
  });

  it('keeps an unrecognised failure retryable rather than declaring a dead end', () => {
    expect(operatorUnlockFailure(httpError(500, 'internal', 'the daemon fell over')).retryable).toBe(true);
  });
});

describe('the posture, from two facts rather than one', () => {
  it('names the connection ON the machine but not yet unlocked, which neither old posture covered', () => {
    // `governed` used to be the exact inverse of "at the machine". `local-locked` is what happened when it
    // stopped being: a browser is a paired device wherever it runs. Collapsing this into either neighbour
    // is a lie in a different direction — "Remote" to somebody standing at the machine, or "Direct" over a
    // gate they have not passed.
    // Act + Assert
    expect(connectionPosture(false, true)).toBe('direct-local');
    expect(connectionPosture(true, true)).toBe('local-locked');
    expect(connectionPosture(true, false)).toBe('governed-remote');
    expect(connectionPosture(false, false)).toBe('governed-remote');
  });

  it('keeps “cannot tell” for a daemon that said nothing, rather than assuming the flattering answer', () => {
    // Absence has to mean something, and "no answer means loopback" would paint a remote phone as standing
    // at the machine — the one inversion this module exists to prevent.
    // Act + Assert
    expect(connectionPosture(undefined)).toBe('unknown');
    expect(connectionPosture(undefined, true)).toBe('unknown');
  });

  it('reads an OLDER daemon’s single answer as locality, because there it was one', () => {
    // A daemon from before the split gates no local browser, so `!governed` really was "at the machine"
    // there. Trusting it is not a guess about the new state; it is the only state that daemon has.
    // Act + Assert
    expect(connectionPosture(false)).toBe('direct-local');
    expect(connectionPosture(true)).toBe('governed-remote');
  });

  it('says something different to each connection about who the limits apply to', () => {
    // One sentence served every caller and stopped being true. Each branch is keyed so a screen and a
    // screenshot can name which one is on the page.
    // Act + Assert
    expect(grantScopeKey('governed-remote')).toBe('this-browser');
    expect(grantScopeNote('governed-remote')).toContain('reached the machine from somewhere else');
    expect(grantScopeKey('local-locked')).toBe('this-browser-until-unlocked');
    expect(grantScopeNote('local-locked')).toContain('paired device wherever it runs');
    expect(grantScopeKey('direct-local')).toBe('not-on-this-machine');
    expect(grantScopeNote('direct-local')).toContain('none of them apply to it right now');
    expect(grantScopeKey('unknown')).toBe('cannot-tell');
    expect(grantScopeNote('unknown')).toContain('safe reading');
  });
});

describe('a switch a local browser may press only after unlocking', () => {
  it('holds a WIDENING press until the unlock, and never a narrowing one', () => {
    // A prompt between a person and shutting a door is a liability during the incident that made them
    // reach for it. The gate is on widening; revoking is never gated.
    // Arrange
    const local = view({ governed: true, hostLocal: true, passwordSet: true });
    const widenable = entry({ mayGrant: true });

    // Act + Assert — `recorded: false` is the widening press, `true` the narrowing one.
    expect(axisChangeLocked(local, widenable, false)).toBe(true);
    expect(axisChangeLocked(local, widenable, true)).toBe(false);
  });

  it('holds nothing once the browser has unlocked, or on a machine with no password', () => {
    // One gate at the door, then full authority: there is no second question after the unlock, and none at
    // all on a machine that has nothing to unlock with.
    // Arrange
    const widenable = entry({ mayGrant: true });
    const unlocked = view({ governed: false, hostLocal: true, passwordSet: true, unlocked: true });
    const noPassword = view({ governed: false, hostLocal: true, passwordSet: false });

    // Act + Assert
    expect(axisChangeLocked(unlocked, widenable, false)).toBe(false);
    expect(axisChangeLocked(noPassword, widenable, false)).toBe(false);
  });

  it('leaves a caller that may never widen to the one-way notice instead', () => {
    // `mayGrant: false` is not a control at all, and the "only at the machine" sentence already says so.
    // Painting the password over it would offer a remedy that cannot help.
    // Arrange
    const remote = view({ governed: true, hostLocal: false, passwordSet: true });

    // Act + Assert
    expect(axisChangeLocked(remote, entry({ mayGrant: false }), false)).toBe(false);
  });
});

describe('the operator password control', () => {
  it('offers itself only where the daemon would accept it', () => {
    // Both halves of the daemon's rule, restated rather than invented: the route is refused off the host,
    // and a local browser is a paired device that must unlock before it may move an existing password.
    // Act + Assert
    expect(passwordControlState(view({ hostLocal: false }))).toEqual({ kind: 'remote' });
    expect(passwordControlState(view({ hostLocal: true, passwordSet: true, unlocked: false }))).toEqual({
      kind: 'locked',
    });
    expect(passwordControlState(view({ hostLocal: true, passwordSet: true, unlocked: true }))).toEqual({
      kind: 'ready',
      first: false,
    });
    // The state every new user starts in: nothing to prove, and a first password to set.
    expect(passwordControlState(view({ hostLocal: true, passwordSet: false }))).toEqual({ kind: 'ready', first: true });
  });

  it('reads the minimum from the protocol rather than keeping a second copy of the number', () => {
    // A hint that said "eight" while the schema wanted ten would be a lie told at the exact moment somebody
    // is trying to comply with it.
    // Act + Assert
    expect(operatorPasswordProblem('')).toContain('Enter a password');
    expect(operatorPasswordProblem('short')).toContain(String(OPERATOR_PASSWORD_MIN_LENGTH));
    expect(operatorPasswordProblem('a'.repeat(OPERATOR_PASSWORD_MIN_LENGTH))).toBeUndefined();
    expect(OPERATOR_PASSWORD_RULE_NOTE).toContain(String(OPERATOR_PASSWORD_MIN_LENGTH));
  });

  it('catches two entries that disagree, and stays quiet until both are typed', () => {
    // There is no way to read this value back, so a mistyped password is a password nobody knows.
    // Act + Assert
    expect(operatorPasswordMismatch('a-good-password', 'a-good-passwrod')).toBe(true);
    expect(operatorPasswordMismatch('a-good-password', 'a-good-password')).toBe(false);
    expect(operatorPasswordMismatch('a-good-password', '')).toBe(false);
    expect(operatorPasswordMismatch('', 'a-good-password')).toBe(false);
  });

  it('names the host recovery path in the copy a stranded reader meets', () => {
    // THE SENTENCE THAT KEEPS THIS FROM BEING A LOCKOUT. A local browser needs the current password to
    // replace it, so the reader who has forgotten theirs is exactly the reader the control refuses.
    // Act + Assert
    expect(PASSWORD_RECOVERY_NOTE).toContain(PASSWORD_HOST_SET_COMMAND);
    expect(PASSWORD_RECOVERY_NOTE).toContain('without asking for the old one');
    // It is the ONLY way back now that nothing removes a password, so the copy must not send a
    // stranded reader to a verb that no longer exists.
    expect(PASSWORD_RECOVERY_NOTE).not.toContain('password clear');
    expect(PASSWORD_ONE_WAY_NOTE).toContain('cannot be undone');
    // And the remote refusal names where it CAN be done rather than only that it cannot be done here.
    expect(PASSWORD_REMOTE_UNAVAILABLE).toContain(PASSWORD_HOST_SET_COMMAND);
    // Arrival versus credential, before the tap.
    expect(PASSWORD_ARRIVAL_VS_CREDENTIAL).toContain('same desk');
  });
});

describe('the password a first pairing requires', () => {
  it('explains before the tap when it can see there is no password, and says who can fix it from where', () => {
    // A PRE-CHECK, NOT THE RULE. `POST /v1/pair/code` refuses on a passwordless machine for every caller,
    // `fy pair` included — that is where the requirement lives and is proved. This decides only whether a
    // person is told in advance instead of meeting a control that would be refused.
    // Act + Assert
    expect(pairingGate(view({ passwordSet: true }))).toEqual({ kind: 'open' });
    expect(pairingGate(view({ passwordSet: false, hostLocal: true }))).toEqual({
      kind: 'needs-password',
      local: true,
    });
    expect(pairingGate(view({ passwordSet: false, hostLocal: false }))).toEqual({
      kind: 'needs-password',
      local: false,
    });
    expect(pairingNeedsPassword(view({ passwordSet: false }))).toBe(true);
  });

  it('says nothing in advance when it could not read the answer, and leaves the refusal to the daemon', () => {
    // THIS USED TO FAIL CLOSED, and that was right while the browser was the only thing enforcing the
    // requirement. It is a dead end now that the daemon enforces it: hiding the button would withhold a
    // control on the one machine whose grant view could not be read, while the machine that KNOWS is
    // standing by to answer with the reason and the remedy. So there is no `undetermined` state left to
    // express — one rule, in one place, and this surface only ever explains what it can already see.
    // Act + Assert
    expect(pairingGate(null)).toEqual({ kind: 'open' });
    // The copy for the state it CAN see still carries the why and the way through.
    expect(PAIRING_PASSWORD_REQUIREMENT).toContain('runnable files');
    expect(PAIRING_PASSWORD_REQUIREMENT_REMOTE).toContain(PASSWORD_HOST_SET_COMMAND);
  });
});
