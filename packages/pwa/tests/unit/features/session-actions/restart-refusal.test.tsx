import { afterEach, describe, expect, it } from 'bun:test';
import type { MigrationRefusal, SessionView } from '@ferretry/protocol';
import { useRestartRefusal } from '../../../../src/features/session-actions/restart-refusal.tsx';
import {
  RestartDowngradeRefused,
  RestartRefused,
} from '../../../../src/features/session-actions/session-operations.ts';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';
import { sessionView } from '../../../support/sessions.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const refusal = (overrides: Partial<MigrationRefusal> = {}): MigrationRefusal => ({
  status: 'running',
  turn: 13,
  blockedBy: 'unknown',
  restartsWithCli: 0,
  items: [
    {
      kind: 'process',
      verdict: 'unknown',
      title: 'A program Ferretry doesn’t recognise is running',
      detail: 'fy-helper --watch',
      age: '24h',
      blocks: true,
    },
    { kind: 'process', verdict: 'safe_to_kill', title: 'A short read-only command is running', blocks: false },
  ],
  ...overrides,
});

let held: ((reason: unknown) => boolean) | undefined;
const Probe = ({
  publish,
  scope = 'a',
}: {
  readonly publish: (view: SessionView) => void;
  readonly scope?: string;
}) => {
  const { capture, panel } = useRestartRefusal(publish, scope);
  held = capture;
  return <div>{panel}</div>;
};

const show = async (publish: (view: SessionView) => void = () => undefined) => {
  mounted = await mount(<Probe publish={publish} />);
  return mounted.container;
};
const hold = async (restartAnyway: () => Promise<SessionView>, over: Partial<MigrationRefusal> = {}) => {
  let answer = false;
  await interact(() => {
    answer = must(held, 'capture')(new RestartRefused(refusal(over), restartAnyway));
  });
  return answer;
};
const text = (root: HTMLElement): string => root.textContent ?? '';
const press = async (root: HTMLElement, marker: string): Promise<void> => {
  await interact(() => must(root.querySelector<HTMLElement>(`[${marker}]`), marker).click());
};

describe('useRestartRefusal', () => {
  it('leaves any other failure to the caller', async () => {
    const root = await show();
    let answer = true;
    await interact(() => {
      answer = must(held, 'capture')(new Error('socket closed'));
    });
    expect(answer).toBe(false);
    expect(root.querySelector('[data-restart-refusal]')).toBeNull();
  });

  it('lists only what blocked the restart, in plain words, with Cancel focused', async () => {
    const root = await show();
    expect(await hold(async () => sessionView('a'))).toBe(true);
    const panel = text(root);
    expect(panel).toContain('Restart paused — Ferretry can’t tell if what the agent is running is safe to stop.');
    expect(panel).toContain('A program Ferretry doesn’t recognise is running');
    expect(panel).toContain('fy-helper --watch');
    expect(panel).toContain('running 24h');
    expect(panel).not.toContain('read-only');
    expect(panel).not.toContain('helper process');
    expect(document.activeElement).toBe(root.querySelector('[data-restart-refusal-cancel]'));
  });

  it('counts the processes that restart with the CLI, singular and plural', async () => {
    const root = await show();
    await hold(async () => sessionView('a'), { restartsWithCli: 1 });
    expect(text(root)).toContain('1 helper process belongs to the agent and restarts with it.');
    await hold(async () => sessionView('a'), { restartsWithCli: 3 });
    expect(text(root)).toContain('3 helper processes belong to the agent and restart with it.');
  });

  it('Cancel closes the panel and asks nothing', async () => {
    const asked: string[] = [];
    const root = await show();
    await hold(async () => {
      asked.push('again');
      return sessionView('a');
    });
    await press(root, 'data-restart-refusal-cancel');
    expect(root.querySelector('[data-restart-refusal]')).toBeNull();
    expect(asked).toEqual([]);
  });

  it('Restart anyway asks again once, publishes the view and closes', async () => {
    const published: string[] = [];
    let release: (view: SessionView) => void = () => undefined;
    const root = await show(view => published.push(view.config.id));
    await hold(() => new Promise<SessionView>(resolve => (release = resolve)));
    await press(root, 'data-restart-refusal-anyway');
    // A second press while it is in flight is ignored, and the buttons say so.
    expect(text(root)).toContain('Restarting…');
    expect(must(root.querySelector<HTMLButtonElement>('[data-restart-refusal-anyway]'), 'button').disabled).toBe(true);
    await interact(() => release(sessionView('a')));
    await interact(() => Promise.resolve());
    expect(published).toEqual(['a']);
    expect(root.querySelector('[data-restart-refusal]')).toBeNull();
  });

  it('keeps the panel and says why when Restart anyway fails, and can be tried again', async () => {
    const root = await show();
    let calls = 0;
    await hold(async () => {
      calls += 1;
      if (calls === 1) throw new Error('the machine did not answer');
      throw 'plain string';
    });
    await press(root, 'data-restart-refusal-anyway');
    await interact(() => Promise.resolve());
    expect(text(root)).toContain('Restart anyway failed: the machine did not answer');
    await press(root, 'data-restart-refusal-anyway');
    await interact(() => Promise.resolve());
    expect(text(root)).toContain('Restart anyway failed: plain string');
    expect(calls).toBe(2);
  });

  it('drops a held refusal when the ferret on screen changes', async () => {
    const root = await show();
    await hold(async () => sessionView('a'));
    await must(mounted, 'mounted').render(<Probe publish={() => undefined} scope="b" />);
    expect(root.querySelector('[data-restart-refusal]')).toBeNull();
  });
});

