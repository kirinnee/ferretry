import { describe, expect, test } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import { KernelFerretFocus } from '../../../daemon/adapters/store/focus-store.ts';
import { BoardUnavailableError } from '../../../daemon/lib/board/index.ts';

/** Finding 14: one damaged `focus.json` holds every ferret's focus, so it is never read as "no focus" or written as done. */
const DAMAGE = { file: 'focus.json', reason: 'unparsable', sentence: 'focus.json is not JSON' } as const;

const focusOver = (state: Partial<StatePort>) => {
  const warnings: string[] = [];
  const focus = new KernelFerretFocus(
    state as StatePort,
    {} as never,
    { get: async () => ({ id: 'f1' }) as never },
    { run: async (_key, work) => await work() },
    { warn: message => warnings.push(message) },
  );
  return { focus, warnings };
};

describe('a damaged focus file', () => {
  test('is refused as an unavailable board, warned about, never read as no focus', async () => {
    const { focus, warnings } = focusOver({ read: async () => ({ ok: false, error: DAMAGE }) as never });

    await expect(focus.focusOf('f1')).rejects.toBeInstanceOf(BoardUnavailableError);
    await expect(focus.skipOf('f1')).rejects.toBeInstanceOf(BoardUnavailableError);
    expect(warnings.join('\n')).toContain('focus.json is not JSON');
  });

  test('refuses a focus, anchor or skip write that did not land, instead of reporting it done', async () => {
    const { focus, warnings } = focusOver({ update: async () => ({ ok: false, error: DAMAGE }) as never });

    await expect(focus.setFocus('f1', { id: 'F1' } as never, undefined, { anchor: true })).rejects.toBeInstanceOf(
      BoardUnavailableError,
    );
    await expect(
      focus.skip('f1', { reason: 'docs only', at: '2026-11-07T09:00:00.000Z' } as never),
    ).rejects.toBeInstanceOf(BoardUnavailableError);
    expect(warnings).toHaveLength(2);
  });
});
