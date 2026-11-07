import { describe, expect, it } from 'bun:test';
import {
  type CardActionRequestInput,
  type CardCreateRequestInput,
  boardErr,
  boardOk,
  type LaneSetActionRequestInput,
  LANE_TEMPLATES,
} from '../../../contract/index.ts';

import { type BoardMoveTarget, createBoardActions } from '../../../app/lib/board-actions.ts';
import { CHILD, card, laneSetFor, laptop, workstation } from './board-support.ts';

const lanes = laneSetFor();

const harness = (paired = [laptop]) => {
  const sent: { daemonId: string; id: string; request: CardActionRequestInput }[] = [];
  const lanesSent: { daemonId: string; projectId: string; request: LaneSetActionRequestInput }[] = [];
  const created: { daemonId: string; request: CardCreateRequestInput }[] = [];
  const started: { daemonId: string; id: string; key: string | undefined }[] = [];
  let refuse = false;
  const actions = createBoardActions({
    store: {
      changeLanes: async (machine, projectId, request) => {
        lanesSent.push({ daemonId: machine.daemonId, projectId, request });
        return refuse
          ? boardErr({ status: 409, message: 'moved on', code: 'version-conflict' })
          : boardOk({
              laneSet: { ...lanes, version: request.action === 'propose' ? 1 : 2 },
              ask: 'not-needed' as const,
            });
      },
      act: async (machine, id, request) => {
        sent.push({ daemonId: machine.daemonId, id, request });
        return refuse ? boardErr({ status: 409, message: 'no', boardCode: 'owner-gate' as const }) : boardOk(card(id));
      },
      start: async (machine, id, key) => {
        started.push({ daemonId: machine.daemonId, id, key });
        return refuse
          ? boardErr({ status: 404, message: 'the card was closed', boardCode: 'not-found' as const })
          : boardOk({ card: id, ferret: 'worker', started: true });
      },
      create: async (machine, request) => {
        created.push({ daemonId: machine.daemonId, request });
        return refuse
          ? boardErr({ status: 409, message: 'no', boardCode: 'owner-gate' as const })
          : boardOk(card('F9'));
      },
    },
    connection: daemonId => paired.find(machine => machine.daemonId === daemonId),
  });
  return {
    actions,
    sent,
    lanesSent,
    created,
    started,
    refuse: (value: boolean) => {
      refuse = value;
    },
  };
};

const target = (laneId: string): BoardMoveTarget => ({ daemonId: laptop.daemonId, id: 'F1', laneId, laneSet: lanes });

describe('moveTask', () => {
  it('sends a forward move without a reason', async () => {
    const { actions, sent } = harness();
    const answer = await actions.moveCard(target('implement'), 'review');
    expect(answer.ok).toBe(true);
    expect(sent).toEqual([{ daemonId: laptop.daemonId, id: 'F1', request: { action: 'move', to: 'review' } }]);
  });

  it('refuses a move back with no reason, or a blank one, before any round trip', async () => {
    const { actions, sent } = harness();
    for (const reason of [undefined, '', '   ']) {
      const answer = await actions.moveCard(target('review'), 'implement', reason);
      expect(!answer.ok && answer.error).toMatchObject({ status: 0, boardCode: 'reason-required' });
    }
    expect(sent).toHaveLength(0);
  });

  it('sends a move back once it has a reason, trimmed', async () => {
    const { actions, sent } = harness();
    await actions.moveCard(target('review'), 'implement', '  CI found a regression ');
    expect(sent[0]?.request).toEqual({ action: 'move', to: 'implement', reason: 'CI found a regression' });
  });

  it('refuses a lane the project does not have, and a project with no lanes', async () => {
    const { actions, sent } = harness();
    const unknown = await actions.moveCard(target('implement'), 'nowhere', 'x');
    expect(!unknown.ok && unknown.error.boardCode).toBe('unknown-lane');
    const none = await actions.moveCard({ ...target('implement'), laneSet: null }, 'review');
    expect(!none.ok && none.error.boardCode).toBe('no-lane-set');
    expect(sent).toHaveLength(0);
  });

  it('refuses a card whose machine is no longer paired', async () => {
    const { actions } = harness([workstation]);
    const answer = await actions.moveCard(target('implement'), 'review');
    expect(!answer.ok && answer.error.boardCode).toBe('no-machine');
  });
});

