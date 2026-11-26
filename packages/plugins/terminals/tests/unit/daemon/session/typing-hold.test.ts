import { describe, expect, it } from 'bun:test';
import { SessionConsoleService, TYPING_HOLD_MS, TypingHold } from '../../../../daemon/lib/session/console/index.ts';

/**
 * THE TYPING HOLD (owner idea A563), the terminal's half: a person's keys stamp a pane, the stamp lasts 5 s, and it is the
 * pane's own. The fakes here are tmux's answers; the real server is `integration/.../console/typing-hold.test.ts`.
 */
const T0 = 1_800_000_000_000;

const clock = () => {
  let now = T0;
  return {
    nowMs: () => now,
    tick: (ms: number) => {
      now += ms;
    },
  };
};

/** A tmux that answers `list-clients` with the lines given (`seconds|control`), or refuses. */
const tmuxWith = (lines: readonly string[], code = 0) => ({
  execute: async (args: readonly string[]) => ({
    code,
    stdout: args[0] === 'list-clients' ? lines.join('\n') : '',
    stderr: '',
  }),
});
const seconds = (offsetMs: number): number => Math.floor((T0 + offsetMs) / 1_000);

describe('the typing hold', () => {
  it('should hold a pane a person typed into for 5 s, and let go after', async () => {
    const time = clock();
    const hold = new TypingHold(time.nowMs);
    const tmux = tmuxWith([]);

    expect(await hold.held(tmux, '%1', 'fy-a')).toBe(false);
    hold.pressed('%1');
    time.tick(TYPING_HOLD_MS - 1);
    expect(await hold.held(tmux, '%1', 'fy-a')).toBe(true);
    time.tick(1);
    expect(await hold.held(tmux, '%1', 'fy-a')).toBe(false);
  });

  it('should extend the hold with every key, not start it over from the first', async () => {
    const time = clock();
    const hold = new TypingHold(time.nowMs);

    hold.pressed('%1');
    time.tick(4_000);
    hold.pressed('%1');
    time.tick(4_000);

    expect(await hold.held(tmuxWith([]), '%1', 'fy-a')).toBe(true);
  });

  it('should be per pane: one pane typed into holds no other', async () => {
    const hold = new TypingHold(clock().nowMs);

    hold.pressed('%1');

    expect(await hold.held(tmuxWith([]), '%1', 'fy-a')).toBe(true);
    expect(await hold.held(tmuxWith([]), '%2', 'fy-b')).toBe(false);
  });

  it('should see an attached client’s keys by its input second, within the hold', async () => {
    const time = clock();
    const hold = new TypingHold(time.nowMs);

    expect(await hold.held(tmuxWith([`${seconds(-1_000)}|0`]), '%1', 'fy-a')).toBe(true);
    expect(await hold.held(tmuxWith([`${seconds(-6_000)}|0`]), '%1', 'fy-a')).toBe(false);
  });

  it('should never count a control-mode client (the daemon’s own), a failed read or garbage', async () => {
    const hold = new TypingHold(clock().nowMs);
    const fresh = `${seconds(0)}|`;

    expect(await hold.held(tmuxWith([`${fresh}1`]), '%1', 'fy-a')).toBe(false);
    expect(await hold.held(tmuxWith([`${fresh}0`], 1), '%1', 'fy-a')).toBe(false);
    expect(await hold.held(tmuxWith(['x|0', '', '0|0']), '%1', 'fy-a')).toBe(false);
    expect(await hold.held({ execute: async () => Promise.reject(new Error('no server')) }, '%1', 'fy-a')).toBe(false);
  });

  it('should be stamped by the Console BEFORE the first key goes, so a key is never what waits', async () => {
    const hold = new TypingHold(clock().nowMs);
    const seen: boolean[] = [];
    const tmux = {
      execute: async (args: readonly string[]) => {
        if (args[0] === 'send-keys') seen.push(await hold.held(tmuxWith([]), '%7', 'fy-a'));
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const proof = { resolve: async () => ({ paneId: '%7' }) as never };

    const written = await new SessionConsoleService(proof, tmux, hold).write('s1', new TextEncoder().encode('ab'));

    expect(written).toBe(2);
    expect(seen).toEqual([true]);
  });
});
