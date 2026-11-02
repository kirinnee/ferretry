import { describe, it } from 'bun:test';
import {
  type CapabilityAxis,
  type CapabilityGrant,
  type CapabilityGrants,
  DAEMON_CAPABILITIES,
  type DaemonCapability,
  LIMITED_DEVICE_GRANTS,
  type GrantRefusal,
} from '@ferretry/protocol';
import should from 'should';
import {
  applyDeviceGrantPatch,
  DEFAULT_CAPABILITY_GRANTS,
  decideCapability,
  demandNeedsStepUp,
  describeGrantRefusal,
  type GrantEvaluation,
  intersectGrants,
  judgeDeviceGrantChange,
  widenableBy,
} from '../../../src/lib/grants/index.ts';

/**
 * The per-device half of `effective = daemonWide ∧ device` (`docs/design/zero-trust.md` B5).
 *
 * The matrix is written out from the contract rather than derived from the code under test: every axis
 * × every device-grant state × every daemon-wide state, for a governed caller with and without a step-up.
 */

const AXES: readonly CapabilityAxis[] = ['use', 'configure'];

const STATES: readonly CapabilityGrant[] = [
  { use: true, configure: true },
  { use: true, configure: false },
  { use: false, configure: true },
  { use: false, configure: false },
];

const ALL_ON: CapabilityGrants = DEFAULT_CAPABILITY_GRANTS;
const ALL_OFF = Object.fromEntries(
  DAEMON_CAPABILITIES.map(capability => [capability, { use: false, configure: false }]),
) as CapabilityGrants;

const withGrant = (base: CapabilityGrants, capability: DaemonCapability, grant: CapabilityGrant): CapabilityGrants => ({
  ...base,
  [capability]: grant,
});

const governed = (overrides: Partial<GrantEvaluation> = {}): GrantEvaluation => ({
  grants: ALL_ON,
  governed: true,
  hostLocal: false,
  stepUp: true,
  device: ALL_ON,
  ...overrides,
});

/** The contract, case by case: the daemon-wide refusal first, then the device's, then the step-up. */
function expected(
  axis: CapabilityAxis,
  daemonWide: CapabilityGrant,
  device: CapabilityGrant,
  needsStepUp: boolean,
  stepUp: boolean,
): GrantRefusal {
  if (!daemonWide.use || (axis === 'configure' && !daemonWide.configure)) return 'not-granted';
  if (!device.use || (axis === 'configure' && !device.configure)) return 'device-not-granted';
  if (needsStepUp && !stepUp) return 'step-up-required';
  return 'granted';
}

describe('a route that only takes away (C31: narrowing never asks again)', () => {
  it('should need no per-act step-up for a narrowing demand on any capability or axis, and still ask the grant', () => {
    // Act + Assert
    for (const capability of DAEMON_CAPABILITIES) {
      for (const axis of AXES) {
        const demand = { capability, axis, narrowing: true } as const;
        should({ capability, axis, needs: demandNeedsStepUp(demand) }).deepEqual({ capability, axis, needs: false });
        should(decideCapability(demand, governed({ stepUp: false }))).deepEqual({ allowed: true, refusal: 'granted' });
        should(decideCapability(demand, governed({ device: ALL_OFF, stepUp: false })).refusal).equal(
          'device-not-granted',
        );
        should(decideCapability(demand, governed({ grants: ALL_OFF, stepUp: false })).refusal).equal('not-granted');
      }
    }
  });

  it('should still ask the step-up of the same demand when it is not marked narrowing', () => {
    // Act
    const plain = decideCapability({ capability: 'secrets', axis: 'configure' }, governed({ stepUp: false }));

    // Assert
    should(plain.refusal).equal('step-up-required');
  });
});

