import { describe, expect, test } from 'bun:test';
import type { Content, TargetKind, TargetRef } from '../../../contract/act.ts';
import type { InputHolds } from '../../../contract/bound.ts';
import { MintedIdRegistry } from '../../../host/act.ts';
import { testActRunner } from '../../../testing/act.ts';

const target: TargetRef = { kind: 'page' as TargetKind, key: 'p1' };

describe('the test host act runner keeps the kernel rules for prepare and observed', () => {
  test('prepare runs inside the queue before decide; observed hears a completed act only', async () => {
    let document = 'a';
    let fresh = '';
    const log: string[] = [];
    const holds: InputHolds = {
      prepare: async () => {
        fresh = document;
      },
      decide: (_t, op) => (log.push(`decide:${op}@${fresh}`), op === 'close' ? { refused: 'held' } : 'allow'),
      observed: (_t, op, actor) => log.push(`observed:${op}:${actor}`),
    };
    const act = testActRunner({ holds: () => holds, actor: () => 'ferret', minted: new MintedIdRegistry(() => 'x') });
    const first = act(target, 'navigate', async () => ((document = 'b'), { status: 'done' }));
    const second = act(target, 'read', async () => ({ kind: 'content' }) satisfies Content);
    const third = act(target, 'close', async () => ({ status: 'done' }));
    await Promise.all([first, second, third]);
    expect(log).toEqual([
      'decide:navigate@a',
      'observed:navigate:ferret',
      'decide:read@b',
      'observed:read:ferret',
      'decide:close@b',
    ]);
  });
});
