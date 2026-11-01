import { afterEach, describe, expect, test } from 'bun:test';

import { DaemonTaskReferences } from '../../src/components/daemon-task-references.tsx';
import { Markdown } from '../../src/components/markdown.tsx';
import { ReferenceSurfaceProvider, useReferenceSurface } from '../../src/components/reference-surface.tsx';
import { useMachineTaskIds } from '../../src/hooks/use-machine-task-ids.ts';
import { DaemonBoardStore } from '../../src/lib/board-store.ts';
import type { DaemonConnection } from '../../src/lib/daemon-connection.ts';
import { StoreProvider } from '../../src/lib/store.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { fakeEnvironment, fakePort, flush, laptop } from './board-support.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const TEXT = 'see &F364 on the other project, &F12 here, and &F999 which is nobody’s';

const storeFor = (ids: readonly string[] | null) => {
  const port = fakePort({
    ids: async daemon => {
      port.calls.push(`ids:${daemon.daemonId}`);
      return ids;
    },
  });
  return { port, store: new DaemonBoardStore(port, fakeEnvironment()) };
};

const links = (container: HTMLElement) => [...container.querySelectorAll('a')].map(anchor => anchor.textContent);

function Prose() {
  return <Markdown {...useReferenceSurface()} text={TEXT} />;
}

describe('DaemonTaskReferences', () => {
  test('links every card on the machine, whatever its project, and leaves an unknown id as prose', async () => {
    // Arrange
    const { store } = storeFor(['F364', 'F12']);
    const opened: string[] = [];

    // Act
    view = await mount(
      <DaemonTaskReferences connection={laptop} onNavigate={to => opened.push(to)} store={store}>
        <Prose />
      </DaemonTaskReferences>,
    );
    await interact(() => flush());

    // Assert
    expect(links(view.container)).toEqual(['&F364', '&F12']);
    await interact(() => must(view?.container.querySelector('a'), 'the F364 link').click());
    expect(opened).toEqual(['/d/daemon%2Flaptop/board/F364']);
  });

  test('asks the machine once for all of them, not once per reference', async () => {
    // Arrange
    const { store, port } = storeFor(['F364', 'F12']);

    // Act
    view = await mount(
      <DaemonTaskReferences connection={laptop} onNavigate={() => undefined} store={store}>
        <Prose />
        <Prose />
      </DaemonTaskReferences>,
    );
    await interact(() => flush());

    // Assert
    expect(port.calls.filter(call => call.startsWith('ids:'))).toEqual(['ids:daemon/laptop']);
    expect(port.calls.filter(call => call.startsWith('task:'))).toEqual([]);
  });

  test('keeps the text as prose until the ids are known, and for a daemon that does not serve them', async () => {
    const { store } = storeFor(null);
    view = await mount(
      <DaemonTaskReferences connection={laptop} onNavigate={() => undefined} store={store}>
        <Prose />
      </DaemonTaskReferences>,
    );
    expect(links(view.container)).toEqual([]);
    await interact(() => flush());
    expect(links(view.container)).toEqual([]);
  });

  test('offers nothing for a machine that is not paired here', async () => {
    const { store, port } = storeFor(['F364']);
    view = await mount(
      <DaemonTaskReferences connection={undefined} onNavigate={() => undefined} store={store}>
        <Prose />
      </DaemonTaskReferences>,
    );
    await interact(() => flush());
    expect(links(view.container)).toEqual([]);
    expect(port.calls).toEqual([]);
  });

  test('never downgrades a surface that already proves tasks, such as a chat’s', async () => {
    // Arrange
    const { store } = storeFor(['F364']);
    const chatOpens: string[] = [];
    const chat = {
      taskReferenceResolver: (id: string) => id === 'F12',
      onTaskOpen: (id: string) => chatOpens.push(id),
    };

    // Act
    view = await mount(
      <ReferenceSurfaceProvider surface={chat}>
        <DaemonTaskReferences connection={laptop} onNavigate={() => undefined} store={store}>
          <Prose />
        </DaemonTaskReferences>
      </ReferenceSurfaceProvider>,
    );
    await interact(() => flush());
    await interact(() => must(view?.container.querySelector('a'), 'the F12 link').click());

    // Assert
    expect(links(view.container)).toEqual(['&F12']);
    expect(chatOpens).toEqual(['F12']);
  });

  test('keeps the rest of an outer surface while it adds the task proof', async () => {
    // Arrange
    const { store } = storeFor(['F364']);
    const seen: ReturnType<typeof useReferenceSurface>[] = [];
    const Spy = () => {
      seen.push(useReferenceSurface());
      return null;
    };

    // Act
    view = await mount(
      <ReferenceSurfaceProvider surface={{ onSkillOpen: () => undefined }}>
        <DaemonTaskReferences connection={laptop} onNavigate={() => undefined} store={store}>
          <Spy />
        </DaemonTaskReferences>
      </ReferenceSurfaceProvider>,
    );
    await interact(() => flush());

    // Assert
    const last = must(seen.at(-1), 'the surface');
    expect(last.onSkillOpen).toBeFunction();
    expect(last.taskReferenceResolver?.('f364')).toBeTrue();
  });

  test('takes the app’s own board store when none is passed', async () => {
    // Arrange
    const { store, port } = storeFor(['F364']);

    // Act
    view = await mount(
      <StoreProvider store={{ board: store } as never}>
        <DaemonTaskReferences connection={laptop} onNavigate={() => undefined}>
          <Prose />
        </DaemonTaskReferences>
      </StoreProvider>,
    );
    await interact(() => flush());

    // Assert
    expect(links(view.container)).toEqual(['&F364']);
    expect(port.calls).toEqual(['ids:daemon/laptop']);
  });
});

describe('useMachineTaskIds', () => {
  const Ids = ({ store, connection }: { store?: DaemonBoardStore; connection?: DaemonConnection }) => {
    const ids = useMachineTaskIds(store, connection);
    return <p data-ids={ids === undefined ? 'unknown' : [...ids].join(',')} />;
  };

  test('is every id once read, and unknown without a store or a machine', async () => {
    const { store } = storeFor(['F1', 'F2']);
    view = await mount(<Ids connection={laptop} store={store} />);
    await interact(() => flush());
    expect(view.container.querySelector('p')?.getAttribute('data-ids')).toBe('F1,F2');
    await view.render(<Ids connection={laptop} />);
    expect(view.container.querySelector('p')?.getAttribute('data-ids')).toBe('unknown');
    await view.render(<Ids store={store} />);
    expect(view.container.querySelector('p')?.getAttribute('data-ids')).toBe('unknown');
  });
});