describe('effective = daemon-wide AND device, for a governed caller', () => {
  it('should answer every axis × device grant × daemon-wide grant × step-up exactly as the contract says', () => {
    // Act + Assert
    for (const capability of DAEMON_CAPABILITIES) {
      for (const axis of AXES) {
        for (const daemonWide of STATES) {
          for (const device of STATES) {
            for (const stepUp of [true, false]) {
              const decision = decideCapability(
                { capability, axis },
                governed({
                  grants: withGrant(ALL_ON, capability, daemonWide),
                  device: withGrant(ALL_ON, capability, device),
                  stepUp,
                }),
              );
              const needsStepUp = demandNeedsStepUp({ capability, axis });
              const want = expected(axis, daemonWide, device, needsStepUp, stepUp);
              // An allowed act that leaned on the step-up says so, so a single-use one can be spent (B6).
              should(decision).deepEqual({
                allowed: want === 'granted',
                refusal: want,
                ...(want === 'granted' && needsStepUp ? { steppedUp: true } : {}),
              });
            }
          }
        }
      }
    }
  });

  it('should leave the host ungoverned whatever its device record says', () => {
    // B4: somebody at the machine already has the machine, so no device narrowing applies to it.
    // Act + Assert
    for (const capability of DAEMON_CAPABILITIES) {
      for (const axis of AXES) {
        should(
          decideCapability(
            { capability, axis },
            governed({ governed: false, hostLocal: true, stepUp: false, device: ALL_OFF, grants: ALL_OFF }),
          ),
        ).deepEqual({ allowed: true, refusal: 'granted' });
      }
    }
  });

  it('should refuse a proven device whose record is gone, rather than serve it unnarrowed', () => {
    // Act
    const decision = decideCapability({ capability: 'fleet', axis: 'use' }, governed({ device: null }));

    // Assert
    should(decision).deepEqual({ allowed: false, refusal: 'undetermined' });
  });

  it('should apply no device narrowing to a governed caller that is not a device', () => {
    // A remote warden has no device record; it is narrowed by the daemon-wide grant and the step-up only.
    // Arrange
    const { device: _omitted, ...withoutDevice } = governed();

    // Act
    const decision = decideCapability({ capability: 'warden', axis: 'use' }, withoutDevice);

    // Assert
    should(decision).deepEqual({ allowed: true, refusal: 'granted' });
  });

  it('should let a DEFAULT device read the fleet and nothing else', () => {
    // A newly paired device gets `fleet.use` only.
    // Act
    const allowed = DAEMON_CAPABILITIES.flatMap(capability =>
      AXES.filter(
        axis => decideCapability({ capability, axis }, governed({ device: LIMITED_DEVICE_GRANTS })).allowed,
      ).map(axis => `${capability}.${axis}`),
    );

    // Assert
    should(allowed).deepEqual(['fleet.use']);
  });

  it('should refuse the secrets routes to a device without the grant, and need a step-up to run one', () => {
    // Act
    const unGranted = decideCapability(
      { capability: 'secrets', axis: 'use' },
      governed({ device: LIMITED_DEVICE_GRANTS }),
    );
    const unconfirmed = decideCapability({ capability: 'secrets', axis: 'use' }, governed({ stepUp: false }));
    const setting = decideCapability(
      { capability: 'secrets', axis: 'configure' },
      governed({ device: withGrant(ALL_OFF, 'secrets', { use: true, configure: false }) }),
    );

    // Assert
    should([unGranted.refusal, unconfirmed.refusal, setting.refusal]).deepEqual([
      'device-not-granted',
      'step-up-required',
      'device-not-granted',
    ]);
  });

  it('should tell a refused device how to be given the capability, at the machine', () => {
    // Act
    const use = describeGrantRefusal({ capability: 'terminal', axis: 'use' }, 'device-not-granted', 'fy');
    const configure = describeGrantRefusal({ capability: 'secrets', axis: 'configure' }, 'device-not-granted', 'fy');

    // Assert
    should(use).match(/`fy device grant <device> terminal --use`/u);
    should(configure).match(/`fy device grant <device> secrets --configure`/u);
    should(configure).match(/permission to change the settings for the secret store/u);
  });
});

