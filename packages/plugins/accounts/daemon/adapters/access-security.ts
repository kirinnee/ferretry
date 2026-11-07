import type { AccessApi } from '@ferretry/plugin-access/contract';
import type { UsesHandle } from '@ferretry/kernel/manifest';
import type { StoredStepUpProof } from '../../contract/routes/index.ts';

/**
 * WHAT ACCOUNTS ASKS ACCESS (its real port: `holdsPasskey`, `holds`, `verifyStoredProof`, `devices`), resolved at use
 * time. A provider that is off, unreadable or has revoked the device never passes: the answer is `false`.
 */
export function accountSecurity(access: UsesHandle<AccessApi>) {
  const of = async (deviceId: string): Promise<boolean> =>
    (await access
      .current()
      ?.holdsPasskey(deviceId)
      .catch(() => false)) ?? false;
  return {
    passkeys: {
      of,
      any: async (): Promise<boolean> => {
        const devices = await access
          .current()
          ?.devices()
          .catch(() => undefined);
        for (const device of devices ?? []) if (await of(device.id)) return true;
        return false;
      },
    },
    proofs: {
      holds: async (device: string, credential: string): Promise<boolean> =>
        (await access
          .current()
          ?.holds(device, credential)
          .catch(() => false)) ?? false,
      verify: async (proof: StoredStepUpProof, challenge: Uint8Array): Promise<boolean> =>
        (await access
          .current()
          ?.verifyStoredProof(proof, challenge)
          .catch(() => false)) ?? false,
    },
  };
}
