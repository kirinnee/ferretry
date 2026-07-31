import { describe, it } from 'bun:test';
import { AttentionSnapshotSchema } from '@ferretry/protocol';
import should from 'should';
import {
  renderAttentionHistory,
  renderAttentionList,
  renderAttentionMutation,
  renderNotification,
} from '../../../src/lib/attention/render';
import { SESSION, agentItem, humanItem, resolvedItem, snapshot } from './fixtures';

const row = (text: string, index: number): string => text.split('\n')[index] ?? '';

describe('attention fixtures', () => {
  it('should be shapes the protocol actually accepts', () => {
    // Act
    const actual = AttentionSnapshotSchema.safeParse(
      snapshot([humanItem('A1', 'approve the deploy'), agentItem('A2', 'pick a cluster')], {
        resolved: [resolvedItem('A3', 'old thing')],
      }),
    );

    // Assert — rendering a shape the wire would reject proves nothing.
    should(actual.success).be.true();
  });
});

describe('attention listing', () => {
  it('should say so when nothing is waiting', () => {
    // Act
    const actual = renderAttentionList(snapshot([]));

    // Assert
    should(actual).equal('Nothing needs attention.');
  });

  it('should head the listing with a singular count for one item', () => {
    // Act
    const actual = renderAttentionList(snapshot([humanItem('A1', 'approve the deploy')]));

    // Assert
    should(row(actual, 0)).equal(`1 unresolved item in ${SESSION} — oldest first`);
  });

  it('should render an item as its reference, source and subject', () => {
    // Act
    const actual = renderAttentionList(snapshot([humanItem('A1', 'approve  the\n deploy')]));

    // Assert — the subject is flattened so the head of an item is always one line.
    should(row(actual, 1)).equal('  !A1  [question]  approve the deploy');
  });

  it('should show why, how to resolve, and who raised it', () => {
    // Act
    const actual = renderAttentionList(snapshot([agentItem('A2', 'pick a cluster')]));

    // Assert
    should(row(actual, 2)).equal('      why: nothing else can proceed');
    should(row(actual, 3)).equal('      resolve: answer on the board');
    should(row(actual, 4)).equal('      since 2026-07-31T09:05:00.000Z · raised by agent sol');
  });

  it('should not invent a name for an unnamed agent', () => {
    // Act
    const actual = renderAttentionList(snapshot([agentItem('A2', 'pick a cluster', { raisedByName: null })]));

    // Assert
    should(actual).containEql('raised by agent');
    should(actual).not.containEql('agent null');
  });

  it('should include context only when there is some', () => {
    // Act
    const withContext = renderAttentionList(snapshot([humanItem('A1', 'x', { context: 'the CI job times out' })]));
    const withBlank = renderAttentionList(snapshot([humanItem('A1', 'x', { context: '   ' })]));

    // Assert
    should(withContext).containEql('      context: the CI job times out');
    should(withBlank).not.containEql('context:');
  });

  it('should spell out what each ask kind wants from the human', () => {
    // Act
    const permission = renderAttentionList(snapshot([humanItem('A1', 'x', { ask: { kind: 'permission' } })]));
    const review = renderAttentionList(snapshot([humanItem('A1', 'x', { ask: { kind: 'answer-review' } })]));
    const open = renderAttentionList(snapshot([humanItem('A1', 'x', { ask: { kind: 'open-question' } })]));
    const choice = renderAttentionList(
      snapshot([
        humanItem('A1', 'x', {
          ask: { kind: 'multiple-choice', options: [{ label: 'ship it' }, { label: 'hold' }] },
        }),
      ]),
    );

    // Assert
    should(permission).containEql('answer: approve or reject');
    should(review).containEql('answer: good, or ask to clarify');
    should(open).containEql('answer: write a full answer');
    should(choice).containEql('answer: pick one of "ship it" | "hold"');
  });

  it('should omit the answer hint for an item with no ask', () => {
    // Act
    const actual = renderAttentionList(snapshot([humanItem('A1', 'x')]));

    // Assert
    should(actual).not.containEql('answer:');
  });

  it('should order items oldest first, whatever order the daemon sent', () => {
    // Arrange
    const newer = humanItem('A2', 'newer', { waitingSince: '2026-07-31T12:00:00.000Z' });
    const older = humanItem('A1', 'older', { waitingSince: '2026-07-31T08:00:00.000Z' });

    // Act — kteam printed "oldest first" and then trusted the daemon's order.
    const actual = renderAttentionList(snapshot([newer, older]));

    // Assert
    should(row(actual, 1)).containEql('older');
  });

  it('should break an equal wait on the item ordinal', () => {
    // Arrange
    const at = '2026-07-31T08:00:00.000Z';
    const second = humanItem('A2', 'second', { waitingSince: at });
    const first = humanItem('A1', 'first', { waitingSince: at });

    // Act
    const actual = renderAttentionList(snapshot([second, first]));

    // Assert
    should(row(actual, 1)).containEql('first');
  });

  it('should warn about unreadable entries while still listing the readable ones', () => {
    // Act — kteam replaced the entire list with this warning, hiding every valid item.
    const actual = renderAttentionList(snapshot([humanItem('A1', 'still urgent')], { parseErrors: 2 }));

    // Assert
    should(row(actual, 0)).equal(
      'Warning: 2 entries on this board could not be read; the list below may be incomplete.',
    );
    should(actual).containEql('still urgent');
  });

  it('should count a single unreadable entry in the singular', () => {
    // Act
    const actual = renderAttentionList(snapshot([], { parseErrors: 1 }));

    // Assert
    should(row(actual, 0)).containEql('Warning: 1 entry on this board');
    should(row(actual, 1)).equal('Nothing needs attention.');
  });

  it('should elide a subject longer than the row budget', () => {
    // Act
    const actual = renderAttentionList(snapshot([humanItem('A1', 'q'.repeat(120))]));

    // Assert
    should(actual).containEql(`${'q'.repeat(83)}…`);
  });
});

