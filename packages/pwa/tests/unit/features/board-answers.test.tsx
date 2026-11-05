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

test('a plain move back asks why it is going back, in the default words', async () => {
  const row = toTestCards(await boardModelOf([card('F22', { laneId: 'tested', title: 'Try the board' })]))[0];
  if (row === undefined) throw new Error('missing the card to move back');
  const target = row.card;
  let answers: BoardAnswers | undefined;
  function Host() {
    answers = useBoardAnswers({
      actions: fakeActions(),
      ports: undefined,
      connectionOf: () => laptop,
      onNotice: () => undefined,
    });
    return answers.composerFor(target);
  }
  const view = render(<Host />);
  try {
    run(() => answers?.requestMove(row.card, row.group, row.notGoodLaneId));
    const composer = view.root.findByType(BoardSendBack);
    expect(composer.props.heading).toBe('Move Try the board back to Implement');
    expect(composer.props.placeholder).toBe('Why is it going back?');
    expect(composer.props.submitLabel).toBe('Move back');
    expect(composer.props.busyLabel).toBe('Moving…');
  } finally {
    run(() => view.unmount());
  }
});

test('a move back to a machine that is not connected here says so and opens no box', async () => {
  const row = toTestCards(await boardModelOf([card('F22', { laneId: 'tested', title: 'Try the board' })]))[0];
  if (row === undefined) throw new Error('missing the card to move back');
  const actions = fakeActions();
  const target = row.card;
  const notices: (string | null)[] = [];
  let answers: BoardAnswers | undefined;
  function Host() {
    answers = useBoardAnswers({
      actions,
      ports: undefined,
      connectionOf: () => undefined,
      onNotice: message => void notices.push(message),
    });
    return answers.composerFor(target);
  }
  const view = render(<Host />);
  try {
    run(() => answers?.requestMove(row.card, row.group, row.notGoodLaneId, 'send-back'));
    expect(view.root.findAllByType(BoardSendBack)).toHaveLength(0);
    expect(notices.at(-1)).toBe('That machine is not connected here, so the card cannot be sent back from this page.');
    expect(actions.calls).toEqual([]);
  } finally {
    run(() => view.unmount());
  }
});

test('a move for a card in a lane the project does not have is refused with a notice and sends nothing', async () => {
  const row = toTestCards(await boardModelOf([card('F22', { laneId: 'tested', title: 'Try the board' })]))[0];
  if (row === undefined) throw new Error('missing the card to move');
  const actions = fakeActions();
  const lost = { ...row.card, task: { ...row.card.task, laneId: 'ghost' } };
  const notices: (string | null)[] = [];
  let answers: BoardAnswers | undefined;
  function Host() {
    answers = useBoardAnswers({
      actions,
      ports: undefined,
      connectionOf: () => laptop,
      onNotice: message => void notices.push(message),
    });
    return answers.composerFor(lost);
  }
  const view = render(<Host />);
  try {
    run(() => answers?.requestMove(lost, row.group, row.notGoodLaneId));
    expect(notices.at(-1)).toContain('ghost');
    expect(view.root.findAllByType(BoardSendBack)).toHaveLength(0);
    expect(actions.calls).toEqual([]);
  } finally {
    run(() => view.unmount());
  }
});
