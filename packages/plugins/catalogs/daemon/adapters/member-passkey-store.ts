import { AppOriginSchema, InstantSchema, CatalogMemberKeyIdSchema } from '../lib/boundary.ts';
import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { PasskeyStore, StoredPasskey } from '../lib/member-passkeys/types.ts';

/**
 * THE PASSKEYS PAIRED DEVICES REGISTERED, in one document inside the state home.
 *
 * Public keys and counters only. A copy of this file proves nothing: every step-up is a fresh
 * signature by a private key that never leaves the person's authenticator, over a challenge this
 * daemon issued a moment before. It is still written owner-only, because which devices hold which
 * credentials is nobody else's business.
 *
 * Writes are serialized for the reason every read-modify-write document here is: two registrations
 * that both read before either wrote would each drop the other's row. A document that does not parse
 * is DAMAGE and refuses — reading it as "no passkeys" would quietly re-open the first-registration
 * window for every device on the machine.
 */

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/u);

/** Whose passkeys these are (a paired device, or a member's browser) and the schemas that follow. */
const documentSchemas = (owner: z.ZodType<string>) => {
  const record = z.strictObject({
    credentialId: Base64Url.max(1_366),
    deviceId: owner,
    algorithm: z.union([z.literal(-7), z.literal(-8), z.literal(-257)]),
    publicKeySpki: Base64Url.max(2_048),
    signCount: z.number().int().min(0).max(0xffff_ffff),
    origin: AppOriginSchema,
    createdAt: InstantSchema,
  });
  return { record, document: z.strictObject({ schemaVersion: z.literal(1), passkeys: z.array(record) }) };
};

/** The passkey document could not be read as passkeys. A state to report, never an empty list. */
class PasskeyStoreDamaged extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyStoreDamaged';
  }
}

export class StatePasskeyStore implements PasskeyStore {
  #snapshot: readonly StoredPasskey[] | undefined;
  private readonly schemas: ReturnType<typeof documentSchemas>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly state: StatePort,
    private readonly file: StateFileDef,
  ) {
    this.schemas = documentSchemas(CatalogMemberKeyIdSchema);
  }

  snapshot(keyId: string): readonly StoredPasskey[] | undefined {
    return this.#snapshot?.filter(passkey => passkey.deviceId === keyId);
  }

  async list(deviceId: string): Promise<readonly StoredPasskey[]> {
    return (await this.read()).filter(passkey => passkey.deviceId === deviceId);
  }

  async holder(credentialId: string): Promise<string | undefined> {
    return (await this.read()).find(passkey => passkey.credentialId === credentialId)?.deviceId;
  }

  /** Whether ANY paired device holds a passkey: none means no 2FA seed can be saved (docs/secrets.md). */
  async any(): Promise<boolean> {
    return (await this.read()).length > 0;
  }

  /**
   * A credential belongs to one device. Adding one another device already holds is refused rather than
   * re-pointed: re-pointing would hand that device's passkey to whoever registered the same id.
   *
   * Nor is one ever REPLACED on its own device: a new key or origin under a known id would quietly change
   * what a kept proof (a standing rule's) is checked against, with no "passkeys changed" signal. A
   * registration refuses a known id before it gets here, so this only meets a race, and refuses it.
   */
  async add(passkey: StoredPasskey): Promise<void> {
    await this.mutate(current => {
      const held = current.find(existing => existing.credentialId === passkey.credentialId);
      if (held !== undefined && held.deviceId !== passkey.deviceId)
        throw new PasskeyStoreDamaged('that credential already belongs to another device');
      if (held !== undefined) throw new PasskeyStoreDamaged('that credential is already stored, and is never replaced');
      return [...current, this.schemas.record.parse(passkey)];
    });
  }

  /**
   * The counter's compare-and-set, inside the serialized write: the comparison and the write see the
   * same document, so two assertions verified against one stored count cannot both land.
   */
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

  /** One serialized read-modify-write. The transform is pure; only this method touches the file. */
  private async mutate(transform: (current: readonly StoredPasskey[]) => readonly StoredPasskey[]): Promise<void> {
    const operation = this.queue.then(async () => {
      const next = transform(await this.read());
      await this.state.write(this.file, { schemaVersion: 1, passkeys: next });
      this.#snapshot = next;
    });
    this.queue = operation.catch(() => undefined);
    return await operation;
  }

  private async read(): Promise<readonly StoredPasskey[]> {
    const raw = await this.state.read(this.file);
    if (!raw.ok) throw new PasskeyStoreDamaged('the passkey document cannot be read');
    if (raw.value === undefined) {
      this.#snapshot = [];
      return [];
    }
    const parsed = raw.value;
    const document = this.schemas.document.safeParse(parsed);
    if (!document.success) throw new PasskeyStoreDamaged('the passkey document does not describe passkeys');
    if (new Set(document.data.passkeys.map(passkey => passkey.credentialId)).size !== document.data.passkeys.length)
      throw new PasskeyStoreDamaged('the passkey document holds one credential twice');
    this.#snapshot = document.data.passkeys;
    return document.data.passkeys;
  }
}