describe('files on a move back', () => {
  const files = { from: CHILD, ids: [`att_${'a'.repeat(64)}`] };

  it('names the files on a move and on a reopen, and leaves them out when there are none', async () => {
    const { actions, sent } = harness();
    await actions.moveCard(target('review'), 'implement', 'still broken', files);
    await actions.reopen(
      { daemonId: laptop.daemonId, id: 'F1' },
      'implement',
      'again',
      { text: 'again', source: 'owner' },
      files,
    );
    await actions.reopen({ daemonId: laptop.daemonId, id: 'F1' }, 'implement', 'again', {
      text: 'again',
      source: 'owner',
    });
    expect(sent.map(entry => entry.request)).toEqual([
      { action: 'move', to: 'implement', reason: 'still broken', attachments: files },
      {
        action: 'reopen',
        to: 'implement',
        reason: 'again',
        ask: { text: 'again', source: 'owner' },
        attachments: files,
      },
      { action: 'reopen', to: 'implement', reason: 'again', ask: { text: 'again', source: 'owner' } },
    ]);
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
    await actions.undepend(card1, { daemonId: laptop.daemonId, id: 'F2' } as never, 'no longer needed');
    await actions.note(card1, 'a note');
    await actions.link(card1, { pr: 12 } as never);
    await actions.drop(card1, 'obsolete');
    await actions.editField(card1, { title: 'New title' });
    await actions.reparent(card1, { id: 'F9' } as never, 'wrong parent');
    await actions.reparent(card1, null);
    await actions.snoozeTask(card1, '2026-08-02T15:00:00.000Z');
    await actions.snoozeTask(card1, null);
    expect(sent.map(entry => entry.request.action)).toEqual([
      'reopen',
      'depend',
      'depend',
      'undepend',
      'note',
      'link',
      'drop',
      'edit',
      'reparent',
      'reparent',
      'snooze',
      'snooze',
    ]);
    expect(sent[8]?.request).toMatchObject({ parent: { id: 'F9' }, reason: 'wrong parent' });
    expect(sent[9]?.request).toMatchObject({ parent: null });
    expect(sent[9]?.request).not.toHaveProperty('reason');
    expect(sent[10]?.request).toEqual({ action: 'snooze', until: '2026-08-02T15:00:00.000Z' });
    expect(sent[11]?.request).toEqual({ action: 'snooze', until: null });
    expect(sent[2]?.request).toMatchObject({ override: { reason: 'urgent' } });
    expect(sent[3]?.request).toMatchObject({ action: 'undepend', reason: 'no longer needed' });
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

describe('start', () => {
  const card1 = { daemonId: laptop.daemonId, id: 'F1' };

  it('starts a new ferret on the card, on the machine it names', async () => {
    const { actions, started } = harness();
    const answer = await actions.start(card1, 'click-1');
    expect(answer.ok && answer.value).toEqual({ card: 'F1', ferret: 'worker', started: true });
    expect(started).toEqual([{ daemonId: laptop.daemonId, id: 'F1', key: 'click-1' }]);
  });

  it('hands the daemon’s refusal back as a value, and an unpaired machine as such', async () => {
    const { actions, refuse } = harness();
    refuse(true);
    const answer = await actions.start(card1);
    expect(!answer.ok && answer.error).toEqual({ status: 404, message: 'the card was closed', boardCode: 'not-found' });
    const gone = await actions.start({ daemonId: workstation.daemonId, id: 'F1' });
    expect(!gone.ok && gone.error.boardCode).toBe('no-machine');
  });
});

describe('create', () => {
  const request = { kind: 'feature', title: 'Try it', ask: { text: 'do it', source: 'owner (board)' } } as never;

  it('opens the card on the machine it names', async () => {
    const { actions, created } = harness();
    const answer = await actions.create(laptop.daemonId, request);
    expect(answer.ok && answer.value.id).toBe('F9');
    expect(created).toEqual([{ daemonId: laptop.daemonId, request }]);
  });

  it('hands the daemon’s refusal back, and an unpaired machine as such', async () => {
    const { actions, refuse, created } = harness();
    refuse(true);
    const refused = await actions.create(laptop.daemonId, request);
    expect(!refused.ok && refused.error.boardCode).toBe('owner-gate');
    const gone = await actions.create(workstation.daemonId, request);
    expect(!gone.ok && gone.error.boardCode).toBe('no-machine');
    expect(created).toHaveLength(1);
  });
});


describe('lane verbs', () => {
  it('proposes a template and confirms it at once, because the owner chose it', async () => {
    const { actions, lanesSent } = harness();
    const answer = await actions.adoptTemplate(laptop.daemonId, lanes.projectId, 'pr');
    expect(answer.ok && answer.value.version).toBe(2);
    expect(lanesSent.map(sent => sent.request)).toEqual([
      { action: 'propose', template: 'pr', renames: {} },
      { action: 'confirm', version: 1 },
    ]);
  });

  it('stops after a refused proposal', async () => {
    const { actions, lanesSent, refuse } = harness();
    refuse(true);
    const answer = await actions.adoptTemplate(laptop.daemonId, lanes.projectId, 'quick');
    expect(!answer.ok && answer.error.code).toBe('version-conflict');
    expect(lanesSent).toHaveLength(1);
  });

  it('saves an edit against the version it saw', async () => {
    const { actions, lanesSent } = harness();
    const layout = LANE_TEMPLATES.quick;
    const answer = await actions.saveLanes(laptop.daemonId, lanes.projectId, {
      version: 1,
      layout,
      relocate: { review: 'doing' },
    });
    expect(answer.ok).toBe(true);
    expect(lanesSent[0]).toMatchObject({
      projectId: lanes.projectId,
      request: { action: 'edit', version: 1, layout, relocate: { review: 'doing' } },
    });
  });

  it('accepts a proposed set by its version, and says so when the machine is unpaired', async () => {
    const { actions, lanesSent } = harness();
    expect((await actions.acceptLanes(laptop.daemonId, lanes.projectId, 3)).ok).toBe(true);
    expect(lanesSent[0]?.request).toEqual({ action: 'confirm', version: 3 });
    const gone = await actions.acceptLanes(workstation.daemonId, lanes.projectId, 3);
    expect(!gone.ok && gone.error).toMatchObject({ status: 0, code: 'no-machine' });
    expect(lanesSent).toHaveLength(1);
  });
});