describe('who may widen a device', () => {
  it('should let a caller on the host give every axis', () => {
    // Act + Assert
    should(widenableBy(true, undefined)).deepEqual(ALL_ON);
  });

  it('should let a remote device give only what it holds, and only when it may manage devices', () => {
    // Arrange
    const manager = withGrant(withGrant(ALL_OFF, 'pairing', { use: true, configure: true }), 'terminal', {
      use: true,
      configure: false,
    });

    // Act
    const answer = widenableBy(false, manager);

    // Assert
    should(answer.terminal).deepEqual({ use: true, configure: false });
    should(answer.pairing).deepEqual({ use: true, configure: true });
    should(answer.fleet).deepEqual({ use: false, configure: false });
  });

  it('should give nothing to widen to a remote device without pairing.configure, or to no device at all', () => {
    // Arrange
    const noManage = withGrant(ALL_ON, 'pairing', { use: true, configure: false });

    // Act + Assert
    should(widenableBy(false, noManage)).deepEqual(ALL_OFF);
    should(widenableBy(false, undefined)).deepEqual(ALL_OFF);
  });

  it('should never let a remote device grant configure it holds without use', () => {
    // Arrange — an incoherent holder state; the widen answer must still keep configure ⇒ use.
    const holder = withGrant(withGrant(ALL_OFF, 'pairing', { use: true, configure: true }), 'warden', {
      use: false,
      configure: true,
    });

    // Act + Assert
    should(widenableBy(false, holder).warden).deepEqual({ use: false, configure: false });
  });
});

describe('judging one device-grant change', () => {
  const manager = withGrant(withGrant(ALL_OFF, 'pairing', { use: true, configure: true }), 'terminal', {
    use: true,
    configure: true,
  });

  it('should allow any change at the machine, with no step-up', () => {
    // Act
    const verdict = judgeDeviceGrantChange({
      current: LIMITED_DEVICE_GRANTS,
      next: ALL_ON,
      hostLocal: true,
      stepUp: false,
      freshStepUp: false,
      holder: undefined,
    });

    // Assert
    should(verdict).deepEqual({ kind: 'allowed' });
  });

  it('should allow a remote widen of what the caller holds, with a step-up, and refuse it without one', () => {
    // Arrange
    const next = withGrant(LIMITED_DEVICE_GRANTS, 'terminal', { use: true, configure: false });

    // Act
    const confirmed = judgeDeviceGrantChange({
      current: LIMITED_DEVICE_GRANTS,
      next,
      hostLocal: false,
      stepUp: true,
      freshStepUp: true,
      holder: manager,
    });
    const unconfirmed = judgeDeviceGrantChange({
      current: LIMITED_DEVICE_GRANTS,
      next,
      hostLocal: false,
      stepUp: false,
      freshStepUp: false,
      holder: manager,
    });

    // Assert — a widen without a passkey proved for it names the act it is waiting on.
    should(confirmed).deepEqual({ kind: 'allowed' });
    should(unconfirmed).deepEqual({ kind: 'widen-step-up-required' });
  });

  it('should refuse a remote widen on the unlock alone: it needs a passkey proved for it', () => {
    // Arrange — an unlocked device (its step-up is held) with `stepUpOnActions` off.
    const next = withGrant(LIMITED_DEVICE_GRANTS, 'terminal', { use: true, configure: false });

    // Act
    const verdict = judgeDeviceGrantChange({
      current: LIMITED_DEVICE_GRANTS,
      next,
      hostLocal: false,
      stepUp: true,
      freshStepUp: false,
      holder: manager,
    });

    // Assert
    should(verdict).deepEqual({ kind: 'widen-step-up-required' });
  });

  it('should refuse a remote widen of what the caller does not hold, even with a step-up', () => {
    // Arrange
    const next = withGrant(LIMITED_DEVICE_GRANTS, 'secrets', { use: true, configure: false });

    // Act
    const verdict = judgeDeviceGrantChange({
      current: LIMITED_DEVICE_GRANTS,
      next,
      hostLocal: false,
      stepUp: true,
      freshStepUp: false,
      holder: manager,
    });

    // Assert
    should(verdict).deepEqual({ kind: 'forbidden', widened: ['secrets.use'] });
  });

  it('should refuse a remote widen by a device without pairing.configure, even of what it holds', () => {
    // Arrange
    const holder = withGrant(manager, 'pairing', { use: true, configure: false });
    const next = withGrant(LIMITED_DEVICE_GRANTS, 'terminal', { use: true, configure: false });

    // Act
    const verdict = judgeDeviceGrantChange({
      current: LIMITED_DEVICE_GRANTS,
      next,
      hostLocal: false,
      stepUp: true,
      freshStepUp: false,
      holder,
    });

    // Assert
    should(verdict).deepEqual({ kind: 'forbidden', widened: ['terminal.use'] });
  });

  it('should let a remote narrowing through with nothing else — no per-act step-up, even by a device with no grants (C31)', () => {
    // Arrange — the caller holds NOTHING beyond the default; narrowing must still never be harder.
    const current = withGrant(LIMITED_DEVICE_GRANTS, 'terminal', { use: true, configure: true });
    const next = LIMITED_DEVICE_GRANTS;

    // Act
    const confirmed = judgeDeviceGrantChange({
      current,
      next,
      hostLocal: false,
      stepUp: true,
      freshStepUp: false,
      holder: LIMITED_DEVICE_GRANTS,
    });
    const unconfirmed = judgeDeviceGrantChange({
      current,
      next,
      hostLocal: false,
      stepUp: false,
      freshStepUp: false,
      holder: undefined,
    });

    // Assert — with "ask again for each act" on, the step-up is not held; a narrowing still goes through.
    should(confirmed).deepEqual({ kind: 'allowed' });
    should(unconfirmed).deepEqual({ kind: 'allowed' });
  });

  it('should refuse a mixed patch WHOLE when any field widens illegally, before asking for a step-up', () => {
    // Arrange — terminal narrows (fine) while secrets widens (not held).
    const current = withGrant(LIMITED_DEVICE_GRANTS, 'terminal', { use: true, configure: false });
    const next = withGrant(withGrant(current, 'terminal', { use: false, configure: false }), 'secrets', {
      use: true,
      configure: false,
    });

    // Act
    const verdict = judgeDeviceGrantChange({
      current,
      next,
      hostLocal: false,
      stepUp: false,
      freshStepUp: false,
      holder: manager,
    });

    // Assert
    should(verdict).deepEqual({ kind: 'forbidden', widened: ['secrets.use'] });
  });
});

