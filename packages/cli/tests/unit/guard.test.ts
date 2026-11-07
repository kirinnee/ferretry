import { describe, it } from 'bun:test';
import { PROTOCOL } from '@ferretry/kernel/contract';
import should from 'should';
import { judgePlugin, pausedSentence } from '../../src/lib/guard.ts';
import { inventoryOf } from './fakes.ts';

const compiled = { board: 'h1' };

describe('judgePlugin (the client guard, §9.6)', () => {
  it('should allow a plugin that is present, on and has the same contract hash', () => {
    should(judgePlugin(inventoryOf({ id: 'board', contract: 'h1' }), compiled, 'board')).deepEqual({ ok: true });
  });

  for (const [name, inventory, reason] of [
    ['missing', inventoryOf(), 'missing'],
    ['off', inventoryOf({ id: 'board', on: false, contract: 'h1' }), 'off'],
    ['a different hash', inventoryOf({ id: 'board', contract: 'h2' }), 'different'],
  ] as const)
    it(`should block a plugin that is ${name}`, () => {
      should(judgePlugin(inventory, compiled, 'board')).deepEqual({ ok: false, reason });
    });

  it('should block a plugin this fy has no hash for', () => {
    should(judgePlugin(inventoryOf({ id: 'other', contract: 'h1' }), compiled, 'other')).deepEqual({ ok: false, reason: 'different' });
  });

  it('should say which side is older when the session protocol differs', () => {
    should(judgePlugin({ ...inventoryOf({ id: 'board', contract: 'h1' }), protocol: PROTOCOL - 1 } as never, compiled, 'board')).deepEqual({ ok: false, reason: 'daemon-older' });
    should(judgePlugin({ ...inventoryOf({ id: 'board', contract: 'h1' }), protocol: PROTOCOL + 1 } as never, compiled, 'board')).deepEqual({ ok: false, reason: 'daemon-newer' });
  });

  it('should name the command that fixes each block', () => {
    should(pausedSentence({ ok: false, reason: 'off' }, 'Board', 'board', 'fy')).containEql('`fy plugin on board`');
    should(pausedSentence({ ok: false, reason: 'different' }, 'Board', 'board', 'fy')).containEql('`fy daemon restart`');
    should(pausedSentence({ ok: false, reason: 'missing' }, 'Board', 'board', 'fy')).containEql('does not have Board');
    should(pausedSentence({ ok: false, reason: 'daemon-newer' }, 'Board', 'board', 'fy')).containEql('update fy');
  });
});
