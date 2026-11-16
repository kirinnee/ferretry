import { ConversationLeaseStore } from '../../../contract/conversation-lease.ts';
import { HostProcessStarts } from './host-process-starts.ts';
import { type LeaseState, StateLeaseDisk } from './state-lease-disk.ts';

/**
 * The lease store `fy history claim` claims through: the real host's process table and clock over Ferrets' own state
 * tree. Built here, with the other adapters that reach the host, so the verb names none of those globals.
 */
export function hostLeaseStore(state: LeaseState): ConversationLeaseStore {
  return new ConversationLeaseStore(
    new StateLeaseDisk(state, new HostProcessStarts(process.platform)),
    () => new Date(),
  );
}
