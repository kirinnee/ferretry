import type { StatePort } from '@ferretry/kernel/contract';
import { PushFile, PushRecordSchema } from '../../../contract/index.ts';
import { PushError, type PushSubscriptionRecord, type PushSubscriptionStore } from '../../lib/push/index.ts';

/**
 * DURABLE PUSH ENROLMENTS, in one document inside Access's state (`push.json`).
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
 */
export class StatePushRepository implements PushSubscriptionStore {
  constructor(private readonly state: StatePort) {}

  async list(): Promise<readonly PushSubscriptionRecord[]> {
    return await this.read();
  }

  async save(record: PushSubscriptionRecord): Promise<void> {
    await this.mutate(current => [
      ...current.filter(existing => existing.id !== record.id),
      PushRecordSchema.parse(record),
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

  private async mutate(
    transform: (current: readonly PushSubscriptionRecord[]) => readonly PushSubscriptionRecord[],
  ): Promise<void> {
    const written = await this.state.update(PushFile, document => {
      const current = document?.subscriptions ?? [];
      checkUnique(current);
      return { format: 1 as const, subscriptions: transform(current).map(record => PushRecordSchema.parse(record)) };
    });
    if (!written.ok) throw new PushError('corrupt_store', 'the push enrolment document does not describe enrolments');
  }

  private async read(): Promise<readonly PushSubscriptionRecord[]> {
    const document = await this.state.read(PushFile);
    if (!document.ok) throw new PushError('corrupt_store', 'the push enrolment document does not describe enrolments');
    const subscriptions = document.value?.subscriptions ?? [];
    checkUnique(subscriptions);
    return subscriptions;
  }
}

function checkUnique(records: readonly PushSubscriptionRecord[]): void {
  if (new Set(records.map(record => record.id)).size !== records.length)
    throw new PushError('corrupt_store', 'the push enrolment document holds duplicate enrolment identities');
}