describe('attention history', () => {
  it('should say so when nothing has been resolved', () => {
    // Act
    const actual = renderAttentionHistory(snapshot([]));

    // Assert
    should(actual).equal('No recorded resolutions.');
  });

  it('should record who resolved an item and when', () => {
    // Act
    const actual = renderAttentionHistory(snapshot([], { resolved: [resolvedItem('A1', 'approve the deploy')] }));

    // Assert
    should(row(actual, 0)).equal(`Recent resolutions in ${SESSION} — newest first`);
    should(row(actual, 1)).equal('  !A1  approve the deploy · resolved by human at 2026-07-31T10:00:00.000Z');
  });

  it('should name a dismissal as a dismissal', () => {
    // Act
    const actual = renderAttentionHistory(
      snapshot([], { resolved: [resolvedItem('A1', 'stale ask', { disposition: 'dismissed' })] }),
    );

    // Assert
    should(actual).containEql('· dismissed by human at');
  });

  it('should show the recorded answer and note', () => {
    // Act
    const actual = renderAttentionHistory(
      snapshot([], {
        resolved: [
          resolvedItem('A1', 'approve the deploy', {
            ask: { kind: 'permission' },
            response: { kind: 'permission', decision: 'approve' },
            resolutionNote: 'after the smoke test passed',
          }),
        ],
      }),
    );

    // Assert
    should(actual).containEql('— approved — after the smoke test passed');
  });

  it('should omit a blank note', () => {
    // Act
    const actual = renderAttentionHistory(
      snapshot([], { resolved: [resolvedItem('A1', 'x', { resolutionNote: '   ' })] }),
    );

    // Assert
    should(actual).not.containEql('—  ');
  });

  it('should name the agent that resolved an item', () => {
    // Act
    const actual = renderAttentionHistory(
      snapshot([], { resolved: [resolvedItem('A1', 'x', { resolvedBy: 'agent', resolvedByName: 'sol' })] }),
    );

    // Assert
    should(actual).containEql('resolved by agent sol at');
  });

  it('should order resolutions newest first', () => {
    // Arrange
    const older = resolvedItem('A1', 'older', { resolvedAt: '2026-07-31T09:00:00.000Z' });
    const newer = resolvedItem('A2', 'newer', { resolvedAt: '2026-07-31T11:00:00.000Z' });

    // Act
    const actual = renderAttentionHistory(snapshot([], { resolved: [older, newer] }));

    // Assert
    should(row(actual, 1)).containEql('newer');
  });

  it('should break an equal resolution time on the item ordinal, newest id first', () => {
    // Arrange
    const at = '2026-07-31T09:00:00.000Z';
    const first = resolvedItem('A1', 'first', { resolvedAt: at });
    const second = resolvedItem('A2', 'second', { resolvedAt: at });

    // Act
    const actual = renderAttentionHistory(snapshot([], { resolved: [first, second] }));

    // Assert
    should(row(actual, 1)).containEql('second');
  });

  it('should warn about unreadable entries here too', () => {
    // Act
    const actual = renderAttentionHistory(snapshot([], { parseErrors: 1 }));

    // Assert
    should(row(actual, 0)).containEql('could not be read');
  });
});

describe('attention confirmations', () => {
  it('should report a mutation with the reference and what is still waiting', () => {
    // Act
    const actual = renderAttentionMutation('resolved', '!A3', snapshot([humanItem('A1', 'x')]));

    // Assert
    should(actual).equal(`resolved !A3 — 1 unresolved item in ${SESSION}`);
  });

  it('should report a mutation that names no reference', () => {
    // Act
    const actual = renderAttentionMutation('attention recorded', undefined, snapshot([]));

    // Assert
    should(actual).equal(`attention recorded — 0 unresolved items in ${SESSION}`);
  });
});

describe('notification confirmations', () => {
  it('should count the devices reached', () => {
    // Act + Assert
    should(renderNotification(3)).equal('notification sent to 3 devices');
    should(renderNotification(1)).equal('notification sent to 1 device');
  });

  it('should say out loud when the message went nowhere', () => {
    // Act
    const actual = renderNotification(0);

    // Assert
    should(actual).equal('notification sent to 0 devices — no registered device wants this kind');
  });
});
