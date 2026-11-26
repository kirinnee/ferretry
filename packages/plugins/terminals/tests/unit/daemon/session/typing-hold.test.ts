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

/** A tmux that answers `list-clients` with the lines given (`input|attached|control|pane`), or refuses. */
const tmuxWith = (lines: readonly string[], code = 0) => ({
  execute: async (args: readonly string[]) => ({
    code,
    stdout: args[0] === 'list-clients' ? lines.join('\n') : '',
    stderr: '',
  }),
});
const seconds = (offsetMs: number): number => Math.floor((T0 + offsetMs) / 1_000);
/** One attached person's client: its last input and its attach (ms from now), and the pane it is looking at. */
const client = (inputMs: number, attachedMs: number, pane: string): string =>
  `${seconds(inputMs)}|${seconds(attachedMs)}|0|${pane}`;

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

  it('should see a key in the pane the attached client is looking at, within the hold', async () => {
    const hold = new TypingHold(clock().nowMs);

    expect(await hold.held(tmuxWith([client(-1_000, -60_000, '%1')]), '%1', 'fy-a')).toBe(true);
    expect(await new TypingHold(clock().nowMs).held(tmuxWith([client(-6_000, -60_000, '%1')]), '%1', 'fy-a')).toBe(
      false,
    );
  });

  it('should not hold a sibling pane the client is not looking at', async () => {
    const hold = new TypingHold(clock().nowMs);
    const listing = tmuxWith([client(-1_000, -60_000, '%1')]);

    expect(await hold.held(listing, '%1', 'fy-a')).toBe(true);
    expect(await hold.held(listing, '%2', 'fy-a')).toBe(false);
  });

  it('should not take attaching for typing: a stamp no later than the attach is no key', async () => {
    const hold = new TypingHold(clock().nowMs);

    expect(await hold.held(tmuxWith([client(-1_000, -1_000, '%1')]), '%1', 'fy-a')).toBe(false);
    expect(await hold.held(tmuxWith([client(-1_000, 0, '%1')]), '%1', 'fy-a')).toBe(false);
  });

  it('should never hold for a stamp from the future, however far ahead or long after', async () => {
    const time = clock();
    const hold = new TypingHold(time.nowMs);
    const tomorrow = tmuxWith([client(86_400_000, -60_000, '%1')]);

    expect(await hold.held(tomorrow, '%1', 'fy-a')).toBe(false);
    time.tick(3_600_000);
    expect(await hold.held(tomorrow, '%1', 'fy-a')).toBe(false);
  });

  it('should let go 5 s after the stamp was first seen, however the stamp keeps reading', async () => {
    const time = clock();
    const hold = new TypingHold(time.nowMs);
    // One stamp, 1 s old when first read, and tmux's clock says it is still fresh for a long while (a stuck stamp).
    const stamp = Math.floor((T0 - 1_000) / 1_000);
    const stuck = { execute: async () => ({ code: 0, stdout: `${stamp}|${stamp - 60}|0|%1`, stderr: '' }) };

    expect(await hold.held(stuck, '%1', 'fy-a')).toBe(true);
    time.tick(TYPING_HOLD_MS - 1_001);
    expect(await hold.held(stuck, '%1', 'fy-a')).toBe(true);
    time.tick(2_000);
    expect(await hold.held(stuck, '%1', 'fy-a')).toBe(false);
  });

  it('should count a Console key that lands while tmux is being asked', async () => {
    const hold = new TypingHold(clock().nowMs);
    const slow = {
      execute: async () => {
        hold.pressed('%1');
        return { code: 0, stdout: '', stderr: '' };
      },
    };

    expect(await hold.held(slow, '%1', 'fy-a')).toBe(true);
  });

  it('should never count a control-mode client (the daemon’s own), a failed read or garbage', async () => {
    const hold = new TypingHold(clock().nowMs);
    const fresh = `${seconds(-1_000)}|${seconds(-60_000)}`;

    expect(await hold.held(tmuxWith([`${fresh}|1|%1`]), '%1', 'fy-a')).toBe(false);
    expect(await hold.held(tmuxWith([`${fresh}|0|%1`], 1), '%1', 'fy-a')).toBe(false);
    expect(await hold.held(tmuxWith(['x|y|0|%1', '', '0|0|0|%1']), '%1', 'fy-a')).toBe(false);
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
