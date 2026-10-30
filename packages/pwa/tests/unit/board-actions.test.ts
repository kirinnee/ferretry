import { describe, expect, it } from 'bun:test';
import { type BoardTaskActionRequestInput, boardErr, boardOk } from '@ferretry/protocol';

import { type BoardMoveTarget, createBoardActions } from '../../src/lib/board-actions.ts';
import { CHILD, card, laneSetFor, laptop, workstation } from './board-support.ts';

const lanes = laneSetFor();

const harness = (paired = [laptop]) => {
  const sent: { daemonId: string; id: string; request: BoardTaskActionRequestInput }[] = [];
  const responses: unknown[][] = [];
  let refuse = false;
  const actions = createBoardActions({
    store: {
      act: async (machine, id, request) => {
        sent.push({ daemonId: machine.daemonId, id, request });
        return refuse ? boardErr({ status: 409, message: 'no', boardCode: 'owner-gate' as const }) : boardOk(card(id));
      },
    },
    agenda: {
      respond: async (...args: unknown[]) => {
        responses.push(args);
        if (refuse) throw Object.assign(new Error('closed'), { status: 410 });
      },
    } as never,
    connection: daemonId => paired.find(machine => machine.daemonId === daemonId),
  });
  return {
    actions,
    sent,
    responses,
    refuse: (value: boolean) => {
      refuse = value;
    },
  };
};

const target = (laneId: string): BoardMoveTarget => ({ daemonId: laptop.daemonId, id: 'F1', laneId, laneSet: lanes });

describe('moveTask', () => {
  it('sends a forward move without a reason', async () => {
    const { actions, sent } = harness();
    const answer = await actions.moveTask(target('implement'), 'review');
    expect(answer.ok).toBe(true);
    expect(sent).toEqual([{ daemonId: laptop.daemonId, id: 'F1', request: { action: 'move', to: 'review' } }]);
  });

  it('refuses a move back with no reason, or a blank one, before any round trip', async () => {
    const { actions, sent } = harness();
    for (const reason of [undefined, '', '   ']) {
      const answer = await actions.moveTask(target('review'), 'implement', reason);
      expect(!answer.ok && answer.error).toMatchObject({ status: 0, boardCode: 'reason-required' });
    }
    expect(sent).toHaveLength(0);
  });

  it('sends a move back once it has a reason, trimmed', async () => {
    const { actions, sent } = harness();
    await actions.moveTask(target('review'), 'implement', '  CI found a regression ');
    expect(sent[0]?.request).toEqual({ action: 'move', to: 'implement', reason: 'CI found a regression' });
  });

  it('refuses a lane the project does not have, and a project with no lanes', async () => {
    const { actions, sent } = harness();
    const unknown = await actions.moveTask(target('implement'), 'nowhere', 'x');
    expect(!unknown.ok && unknown.error.boardCode).toBe('unknown-lane');
    const none = await actions.moveTask({ ...target('implement'), laneSet: null }, 'review');
    expect(!none.ok && none.error.boardCode).toBe('no-lane-set');
    expect(sent).toHaveLength(0);
  });

  it('refuses a card whose machine is no longer paired', async () => {
    const { actions } = harness([workstation]);
    const answer = await actions.moveTask(target('implement'), 'review');
    expect(!answer.ok && answer.error.boardCode).toBe('no-machine');
  });
});

describe('the other verbs', () => {
  const card1 = { daemonId: laptop.daemonId, id: 'F1' };

  it('send the request each one names, to the card’s machine', async () => {
    const { actions, sent } = harness();
    await actions.reopen(card1, 'implement', 'it came back', { text: 'again', source: `session:${CHILD}` });
    await actions.depend(card1, { task: { daemonId: laptop.daemonId, id: 'F2' } as never, until: 'merged' as never });
    await actions.depend(card1, {
      task: { daemonId: laptop.daemonId, id: 'F3' } as never,
      until: 'merged' as never,
      overrideReason: 'urgent',
    });
    await actions.note(card1, 'a note');
    await actions.link(card1, { pr: 12 } as never);
    await actions.drop(card1, 'obsolete');
    await actions.editField(card1, { title: 'New title' });
    expect(sent.map(entry => entry.request.action)).toEqual([
      'reopen',
      'depend',
      'depend',
      'note',
      'link',
      'drop',
      'edit',
    ]);
    expect(sent[2]?.request).toMatchObject({ override: { reason: 'urgent' } });
    expect(sent[1]?.request).not.toHaveProperty('override');
    expect(sent.every(entry => entry.daemonId === laptop.daemonId && entry.id === 'F1')).toBe(true);
  });

  it('hand the daemon’s refusal back as a value', async () => {
    const { actions, refuse } = harness();
    refuse(true);
    const answer = await actions.drop(card1, 'x');
    expect(!answer.ok && answer.error.boardCode).toBe('owner-gate');
  });
});

describe('answer', () => {
  const ref = { sessionId: CHILD, id: 'A1' };

  it('answers through the agenda path, scoped to the ferret’s own session', async () => {
    const { actions, responses } = harness();
    const answer = await actions.answer(laptop.daemonId, ref, { kind: 'yes' } as never, 'ok');
    expect(answer.ok).toBe(true);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.[0]).toBe(laptop);
    expect(JSON.stringify(responses[0]?.[1])).toContain(CHILD);
    expect(responses[0]?.slice(2)).toEqual(['A1', { kind: 'yes' }, 'ok']);
  });

  it('hands a failed answer back with its status, and an unpaired machine as such', async () => {
    const { actions, refuse } = harness();
    refuse(true);
    const failed = await actions.answer(laptop.daemonId, ref, { kind: 'yes' } as never);
    expect(!failed.ok && failed.error).toEqual({ status: 410, message: 'closed', boardCode: null });
    const gone = await actions.answer(workstation.daemonId, ref, { kind: 'yes' } as never);
    expect(!gone.ok && gone.error.boardCode).toBe('no-machine');
  });

  it('reports a thrown non-error as text', async () => {
    const actions = createBoardActions({
      store: { act: async () => boardErr({ status: 0, message: '', boardCode: null }) },
      agenda: {
        respond: async () => {
          throw 'plain';
        },
      } as never,
      connection: () => laptop,
    });
    const answer = await actions.answer(laptop.daemonId, ref, { kind: 'yes' } as never);
    expect(!answer.ok && answer.error).toEqual({ status: 0, message: 'plain', boardCode: null });
  });
});
