import type { AccessApi } from '@ferretry/plugin-access/contract';
import type { UsesHandle } from '@ferretry/kernel/manifest';
import type { StoredStepUpProof } from '../../contract/routes/index.ts';

/** TODO(access contract): holdsPasskey is approved in d97009056; stored-proof reads await Access's port. */
type SecurityReads = AccessApi & {
  holdsPasskey?(deviceId: string): Promise<boolean>;
  holds?(deviceId: string, credentialId: string): Promise<boolean>;
  verifyStoredProof?(proof: StoredStepUpProof, expectedChallenge: Uint8Array): Promise<boolean>;
};

/** Resolve the optional provider at use time. Missing, unreadable or revoked evidence never passes. */
export function accountSecurity(access: UsesHandle<AccessApi>) {
  const current = (): SecurityReads | undefined => access.current();
  const of = async (deviceId: string): Promise<boolean> =>
    (await current()
      ?.holdsPasskey?.(deviceId)
      .catch(() => false)) ?? false;
  return {
    passkeys: {
      of,
      any: async (): Promise<boolean> => {
        const devices = await current()
          ?.devices()
          .catch(() => undefined);
        for (const device of devices ?? []) if (await of(device.id)) return true;
        return false;
      },
    },
    proofs: {
      holds: async (device: string, credential: string): Promise<boolean> =>
        (await current()?.holds?.(device, credential)) ?? false,
      verify: async (proof: StoredStepUpProof, challenge: Uint8Array): Promise<boolean> =>
        (await current()?.verifyStoredProof?.(proof, challenge)) ?? false,
    },
  };
}
