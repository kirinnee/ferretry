import { describe, expect, it } from 'bun:test';
import {
  CAPABILITY_AXES,
  type CapabilityGrantView,
  DAEMON_CAPABILITIES,
  GRANT_REFUSALS,
  type GrantRefusal,
  type GrantsView,
  STEP_UP_REQUIRED_CODE,
} from '@ferretry/protocol';
import {
  accessWeightsPresent,
  axisAllowed,
  axisGuidance,
  axisLabel,
  axisQuestion,
  axisRefusal,
  capabilityLabel,
  capabilityNoun,
  capabilityReach,
  capabilityWeight,
  connectionPosture,
  grantAlreadyReads,
  grantChangeable,
  grantGuidance,
  grantOnlyAtMachine,
  grantPatch,
  grantRefusalNotice,
  grantScopeKey,
  grantScopeNote,
  LOCAL_TWO_WAY_NOTE,
  mayGrantCapability,
  openReason,
  openReasonLabel,
  originNote,
  postureCopy,
  postureFromCapabilities,
  REMOTE_ONE_WAY_NOTE,
  remoteRevokeWarning,
  STEP_UP_NOTE,
  weightCopy,
  weightPips,
} from '../../src/lib/grants.ts';

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
  governed: true,
  hostLocal: false,
  steppedUp: false,
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

  it('offers a passkey step-up for `step-up-required` alone', () => {
    expect(grantGuidance('step-up-required').offersStepUp).toBe(true);
    for (const refusal of GRANT_REFUSALS.filter(candidate => candidate !== 'step-up-required'))
      expect(grantGuidance(refusal).offersStepUp).toBe(false);
  });

  it('words `step-up-required` as a passkey touch, with no password or unlock in it', () => {
    const bare = grantGuidance('step-up-required');
    const named = grantGuidance('step-up-required', 'terminal');
    expect(bare.badge).toBe('Needs your passkey');
    expect(bare.tone).toBe('limit');
    expect(bare.explanation).toContain('passkey');
    expect(named.explanation).toContain(capabilityNoun('terminal'));
    for (const guidance of [bare, named]) expect(guidance.explanation).not.toMatch(/password|unlock/iu);
    for (const refusal of GRANT_REFUSALS) expect(grantGuidance(refusal).explanation).not.toMatch(/password|unlock/iu);
    expect(STEP_UP_NOTE).toContain('passkey');
    expect(STEP_UP_NOTE).not.toMatch(/password|unlock/iu);
  });

  it('never claims a credential stood behind a plain allowed answer', () => {
    expect(grantGuidance('granted').explanation).toBe('The operator allows this.');
  });

  it('names the capability in the two refusals a person acts on per capability', () => {
    expect(grantGuidance('not-granted', 'terminal').explanation).toContain(capabilityNoun('terminal'));
    expect(grantGuidance('step-up-required', 'warden').explanation).toContain(capabilityNoun('warden'));
    // And leaves the machine-wide facts alone: five rows repeating one sentence five times is noise.
    expect(grantGuidance('undetermined', 'fleet').explanation).toBe(grantGuidance('undetermined').explanation);
    expect(grantGuidance('granted', 'fleet').explanation).toBe(grantGuidance('granted').explanation);
  });

  it('reads each axis and its reason off the view rather than re-deriving them', () => {
    const refused = entry({ use: true, configure: false, useRefusal: 'granted', configureRefusal: 'step-up-required' });
    expect(axisAllowed(refused, 'use')).toBe(true);
    expect(axisAllowed(refused, 'configure')).toBe(false);
    expect(axisRefusal(refused, 'use')).toBe('granted');
    expect(axisRefusal(refused, 'configure')).toBe('step-up-required');
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
    expect(guidance.offersStepUp).toBe(false);

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

  it('says how a remote reader gets a switch back, and the order that avoids a lockout', () => {
    expect(remoteRevokeWarning('terminal')).toContain('fy daemon config set terminal --use');
    expect(remoteRevokeWarning('terminal', 'fyd')).toContain('fyd daemon config set terminal --use');
    expect(remoteRevokeWarning('terminal')).not.toContain('revoke that device FIRST');
    expect(remoteRevokeWarning('pairing')).toContain('revoke that device FIRST');
    expect(grantOnlyAtMachine('fleet')).toContain('fy daemon config set fleet --use');
    expect(grantOnlyAtMachine('fleet')).not.toMatch(/password|unlock/iu);
    expect(grantOnlyAtMachine('fleet', 'fyd')).toContain('fyd daemon config set fleet --use');
  });

  it('describes the one-way and two-way doors', () => {
    expect(REMOTE_ONE_WAY_NOTE).toContain('never back on');
    expect(LOCAL_TWO_WAY_NOTE).toContain('both ways');
    expect(mayGrantCapability(entry({ mayGrant: true }))).toBe(true);
    expect(mayGrantCapability(entry({ mayGrant: false }))).toBe(false);
  });

  it('weighs every capability and keys only the weights present, most access first', () => {
    for (const capability of DAEMON_CAPABILITIES) {
      expect(weightPips(capabilityWeight(capability))).toBeGreaterThan(0);
      expect(weightCopy(capabilityWeight(capability)).label.length).toBeGreaterThan(0);
    }
    expect(accessWeightsPresent(['warden', 'fleet'])).toEqual(['broad', 'moderate']);
    expect(accessWeightsPresent([])).toEqual([]);
  });
});