describe('applying a device-grant patch', () => {
  it('should turn use on with configure, and configure off with use', () => {
    // Act
    const widened = applyDeviceGrantPatch(LIMITED_DEVICE_GRANTS, { terminal: { configure: true } });
    const narrowed = applyDeviceGrantPatch(ALL_ON, { terminal: { use: false } });

    // Assert
    should(widened.terminal).deepEqual({ use: true, configure: true });
    should(narrowed.terminal).deepEqual({ use: false, configure: false });
  });

  it('should read a contradictory field as the narrowing, and leave unnamed capabilities alone', () => {
    // Act
    const next = applyDeviceGrantPatch(ALL_ON, { browser: { use: false, configure: true } });

    // Assert
    should(next.browser).deepEqual({ use: false, configure: false });
    should(next.fleet).deepEqual(ALL_ON.fleet);
  });

  it('should keep a plain axis change as written', () => {
    // Act
    const next = applyDeviceGrantPatch(ALL_ON, { warden: { configure: false } });

    // Assert
    should(next.warden).deepEqual({ use: true, configure: false });
  });
});

describe('intersecting grants', () => {
  it('should AND every axis', () => {
    // Arrange
    const left = withGrant(ALL_ON, 'fleet', { use: true, configure: false });
    const right = withGrant(ALL_ON, 'fleet', { use: false, configure: true });

    // Act + Assert
    should(intersectGrants(left, right).fleet).deepEqual({ use: false, configure: false });
    should(intersectGrants(ALL_ON, ALL_ON)).deepEqual(ALL_ON);
  });
});
