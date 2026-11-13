import { describe, expect, mock, test } from 'bun:test';
import type { ReactElement } from 'react';
import { agendaListSnapshot, MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import { projectionRecord, projectionSnapshot } from '../../../support/app/agenda-projection.ts';
import { ResolvedItemView } from '../../../../app/features/agenda/resolved-item-view.tsx';
import { AgendaItemView } from '../../../../app/features/agenda/agenda-item-view.tsx';
import type { InboxResolved } from '../../../../app/lib/agenda-inbox.ts';
import { daemonConnection } from '../../../../app/shell.ts';
import { AgendaClientContext } from '../../../../app/lib/agenda-client-context.tsx';
import { callFromFetch, type TestFetch } from '../../../support/app/call-from-fetch.ts';
import { ensureDom } from '@ferretry/app/testing';
ensureDom();
import { render, run, runAsync } from '@ferretry/app/testing';
import { sessionView } from '../../../support/app/sessions.ts';

const connection = daemonConnection({
  daemonId: 'fixture',
});
const record = agendaListSnapshot(projectionSnapshot(0, 1)).resolved[0];
if (record === undefined) throw new Error('fixture needs one resolved record');
const row: InboxResolved = {
  key: 'fixture:machine:A1',
  daemonId: connection.daemonId,
  machineName: 'Fixture machine',
  view: sessionView(MACHINE_AGENDA_ID),
  record,
};
/** The half's one client, answered by `read`; the view reaches nothing else. */
const withClient = (read: TestFetch, element: ReactElement) => (
  <AgendaClientContext.Provider value={callFromFetch(read)}>{element}</AgendaClientContext.Provider>
);

describe('the machine resolved item view', () => {
  test('also reads an older record whose conversation must be rebuilt', () => {
    // Arrange
    const full = projectionRecord();
    delete full.conversation;
    delete full.conversationCount;
    // Act
    const view = render(<ResolvedItemView row={{ ...row, record: full }} connection={connection} onClose={() => {}} />);
    // Assert
    expect(view.root.findByType(AgendaItemView).props.history.length).toBeGreaterThan(0);
  });
  test('loads the full machine item and opens it read-only, including its edits', async () => {
    // Arrange
    const read = mock<TestFetch>(async () => Response.json(projectionRecord()));
    let closed = 0;
    let view: ReturnType<typeof render> | undefined;
    // Act
    await runAsync(async () => {
      view = render(
        withClient(
          read,
          <ResolvedItemView
            row={row}
            connection={connection}
            onClose={() => {
              closed++;
            }}
          />,
        ),
      );
    });
    // Assert
    expect(String(read.mock.calls[0]?.[0])).toContain('/v1/machine/agenda/A1');
    const full = view?.root.findByType(AgendaItemView);
    expect(full?.props.item.tabs[0].name).toBe('Notes');
    expect(full?.props.history.length).toBeGreaterThan(0);
    expect(full?.props.settled).toBeDefined();
    expect(full?.props.onSnooze).toBeUndefined();
    run(() => full?.props.onAct({ kind: 'resolve' }));
    run(() => full?.props.onClose());
    expect(closed).toBe(1);
  });

  test('shows a read failure and retries without losing the header', async () => {
    // Arrange
    const read = mock<TestFetch>(async () => Response.json(projectionRecord()));
    read.mockImplementationOnce(() => Promise.reject(new Error('Offline')));
    let view: ReturnType<typeof render> | undefined;
    // Act
    await runAsync(async () => {
      view = render(withClient(read, <ResolvedItemView row={row} connection={connection} onClose={() => {}} />));
    });
    // Assert
    expect(view?.root.findByProps({ role: 'alert' }).children).toEqual(['Offline']);
    const retry = view?.root.findAllByType('button').find(button => button.children.includes('Try again'));
    await runAsync(async () => {
      retry?.props.onClick();
    });
    expect(view?.root.findByType(AgendaItemView).props.item.id).toBe('A1');
  });
});
