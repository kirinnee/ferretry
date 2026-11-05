import { expect, test } from 'bun:test';
import { type BoardAnswers, useBoardAnswers } from '../../../src/features/board/board-answers.tsx';
import { BoardSendBack } from '../../../src/features/board/board-send-back.tsx';
import { toTestCards } from '../../../src/lib/to-test-inbox.ts';
import '../../support/dom.ts';
import { render, run, runAsync } from '../../support/react.ts';
import { boardModelOf, card, laptop } from '../board-support.ts';
import { fakeActions } from './board-detail-support.tsx';

test('a send-back answer asks what should change and sends the owner’s words only after submission', async () => {
  const row = toTestCards(await boardModelOf([card('F22', { laneId: 'tested', title: 'Try the board' })]))[0];
  if (row === undefined) throw new Error('missing the card to send back');
  const actions = fakeActions();
  const target = row.card;
  let answers: BoardAnswers | undefined;
  function Host() {
    answers = useBoardAnswers({
      actions,
      ports: undefined,
      connectionOf: () => laptop,
      onNotice: () => undefined,
    });
    return answers.composerFor(target);
  }
  const view = render(<Host />);
  try {
    run(() => answers?.requestMove(row.card, row.group, row.notGoodLaneId, 'send-back'));
    const composer = view.root.findByType(BoardSendBack);
    expect(composer.props.heading).toBe('Send Try the board back to Implement');
    expect(composer.props.placeholder).toBe('What should change?');
    expect(composer.props.submitLabel).toBe('Send back');
    expect(actions.calls).toEqual([]);
    await runAsync(async () => {
      await composer.props.onSubmit({ reason: 'Cover the older-machine path.', attachmentIds: [] });
    });
    expect(actions.calls).toEqual(['moveTask:["implement","Cover the older-machine path."]']);
    expect(view.root.findAllByType(BoardSendBack)).toHaveLength(0);
  } finally {
    run(() => view.unmount());
  }
});
