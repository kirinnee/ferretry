import { describe, expect, test } from 'bun:test';
import { recordMoveRefusal } from '../../../../../daemon/modules/session-move.ts';

/** `session.move_refused`: the one record of a 409, shaped like `session.move_forced`. */
describe('recordMoveRefusal', () => {
  const record = async (items: Array<{ blocks: boolean; title: string; detail?: string }>) => {
    const appended: unknown[][] = [];
    await recordMoveRefusal(
      { append: async (...args: unknown[]) => void appended.push(args) } as never,
      { warn: () => {} },
      'wren' as never,
      { to: 'claude-two', verdict: 'unknown', cause: 'nothing observable', described: { items }, by: 'warden' },
    );
    return appended;
  };

  test('appends exactly one event with the target, verdict, cause, blockers and who asked', async () => {
    const appended = await record([
      { blocks: true, title: 'a tool shell', detail: 'zsh -c …' },
      { blocks: false, title: 'harmless' },
      { blocks: true, title: 'bare' },
    ]);
    expect(appended).toEqual([
      [
        'wren',
        'session.move_refused',
        {
          to: 'claude-two',
          verdict: 'unknown',
          cause: 'nothing observable',
          blockers: [{ title: 'a tool shell', detail: 'zsh -c …' }, { title: 'bare' }],
          by: 'warden',
        },
      ],
    ]);
  });

  test('a failed append is said once and swallowed, so the caller still throws its typed refusal', async () => {
    const warnings: Array<[string, unknown]> = [];
    await recordMoveRefusal(
      {
        append: async () => {
          throw new Error('EIO');
        },
      } as never,
      { warn: (message: string, fields?: unknown) => void warnings.push([message, fields]) },
      'wren' as never,
      { to: 'claude-two', verdict: 'unknown', cause: 'x', described: { items: [] }, by: 'owner' },
    );
    expect(warnings).toEqual([
      [
        'a refused move could not be journalled; it is still refused',
        { session: 'wren', event: 'session.move_refused', error: 'EIO' },
      ],
    ]);
  });
});
