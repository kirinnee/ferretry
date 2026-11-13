/**
 * G83 S90 R-0399: the real Access and the real Accounts, as the generated registry builds them, on the kernel test host. Access issues a passkey
 * challenge for a staged act only through the plugin that staged it (`step-up.stages:<act>`), so these cases boot both
 * halves and ask the step-up options route as a paired device. Not `stage_not_found` for a waiting stage, the bound
 * subject on the challenge, `stage_not_found` for another device (the per-device acts) and for an unknown stage.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../gate/contract/index.ts';
import { deviceStanding, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeSealedDocuments, FakeVault } from '../../../../vault/contract/testing/index.ts';
import { DevicesFile, HOSTED_APP_ORIGIN, PasskeysFile } from '../../../../../plugins/access/contract/index.ts';
import { padInputValue } from '../../../../../plugins/accounts/contract/routes/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { device, fixedClock, type TestHost, testHost } from '../../../testing/index.ts';

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no  half`);
  return found;
};
const access = real('access');
const accounts = real('accounts');

const ORIGIN = HOSTED_APP_ORIGIN;
const NOW = '2026-11-01T12:00:00.000Z';
const SEED = 'JBSWY3DPEHPK3PXP';
const D = `fy_device_id_${'d'.repeat(22)}`;
const E = `fy_device_id_${'e'.repeat(22)}`;
const KEY = 'MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

/** Real Access + real Accounts. Devices D and E are paired and each holds a passkey (planted, as a restart would find them). */
async function world(): Promise<TestHost> {
  const host = await testHost({
    plugins: [access, accounts],
    gate: new StandInAdmission(request =>
      request.principal?.kind === 'device' ? deviceStanding(request.principal.holder) : ownerStanding(),
    ),
    clock: fixedClock(NOW),
    fakes: {
      vault: new FakeVault(),
      sealed: new FakeSealedDocuments(),
      asks: new FakeAsks(),
      gate: { audit: async () => undefined, policy: () => undefined },
    },
  });
  hosts.push(host);
  const daemonId = host.identity.daemonId;
  host.state('access').plant(
    DevicesFile,
    JSON.stringify({
      format: 1,
      daemonId,
      devices: [D, E].map(id => ({
        id,
        daemonId,
        name: id === D ? 'Phone' : 'Laptop',
        platform: 'browser',
        createdAt: NOW,
        lastSeenAt: NOW,
        publicKey: KEY,
        grants: DEFAULT_CAPABILITY_GRANTS,
      })),
    }),
  );
  host.state('access').plant(
    PasskeysFile,
    JSON.stringify({
      format: 1,
      passkeys: [D, E].map(id => ({
        credentialId: `cred-${id.slice(-4)}`,
        deviceId: id,
        algorithm: -7,
        publicKeySpki: 'c3BraQ',
        signCount: 0,
        origin: ORIGIN,
        createdAt: NOW,
      })),
    }),
  );
  return host;
}

const options = async (host: TestHost, as: string, act: string, subject: string) =>
  await host.request('POST', '/v1/step-up/options', { as: device(as), body: { origin: ORIGIN, act, subject } });

describe('G83 S90 R-0399 Access finds the stages Accounts staged', () => {
  it('G83 S90 should issue an add-2fa-key challenge stamped with the bound subject, never the stage id', async () => {
    const host = await world();
    await host.request('PUT', '/v1/accounts/GITHUB', {
      body: { label: 'GitHub', username: 'octo', password: 'fixture-pw' },
    });
    const staged = await host.request('POST', '/v1/accounts/GITHUB/factors/seed', {
      body: { padded: padInputValue(SEED), totpAcknowledged: true },
    });
    expect(staged.status).toBe(201);
    const stage = staged.json<{ stage: string }>().stage;

    const answered = await options(host, D, 'add-2fa-key', stage);

    expect(answered.status).toBe(200);
    expect(JSON.stringify(answered.json())).not.toContain('stage_not_found');
    expect(answered.json<{ challenge: string }>().challenge.length).toBeGreaterThan(10);
  });

  it('G83 should answer stage_not_found for a 2FA stage that is not waiting', async () => {
    const host = await world();

    const missing = await options(host, D, 'add-2fa-key', `st_${'a'.repeat(24)}`);

    expect([missing.status, missing.json<{ code: string }>().code]).toEqual([404, 'stage_not_found']);
  });

  it('G83 R-0399 should issue an approve-paste-rule challenge to the device the stage waits on, and stage_not_found to another', async () => {
    const host = await world();
    await host.runJob('accounts.paste-rules');
    const staged = await host.request('POST', '/v1/copy-rules/stages', {
      as: device(D),
      body: { from: { kind: 'command', program: 'gh' }, to: { kind: 'terminal', program: 'vercel' } },
    });
    expect(staged.status).toBe(201);
    const stage = staged.json<{ stage: string }>().stage;

    const mine = await options(host, D, 'approve-paste-rule', stage);
    const theirs = await options(host, E, 'approve-paste-rule', stage);

    expect(mine.status).toBe(200);
    expect(mine.json<{ challenge: string }>().challenge.length).toBeGreaterThan(10);
    expect([theirs.status, theirs.json<{ code: string }>().code]).toEqual([404, 'paste_rule_stage_not_found']);
  });
});
