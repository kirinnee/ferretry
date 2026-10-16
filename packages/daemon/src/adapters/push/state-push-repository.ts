import { join } from 'node:path';
import {
  BrowserPushSubscriptionSchema,
  InstantSchema,
  PairedDeviceIdSchema,
  PushDeviceViewSchema,
  RegisterPushDeviceRequestSchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import {
  type FileSystemPort,
  type FoundationPaths,
  PushError,
  type PushSubscriptionRecord,
  type PushSubscriptionStore,
} from '../../lib/index.ts';

/**
 * DURABLE PUSH ENROLMENTS, in one document inside the state home this daemon already owns.
 *
 * ## THE DOCUMENT IS THE SECRET, AND IT IS FILED AS ONE
 *
 * An endpoint and its two key halves are a bearer capability to wake somebody's phone: anyone holding
 * the triple can push to that browser until it unsubscribes, whether or not they hold a credential for
 * this daemon. So the file is written with the same owner-only mode as the signing key beside it, and
 * nothing above this layer is ever handed the triple — see `pushDeviceView`, which is the only
 * projection onto the wire and has no endpoint field to leak.
 *
 * ## WRITES ARE SERIALIZED, AND THAT IS THE WHOLE CORRECTNESS ARGUMENT
 *
 * Every mutation is a read-modify-write of one JSON array. Two concurrent enrolments that both read
 * before either wrote would each persist a document missing the other's row, and the loser would be a
 * browser that believes it is enrolled and never receives anything. The queue makes the sequence
 * total; the atomic write makes each step all-or-nothing.
 *
 * ## A DAMAGED DOCUMENT IS DAMAGE, NOT AN EMPTY FLEET
 *
 * A document this daemon cannot parse refuses rather than reading as "nobody is enrolled". The benign
 * reading is the more dangerous one: it answers every list with an empty set, silently drops every
 * notification, and looks exactly like a machine with nothing to say.
 *
 * ## ONE NAMED EXCEPTION: A RECORD AN OLDER BINARY OF THIS SAME DAEMON WROTE
 *
 * `prefs` was a real field on this record until this daemon stopped storing device preferences
 * (`packages/pwa/src/lib/notification-filter.ts` owns that decision now). A binary upgrade does not
 * rewrite the document already on disk, so the very first read after upgrading meets rows an older
 * version of THIS SAME PROCESS wrote, each still carrying `prefs`. Refusing that — "damage" by the
 * rule above — would turn an ordinary upgrade into every existing enrolment going dark. `prefs` is
 * therefore named and ignored, the one field this otherwise-strict record tolerates; anything else
 * unrecognised is still the real damage the rule describes.
 */

const PUSH_MODE = 0o600;

/**
 * `prefs` is read here and then dropped by the `.transform` below, never surfacing on the parsed
 * `PushSubscriptionRecord` — so a row this daemon re-saves (`save()` below) sheds the legacy field
 * for good, even though the document it was read from still names it.
 */
const RecordSchema = z
  .strictObject({
    id: PushDeviceViewSchema.shape.id,
    deviceId: PairedDeviceIdSchema,
    deviceName: RegisterPushDeviceRequestSchema.shape.deviceName,
    subscription: BrowserPushSubscriptionSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    prefs: z.unknown().optional(),
  })
  .transform(({ prefs: _legacyPrefs, ...record }) => record);

const DocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  subscriptions: z.array(RecordSchema),
});

export class StatePushRepository implements PushSubscriptionStore {
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    paths: FoundationPaths,
    private readonly files: Pick<FileSystemPort, 'readText' | 'writeTextAtomic' | 'setMode'>,
  ) {
    this.path = join(paths.state, 'push.json');
  }

  async list(): Promise<readonly PushSubscriptionRecord[]> {
    return await this.read();
  }

  async save(record: PushSubscriptionRecord): Promise<void> {
    await this.mutate(current => [
      ...current.filter(existing => existing.id !== record.id),
      RecordSchema.parse(record),
    ]);
  }

  async forget(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    let forgotten = 0;
    await this.mutate(current => {
      const kept = current.filter(record => !ids.includes(record.id));
      forgotten = current.length - kept.length;
      return kept;
    });
    return forgotten;
  }

  /** One serialized read-modify-write. The transform is pure; only this method touches the file. */
  private async mutate(
    transform: (current: readonly PushSubscriptionRecord[]) => readonly PushSubscriptionRecord[],
  ): Promise<void> {
    const operation = this.queue.then(async () => {
      const next = transform(await this.read());
      await this.files.writeTextAtomic(this.path, `${JSON.stringify({ schemaVersion: 1, subscriptions: next })}\n`);
      await this.files.setMode(this.path, PUSH_MODE);
    });
    this.queue = operation.catch(() => undefined);
    return await operation;
  }

  private async read(): Promise<readonly PushSubscriptionRecord[]> {
    const raw = await this.files.readText(this.path);
    if (raw === undefined) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PushError('corrupt_store', 'the push enrolment document is not valid JSON');
    }
    const document = DocumentSchema.safeParse(parsed);
    if (!document.success)
      throw new PushError('corrupt_store', 'the push enrolment document does not describe enrolments');
    if (new Set(document.data.subscriptions.map(record => record.id)).size !== document.data.subscriptions.length)
      throw new PushError('corrupt_store', 'the push enrolment document holds duplicate enrolment identities');
    return document.data.subscriptions;
  }
}
