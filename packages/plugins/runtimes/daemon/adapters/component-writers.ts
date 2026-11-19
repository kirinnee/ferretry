/**
 * The setup import's door to each component owner's own write (`ProfileComponentSource.put`).
 *
 * Runtimes never writes another plugin's file: it hands the document to the plugin that owns the kind, found through the
 * same hook the read side uses, and reports what the owner answered. Every answer is an outcome (an owner that is off,
 * slow, offers no write or throws is a refusal in a sentence), so one owner's trouble never stops the others.
 */
import type { ComponentWriter, OwnerWriteOutcome } from '../lib/account/owner-components.ts';
import { type ComponentSourceLookup, sourceHookFor, TIMED_OUT, type Within } from './profile-components.ts';

const refused = (reason: string): OwnerWriteOutcome => ({ outcome: 'refused', reason });

export function componentWriters(lookup: ComponentSourceLookup, within: Within): ComponentWriter {
  return {
    put: async write => {
      const hook = sourceHookFor(write.kind, write.harness);
      if (hook === undefined) return refused('no part of Ferretry owns these components');
      const owner = lookup(hook);
      if (owner === 'unavailable') return refused('the part of Ferretry that owns them is not running');
      if (owner.put === undefined) return refused('the part of Ferretry that owns them cannot take an import yet');
      try {
        const answered = await within(owner.put(write.name, write.text));
        if (answered === TIMED_OUT) return refused('the part of Ferretry that owns them did not answer in time');
        if (!answered.ok) return refused(answered.reason);
        return { outcome: answered.held === true ? 'held' : 'written' };
      } catch (error) {
        return refused(error instanceof Error && error.message.length > 0 ? error.message : 'it could not be written');
      }
    },
  };
}
