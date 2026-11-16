import { expect, test } from 'bun:test';
import { AgendaInputCard, useAgenda } from '../../../../app/features/agenda/agenda.tsx';
import { AgendaClientContext } from '../../../../app/lib/agenda-client-context.tsx';
import { daemonConnection } from '../../../../app/shell.ts';
import { daemonSessionScope } from '../../../../app/shell.ts';
import { agendaItem } from '../../../support/app/agenda-inbox.tsx';
import { callFromFetch } from '../../../support/app/call-from-fetch.ts';
import { ensureDom, render, run } from '@ferretry/app/testing';

ensureDom();

// #B147: a version picked in the agenda swaps the input card out within the same opening; a hold it made went with it.
// The card itself is the input owner's (`ask:input`, drawn by key); what is the Agenda's is the view it holds open.
test('picking an older version while the input card holds the view lets the hold go with the card', () => {
  const connection = daemonConnection({ daemonId: 'review' });
  const scope = daemonSessionScope(connection, 'sess-1');
  const prompt = 'Provide the deploy password';
  const item = agendaItem('A7', {
    kind: 'input',
    input: { requestId: 'ab'.repeat(16) },
    ask: undefined,
    context: `The plan could not fill this request.\nThe agent says: ${prompt}`,
    revisions: [
      {
        at: '2026-10-30T11:59:00.000Z',
        by: 'daemon',
        changed: ['context'],
        previous: { context: `The agent says: ${prompt}` },
      },
    ],
  } as never);
  const record = {
    ...item,
    resolvedAt: '2026-10-30T12:00:00.000Z',
    resolvedBy: 'daemon',
    resolvedBySession: null,
    resolvedByName: null,
    resolutionNote: 'Input request delivered.',
    disposition: 'done',
  };
  const board = (resolved: boolean): never =>
    ({
      v: 1,
      sessionId: 'sess-1',
      items: resolved ? [] : [item],
      resolved: resolved ? [record] : [],
      count: resolved ? 0 : 1,
      parseErrors: 0,
      updatedAt: '2026-10-30T12:00:00.000Z',
    }) as never;
  // No machine answers this test's reads: the view is drawn from the board it is handed.
  const machine = callFromFetch(() => Promise.reject(new Error('no machine in this test')));
  let covered = true;
  function Chat({ snapshot }: { readonly snapshot: never }) {
    const agenda = useAgenda({
      connection,
      scope,
      client: undefined,
      snapshot,
      status: 'ready',
      agendaMode: true,
      ferret: 'Review',
      focus: { target: 'A7' as never, seq: 1 },
      swipeable: false,
    });
    covered = agenda.covered;
    return (
      <div>
        {agenda.view}
        {agenda.above}
      </div>
    );
  }
  function Host({ resolved }: { readonly resolved: boolean }) {
    return (
      <AgendaClientContext.Provider value={machine}>
        <Chat snapshot={board(resolved)} />
      </AgendaClientContext.Provider>
    );
  }
  const view = render(<Host resolved={false} />);
  try {
    // The owner's card says a follow-up offer is on screen: the view is held.
    run(() => view.root.findByType(AgendaInputCard).props.onHold(true));
    run(() => view.root.findByProps({ 'data-agenda-menu-toggle': '' }).props.onClick());
    const picker = view.root.findByProps({ 'data-agenda-version-picker': '' });
    run(() => picker.props.onChange({ currentTarget: { value: '1' } }));
    expect(view.root.findAllByProps({ 'data-agenda-old-version': '' }).length).toBeGreaterThan(0);
    // The older version keeps its own prompt: no card is drawn to say it, so the card and its hold are gone.
    expect(view.root.findAllByType(AgendaInputCard)).toHaveLength(0);
    run(() => view.root.findAllByProps({ 'data-agenda-latest': '' })[0]?.props.onClick());
    expect(view.root.findAllByType(AgendaInputCard)).toHaveLength(1);
    // The request ends: nothing holds the view any more, so it closes by itself.
    run(() => view.update(<Host resolved />));
    expect(covered).toBe(false);
  } finally {
    run(() => view.unmount());
  }
});
