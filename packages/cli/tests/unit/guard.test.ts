import { describe, it } from 'bun:test';
import { CORE_IDS, PROTOCOL } from '@ferretry/kernel/contract';
import should from 'should';
import { judgeCall, judgePlugin, pausedSentence } from '../../src/lib/guard.ts';
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
    should(judgePlugin(inventoryOf({ id: 'other', contract: 'h1' }), compiled, 'other')).deepEqual({
      ok: false,
      reason: 'different',
    });
  });

  it('should say which side is older when the session protocol differs', () => {
    should(
      judgePlugin(
        { ...inventoryOf({ id: 'board', contract: 'h1' }), protocol: PROTOCOL - 1 } as never,
        compiled,
        'board',
      ),
    ).deepEqual({ ok: false, reason: 'daemon-older' });
    should(
      judgePlugin(
        { ...inventoryOf({ id: 'board', contract: 'h1' }), protocol: PROTOCOL + 1 } as never,
        compiled,
        'board',
      ),
    ).deepEqual({ ok: false, reason: 'daemon-newer' });
  });

  it('should say which side to update when the session protocol differs', () => {
    should(pausedSentence({ ok: false, reason: 'daemon-older' }, 'Board', 'board', 'fy')).containEql(
      'restart it on the new build with `fy daemon restart`',
    );
    should(pausedSentence({ ok: false, reason: 'daemon-newer' }, 'Board', 'board', 'fy')).containEql(
      'update fy to use it',
    );
  });

  it('should name the command that fixes each block', () => {
    should(pausedSentence({ ok: false, reason: 'off' }, 'Mail', 'mail', 'fy')).containEql('`fy plugin on mail`');
    // The work surfaces ride one switch (`plugin on` is unwired), so an off one says that and nothing else; no other plugin does.
    const work = pausedSentence({ ok: false, reason: 'off' }, 'Board', 'board', 'fy');
    should(work).startWith('Board is turned off: set `work: on`');
    should(work).not.containEql('plugin on');
    should(pausedSentence({ ok: false, reason: 'off' }, 'Mail', 'mail', 'fy')).not.containEql('work: on');
    should(pausedSentence({ ok: false, reason: 'different' }, 'Board', 'board', 'fy')).containEql(
      '`fy daemon restart`',
    );
    should(pausedSentence({ ok: false, reason: 'missing' }, 'Board', 'board', 'fy')).containEql('does not have Board');
    should(pausedSentence({ ok: false, reason: 'daemon-newer' }, 'Board', 'board', 'fy')).containEql('update fy');
  });
});

describe('judgeCall (every core package first, §9.6)', () => {
  // Derived from the kernel's CORE_IDS so the next core piece cannot leave this fixture behind.
  const core = CORE_IDS.map(id => ({ id: id as string, contract: `h-${id}` }));
  const compiled: Record<string, string> = {
    ...Object.fromEntries(core.map(entry => [entry.id, entry.contract])),
    board: 'h1',
  };

  it('should allow a plugin when every core package and the plugin match', () => {
    should(judgeCall(inventoryOf(...core, { id: 'board', contract: 'h1' }), compiled, 'board')).deepEqual({ ok: true });
  });

  it('should block a matching plugin when a core package differs, is off or is missing', () => {
    const differs = core.map(entry => (entry.id === 'gate' ? { ...entry, contract: 'other' } : entry));
    should(judgeCall(inventoryOf(...differs, { id: 'board', contract: 'h1' }), compiled, 'board')).deepEqual({
      ok: false,
      reason: 'core',
      core: 'gate',
      why: 'different',
    });
    const off = core.map(entry => (entry.id === 'vault' ? { ...entry, on: false } : entry));
    should(judgeCall(inventoryOf(...off, { id: 'board', contract: 'h1' }), compiled, 'board')).deepEqual({
      ok: false,
      reason: 'core',
      core: 'vault',
      why: 'off',
    });
    const noFerrets = {
      protocol: PROTOCOL,
      plugins: [...core.filter(entry => entry.id !== 'ferrets'), { id: 'board', contract: 'h1' }].map(entry => ({
        ...entry,
        on: true,
      })),
    };
    should(judgeCall(noFerrets, compiled, 'board')).deepEqual({
      ok: false,
      reason: 'core',
      core: 'ferrets',
      why: 'missing',
    });
  });

  it('should block everything when this fy has no compiled hash for a core package', () => {
    const { kernel: _kernel, ...withoutKernel } = compiled;
    should(judgeCall(inventoryOf(...core, { id: 'board', contract: 'h1' }), withoutKernel, 'board')).deepEqual({
      ok: false,
      reason: 'core',
      core: 'kernel',
      why: 'different',
    });
  });

  it('should still say which side is older before any core verdict', () => {
    const older = { protocol: PROTOCOL - 1, plugins: [] } as never;
    should(judgeCall(older, compiled, 'board')).deepEqual({ ok: false, reason: 'daemon-older' });
  });

  it('should name the core package and the fix', () => {
    should(
      pausedSentence({ ok: false, reason: 'core', core: 'gate', why: 'different' }, 'Gate', 'gate', 'fy'),
    ).containEql('Gate, which everything needs, differs between fy and the daemon');
    should(
      pausedSentence({ ok: false, reason: 'core', core: 'gate', why: 'missing' }, 'Gate', 'gate', 'fy'),
    ).containEql('does not have Gate, which everything needs');
  });
});
