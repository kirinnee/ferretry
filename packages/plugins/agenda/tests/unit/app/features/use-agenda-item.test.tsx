import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { ReactNode } from 'react';
import { agendaListSnapshot, type AgendaItem, type AgendaListRecord } from '../../../../app/wire/index.ts';
import { projectionRecord, projectionSnapshot } from '../../../support/app/agenda-projection.ts';
import { useAgendaItem } from '../../../../app/features/agenda/use-agenda-item.ts';
import { AgendaClientContext } from '../../../../app/lib/agenda-client-context.tsx';
import { SESSION_AGENDA_ITEM } from '../../../../app/lib/agenda-wire.ts';
import { daemonConnection } from '../../../../app/shell.ts';
import { daemonSessionScope } from '../../../../app/shell.ts';
import { callFromFetch, type TestFetch } from '../../../support/app/call-from-fetch.ts';
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

/** The half's one client, answered by a scripted fetcher; `read` records every request it was asked for. */
const scripted = () => {
  const read = mock<TestFetch>(async () => Response.json(projectionRecord()));
  const client = callFromFetch((url, init) => read(url, init));
  const With = ({ children }: { readonly children: ReactNode }) => (
    <AgendaClientContext.Provider value={client}>{children}</AgendaClientContext.Provider>
  );
  return { read, client, With };
};

const networks: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const network of networks.splice(0)) network.mockRestore();
});

describe('loading a resolved agenda document', () => {
  test('reads through the half’s client by route key, never as a plain network request', async () => {
    // Arrange
    const network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Plain HTTP must not be used.'));
    networks.push(network);
    const { read, client, With } = scripted();
    // Act
    await runAsync(async () => {
      render(
        <With>
          <Probe item={header} />
        </With>,
      );
    });
    // Assert
    expect(network).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(client.calls.map(call => call.route)).toEqual([SESSION_AGENDA_ITEM]);
    expect(latest.item).toEqual(projectionRecord());
  });

  test('keeps active and older full records available without a read', () => {
    // Arrange
    const { read, With } = scripted();
    const full = projectionRecord();
    // Act
    const view = render(
      <With>
        <Probe item={full} />
      </With>,
    );
    // Assert
    expect(latest.item).toBe(full);
    expect(read).not.toHaveBeenCalled();
    run(() =>
      view.update(
        <With>
          <Probe />
        </With>,
      ),
    );
    expect(latest.item).toBeUndefined();
  });

  test('shows loading, refuses late results after close, then reads again when reopened', async () => {
    // Arrange
    let finish: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>(resolve => {
      finish = resolve;
    });
    const { read, With } = scripted();
    read.mockImplementationOnce(() => pending);
    const view = render(
      <With>
        <Probe item={header} />
      </With>,
    );
    expect(latest.loading).toBe(true);
    // Act
    run(() =>
      view.update(
        <With>
          <Probe />
        </With>,
      ),
    );
    await runAsync(async () => {
      finish?.(Response.json(projectionRecord()));
    });
    // Assert
    expect(latest.item).toBeUndefined();
    await runAsync(async () => {
      view.update(
        <With>
          <Probe item={header} />
        </With>,
      );
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(latest.item).toEqual(projectionRecord());
    expect(latest.loading).toBe(false);
  });

  test('keeps a failed read visible with a retry, and clears the error after success', async () => {
    // Arrange
    const { read, With } = scripted();
    read.mockImplementationOnce(() => Promise.reject(new Error('The machine is offline.')));
    // Act
    await runAsync(async () => {
      render(
        <With>
          <Probe item={header} />
        </With>,
      );
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
    const { read, With } = scripted();
    read.mockImplementation(() => Promise.reject(undefined));
    // Act
    await runAsync(async () => {
      render(
        <With>
          <Probe item={header} />
        </With>,
      );
    });
    // Assert
    expect(latest.error).toBe('Could not read this item.');
  });
});
