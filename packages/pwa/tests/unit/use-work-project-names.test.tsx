import { afterEach, describe, expect, it } from 'bun:test';
import type { ReactElement } from 'react';
import { useWorkProjectNames } from '../../src/hooks/use-work-project-names.ts';
import { DaemonBoardStore } from '../../src/lib/board-store.ts';
import type { DaemonConnection } from '../../src/lib/daemon-connection.ts';
import { type AppStore, StoreProvider } from '../../src/lib/store.tsx';
import { interact, type Mounted, mount } from '../support/dom.ts';
import { fakeEnvironment, fakePort, flush, laneSetFor, laptop, PROJECT } from './board-support.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const board = () =>
  new DaemonBoardStore(
    fakePort({
      projects: async () => [
        { id: 'unfiled', name: 'Unfiled', path: null, laneSet: null },
        { id: PROJECT, name: 'Relay', path: '/work/relay', laneSet: laneSetFor() },
      ],
    }),
    fakeEnvironment(),
  );

const inStore = (store: DaemonBoardStore | undefined, children: ReactElement): ReactElement =>
  store === undefined ? (
    children
  ) : (
    <StoreProvider store={{ board: store } as unknown as AppStore}>{children}</StoreProvider>
  );

function Names({
  daemon,
  active,
  seen,
}: {
  readonly daemon: DaemonConnection | undefined;
  readonly active: boolean;
  readonly seen: { names?: ReadonlyMap<string, string> };
}) {
  seen.names = useWorkProjectNames(daemon, active);
  return null;
}

describe('the names of a machine’s projects', () => {
  it('reads the board projects while active and names each by its id', async () => {
    const seen: { names?: ReadonlyMap<string, string> } = {};
    view = await mount(inStore(board(), <Names daemon={laptop} active seen={seen} />));
    await interact(flush);
    expect(seen.names?.get(PROJECT)).toBe('Relay');
    expect(seen.names?.get('unfiled')).toBe('Unfiled');
  });

  it('adds no request while inactive, and names nothing', async () => {
    const seen: { names?: ReadonlyMap<string, string> } = {};
    const port = fakePort();
    const store = new DaemonBoardStore(port, fakeEnvironment());
    view = await mount(inStore(store, <Names daemon={laptop} active={false} seen={seen} />));
    await interact(flush);
    expect(port.calls).toEqual([]);
    expect(seen.names?.size).toBe(0);
  });

  it('names nothing without a daemon, and without an app store', async () => {
    const seen: { names?: ReadonlyMap<string, string> } = {};
    view = await mount(inStore(board(), <Names daemon={undefined} active seen={seen} />));
    await interact(flush);
    expect(seen.names?.size).toBe(0);
    await view.unmount();
    view = await mount(<Names daemon={laptop} active seen={seen} />);
    await interact(flush);
    expect(seen.names?.size).toBe(0);
  });
});
