import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { agendaListSnapshot, MACHINE_AGENDA_ID } from '@ferretry/protocol';
import { projectionRecord, projectionSnapshot } from '../../../../protocol/tests/fixtures/agenda-projection.ts';
import { ResolvedItemView } from '../../../src/features/agenda/resolved-item-view.tsx';
import { AgendaItemView } from '../../../src/features/agenda/agenda-item-view.tsx';
import type { InboxResolved } from '../../../src/lib/agenda-inbox.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import '../../support/dom.ts';
import { render, run, runAsync } from '../../support/react.ts';
import { sessionView } from '../../support/sessions.ts';

const connection = daemonConnection({
  daemonId: 'fixture',
  baseUrl: 'https://fixture.example.test',
  deviceId: 'device',
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
const fetchers: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const read of fetchers.splice(0)) read.mockRestore();
});

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
    const read = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(projectionRecord()));
    fetchers.push(read);
    let closed = 0;
    let view: ReturnType<typeof render> | undefined;
    // Act
    await runAsync(async () => {
      view = render(
        <ResolvedItemView
          row={row}
          connection={connection}
          onClose={() => {
            closed++;
          }}
        />,
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
    const read = spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue(Response.json(projectionRecord()));
    fetchers.push(read);
    let view: ReturnType<typeof render> | undefined;
    // Act
    await runAsync(async () => {
      view = render(<ResolvedItemView row={row} connection={connection} onClose={() => {}} />);
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
