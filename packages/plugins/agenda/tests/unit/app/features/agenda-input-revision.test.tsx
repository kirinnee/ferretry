import { expect, test } from 'bun:test';
import { createElement as h } from 'react';
import { useAgenda } from '../../../../app/features/agenda/agenda.tsx';
import { daemonConnection } from '../../../../app/shell.ts';
import { daemonSessionScope } from '../../../../app/shell.ts';
import { DaemonClientProvider } from '../../../../app/shell.ts';
import { list as accountList } from '../../../support/app/accounts-fixtures.ts';
import { agendaItem } from '../../../support/app/agenda-inbox.tsx';
import { interact, mount } from '../../../support/app/dom.ts';
import { click, settle } from '../../../support/app/dom-form.ts';
import { healthOf } from '../../../support/app/health.ts';
import { offer, saved, withSaved } from '../../../support/app/input-fixtures.ts';

// #B147: a version picked in the agenda swaps the input card out within the same opening; a hold it made went with it.
test('picking an older version while a follow-up holds the view lets the hold go with the card', async () => {
  const connection = daemonConnection({
    daemonId: 'review',
    baseUrl: 'https://review.example.test',
    deviceId: 'review',
  });
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
  const value = withSaved(
    saved({
      match: 'app.clickup.com',
      project: { id: 'p_ferretry', name: 'ferretry' },
      offers: [
        offer({ id: 'WORK', label: 'Work', signIn: 'si_0123456789abcdef' }),
        offer({ id: 'HOME', label: 'Home', signIn: 'si_fedcba9876543210' }),
      ],
    }),
    { prompt, expiresAt: '2099-01-01T00:00:00.000Z' },
  );
  let delivered = false;
  const client = {
    request: async (path: string, schema: { parse: (raw: unknown) => unknown }, init?: RequestInit) => {
      if (path === '/v1/health') return schema.parse(healthOf('9.9.9', []));
      if (path === '/v1/accounts') return schema.parse(accountList());
      if (path.endsWith('/deliver')) {
        delivered = true;
        return schema.parse({
          id: value.id,
          deliveryId: JSON.parse(String(init?.body)).deliveryId,
          state: 'delivered',
          submitted: true,
        });
      }
      if (path.includes('/input-requests')) return schema.parse({ requests: delivered ? [] : [value] });
      throw new Error(`unexpected fake route ${path}`);
    },
  };
  let covered = true;
  function Host({ snapshot }: { snapshot: never }) {
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
    return h('div', null, agenda.view, agenda.above);
  }
  const tree = (resolved: boolean) =>
    h(DaemonClientProvider, { client: async () => client as never } as never, h(Host, { snapshot: board(resolved) }));
  const flush = async () => {
    for (let n = 0; n < 6; n++) await settle();
  };
  const view = await mount(tree(false));
  try {
    await flush();
    await click(view.container.querySelector('[data-input-offer="HOME"]'));
    await flush();
    expect(view.container.querySelector('[data-input-always-button]')).not.toBeNull();
    await interact(() => view.container.querySelector<HTMLButtonElement>('[data-agenda-menu-toggle]')?.click());
    const picker = view.container.querySelector<HTMLSelectElement>('[data-agenda-version-picker]');
    if (picker === null) throw new Error('expected the edited input to have a version picker');
    await interact(() => {
      picker.value = '1';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(view.container.querySelector('[data-agenda-old-version]')).not.toBeNull();
    // The older version keeps its own prompt: no card is drawn to say it.
    expect(view.container.textContent).toContain(prompt);
    await click(view.container.querySelector('[data-agenda-latest]'));
    await flush();
    expect(view.container.querySelector('[data-input-gone]')).not.toBeNull();
    await view.render(tree(true));
    await flush();
    expect(covered).toBe(false);
  } finally {
    await view.unmount();
  }
});
