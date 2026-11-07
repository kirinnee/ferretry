import { describe, expect, test } from 'bun:test';
import type { AgendaId } from '../../../../app/wire/index.ts';
import { AgendaInboxComposer } from '../../../../app/features/agenda/agenda-inbox-composer.tsx';
import { agendaForms } from '../../../../app/lib/agenda-form-state.ts';
import { daemonConnection } from '../../../../app/shell.ts';
import { ensureDom } from '@ferretry/app/testing';
ensureDom();
import { render as renderTree, run, runAsync } from '@ferretry/app/testing';
import type { ReactElement } from 'react';
import { FakeComposer, WithFakeComposer } from '../../../support/app/composer-port.tsx';
import { sessionView } from '../../../support/app/sessions.ts';

// The composer is Conversation's: the Inbox's reply box is whatever composer the host binds (`AgendaComposerContext`),
// here the suites' host composer. What is asserted is what the Agenda hands it.
const Composer = FakeComposer;
const render = (element: ReactElement) => renderTree(<WithFakeComposer>{element}</WithFakeComposer>);
/** This device's dictation settings, as the chat composer reads them (opaque to the Agenda). */
const DEFAULT_STT_SETTINGS = { engine: 'browser' } as const;
/** The mic the host composer draws when it is handed dictation settings. */
const isMic = (node: { readonly props: Record<string, unknown> }): boolean => node.props['data-composer-mic'] === '';

const daemon = daemonConnection({ daemonId: 'laptop' });

describe('the open Inbox item’s composer', () => {
  test('is the host’s composer, for the ferret that asked, and sends what is typed about the item', async () => {
    const sent: { sessionId: string; message: string }[] = [];
    const api = {
      send: async (sessionId: string, request: { message: string }) => {
        sent.push({ sessionId, message: request.message });
        return {} as never;
      },
    };
    const view = render(
      <AgendaInboxComposer
        clientFor={async () => api}
        compact
        connection={daemon}
        itemId={'A5' as AgendaId}
        view={sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } })}
      />,
    );
    // Nothing is drawn until the machine's client is ready.
    expect(view.root.findAllByType(Composer)).toHaveLength(0);
    await runAsync(async () => {
      await Promise.resolve();
    });
    const composer = view.root.findByType(Composer);
    expect(composer.props.sessionId).toBe('sess-2');
    expect(composer.props.placeholder).toBe('Reply to Kai…');
    const field = () => view.root.find(node => node.type === 'textarea');
    run(() =>
      field().props.onChange({ currentTarget: { value: 'only after lunch', selectionStart: 16, selectionEnd: 16 } }),
    );
    await runAsync(async () => {
      view.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
    expect(sent).toEqual([{ sessionId: 'sess-2', message: '!A5 only after lunch' }]);
    run(() => view.unmount());
  });

  test('draws nothing when the machine’s client cannot be had', async () => {
    const view = render(
      <AgendaInboxComposer
        clientFor={async () => {
          throw new Error('unpaired');
        }}
        compact={false}
        connection={daemon}
        itemId={'A5' as AgendaId}
        view={sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } })}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    expect(view.root.findAllByType(Composer)).toHaveLength(0);
    run(() => view.unmount());
  });

  test('on a form card Send answers the form, never the chat, even with an empty box', async () => {
    const sent: string[] = [];
    let answered = 0;
    const api = {
      send: async (_sessionId: string, request: { message: string }) => {
        sent.push(request.message);
        return {} as never;
      },
    };
    const view = render(
      <AgendaInboxComposer
        answerForm={() => {
          answered += 1;
        }}
        clientFor={async () => api}
        compact
        connection={daemon}
        itemId={'A6' as AgendaId}
        view={sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } })}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    expect(view.root.findByType(Composer).props.allowEmptySend).toBe(true);
    await runAsync(async () => {
      view.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
    expect(answered).toBe(1);
    expect(sent).toEqual([]);
    run(() => view.unmount());
  });

  test('a form’s “nothing to send” line goes once a pick changes', async () => {
    const api = { send: async () => ({}) as never };
    const view = render(
      <AgendaInboxComposer
        answerForm={() => {
          throw new Error('Pick an answer or type something before you send the form.');
        }}
        clientFor={async () => api}
        compact
        connection={daemon}
        formKey="form-key"
        itemId={'A7' as AgendaId}
        view={sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } })}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    await runAsync(async () => {
      view.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
    const alerts = () => view.root.findAll(node => node.type === 'p' && node.props.role === 'alert');
    expect(alerts()).toHaveLength(1);
    run(() => agendaForms.set('form-key', [], '2', ['Page']));
    expect(alerts()).toHaveLength(0);
    run(() => view.unmount());
    agendaForms.forget('form-key');
  });
});

describe('the open Inbox item’s voice', () => {
  const mount = async (dictationSettings?: typeof DEFAULT_STT_SETTINGS) => {
    const view = render(
      <AgendaInboxComposer
        clientFor={async () => ({ send: async () => ({}) as never })}
        compact
        connection={daemon}
        itemId={'A5' as AgendaId}
        view={sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } })}
        {...(dictationSettings === undefined ? {} : { dictationSettings })}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    return view;
  };

  test('carries the chat composer’s mic, from the same dictation settings', async () => {
    const view = await mount(DEFAULT_STT_SETTINGS);
    expect(view.root.findByType(Composer).props.dictationSettings).toBe(DEFAULT_STT_SETTINGS);
    expect(view.root.findAll(isMic)).toHaveLength(1);
    run(() => view.unmount());
  });

  test('without dictation settings the box has no mic, as the chat composer does not', async () => {
    const view = await mount();
    expect(view.root.findAll(isMic)).toHaveLength(0);
    run(() => view.unmount());
  });
});

describe('the open Inbox item’s composer without a host composer', () => {
  test('draws no box at all', async () => {
    const view = renderTree(
      <AgendaInboxComposer
        clientFor={async () => ({ send: async () => ({}) as never })}
        compact
        connection={daemon}
        itemId={'A5' as AgendaId}
        view={sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } })}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    expect(view.toJSON()).toBeNull();
    run(() => view.unmount());
  });
});
