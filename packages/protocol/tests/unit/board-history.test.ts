import { describe, it } from 'bun:test';
import should from 'should';
import { type BoardTaskEvent, BoardTaskEventSchema } from '../../src/lib/board.ts';
import { describeBoardEvent } from '../../src/lib/board-history.ts';

const AT = '2026-10-30T10:00:00.000Z';
const DENISHA = 'mvuc7tsf-0c3d50df';
const KIRIN = 'mvgt2oz9-04e28935';
const FERRETRY_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';

const LANES: Readonly<Record<string, string>> = {
  todo: 'Todo',
  plan: 'Plan/Design',
  implement: 'Implement',
  review: 'Review/CI',
  merged: 'Merged',
};
const NAMES: Readonly<Record<string, string>> = { [DENISHA]: 'denisha', [KIRIN]: 'kirin' };
const lane = (id: string): string => LANES[id] ?? id;
const names = (id: string): string => NAMES[id] ?? id;

/** An event checked against the wire schema, so a test can never describe an event the daemon would not send. */
const event = (fields: Record<string, unknown>): BoardTaskEvent =>
  BoardTaskEventSchema.parse({ seq: 2, at: AT, actor: { kind: 'ferret', sessionId: DENISHA }, ...fields });

describe('describeBoardEvent', () => {
  const say = (fields: Record<string, unknown>) => describeBoardEvent(event(fields), lane, names);

  it('should describe a creation and a plain move', () => {
    // Act + Assert
    should(say({ type: 'created', laneId: 'todo', seq: 1 })).equal('created in Todo');
    should(say({ type: 'moved', from: 'todo', to: 'plan', backward: false, reason: null })).equal(
      'moved Todo → Plan/Design',
    );
    should(say({ type: 'moved', from: 'todo', to: 'plan', backward: false, reason: 'go' })).equal(
      'moved Todo → Plan/Design: go',
    );
  });

  it('should say a move went back, and an automatic one why the daemon made it', () => {
    // Act + Assert
    should(say({ type: 'moved', from: 'review', to: 'implement', backward: true, reason: 'tests failed' })).equal(
      'moved back Review/CI → Implement: tests failed',
    );
    should(
      say({
        type: 'moved',
        from: 'implement',
        to: 'review',
        backward: false,
        reason: null,
        auto: true,
        trigger: 'pr.opened',
        actor: { kind: 'daemon' },
      }),
    ).equal('moved Implement → Review/CI (auto, pr.opened)');
  });

  it('should describe a reopen with the owner’s new ask', () => {
    // Act + Assert
    should(
      say({
        type: 'reopened',
        from: 'merged',
        to: 'todo',
        reason: 'new scope',
        ask: { text: 'do more', source: 'chat://2' },
      }),
    ).equal('reopened Merged → Todo: new scope — ask: do more');
  });

  it('should describe notes, clarifications and links', () => {
    // Act + Assert
    should(say({ type: 'note', text: 'hello' })).equal('note: hello');
    should(say({ type: 'clarified', text: 'also dark mode', source: 'chat://3' })).equal('clarified: also dark mode');
    should(say({ type: 'linked', field: 'pr', value: 'https://github.com/kirinnee/ferretry/pull/42' })).equal(
      'linked pr: https://github.com/kirinnee/ferretry/pull/42',
    );
  });

  it('should describe an assignment by callsign, and nobody as nobody', () => {
    // Act + Assert
    should(say({ type: 'assigned', from: null, to: KIRIN })).equal('assigned nobody → kirin');
    should(say({ type: 'assigned', from: KIRIN, to: null })).equal('assigned kirin → nobody');
  });

  it('should describe dependencies, with the owner override when there is one', () => {
    // Act + Assert
    should(say({ type: 'depended', task: { id: 'F2' }, until: 'shipped' })).equal('depends on &F2 until shipped');
    should(
      say({
        type: 'depended',
        task: { id: 'F2' },
        until: 'released',
        override: { by: 'owner', reason: 'urgent', at: AT },
      }),
    ).equal('depends on &F2 until released (owner override: urgent)');
    should(say({ type: 'undepended', task: { id: 'F2' }, reason: 'moot' })).equal('no longer depends on &F2: moot');
  });

  it('should describe blocks, with or without a reason to unblock', () => {
    // Act + Assert
    should(say({ type: 'blocked', reason: 'vendor' })).equal('blocked: vendor');
    should(say({ type: 'unblocked', reason: null })).equal('unblocked');
    should(say({ type: 'unblocked', reason: 'fixed' })).equal('unblocked: fixed');
  });

  it('should describe edits and file claims', () => {
    // Act + Assert
    should(say({ type: 'field-edited', field: 'title' })).equal('edited title');
    should(say({ type: 'file-claimed', path: 'src/a.ts' })).equal('claimed src/a.ts');
    should(say({ type: 'file-released', path: 'src/a.ts', reason: null })).equal('released src/a.ts');
    should(say({ type: 'file-released', path: 'src/a.ts', reason: 'done' })).equal('released src/a.ts: done');
  });

  it('should describe a rank, set or cleared', () => {
    // Act + Assert
    should(say({ type: 'ordered', from: null, to: 3 })).equal('ranked — → 3');
    should(say({ type: 'ordered', from: 3, to: null })).equal('ranked 3 → —');
  });

  it('should describe a refile, with or without a reason', () => {
    // Act + Assert
    should(say({ type: 'refiled', fromProject: FERRETRY_ID, toProject: OTHER_ID, toLane: 'todo', reason: null })).equal(
      `refiled to ${OTHER_ID} (Todo)`,
    );
    should(
      say({ type: 'refiled', fromProject: FERRETRY_ID, toProject: 'unfiled', toLane: 'todo', reason: 'wrong board' }),
    ).equal('refiled to unfiled (Todo): wrong board');
  });

  it('should describe a drop and a migration', () => {
    // Act + Assert
    should(say({ type: 'dropped', reason: 'superseded' })).equal('dropped: superseded');
    should(say({ type: 'migrated', legacyRef: 'sess-1:F12' })).equal('migrated from sess-1:F12');
  });
});