describe('grantPatch', () => {
  it('names one capability and one axis, so a stale tab cannot revert what it never read', () => {
    expect(grantPatch('warden', 'configure', false)).toEqual({ warden: { configure: false } });
    expect(grantPatch('fleet', 'use', true)).toEqual({ fleet: { use: true } });
  });
});

describe('grantChangeable', () => {
  const noConfigure = entry({ granted: { use: true, configure: false } });
  const noUse = entry({ granted: { use: false, configure: true } });

  it('lets a governed caller change a capability only when it holds use AND configure on it', () => {
    expect(grantChangeable(view({ governed: true }), entry())).toBe(true);
    expect(grantChangeable(view({ governed: true }), noConfigure)).toBe(false);
    expect(grantChangeable(view({ governed: true }), noUse)).toBe(false);
  });

  it('lets a caller on the host change anything, because it is not governed', () => {
    const local = view({ governed: false, hostLocal: true });
    expect(grantChangeable(local, noConfigure)).toBe(true);
    expect(grantChangeable(local, noUse)).toBe(true);
  });

  it('is not decided by a passkey step-up, which can always be obtained on the spot', () => {
    expect(grantChangeable(view({ governed: true, steppedUp: false }), entry())).toBe(true);
    expect(grantChangeable(view({ governed: true, steppedUp: true }), noConfigure)).toBe(false);
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
      [STEP_UP_REQUIRED_CODE, 'step-up-required'],
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

  it('recognises the step-up code as a 403 and the lost decision as a 503, and nothing as a 429', () => {
    expect(STEP_UP_REQUIRED_CODE).toBe('grant_step_up_required');
    const stepUp = grantRefusalNotice(httpError(403, STEP_UP_REQUIRED_CODE));
    expect(stepUp?.refusal).toBe('step-up-required');
    expect(stepUp?.guidance.offersStepUp).toBe(true);
    expect(grantRefusalNotice(httpError(503, 'grants_undetermined'))?.refusal).toBe('undetermined');
    expect(grantRefusalNotice(httpError(429, STEP_UP_REQUIRED_CODE))).toBeNull();
    expect(grantRefusalNotice(httpError(429, 'grant_not_granted'))).toBeNull();
  });

  it('no longer knows the password-era codes', () => {
    expect(grantRefusalNotice(httpError(403, 'grant_locked'))).toBeNull();
    expect(grantRefusalNotice(httpError(429, 'grant_rate_limited'))).toBeNull();
  });

  it('is null for everything that is not a grant refusal, so ordinary failures read normally', () => {
    expect(grantRefusalNotice(httpError(403, 'fleet_apply_refused'))).toBeNull();
    expect(grantRefusalNotice(httpError(404, 'grant_not_granted'))).toBeNull();
    expect(grantRefusalNotice(new Error('the daemon is unreachable'))).toBeNull();
    expect(grantRefusalNotice(null)).toBeNull();
    expect(grantRefusalNotice('a string')).toBeNull();
    expect(grantRefusalNotice({ status: 403 })).toBeNull();
  });

  it('carries an empty detail rather than inventing one when the daemon said nothing', () => {
    expect(grantRefusalNotice(Object.assign(new Error(''), { status: 403, code: STEP_UP_REQUIRED_CODE }))?.detail).toBe(
      '',
    );
  });
});

describe('the posture', () => {
  it('reads governed callers as remote and ungoverned ones as at the machine', () => {
    expect(connectionPosture(false)).toBe('direct-local');
    expect(connectionPosture(true)).toBe('governed-remote');
  });

  it('keeps “cannot tell” for a daemon that said nothing, rather than assuming the flattering answer', () => {
    expect(connectionPosture(undefined)).toBe('unknown');
  });

  it('falls back to the capabilities only when they agree, and never to the friendly side', () => {
    expect(postureFromCapabilities([])).toBe('unknown');
    expect(postureFromCapabilities([entry({ mayGrant: true }), entry({ mayGrant: true })])).toBe('direct-local');
    expect(postureFromCapabilities([entry({ mayGrant: false })])).toBe('governed-remote');
    expect(postureFromCapabilities([entry({ mayGrant: true }), entry({ mayGrant: false })])).toBe('unknown');
  });

  it('has copy for every posture, and none of it mentions a password or an unlock', () => {
    for (const posture of ['direct-local', 'governed-remote', 'unknown'] as const) {
      const copy = postureCopy(posture);
      expect(copy.badge.length).toBeGreaterThan(0);
      expect(`${copy.headline} ${copy.detail}`).not.toMatch(/password|unlock/iu);
    }
    expect(postureCopy('governed-remote').detail).toContain('passkey');
  });

  it('says something different to each connection about who the limits apply to', () => {
    expect(grantScopeKey('governed-remote')).toBe('this-browser');
    expect(grantScopeNote('governed-remote')).toContain('reached the machine from somewhere else');
    expect(grantScopeKey('direct-local')).toBe('not-on-this-machine');
    expect(grantScopeNote('direct-local')).toContain('none of them apply to it');
    expect(grantScopeKey('unknown')).toBe('cannot-tell');
    expect(grantScopeNote('unknown')).toContain('safe reading');
    for (const posture of ['direct-local', 'governed-remote', 'unknown'] as const)
      expect(grantScopeNote(posture)).not.toMatch(/password|unlock/iu);
  });
});

describe('why an axis is open', () => {
  it('puts a pending step-up ahead of every other reading, because it is the next step', () => {
    const waiting = entry({ use: false, useRefusal: 'step-up-required' });
    for (const posture of ['direct-local', 'governed-remote', 'unknown'] as const)
      expect(openReason(waiting, 'use', posture)).toBe('step-up');
    expect(openReasonLabel('step-up')).toBe('Open — after your passkey');
  });

  it('reads closed, ungoverned, unknown and granted off the axis and the posture', () => {
    const shut = entry({ configure: false, configureRefusal: 'not-granted' });
    expect(openReason(shut, 'configure', 'governed-remote')).toBe('closed');
    expect(openReason(entry(), 'use', 'direct-local')).toBe('ungoverned');
    expect(openReason(entry(), 'use', 'unknown')).toBe('unknown');
    expect(openReason(entry(), 'use', 'governed-remote')).toBe('granted');
    for (const reason of ['ungoverned', 'granted', 'closed', 'unknown'] as const)
      expect(openReasonLabel(reason).length).toBeGreaterThan(0);
  });
});
