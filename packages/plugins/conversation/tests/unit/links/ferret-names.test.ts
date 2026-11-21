import { describe, expect, test } from 'bun:test';
import {
  ferretConversationNames,
  startTitleSweep,
  titleOffer,
  titleWatch,
} from '../../../daemon/links/lib/ferret-names.ts';

const ferret = (extra: Record<string, unknown>) =>
  ({ id: 'ms-12', harness: 'claude-code', harnessConversation: 'c1', name: 'Ms-12', ...extra }) as never;

describe('which ferret runs each conversation, and its title', () => {
  test('a ferret with a title gives it, and who chose it', () => {
    expect(
      ferretConversationNames([ferret({ title: 'Fix flaky login test', titleSource: 'auto' })]).get('claude-code:c1'),
    ).toEqual({
      ferret: 'ms-12',
      name: 'Ms-12',
      title: 'Fix flaky login test',
      titleSource: 'auto',
    });
  });

  test('a title stored before its source existed is the owner’s', () => {
    expect(ferretConversationNames([ferret({ title: 'Mine' })]).get('claude-code:c1')).toMatchObject({
      title: 'Mine',
      titleSource: 'owner',
    });
  });

  test('a ferret with no title, a blank one, or only the start placeholder has none', () => {
    for (const title of [undefined, '', '   ', 'interactive', ' Interactive ']) {
      const found = ferretConversationNames([
        ferret({ title, titleSource: title === undefined ? undefined : 'auto' }),
      ]).get('claude-code:c1');
      expect(found).toEqual({ ferret: 'ms-12', name: 'Ms-12' });
    }
  });

  test('a placeholder the owner typed is their title', () => {
    expect(
      ferretConversationNames([ferret({ title: 'interactive', titleSource: 'owner' })]).get('claude-code:c1'),
    ).toMatchObject({
      title: 'interactive',
      titleSource: 'owner',
    });
  });

  test('a ferret that runs no harness conversation is not listed', () => {
    expect(ferretConversationNames([ferret({ harnessConversation: undefined })]).size).toBe(0);
  });
});

describe('which conversations the title sweep still watches (r11 S11 round 3)', () => {
  test('a running ferret with no title, the placeholder or an offered title is watched', () => {
    for (const state of ['starting', 'working', 'idle']) {
      for (const extra of [
        {},
        { title: 'interactive', titleSource: 'auto' },
        { title: 'Fix login', titleSource: 'auto' },
      ]) {
        expect([...titleWatch([ferret({ state, ...extra })])]).toEqual(['claude-code:c1']);
      }
    }
  });

  test('a STOPPED ferret is never watched, whatever its title', () => {
    for (const extra of [{}, { title: 'Fix login', titleSource: 'auto' }]) {
      expect(titleWatch([ferret({ state: 'stopped', ...extra })]).size).toBe(0);
    }
  });

  test('an owner title ends the watch, stored before the source existed or not', () => {
    expect(titleWatch([ferret({ state: 'idle', title: 'Mine', titleSource: 'owner' })]).size).toBe(0);
    expect(titleWatch([ferret({ state: 'idle', title: 'Mine' })]).size).toBe(0);
    expect(titleWatch([ferret({ state: 'idle', title: 'interactive', titleSource: 'owner' })]).size).toBe(0);
  });

  test('a ferret with no harness conversation is not watched', () => {
    expect(titleWatch([ferret({ state: 'idle', harnessConversation: undefined })]).size).toBe(0);
  });
});

describe('offering a title to a ferret (r11 S11 CI coverage)', () => {
  test('a ferret’s id is offered the title and its answer is given back', async () => {
    const offered: Array<[string, string]> = [];
    const offer = titleOffer({
      adoptTitle: async (id, title) => {
        offered.push([id, title]);
        return 'adopted';
      },
    });
    expect(await offer('ms-12', 'Fix flaky login test')).toBe('adopted');
    expect(offered).toEqual([['ms-12', 'Fix flaky login test']]);
  });

  test('an id that is not a ferret’s keeps what it has, and nothing is offered', async () => {
    let asked = false;
    const offer = titleOffer({
      adoptTitle: async () => {
        asked = true;
        return 'adopted';
      },
    });
    expect(await offer('not a ferret id!', 'Fix flaky login test')).toBe('kept');
    expect(asked).toBe(false);
  });

  test('a Ferrets with no such port keeps what it has', async () => {
    expect(await titleOffer({})('ms-12', 'Fix flaky login test')).toBe('kept');
  });
});

describe('the title sweep (r11 S11 CI coverage)', () => {
  const settle = async () => await new Promise<void>(resolve => setTimeout(resolve, 0));

  const sweep = (
    over: {
      readonly watching?: () => Promise<ReadonlySet<string>>;
      readonly refresh?: (only: ReadonlySet<string>) => Promise<void>;
    } = {},
  ) => {
    const clock: { interval?: number; tick?: () => void; stopped: number } = { stopped: 0 };
    const refreshed: string[][] = [];
    const warnings: string[] = [];
    const stop = startTitleSweep({
      every: (intervalMs, tick) => {
        clock.interval = intervalMs;
        clock.tick = tick;
        return () => {
          clock.stopped += 1;
        };
      },
      watching: over.watching ?? (async () => new Set(['claude-code:c1'])),
      refresh:
        over.refresh ??
        (async only => {
          refreshed.push([...only]);
        }),
      warn: message => void warnings.push(message),
    });
    return { clock, refreshed, warnings, stop };
  };

  test('every five seconds it looks again at exactly the conversations a title can still arrive for, and hands back what stops it', async () => {
    const { clock, refreshed, stop } = sweep();
    expect(clock.interval).toBe(5_000);
    clock.tick?.();
    await settle();
    expect(refreshed).toEqual([['claude-code:c1']]);
    stop();
    expect(clock.stopped).toBe(1);
  });

  test('with nothing to watch a tick reads nothing at all', async () => {
    const { clock, refreshed } = sweep({ watching: async () => new Set() });
    clock.tick?.();
    await settle();
    expect(refreshed).toEqual([]);
  });

  test('a tick still running when the next is due is not started twice', async () => {
    let release: () => void = () => undefined;
    const { clock, refreshed } = sweep({
      refresh: async only => {
        refreshed.push([...only]);
        await new Promise<void>(resolve => {
          release = resolve;
        });
      },
    });
    clock.tick?.();
    await settle();
    clock.tick?.();
    await settle();
    expect(refreshed).toHaveLength(1);
    release();
    await settle();
    clock.tick?.();
    await settle();
    expect(refreshed).toHaveLength(2);
    release();
  });

  test('a failing look is said once and the sweep carries on at the next tick', async () => {
    let fail: unknown = new Error('disk gone');
    const { clock, refreshed, warnings } = sweep({
      refresh: async only => {
        if (fail !== undefined) throw fail;
        refreshed.push([...only]);
      },
    });
    clock.tick?.();
    await settle();
    expect(warnings).toEqual(['The title sweep failed: disk gone']);
    fail = 'plain text';
    clock.tick?.();
    await settle();
    expect(warnings.at(-1)).toBe('The title sweep failed: plain text');
    fail = undefined;
    clock.tick?.();
    await settle();
    expect(refreshed).toEqual([['claude-code:c1']]);
  });
});
