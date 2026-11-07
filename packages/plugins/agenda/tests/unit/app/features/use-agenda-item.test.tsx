import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { agendaListSnapshot, type AgendaItem, type AgendaListRecord } from '../../../../app/wire/index.ts';
import { projectionRecord, projectionSnapshot } from '../../../support/app/agenda-projection.ts';
import { useAgendaItem } from '../../../../app/features/agenda/use-agenda-item.ts';
import { daemonConnection } from '../../../../app/shell.ts';
import { daemonSessionScope } from '../../../../app/shell.ts';
import { boundDaemonId } from '../../../../app/shell.ts';
import type { DaemonFetch } from '../../../../app/shell.ts';
import { type AppStore, StoreProvider } from '../../../../app/shell.ts';
import { ensureDom } from '@ferretry/app/testing';
ensureDom();
import { render, run, runAsync } from '@ferretry/app/testing';

const connection = daemonConnection({
  daemonId: 'fixture',
});
const scope = daemonSessionScope(connection, 'session');
const header = agendaListSnapshot(projectionSnapshot(0, 1)).resolved[0];
let latest: ReturnType<typeof useAgendaItem>;
const Probe = ({ item }: { item?: AgendaItem | AgendaListRecord }) => {
  latest = useAgendaItem(connection, scope, item);
  return null;
};
const fetchers: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const read of fetchers.splice(0)) read.mockRestore();
});

describe('loading a resolved agenda document', () => {
  test('reads through the paired carrier instead of an unauthenticated plain network request', async () => {
    // Arrange
    const network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Plain HTTP must not be used.'));
    fetchers.push(network);
    const requests: RequestInit[] = [];
    const routed: DaemonFetch = async (_input, init) => {
      requests.push(init ?? {});
      return Response.json(projectionRecord());
    };
    const store = { carrier: { fetch: routed } } as unknown as AppStore;
    // Act
    await runAsync(async () => {
      render(
        <StoreProvider store={store}>
          <Probe item={header} />
        </StoreProvider>,
      );
    });
    // Assert
    expect(network).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(boundDaemonId(requests[0])).toBe(connection.daemonId);
    expect(latest.item).toEqual(projectionRecord());
  });
  test('keeps active and older full records available without a read', () => {
    // Arrange
    const read = spyOn(globalThis, 'fetch');
    fetchers.push(read);
    const full = projectionRecord();
    // Act
    const view = render(<Probe item={full} />);
    // Assert
    expect(latest.item).toBe(full);
    expect(read).not.toHaveBeenCalled();
    run(() => view.update(<Probe />));
    expect(latest.item).toBeUndefined();
  });

  test('shows loading, refuses late results after close, then reads again when reopened', async () => {
    // Arrange
    let finish: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>(resolve => {
      finish = resolve;
    });
    const read = spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(pending)
      .mockResolvedValue(Response.json(projectionRecord()));
    fetchers.push(read);
    const view = render(<Probe item={header} />);
    expect(latest.loading).toBe(true);
    // Act
    run(() => view.update(<Probe />));
    await runAsync(async () => {
      finish?.(Response.json(projectionRecord()));
    });
    // Assert
    expect(latest.item).toBeUndefined();
    await runAsync(async () => {
      view.update(<Probe item={header} />);
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(latest.item).toEqual(projectionRecord());
    expect(latest.loading).toBe(false);
  });

  test('keeps a failed read visible with a retry, and clears the error after success', async () => {
    // Arrange
    const read = spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('The machine is offline.'))
      .mockResolvedValue(Response.json(projectionRecord()));
    fetchers.push(read);
    // Act
    await runAsync(async () => {
      render(<Probe item={header} />);
    });
    // Assert
    expect(latest.error).toBe('The machine is offline.');
    expect(latest.item).toBeUndefined();
    await runAsync(async () => {
      latest.retry();
    });
    expect(latest.error).toBeUndefined();
    expect(latest.item).toEqual(projectionRecord());
  });

  test('gives an unreadable failure a plain message', async () => {
    // Arrange
    const read = spyOn(globalThis, 'fetch').mockRejectedValue(undefined);
    fetchers.push(read);
    // Act
    await runAsync(async () => {
      render(<Probe item={header} />);
    });
    // Assert
    expect(latest.error).toBe('Could not read this item.');
  });
});
