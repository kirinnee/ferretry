import type { StatePort } from '@ferretry/kernel/contract';
import { PasskeysFile, StoredPasskeySchema } from '../../../contract/index.ts';
import type { PasskeyStore, StoredPasskey } from '../../lib/step-up/index.ts';

/**
 * THE PASSKEYS PAIRED DEVICES REGISTERED, in one document inside Access's state (`passkeys.json`).
 *
 * Public keys and counters only. A copy of this file proves nothing: every step-up is a fresh
 * signature by a private key that never leaves the person's authenticator, over a challenge this
 * daemon issued a moment before. It is still written owner-only, because which devices hold which
 * credentials is nobody else's business.
 *
 * Writes are serialized for the reason every read-modify-write document here is: two registrations
 * that both read before either wrote would each drop the other's row (the kernel's `update` is one chain per
 * file). A document that does not parse is DAMAGE and refuses — reading it as "no passkeys" would quietly
 * re-open the first-registration window for every device on the machine.
 */
export class PasskeyStoreDamaged extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyStoreDamaged';
  }
}

export class StatePasskeyStore implements PasskeyStore {
  constructor(private readonly state: StatePort) {}

  async list(deviceId: string): Promise<readonly StoredPasskey[]> {
    return (await this.read()).filter(passkey => passkey.deviceId === deviceId);
  }

  async holder(credentialId: string): Promise<string | undefined> {
    return (await this.read()).find(passkey => passkey.credentialId === credentialId)?.deviceId;
  }

  async any(): Promise<boolean> {
    return (await this.read()).length > 0;
  }

  async add(passkey: StoredPasskey): Promise<void> {
    await this.mutate(current => {
      const held = current.find(existing => existing.credentialId === passkey.credentialId);
      if (held !== undefined && held.deviceId !== passkey.deviceId)
        throw new PasskeyStoreDamaged('that credential already belongs to another device');
      if (held !== undefined) throw new PasskeyStoreDamaged('that credential is already stored, and is never replaced');
      return [...current, StoredPasskeySchema.parse(passkey)];
    });
  }

  async updateSignCount(deviceId: string, credentialId: string, signCount: number): Promise<boolean> {
    let moved = false;
    await this.mutate(current =>
      current.map(passkey => {
        if (passkey.deviceId !== deviceId || passkey.credentialId !== credentialId) return passkey;
        if (passkey.signCount >= signCount && (passkey.signCount !== 0 || signCount !== 0)) return passkey;
        moved = true;
        return { ...passkey, signCount };
      }),
    );
    return moved;
  }

  async forgetDevice(deviceId: string): Promise<void> {
    await this.mutate(current => current.filter(passkey => passkey.deviceId !== deviceId));
  }

  private async mutate(transform: (current: readonly StoredPasskey[]) => readonly StoredPasskey[]): Promise<void> {
    const written = await this.state.update(PasskeysFile, document => {
      const current = document?.passkeys ?? [];
      checkUnique(current);
      return { format: 1 as const, passkeys: transform(current).map(passkey => StoredPasskeySchema.parse(passkey)) };
    });
    if (!written.ok) throw new PasskeyStoreDamaged('the passkey document does not describe passkeys');
  }

  private async read(): Promise<readonly StoredPasskey[]> {
    const document = await this.state.read(PasskeysFile);
    if (!document.ok) throw new PasskeyStoreDamaged('the passkey document does not describe passkeys');
    const passkeys = document.value?.passkeys ?? [];
    checkUnique(passkeys);
    return passkeys;
  }
}

function checkUnique(passkeys: readonly StoredPasskey[]): void {
  if (new Set(passkeys.map(passkey => passkey.credentialId)).size !== passkeys.length)
    throw new PasskeyStoreDamaged('the passkey document holds one credential twice');
}
