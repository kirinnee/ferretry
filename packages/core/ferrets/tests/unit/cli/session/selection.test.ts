import { describe, expect, test } from 'bun:test';
import { selectSessions } from '../../../../cli/lib/session/selection.ts';
import { sessionView } from './session-fixtures.ts';

const running = sessionView({ id: 'run', name: 'wren', label: 'batch' as never });
const idle = sessionView({ id: 'idle', name: 'fern', state: 'idle', label: 'batch ' as never });
const done = sessionView({ id: 'done', name: 'oak', state: 'stopped', label: 'batch' as never });
const packed = sessionView({ id: 'packed', name: 'elm', label: 'batch' as never, pack: 'crew' as never });

describe('fy ps label filter', () => {
  test('V-0366 keeps only the exact ownership label, before the liveness filter', () => {
    const actual = selectSessions([running, idle, done], { label: 'batch' });
    expect(actual.sessions.map(view => view.name)).toEqual(['wren']);
  });

  test('V-0366 points at -a when the label matched only stopped ferrets', () => {
    const actual = selectSessions([done], { label: 'batch' });
    expect(actual.sessions).toEqual([]);
    expect(actual.emptyMessage).toBe('no running ferrets (use -a to show stopped ones)');
  });

  test('V-0366 says which label matched nothing rather than claiming there are no ferrets', () => {
    const actual = selectSessions([running, idle], { label: 'other', all: true });
    expect(actual.emptyMessage).toBe('no ferrets with label "other"');
  });

  test('V-0366 --pack and --label both apply when both are given', () => {
    const actual = selectSessions([running, packed], { label: 'batch', pack: 'crew' });
    expect(actual.sessions.map(view => view.name)).toEqual(['elm']);
    expect(selectSessions([running], { label: 'batch', pack: 'crew' }).emptyMessage).toBe('no ferrets in pack "crew"');
  });
});
