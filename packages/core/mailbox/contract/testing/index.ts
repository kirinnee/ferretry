import type { FerretId } from '@ferretry/core-ferrets/contract';
import { err, ok } from '@ferretry/std';
import type { MailboxQueueApi } from '../port.ts';
import type { QueuedMessage } from '../wire-send.ts';

/** `@ferretry/core-mailbox/contract/testing` (§7.8): the in-memory queue port a plugin that reads the Mailbox is tested against. */
export class FakeMailboxQueue implements MailboxQueueApi {
  private readonly held = new Map<string, QueuedMessage[]>();
  /** Set, every call fails with it (a store that breaks with something nobody worded). */
  failure: Error | undefined;

  /** Puts messages in a ferret's queue, as the Mailbox's service would have. */
  seed(ferret: FerretId, ...messages: readonly QueuedMessage[]): void {
    this.held.set(ferret, [...(this.held.get(ferret) ?? []), ...messages]);
  }

  async queue(ferret: FerretId) {
    if (this.failure !== undefined) throw this.failure;
    return { messages: [...(this.held.get(ferret) ?? [])] };
  }

  async editQueued(ferret: FerretId, message: string, request: { readonly text: string }) {
    if (this.failure !== undefined) throw this.failure;
    const current = this.held.get(ferret)?.find(entry => entry.id === message);
    if (current === undefined)
      return err({ code: 'not_found', message: `session ${ferret} has no queued message ${message}` });
    if (current.state !== 'queued')
      return err({
        code: 'not_waiting',
        message: `message ${message} is ${current.state}, so it can no longer be changed`,
      });
    const next = { ...current, text: request.text, revision: current.revision + 1 };
    this.held.set(
      ferret,
      (this.held.get(ferret) ?? []).map(entry => (entry.id === message ? next : entry)),
    );
    return ok(next);
  }

  async cancelQueued(ferret: FerretId, message: string) {
    if (this.failure !== undefined) throw this.failure;
    const current = this.held.get(ferret)?.find(entry => entry.id === message);
    if (current === undefined)
      return err({ code: 'not_found', message: `session ${ferret} has no queued message ${message}` });
    if (current.state !== 'queued')
      return err({
        code: 'not_waiting',
        message: `message ${message} is ${current.state}, so it can no longer be changed`,
      });
    const next = { ...current, state: 'cancelled' as const };
    this.held.set(
      ferret,
      (this.held.get(ferret) ?? []).map(entry => (entry.id === message ? next : entry)),
    );
    return ok(next);
  }
}
