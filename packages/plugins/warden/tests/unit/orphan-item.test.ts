import { describe, it } from 'bun:test';
import should from 'should';
import type { CardId } from '@ferretry/plugin-board/contract';
import { MAX_AGENDA_DETAIL_LENGTH } from '../../daemon/lib/protocol.ts';
import { MAX_LISTED_ORPHANS, orphanItem } from '../../daemon/lib/orphan-item.ts';
import type { OrphanedCard } from '../../daemon/lib/orphans.ts';

const card = (n: number, waitingSince = `2026-07-01T00:${String(n % 60).padStart(2, '0')}:00.000Z`): OrphanedCard => ({
  id: `F${String(n)}` as CardId,
  assignee: 'worker',
  line: `&F${String(n)} Card ${String(n)} is waiting in Implement, but no ferret is assigned, so nothing will happen to it.`,
  waitingSince,
});

describe('the orphaned cards item', () => {
  it('should say nothing when no card is orphaned: the caller closes the item', () => {
    should(orphanItem([])).be.undefined();
  });

  it('should name a single card, and count several', () => {
    // Act
    const one = orphanItem([card(1)]);
    const three = orphanItem([card(1), card(2), card(3)]);

    // Assert
    should(one?.subject).equal('A card has nobody working on it');
    should(one?.why).containEql('This one was handed');
    should(three?.subject).equal('3 cards have nobody working on them');
    should(three?.why).containEql('These were handed');
    should(three?.why).not.containEql('nothing under it is alive');
    should(three?.howToResolve).containEql('start a ferret on it');
    should(three?.context).equal([1, 2, 3].map(n => `- ${card(n).line}`).join('\n'));
  });

  it('should list the oldest wait first, whatever order the cards arrive in', () => {
    // Act
    const item = orphanItem([
      card(1, '2026-07-03T00:00:00.000Z'),
      card(2, '2026-07-01T00:00:00.000Z'),
      card(3, '2026-07-02T00:00:00.000Z'),
    ]);

    // Assert
    should(item?.context.split('\n').map(row => row.split(' ')[1])).eql(['&F2', '&F3', '&F1']);
  });

  it('should name the first dozen and count the rest, so 31 orphans make one item showing 12 and "…and 19 more."', () => {
    // Arrange
    const cards = Array.from({ length: 31 }, (_, index) => card(index + 1));

    // Act
    const item = orphanItem(cards);

    // Assert
    should(MAX_LISTED_ORPHANS).equal(12);
    should(item?.subject).equal('31 cards have nobody working on them');
    const rows = item?.context.split('\n') ?? [];
    should(rows).have.length(13);
    should(rows.slice(0, 12).every(row => row.startsWith('- &F'))).be.true();
    should(rows[12]).equal('…and 19 more.');
  });

  it('should stay one bounded body however many cards are orphaned: 10,000 cards, a short item', () => {
    // Arrange
    const cards = Array.from({ length: 10_000 }, (_, index) => card(index + 1));

    // Act
    const item = orphanItem(cards);

    // Assert
    should(item?.subject).equal('10000 cards have nobody working on them');
    should(item?.context.split('\n')).have.length(13);
    should(item?.context.endsWith('…and 9988 more.')).be.true();
    should((item?.context.length ?? 0) <= MAX_AGENDA_DETAIL_LENGTH).be.true();
  });

  it('should drop whole rows, and count them, when even a dozen would not fit an item', () => {
    // Arrange
    const long = (n: number): OrphanedCard => ({ ...card(n), line: `&F${String(n)} ${'word '.repeat(80).trim()}` });

    // Act
    const item = orphanItem(Array.from({ length: 30 }, (_, index) => long(index + 1)));

    // Assert
    const rows = item?.context.split('\n') ?? [];
    should((item?.context.length ?? 0) <= MAX_AGENDA_DETAIL_LENGTH).be.true();
    should(rows.length).be.below(MAX_LISTED_ORPHANS + 1);
    should(rows.slice(0, -1).every(row => row.startsWith('- &F'))).be.true();
    should(rows.at(-1)).equal(`…and ${String(30 - (rows.length - 1))} more.`);
  });

  it('should say the same thing for the same cards: the wording is what the board compares', () => {
    // Act + Assert
    should(orphanItem([card(1), card(2)])).eql(orphanItem([card(2), card(1)]));
  });
});
