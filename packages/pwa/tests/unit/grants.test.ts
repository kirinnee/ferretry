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
  deviceGrantCommand,
  deviceGrantNote,
  grantAlreadyReads,
  grantChangeable,
  grantGuidance,
  grantOnlyAtMachine,
  grantPatch,
  grantRefusalNotice,
  grantScopeKey,
  grantScopeNote,
  mayGrantCapability,
  openReason,
  openReasonLabel,
  originNote,
  postureCopy,
  REMOTE_ONE_WAY_NOTE,
  remoteRevokeWarning,
  STEP_UP_FALLBACK_ACT,
  STEP_UP_NOTE,
  stepUpAct,
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

  it('words an act for every capability on each axis, and only the settings axis names the capability', () => {
    for (const capability of DAEMON_CAPABILITIES) {
      const use = stepUpAct({ capability, axis: 'use' });
      const configure = stepUpAct({ capability, axis: 'configure' });
      expect(use.length).toBeGreaterThan(0);
      expect(configure).toBe(`change the settings for ${capabilityNoun(capability)}`);
    }
    expect(new Set(DAEMON_CAPABILITIES.map(capability => stepUpAct({ capability, axis: 'use' }))).size).toBe(
      DAEMON_CAPABILITIES.length,
    );
    expect(stepUpAct({ capability: 'terminal', axis: 'use' })).toBe('open a terminal');
    // An act that adds access is named as itself, never as the capability's general use.
    expect(stepUpAct({ capability: 'pairing', axis: 'use', act: 'add-device' })).toBe('add a device');
    expect(stepUpAct({ capability: 'pairing', axis: 'use', act: 'widen-device' })).toBe(
      'give another device more access',
    );
    // Turning "what agents may control" back on remotely (T, owner decision): same rail, its own verb.
    expect(stepUpAct({ capability: 'fleet', axis: 'configure', act: 'enable-agent-control' })).toBe(
      'let agents control that again',
    );
    expect(stepUpAct({ capability: 'browser', axis: 'use' })).toBe('open the remote browser');
    expect(stepUpAct({ capability: 'pairing', axis: 'use' })).toBe('add or manage a paired device');
    expect(stepUpAct({ capability: 'secrets', axis: 'use' })).toBe('run a command with a stored secret');
    expect(STEP_UP_FALLBACK_ACT).toBe('make this change');
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

  it('words `device-not-granted` as a widen of this one device, and never as a passkey or an operator decision', () => {
    // The machine allows it; only THIS device lacks it. A passkey cannot help and the operator has not said no.
    const bare = grantGuidance('device-not-granted');
    const named = grantGuidance('device-not-granted', 'terminal');
    expect(bare.tone).toBe('limit');
    expect(bare.offersStepUp).toBe(false);
    expect(bare.explanation).toContain('this device has not been given it');
    expect(named.explanation).toContain(capabilityNoun('terminal'));
    expect(named.explanation).toContain('fy device grant <device> terminal --use');
    expect(named.explanation).not.toContain('operator');
  });

  it('describes the secret store as code on the machine, in the dangerous tier beside the terminal', () => {
    expect(capabilityNoun('secrets')).toBe('the secret store');
    expect(capabilityLabel('secrets')).toBe('Secrets');
    expect(capabilityReach('secrets')).toContain('code on this machine');
    expect(capabilityReach('secrets')).toContain('sets or deletes stored secrets');
    expect(capabilityWeight('secrets')).toBe(capabilityWeight('terminal'));
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
    expect(remoteRevokeWarning('sharing')).toContain('fy daemon config set sharing --use');
    expect(remoteRevokeWarning('sharing')).not.toContain('also stops');
    expect(grantOnlyAtMachine('fleet')).toContain('fy daemon config set fleet --use');
    expect(grantOnlyAtMachine('fleet')).not.toMatch(/password|unlock/iu);
    expect(grantOnlyAtMachine('fleet', 'fyd')).toContain('fyd daemon config set fleet --use');
  });

  it('describes the one-way door, and says a browser on the machine does not get past it', () => {
    expect(REMOTE_ONE_WAY_NOTE).toContain('never back on');
    expect(REMOTE_ONE_WAY_NOTE).toContain('even on the machine itself');
    expect(REMOTE_ONE_WAY_NOTE).toContain('fy daemon config set');
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

  it('lets an ungoverned caller (the CLI, never a browser) change anything', () => {
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
      ['grant_device_not_granted', 'device-not-granted'],
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
  it('reads a governed connection as governed, and has no direct-local reading at all', () => {
    expect(connectionPosture(true)).toBe('governed');
    expect(postureCopy('governed').headline).toContain('even when it runs on the machine itself');
  });

  it('keeps “cannot tell” for a daemon that said nothing, rather than assuming the flattering answer', () => {
    expect(connectionPosture(undefined)).toBe('unknown');
  });

  it('never tells a browser that the limits do not apply, even when the daemon says it is not governed', () => {
    // No browser is ever ungoverned (only the CLI is), so "not governed" is not something to flatter.
    expect(connectionPosture(false)).toBe('unknown');
  });

  it('has copy for every posture, and none of it mentions a password or an unlock', () => {
    for (const posture of ['governed', 'unknown'] as const) {
      const copy = postureCopy(posture);
      expect(copy.badge.length).toBeGreaterThan(0);
      expect(`${copy.headline} ${copy.detail}`).not.toMatch(/password|unlock|standing at the machine/iu);
    }
    expect(postureCopy('governed').detail).toContain('passkey');
  });

  it('says who the limits apply to, and that a browser on the machine is not exempt', () => {
    expect(grantScopeKey('governed')).toBe('this-browser');
    expect(grantScopeNote('governed')).toContain('on the machine itself included');
    expect(grantScopeKey('unknown')).toBe('cannot-tell');
    expect(grantScopeNote('unknown')).toContain('safe reading');
    for (const posture of ['governed', 'unknown'] as const)
      expect(grantScopeNote(posture)).not.toMatch(/password|unlock/iu);
  });
});

describe('why an axis is open', () => {
  it('puts a pending step-up ahead of every other reading, because it is the next step', () => {
    const waiting = entry({ use: false, useRefusal: 'step-up-required' });
    for (const posture of ['governed', 'unknown'] as const) expect(openReason(waiting, 'use', posture)).toBe('step-up');
    expect(openReasonLabel('step-up')).toBe('Open — after your passkey');
  });

  it('reads closed, unknown and granted off the axis and the posture', () => {
    const shut = entry({ configure: false, configureRefusal: 'not-granted' });
    expect(openReason(shut, 'configure', 'governed')).toBe('closed');
    expect(openReason(entry(), 'use', 'unknown')).toBe('unknown');
    expect(openReason(entry(), 'use', 'governed')).toBe('granted');
    for (const reason of ['granted', 'closed', 'unknown'] as const)
      expect(openReasonLabel(reason).length).toBeGreaterThan(0);
  });
});

describe('the per-device grant', () => {
  it('names the host command that widens one device, with the product binary threaded through', () => {
    expect(deviceGrantCommand('terminal', 'use')).toBe('fy device grant <device> terminal --use');
    expect(deviceGrantCommand('secrets', 'configure', 'ferret')).toBe(
      'ferret device grant <device> secrets --configure',
    );
  });

  it('is silent on the host, where there is no device grant, and when the device withholds nothing', () => {
    expect(deviceGrantNote(entry())).toBeNull();
    expect(deviceGrantNote(entry({ deviceGranted: { use: true, configure: true } }))).toBeNull();
    // Withheld by the machine as well: the daemon-wide refusal already has its own sentence.
    expect(
      deviceGrantNote(
        entry({ granted: { use: false, configure: false }, deviceGranted: { use: false, configure: false } }),
      ),
    ).toBeNull();
  });

  it('says which axes this device lacks although the machine allows them, with the remedy', () => {
    const note = deviceGrantNote(
      entry({ capability: 'terminal', deviceGranted: { use: false, configure: false } }),
      'ferret',
    );
    expect(note).toContain('use or configure of session terminals');
    expect(note).toContain('ferret device grant <device> terminal --use');
    const configureOnly = deviceGrantNote(entry({ deviceGranted: { use: true, configure: false } }));
    expect(configureOnly).toContain('configure of the agent fleet');
    expect(configureOnly).toContain('--configure');
  });
});