describe('useRestartRefusal — a smaller context window', () => {
  const downgrade = { model: 'claude-opus-5-5', targetWindow: 200_000, currentWindow: 1_000_000 };
  const holdDowngrade = async (
    restartAnyway: () => Promise<SessionView>,
    numbers: typeof downgrade | null = downgrade,
  ) => {
    let answer = false;
    await interact(() => {
      answer = must(held, 'capture')(new RestartDowngradeRefused(numbers, restartAnyway));
    });
    return answer;
  };

  it('says the two windows in plain words, with Cancel focused and the explicit button named for what it does', async () => {
    const root = await show();
    expect(await holdDowngrade(async () => sessionView('a'))).toBe(true);
    const panel = text(root);
    expect(panel).toContain(
      'Restarting would give this conversation a smaller window — 200,000 tokens instead of 1,000,000 — so part of it would be cut off.',
    );
    expect(panel).toContain('Restart with the smaller window');
    expect(panel).not.toContain('allowContextDowngrade');
    expect(root.querySelector('[data-restart-downgrade]')).not.toBeNull();
    expect(document.activeElement).toBe(root.querySelector('[data-restart-refusal-cancel]'));
  });

  it('says it without numbers when an older daemon sent none', async () => {
    const root = await show();
    await holdDowngrade(async () => sessionView('a'), null);
    expect(text(root)).toContain('a smaller window, so part of it would be cut off.');
  });

  it('Cancel asks nothing; the explicit button asks once, publishes and closes', async () => {
    const published: string[] = [];
    let asked = 0;
    const root = await show(view => published.push(view.config.id));
    await holdDowngrade(async () => {
      asked += 1;
      return sessionView('a');
    });
    await press(root, 'data-restart-refusal-cancel');
    expect(root.querySelector('[data-restart-downgrade]')).toBeNull();
    expect(asked).toBe(0);
    await holdDowngrade(async () => {
      asked += 1;
      return sessionView('a');
    });
    await press(root, 'data-restart-refusal-anyway');
    await interact(() => Promise.resolve());
    expect(asked).toBe(1);
    expect(published).toEqual(['a']);
    expect(root.querySelector('[data-restart-downgrade]')).toBeNull();
  });

  it('shows the busy label while asking, and names the failure by what was pressed', async () => {
    const root = await show();
    let release: (view: SessionView) => void = () => undefined;
    await holdDowngrade(() => new Promise<SessionView>(resolve => (release = resolve)));
    await press(root, 'data-restart-refusal-anyway');
    expect(text(root)).toContain('Restarting…');
    await interact(() => release(sessionView('a')));
    await interact(() => Promise.resolve());
    await holdDowngrade(async () => {
      throw new Error('the machine did not answer');
    });
    await press(root, 'data-restart-refusal-anyway');
    await interact(() => Promise.resolve());
    expect(text(root)).toContain('Restart with the smaller window failed: the machine did not answer');
  });

  it('moves on to the other question when confirming this one meets it, instead of failing', async () => {
    const root = await show();
    await holdDowngrade(async () => {
      throw new RestartRefused(refusal(), async () => sessionView('a'));
    });
    await press(root, 'data-restart-refusal-anyway');
    await interact(() => Promise.resolve());
    expect(root.querySelector('[data-restart-downgrade]')).toBeNull();
    expect(root.querySelector('[data-restart-refusal]')).not.toBeNull();
    expect(text(root)).not.toContain('failed');
  });
});
