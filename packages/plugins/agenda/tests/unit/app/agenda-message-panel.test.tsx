import { afterEach, describe, expect, test } from 'bun:test';
import type { ComponentType } from 'react';
import { agendaAnswerMessage } from '@ferretry/core-asks/contract';
import { ensureDom, interact, type Mounted, mount, settleUntil } from '@ferretry/app/testing';
import { createAgendaMessagePanel } from '../../../app/views/agenda-message-panel.tsx';
import { DaemonAgendaStore } from '../../../app/lib/agenda-store.ts';
import type { AgendaRuntime } from '../../../app/lib/agenda-runtime.ts';
import { agendaItem, choices } from '../../support/app/agenda-inbox.tsx';
import { daemonConnection, daemonSessionScope } from '../../../app/shell.ts';
import { ReferenceSurfaceProvider } from '../../../app/shell.ts';

ensureDom();

/**
 * The `conversation.row-body` panel Agenda contributes: an agenda message drawn as its card INSTEAD of the words
 * Conversation hands it as `fallback`; any other message returns `fallback` as it is and reads nothing; a send on its
 * way is worded against the ferret's open items.
 */

const ASK = 'How should outdated ferrets pick up new instructions after an update?';
const connection = daemonConnection({ daemonId: 'studio' });
const scope = daemonSessionScope(connection, 's-1');

const board = {
  v: 1,
  sessionId: 's-1',
  items: [
    agendaItem('A45', { subject: ASK, title: 'Restarting outdated ferrets', ask: choices('Button only', 'Automatic') }),
  ],
  resolved: [],
  count: 1,
  parseErrors: 0,
  updatedAt: '2026-11-04T10:00:00.000Z',
};

/** A runtime that holds one store and counts the boards it was asked to read. */
const runtimeOf = (store: DaemonAgendaStore, hydrated: string[]): AgendaRuntime =>
  ({
    connection,
    agenda: {
      store,
      hydrate: async (_daemon: unknown, asked: { sessionId: string }) => {
        hydrated.push(asked.sessionId);
        store.applySnapshot(scope, board);
      },
    },
  }) as unknown as AgendaRuntime;

const surface = { agendaReferenceResolver: () => true, onAgendaOpen: () => undefined };

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const draw = async (props: Record<string, unknown>) => {
  const hydrated: string[] = [];
  const store = new DaemonAgendaStore();
  const Panel = createAgendaMessagePanel(runtimeOf(store, hydrated)) as unknown as ComponentType<
    Record<string, unknown>
  >;
  view = await mount(
    <ReferenceSurfaceProvider surface={surface}>
      <Panel {...props} />
    </ReferenceSurfaceProvider>,
  );
  return { hydrated, store };
};

const fallback = <p data-fallback="">the plain words</p>;
const text = (): string => view?.container.textContent ?? '';

describe('the agenda-message panel in conversation.row-body', () => {
  test('an agenda message is its card, titled from the board once read, and the plain words are not drawn', async () => {
    const message = agendaAnswerMessage({ id: 'A45', quote: ASK }, 'Button only');
    const { hydrated } = await draw({ subject: 's-1', entry: { id: 'r1', kind: 'user', text: message }, fallback });
    expect(view?.container.querySelector('[data-agenda-kind="answer"]')).not.toBeNull();
    expect(view?.container.querySelector('[data-fallback]')).toBeNull();
    await settleUntil(
      () => text().includes('Restarting outdated ferrets'),
      () => `the board's title never drew: ${text()}`,
      interact,
    );
    expect(hydrated).toEqual(['s-1']);
  });

  /** Mounts a recognised agenda message over a runtime whose board read is `hydrate`, on a store of its own. */
  const drawWith = async (hydrate: (store: DaemonAgendaStore) => Promise<void>) => {
    const message = agendaAnswerMessage({ id: 'A45', quote: ASK }, 'Button only');
    const store = new DaemonAgendaStore();
    const Panel = createAgendaMessagePanel({
      connection,
      agenda: { store, hydrate: () => hydrate(store) },
    } as unknown as AgendaRuntime) as unknown as ComponentType<Record<string, unknown>>;
    view = await mount(
      <ReferenceSurfaceProvider surface={surface}>
        <Panel entry={{ id: 'r1', kind: 'user', text: message }} fallback={fallback} subject="s-1" />
      </ReferenceSurfaceProvider>,
    );
  };

  test('while the board is not read yet the card names the ask the message quoted', async () => {
    await drawWith(() => new Promise(() => undefined));
    expect(text()).toContain(ASK);
    expect(view?.container.querySelector('[data-agenda-message]')).not.toBeNull();
  });

  test('a board read that is refused or fails draws the plain words, not a card over no board', async () => {
    // The real client marks the scope failed (store.fail) and rejects; the panel swallows the rejection.
    await drawWith(async store => {
      store.fail(scope);
      throw new Error('refused');
    });
    await settleUntil(
      () => view?.container.querySelector('[data-fallback]') !== null,
      () => `the plain words never came back: ${view?.container.innerHTML}`,
      interact,
    );
    expect(text()).toBe('the plain words');
    expect(view?.container.querySelector('[data-agenda-message]')).toBeNull();
  });

  test('a message that is no agenda message returns the plain words as they are, and reads no board', async () => {
    const { hydrated } = await draw({
      subject: 's-1',
      entry: { id: 'r1', kind: 'user', text: 'just a note' },
      fallback,
    });
    expect(view?.container.innerHTML).toBe('<p data-fallback="">the plain words</p>');
    expect(hydrated).toEqual([]);
  });

  test('a send on its way that names an open item is its card at once, worded against the board', async () => {
    const { hydrated } = await draw({
      subject: 's-1',
      entry: { id: 'send:1', kind: 'user', text: '^A45 Leaning to Automatic' },
      onItsWay: true,
      fallback,
    });
    await settleUntil(
      () => view?.container.querySelector('[data-agenda-kind="re"]') !== null,
      () => `the reply never became its card: ${text()}`,
      interact,
    );
    expect(view?.container.querySelector('[data-fallback]')).toBeNull();
    expect(text()).toContain('Leaning to Automatic');
    expect(hydrated).toEqual(['s-1']);
  });

  test('a send on its way about no item keeps its plain words', async () => {
    await draw({ subject: 's-1', entry: { id: 'send:1', kind: 'user', text: 'thanks' }, onItsWay: true, fallback });
    await settleUntil(
      () => view?.container.querySelector('[data-fallback]') !== null,
      () => `the plain words are gone: ${text()}`,
      interact,
    );
    expect(view?.container.querySelector('[data-agenda-message]')).toBeNull();
  });

  test('with nothing to replace, or no ferret or row to read, it draws what it was given', async () => {
    await draw({ subject: 's-1', entry: { id: 'r', kind: 'user', text: 'x' } });
    expect(view?.container.innerHTML).toBe('');
    await view?.unmount();
    await draw({ fallback });
    expect(view?.container.innerHTML).toBe('<p data-fallback="">the plain words</p>');
  });
});
