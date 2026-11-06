import { describe, it } from 'bun:test';
import should from 'should';
import { daemonFeatureList } from '../../src/lib/index.ts';

/**
 * The exact list of names this build reports, as a literal. The list is a wire fact the PWA and every daemon
 * share (docs/standards/fact-ownership), so changing it must be a deliberate edit to THIS array, never a side
 * effect of moving the declarations around.
 */
const EXPECTED_FEATURES = [
  'accounts.2fa-keys.1',
  'accounts.signins.1',
  'agenda.asks.1',
  'agenda.card-asks.1',
  'agenda.cards.1',
  'agenda.channel.1',
  'agenda.clear-agents.1',
  'agenda.conversation.1',
  'agenda.gate.attachments.1',
  'agenda.link-meaning.1',
  'agenda.offer-close.1',
  'agenda.open.1',
  'agenda.patch.1',
  'agenda.snooze.1',
  'agenda.tabs.1',
  'agenda.task.1',
  'agenda.wire.1',
  'board.gate-items.1',
  'board.lanes.1',
  'board.patch.1',
  'board.reopen.attachments.1',
  'board.switch.1',
  'board.visibility.1',
  'catalog-installs.updates.1',
  'catalogs.items.1',
  'catalogs.join-proof.1',
  'catalogs.links.1',
  'catalogs.quick-add.1',
  'catalogs.versions.1',
  'catalogs.versions.2',
  'copy-rules.passkey.1',
  'input.phone-approval.1',
  'login.budget.1',
  'messages.tail.1',
  'pack.idea.4000',
  'push.clear.1',
  'session.credential.1',
  'shared-draft.slots.1',
  'shared-draft.uploading.1',
  'sign-in-rules-terminal.1',
  'sign-in-rules.1',
  'task-plan.1',
  'tidy.1',
  'work.search.1',
] as const;

describe('daemonFeatureList', () => {
  it('should be exactly the names this build reports today, in sorted order', () => {
    // Arrange / Act
    const list = daemonFeatureList();

    // Assert
    should([...list]).deepEqual([...EXPECTED_FEATURES]);
  });
});
