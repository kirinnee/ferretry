import { describe, it } from 'bun:test';
import should from 'should';
import { composerHoldsOtherText, heldAt } from '../../../../daemon/lib/tmux/composer-screen.ts';

/**
 * G33 — "The composer action is `terminal`/`use` and acts only while the composer holds exactly the quoted draft."
 *
 * THIS IS THE PART TERMINALS OWNS: reading the pane and deciding whether the composer holds exactly the quoted draft.
 * The row itself belongs to Conversation (D2 #7, the composer owner); the ledger and audit half ("writes no ledger
 * row, audited with `mode: 'composer'`, never with the text") is its route's. This test goes when Conversation merges
 * and writes the row's own `G33` test.
 */
describe('G33 the composer acts only while the composer holds exactly the quoted draft', () => {
  const DRAFT = 'please rerun the suite';
  const composerWith = (text: string) => ({
    visible: `› ${text}\n\n  gpt-5 default`,
    cursor: { x: 2 + text.length, y: 0 },
  });

  it('G33 holds the draft when the composer shows exactly it', () => {
    const { visible, cursor } = composerWith(DRAFT);
    should(heldAt(visible, cursor, DRAFT, false)).equal('composer');
    should(composerHoldsOtherText(visible, cursor, DRAFT)).be.false();
  });

  it('G33 does not act on a composer that holds the draft beside a person’s own words', () => {
    const { visible, cursor } = composerWith(`${DRAFT} and delete my draft`);
    should(composerHoldsOtherText(visible, cursor, DRAFT)).be.true();
  });

  it('G33 does not act on an empty composer or a pane with no composer', () => {
    should(heldAt('› \n', { x: 2, y: 0 }, DRAFT, false)).be.undefined();
    should(composerHoldsOtherText('› \n', { x: 2, y: 0 }, DRAFT)).be.false();
    should(heldAt('no prompt here\n', {}, DRAFT, false)).be.undefined();
  });

  it('G33 does not act on a composer that holds a different draft', () => {
    const { visible, cursor } = composerWith('something else entirely');
    should(heldAt(visible, cursor, DRAFT, false)).be.undefined();
  });
});
