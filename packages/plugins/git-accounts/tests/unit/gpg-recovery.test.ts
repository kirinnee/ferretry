import { expect, test } from 'bun:test';
import type { SealedDocumentHandle } from '@ferretry/core-vault/contract';
import type { GitAccount, GitApiCall } from '../../contract/index.ts';
import { GpgKeyService } from '../../daemon/features/gpg-keys/service.ts';
import type { GpgSigners } from '../../daemon/features/gpg-keys/signer.ts';
import { AccountLocks } from '../../daemon/lib/account-locks.ts';

const ID = 'gha_4242';
const fingerprint = 'A'.repeat(40);
function world() {
  let account: GitAccount = {
    id: ID,
    provider: 'github',
    githubId: 4242,
    login: 'synthetic',
    scopes: ['admin:gpg_key'],
    createdAt: '2026-11-19T00:00:00.000Z',
    keys: {},
  };
  const values = new Map<string, string>();
  let deleteFails = false;
  const sealed = {
    get: async (name: string) => values.get(name),
    put: async (name: string, value: string) => {
      values.set(name, value);
    },
    delete: async (name: string) => {
      if (deleteFails) throw new Error('synthetic vault write failure');
      values.delete(name);
    },
  } as unknown as SealedDocumentHandle;
  const remote = new Set<number>();
  let remoteDeleteFails = false;
  let ambiguousUpload = false;
  let remoteDeletes = 0;
  let records = 0;
  let failRecord = -1;
  let kits = 0;
  let disabled = 0;
  const accounts = {
    find: async () => structuredClone(account),
    recordKeys: async (_id: string, keys: GitAccount['keys']) => {
      if (++records === failRecord) throw new Error('synthetic account write failure');
      account = { ...account, keys };
    },
    api: async (_id: string, call: GitApiCall) => {
      if (call.method === 'GET')
        return { status: 200, body: [...remote].map(id => ({ id, key_id: fingerprint.slice(-16) })), headers: {} };
      if (call.method === 'POST') {
        remote.add(701);
        if (ambiguousUpload) throw new Error('another machine uploaded the same key; the POST response was lost');
        return { status: 201, body: { id: 701 }, headers: {} };
      }
      if (remoteDeleteFails) return { status: 502, body: {}, headers: {} };
      remoteDeletes++;
      remote.delete(701);
      return { status: 204, body: null, headers: {} };
    },
  };
  const homes = {
    generate: async () => ({ fingerprint, publicKey: 'synthetic public block', secretKey: 'synthetic private block' }),
    disable: async () => {
      disabled++;
    },
    forget: async () => {},
    kit: async () => {
      kits++;
      return { home: '/synthetic/public', fingerprint, program: '/synthetic/shim' };
    },
  } as unknown as GpgSigners;
  const locks = new AccountLocks();
  const restart = () =>
    new GpgKeyService(
      accounts,
      sealed,
      homes,
      () => 'synthetic',
      (id, work) => locks.run(id, work),
    );
  return {
    restart,
    remote,
    values,
    account: () => account,
    kits: () => kits,
    disabled: () => disabled,
    remoteDeletes: () => remoteDeletes,
    ambiguousUpload: () => {
      ambiguousUpload = true;
    },
    failVaultDelete: (on: boolean) => {
      deleteFails = on;
    },
    failRemoteDelete: (on: boolean) => {
      remoteDeleteFails = on;
    },
    failRecordAt: (at: number) => {
      failRecord = at;
    },
  };
}

test('vault deletion failure cannot restore signing after restart; durable revocation retains the remote id for retry', async () => {
  const w = world();
  const service = w.restart();
  await service.create(ID, { purpose: 'signing', format: 'gpg' });
  w.failVaultDelete(true);
  await expect(service.removeLocked(ID)).rejects.toThrow('synthetic vault');
  expect(w.disabled()).toBeGreaterThan(0);
  expect(w.account().keys.signing).toMatchObject({ githubKeyId: '701', revoking: true });
  expect(w.values.has(`${ID}:gpg`)).toBe(true);
  const restarted = w.restart();
  await restarted.warm([ID], () => {});
  await expect(restarted.launchKit(ID)).rejects.toMatchObject({ status: 409 });
  expect(w.kits()).toBe(0);
  w.failVaultDelete(false);
  await restarted.removeLocked(ID);
  expect(w.remote.size).toBe(0);
  expect(w.account().keys.signing).toBeUndefined();
});

test('an ambiguous upload never deletes another machine’s matching key by fingerprint', async () => {
  const w = world();
  w.ambiguousUpload();
  await expect(w.restart().create(ID, { purpose: 'signing', format: 'gpg' })).rejects.toThrow('response was lost');
  expect(w.account().keys.signing).toMatchObject({ registrationPending: true, revoking: true });
  const restarted = w.restart();
  await expect(restarted.removeLocked(ID)).rejects.toMatchObject({ status: 502, code: 'key_cleanup_manual' });
  expect(w.remoteDeletes()).toBe(0);
  expect(w.remote.size).toBe(1);
  expect(w.values.has(`${ID}:gpg`)).toBe(false);
});

for (const rollbackFails of [false, true])
  test(`a successful upload whose account write fails ${rollbackFails ? 'keeps durable cleanup for retry' : 'is rolled back'}`, async () => {
    const w = world();
    w.failRecordAt(2);
    w.failRemoteDelete(rollbackFails);
    await expect(w.restart().create(ID, { purpose: 'signing', format: 'gpg' })).rejects.toThrow(
      'synthetic account write',
    );
    expect(w.values.has(`${ID}:gpg`)).toBe(false);
    if (rollbackFails) {
      expect(w.account().keys.signing).toMatchObject({ revoking: true, registrationPending: true });
      expect(w.remote.size).toBe(1);
      const restarted = w.restart();
      await expect(restarted.launchKit(ID)).rejects.toMatchObject({ status: 409 });
      w.failRemoteDelete(false);
      await restarted.removeLocked(ID);
    }
    expect(w.remote.size).toBe(0);
    expect(w.account().keys.signing).toBeUndefined();
  });
