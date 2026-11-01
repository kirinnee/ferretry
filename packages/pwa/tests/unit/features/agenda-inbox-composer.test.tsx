import { describe, expect, test } from 'bun:test';
import type { AgendaId } from '@ferretry/protocol';
import { Composer } from '../../../src/components/composer.tsx';
import { LiveMarkdownEditor } from '../../../src/components/live-markdown-editor.tsx';
import { AgendaInboxComposer } from '../../../src/features/agenda/agenda-inbox-composer.tsx';
import { agendaForms } from '../../../src/lib/agenda-form-state.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import '../../support/dom.ts';
import { render, run, runAsync } from '../../support/react.ts';
import { sessionView } from '../../support/sessions.ts';

const daemon = daemonConnection({ daemonId: 'laptop', baseUrl: 'https://laptop.example.test', deviceId: 'device' });

describe('the open Inbox item’s composer', () => {
  test('is the real composer, for the ferret that asked, and sends what is typed about the item', async () => {
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
    const field = () => view.root.find(node => node.type === 'textarea' || node.type === LiveMarkdownEditor);
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

  test('a form’s “not answered yet” line goes once a pick changes', async () => {
    const api = { send: async () => ({}) as never };
    const view = render(
      <AgendaInboxComposer
        answerForm={() => {
          throw new Error('Not answered yet: 2. Alerts. Press Send again to send it as it is.');
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
