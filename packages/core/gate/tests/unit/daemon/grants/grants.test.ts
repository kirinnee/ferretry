import { describe, expect, test } from 'bun:test';
import {
  type CapabilityGrants,
  type CapabilityPresentation,
  DEFAULT_CAPABILITY_GRANTS,
  LIMITED_DEVICE_GRANTS,
} from '../../../../contract/index.ts';
import manifest from '../../../../manifest.ts';
import {
  type GrantAuditEntry,
  GrantError,
  GrantService,
  GrantsPatchSchema,
} from '../../../../daemon/lib/grants/service.ts';

function service(start: CapabilityGrants | 'undetermined' = DEFAULT_CAPABILITY_GRANTS, written = false) {
  let grants: CapabilityGrants | undefined = start === 'undetermined' ? undefined : start;
  const history: GrantAuditEntry[] = [];
  const svc = new GrantService({
    document: {
      read: () => grants,
      written: () => written,
      write: async next => {
        grants = next;
      },
    },
    history: {
      record: async entry => {
        history.push(entry);
      },
      recent: async limit => ({ entries: history.toReversed().slice(0, limit), unreadable: 0, truncated: false }),
    },
    clock: { now: () => '2026-11-07T12:00:00.000Z' },
    clientName: 'fy',
  });
  return { svc, history, grants: () => grants as CapabilityGrants };
}

const owner: CapabilityPresentation = { local: true, adminToken: true, actor: 'admin-cli', stepUp: false };
const phone = (stepUp = true, deviceGrants: CapabilityGrants = DEFAULT_CAPABILITY_GRANTS): CapabilityPresentation => ({
  local: false,
  adminToken: false,
  actor: 'device:phone',
  stepUp,
  deviceGrants,
});

const failure = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'applied';
  } catch (error) {
    return error instanceof GrantError ? `${error.failure}: ${error.message}` : String(error);
  }
};

describe('the grants surface', () => {
  test('G9 GrantsView reports governed, hostLocal and steppedUp as separate fields', () => {
    const { svc } = service();
    expect(svc.view(owner)).toMatchObject({ governed: false, hostLocal: true, steppedUp: false });
    expect(svc.view(phone(true))).toMatchObject({ governed: true, hostLocal: false, steppedUp: true });
  });

  test('G124 G151 mayGrant warns before anyone acts; deviceGranted shows the device’s own record', () => {
    const { svc } = service();
    const view = svc.view(phone(true, LIMITED_DEVICE_GRANTS));
    expect(view.capabilities.every(c => c.mayGrant === false)).toBe(true);
    expect(view.capabilities.find(c => c.capability === 'terminal')).toMatchObject({
      use: false,
      useRefusal: 'device-not-granted',
      deviceGranted: { use: false, configure: false },
    });
    expect(svc.view(owner).capabilities.every(c => c.mayGrant)).toBe(true);
  });

  test('G46 G121 a remote caller can never turn a capability on, step-up or not, and the refusal names the host command', async () => {
    const off = { ...DEFAULT_CAPABILITY_GRANTS, fleet: { use: false, configure: false } };
    const { svc } = service(off);
    const refusal = await failure(svc.patch({ fleet: { use: true } }, phone(true)));
    expect(refusal).toContain('forbidden');
    expect(refusal).toContain('`fy daemon config set fleet --use`');
  });

  test('G123 a patch that widens one capability and narrows another is refused entirely', async () => {
    const off = { ...DEFAULT_CAPABILITY_GRANTS, fleet: { use: false, configure: false } };
    const { svc, grants } = service(off);
    expect(await failure(svc.patch({ fleet: { use: true }, terminal: { use: false } }, phone(true)))).toContain(
      'forbidden',
    );
    expect(grants().terminal.use).toBe(true);
  });

  test('G122 G126 remotely, turning off an on capability needs the live step-up', async () => {
    const { svc } = service();
    expect(await failure(svc.patch({ terminal: { use: false } }, phone(false)))).toContain('step-up-required');
    expect(await failure(svc.patch({ terminal: { use: false } }, phone(true)))).toBe('applied');
  });

  test('G159 a change moves the answer in the same call and is recorded after the write', async () => {
    const { svc, grants, history } = service();
    await svc.patch({ browser: { configure: false } }, owner);
    expect(grants().browser).toEqual({ use: true, configure: false });
    expect(history).toEqual([
      { at: '2026-11-07T12:00:00.000Z' as GrantAuditEntry['at'], actor: 'admin-cli', changes: ['browser.configure=off'] },
    ]);
  });

  test('G155 each capability reports its origin: default, or the config file', () => {
    expect(service().svc.view(owner).capabilities[0]?.origin).toBe('default');
    expect(service(DEFAULT_CAPABILITY_GRANTS, true).svc.view(owner).capabilities[0]?.origin).toBe('config file');
  });

  test('G154 an undetermined document reports both axes shut and refuses every change', async () => {
    const { svc } = service('undetermined');
    expect(svc.view(phone()).capabilities.every(c => !c.use && c.useRefusal === 'undetermined')).toBe(true);
    expect(await failure(svc.patch({ fleet: { use: false } }, owner))).toContain('unavailable');
  });

  test('G160 the grant history is a person route, and an empty patch is refused', () => {
    expect(manifest.actions.routes.find(route => route.key === 'GET /v1/grants/audit')).toMatchObject({
      minimum: 'operator',
      caller: 'person',
    });
    expect(GrantsPatchSchema.safeParse({}).success).toBe(false);
  });
});
