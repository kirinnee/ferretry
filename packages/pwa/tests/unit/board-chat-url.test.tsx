import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';

import { useChatTasksUrl, useStateChatTasks } from '../../src/hooks/use-chat-tasks-url.ts';
import { type ChatTasksView, readChatTasksUrl, withChatTasksUrl } from '../../src/lib/board-chat-url.ts';
import '../support/dom.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('readChatTasksUrl and withChatTasksUrl', () => {
  test('read what the address says and treat anything else as the plain panel', () => {
    expect(readChatTasksUrl('')).toEqual({ expanded: false, agents: false });
    expect(readChatTasksUrl('?tasks=full&agents=1')).toEqual({ expanded: true, agents: true });
    expect(readChatTasksUrl('?tasks=wide&agents=0')).toEqual({ expanded: false, agents: false });
  });

  test('set and clear each parameter and leave the rest of the query alone', () => {
    expect(withChatTasksUrl('', { expanded: true })).toBe('?tasks=full');
    expect(withChatTasksUrl('?agenda=A3', { expanded: true, agents: true })).toBe('?agenda=A3&tasks=full&agents=1');
    expect(withChatTasksUrl('?tasks=full&agents=1&agenda=A3', { expanded: false })).toBe('?agents=1&agenda=A3');
    expect(withChatTasksUrl('?tasks=full&agents=1', { expanded: false, agents: false })).toBe('');
    expect(withChatTasksUrl('?tasks=full', {})).toBe('?tasks=full');
  });
});

interface Moves {
  readonly navigated: { to: string; replace: boolean }[];
  readonly backed: string[];
}

const probe = (search: string, moves: Moves, seen: { view?: ChatTasksView }): (() => ReactElement) =>
  function Probe() {
    seen.view = useChatTasksUrl(
      {
        navigate: (to, options) => void moves.navigated.push({ to, replace: options?.replace === true }),
        back: to => void moves.backed.push(to),
      },
      { pathname: '/d/laptop/s/S1', search },
    );
    return <p>{String(seen.view.expanded)}</p>;
  };

const rig = async (search: string) => {
  const moves: Moves = { navigated: [], backed: [] };
  const seen: { view?: ChatTasksView } = {};
  const Probe = probe(search, moves, seen);
  view = await mount(<Probe />);
  return { moves, seen };
};

describe('useChatTasksUrl', () => {
  test('reads the address', async () => {
    const { seen } = await rig('?tasks=full&agents=1');
    expect(seen.view).toMatchObject({ expanded: true, agents: true });
  });

  test('expands by pushing an entry that keeps the rest of the query', async () => {
    const { moves, seen } = await rig('?agenda=A3');
    await interact(() => must(seen.view, 'view').setExpanded(true));
    expect(moves.navigated).toEqual([{ to: '/d/laptop/s/S1?agenda=A3&tasks=full', replace: false }]);
  });

  test('changes "Show agent tasks" in place', async () => {
    const { moves, seen } = await rig('?tasks=full');
    await interact(() => must(seen.view, 'view').setAgents(true));
    expect(moves.navigated).toEqual([{ to: '/d/laptop/s/S1?tasks=full&agents=1', replace: true }]);
  });

  test('collapses by stepping back when it was never opened here, or nothing changed since', async () => {
    const reloaded = await rig('?tasks=full');
    await interact(() => must(reloaded.seen.view, 'view').setExpanded(false));
    expect(reloaded.moves.backed).toEqual(['/d/laptop/s/S1']);
    await view?.unmount();
    view = null;

    const opened = await rig('');
    await interact(() => must(opened.seen.view, 'view').setExpanded(true));
    expect(opened.moves.backed).toEqual([]);
  });

  test('collapses in place when "Show agent tasks" changed while expanded, so the choice survives', async () => {
    const moves: Moves = { navigated: [], backed: [] };
    const seen: { view?: ChatTasksView } = {};
    const router = {
      navigate: (to: string, options?: { replace?: boolean }) =>
        void moves.navigated.push({ to, replace: options?.replace === true }),
      back: (to: string) => void moves.backed.push(to),
    };
    function Probe({ search }: { readonly search: string }) {
      seen.view = useChatTasksUrl(router, { pathname: '/d/laptop/s/S1', search });
      return null;
    }
    view = await mount(<Probe search="" />);
    await interact(() => must(seen.view, 'view').setExpanded(true));
    await view.render(<Probe search="?tasks=full&agents=1" />);
    await interact(() => must(seen.view, 'view').setExpanded(false));
    expect(moves.backed).toEqual([]);
    expect(moves.navigated.at(-1)).toEqual({ to: '/d/laptop/s/S1?agents=1', replace: true });
  });
});

describe('useStateChatTasks', () => {
  test('keeps the same two choices in state', async () => {
    const seen: { view?: ChatTasksView } = {};
    function Probe() {
      seen.view = useStateChatTasks();
      return null;
    }
    view = await mount(<Probe />);
    expect(seen.view).toMatchObject({ expanded: false, agents: false });
    await interact(() => must(seen.view, 'view').setExpanded(true));
    await interact(() => must(seen.view, 'view').setAgents(true));
    expect(seen.view).toMatchObject({ expanded: true, agents: true });
  });
});
