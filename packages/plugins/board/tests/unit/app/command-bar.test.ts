import { describe, expect, it } from 'bun:test';
import type { PluginCommandContext } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { boardForFerretCommands, boardPlaces } from '../../../app/command-bar.ts';

/**
 * Board in the command bar: its place under "Go to" (v4's words) and "Board for <ferret>" (S-0449), offered only on a
 * ferret's page, named by the ferret's callsign once the daemon says it, and opening the board narrowed to it.
 */

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const contextOf = (
  over: Partial<PluginCommandContext> = {},
  call: (route: string) => Promise<unknown> = async () => [{ id: 'f-live', name: 'ms-98' }],
  went: string[] = [],
): PluginCommandContext => ({
  client: { call } as unknown as PluginClient,
  daemon: 'dm1',
  navigate: href => went.push(href),
  screenHref: (daemon, plugin, screen) => (plugin === 'board' && screen === 'board' ? `/d/${daemon}/board` : undefined),
  changed: () => undefined,
  ...over,
});

describe('Board’s place', () => {
  it('is one "Go to" row in v4’s words, found by the words v4 knew it by', () => {
    const [place, ...rest] = boardPlaces(contextOf())();
    expect(rest).toEqual([]);
    expect(place).toMatchObject({
      id: 'screen-board.board',
      group: 'Go to',
      label: 'Board',
      description: 'Every task on every machine as lanes: what is moving, stuck or waiting on you',
      resting: true,
    });
    expect(place?.keywords).toContain('kanban');
  });

  it('is left out where no plugin draws the board', () => {
    expect(boardPlaces(contextOf({ screenHref: () => undefined }))()).toEqual([]);
  });
});

describe('Board for <ferret> (S-0449)', () => {
  it('offers nothing off a ferret’s page, and asks the daemon nothing', () => {
    let calls = 0;
    const list = boardForFerretCommands(
      contextOf({}, async () => {
        calls += 1;
        return [];
      }),
    );
    expect(list()).toEqual([]);
    expect(calls).toBe(0);
  });

  it('is named by the start of the ferret’s id until its callsign arrives, then by the callsign', async () => {
    let changes = 0;
    const list = boardForFerretCommands(contextOf({ ferret: 'f-live-0123456789', changed: () => (changes += 1) }));
    expect(list()[0]?.label).toBe('Board for f-live-0');
    await settle();
    expect(changes).toBe(1);
  });

  it('S-0449 says what v4 said, and opens the board narrowed to the ferret', async () => {
    const went: string[] = [];
    const list = boardForFerretCommands(contextOf({ ferret: 'f-live' }, undefined, went));
    list();
    await settle();
    const [entry] = list();
    expect(entry).toMatchObject({
      id: 'board-for-ferret-dm1',
      group: 'Go to',
      label: 'Board for Ms-98',
      description: "Open the board filtered to this ferret's cards.",
      resting: true,
    });
    expect(entry?.keywords).toEqual(['board', 'for this ferret', 'cards', 'tasks', 'kanban', 'project', 'mine']);
    entry?.run();
    expect(went).toEqual(['/d/dm1/board?ferret=f-live']);
  });

  it('keeps the id-named entry when the callsigns cannot be read', async () => {
    const list = boardForFerretCommands(
      contextOf({ ferret: 'abcdefghijkl' }, async () => {
        throw new Error('no daemon');
      }),
    );
    list();
    await settle();
    expect(list()[0]?.label).toBe('Board for abcdefgh');
  });
});
