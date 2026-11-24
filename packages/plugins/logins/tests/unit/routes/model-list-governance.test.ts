import { describe, it } from 'bun:test';
import { DEFAULT_GATE_CONFIG, FULL_DEVICE_GRANTS, LIMITED_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import { deviceStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { AdmissionDecision, ApiRequest, CallStanding, ScopedRoute } from '@ferretry/kernel/contract';
import should from 'should';
import manifest from '../../../manifest.ts';

/**
 * Who may ask a login's provider for its model list, through Gate's stand-in admission over the REAL descriptors the
 * manifest declares (the real `GateAdmission` decides the same demand the same way; its own suite covers the demand).
 *
 * The picker's door (`refresh`) is `fleet.use` and can only ever read a stale list. "Refresh list" (`force`) is the call
 * that makes the provider be asked on demand, so it is `fleet.configure` like the keyed Test: a paired device holding
 * only `fleet.use` (a limited one, `fy pair --limited`) is refused it.
 */
const REFRESH = 'POST /v1/logins/:loginId/model-list/refresh';
const FORCE = 'POST /v1/logins/:loginId/model-list/force';
const TEST = 'POST /v1/logins/:loginId/test';

const descriptor = (key: string): ScopedRoute => {
  const declared = manifest.actions.routes.find(candidate => candidate.key === key);
  if (declared === undefined) throw new Error(`the logins manifest declares no ${key}`);
  return declared as unknown as ScopedRoute;
};

const request = (path: string): ApiRequest => ({
  method: 'POST',
  path,
  query: new Map(),
  headers: new Map(),
  arrival: { kind: 'carried', carrier: 'direct' } as ApiRequest['arrival'],
  text: async () => '{}',
});

const admit = (key: string, standing: CallStanding): AdmissionDecision =>
  new StandInAdmission(
    () => standing,
    () => DEFAULT_GATE_CONFIG,
  ).admit({
    table: 'route',
    descriptor: descriptor(key),
    request: request(key.split(' ')[1]?.replace(':loginId', 'deepseek') ?? ''),
    params: new Map([['loginId', 'deepseek']]),
  });

describe('who may read a login’s model list', () => {
  it('should declare "Refresh list" as fleet.configure and the picker’s read as fleet.use', () => {
    // Assert
    should(String(descriptor(FORCE).capability?.capability)).equal('fleet');
    should(descriptor(FORCE).capability?.axis).equal('configure');
    should(descriptor(TEST).capability?.axis).equal('configure');
    should(String(descriptor(REFRESH).capability?.capability)).equal('fleet');
    should(descriptor(REFRESH).capability?.axis).equal('use');
  });

  it('should refuse a remote paired device holding only fleet.use the forced refresh, and let it open a picker', () => {
    // Arrange
    const limited = deviceStanding('phone', LIMITED_DEVICE_GRANTS);

    // Act
    const forced = admit(FORCE, limited);
    const picker = admit(REFRESH, limited);

    // Assert
    should(forced.outcome).equal('refused');
    should((forced as { response: { status: number } }).response.status).equal(403);
    should(picker.outcome).equal('admitted');
  });

  it('should let a device holding fleet.configure, and the owner at the machine, force a refresh', () => {
    // Assert
    should(admit(FORCE, deviceStanding('phone', FULL_DEVICE_GRANTS)).outcome).equal('admitted');
    should(admit(FORCE, ownerStanding()).outcome).equal('admitted');
  });

  it('should refuse a device with no fleet grant at all both doors', () => {
    // Arrange
    const none = deviceStanding('phone', { ...FULL_DEVICE_GRANTS, fleet: { use: false, configure: false } });

    // Assert
    should(admit(FORCE, none).outcome).equal('refused');
    should(admit(REFRESH, none).outcome).equal('refused');
  });
});
