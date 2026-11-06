import { describe, expect, test } from 'bun:test';
import type { AgendaId } from '@ferretry/protocol';
import { Composer } from '../../../src/components/composer.tsx';
import { DictationControl } from '../../../src/components/dictation-control.tsx';
import { LiveMarkdownEditor } from '../../../src/components/live-markdown-editor.tsx';
import { AgendaInboxComposer } from '../../../src/features/agenda/agenda-inbox-composer.tsx';
import { agendaForms } from '../../../src/lib/agenda-form-state.ts';
import { STALE_ASK_COPY } from '../../../src/lib/agenda-gate-send.ts';
import { referencesOf } from '../../../src/lib/answer-chip.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { DEFAULT_STT_SETTINGS } from '../../../src/lib/stt/stt-settings.ts';
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

  test('on a card’s own agenda Send answers the card with the typed words, never the chat, and says what to type', async () => {
    const sent: string[] = [];
    const answered: string[] = [];
    const replied: string[] = [];
    const api = {
      send: async (_sessionId: string, request: { message: string }) => {
        sent.push(request.message);
        return {} as never;
      },
    };
    const view = render(
      <AgendaInboxComposer
        answerTyped={{
          key: 'gate:F12:tested:3',
          send: words => void answered.push(words.message),
          approves: words => words === 'works now',
        }}
        clientFor={async () => api}
        compact
        connection={daemon}
        itemId={'A8' as AgendaId}
        onReplied={reply => replied.push(reply.words)}
        typedPlaceholder="What is wrong, or what needs changing?"
        view={sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } })}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    const composer = view.root.findByType(Composer);
    expect(composer.props.placeholder).toBe('What is wrong, or what needs changing?');
    // An empty box has nothing to say: it is never an answer.
    expect(composer.props.allowEmptySend).toBe(false);
    // Send is the gate answer or an error in the box — never the device outbox, which would chat it later.
    expect(composer.props.directSend).toBe(true);
    const field = () => view.root.find(node => node.type === 'textarea' || node.type === LiveMarkdownEditor);
    run(() =>
      field().props.onChange({ currentTarget: { value: 'the badge is red', selectionStart: 16, selectionEnd: 16 } }),
    );
    await runAsync(async () => {
      view.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
    expect(answered).toEqual(['the badge is red']);
    expect(sent).toEqual([]);
    expect(replied).toEqual([]);
    // Words that plainly approve are a reply about the item, with its reference: the card is not answered, and the
    // reply overlay is not applied (the ask is still open, so the item stays in the Inbox with its Good).
    run(() => field().props.onChange({ currentTarget: { value: 'works now', selectionStart: 9, selectionEnd: 9 } }));
    await runAsync(async () => {
      view.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
    expect(answered).toEqual(['the badge is red']);
    expect(sent).toEqual(['!A8 works now']);
    expect(replied).toEqual([]);
    run(() => view.unmount());
  });

  test('a typed answer is the owner’s words exactly: the raw client, never the item’s !A reference prefix', async () => {
    const api = { send: async () => ({}) as never };
    const view = render(
      <AgendaInboxComposer
        answerTyped={{ key: 'gate:F12:tested:3', send: () => undefined, approves: () => false }}
        clientFor={async () => api}
        compact
        connection={daemon}
        itemId={'A404' as AgendaId}
        view={sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } })}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    expect(referencesOf(view.root.findByType(Composer).props.api)).toEqual([]);
    run(() => view.unmount());
  });

  test('a Send pressed for an ask that was replaced meanwhile answers nothing and shows a plain error line', async () => {
    const api = { send: async () => ({}) as never };
    const heard: string[] = [];
    const draw = (key: string) => (
      <AgendaInboxComposer
        answerTyped={{
          key,
          send: words => void heard.push(`${key}: ${words.message}`),
          approves: words => words === 'works now',
        }}
        clientFor={async () => api}
        compact
        connection={daemon}
        itemId={'A404' as AgendaId}
        view={sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } })}
      />
    );
    const view = render(draw('gate:F12:tested:3'));
    await runAsync(async () => {
      await Promise.resolve();
    });
    // The client Send was pressed with: bound to the first ask.
    const pressed = view.root.findByType(Composer).props.api as { send: (s: string, i: unknown) => unknown };
    run(() => view.update(draw('gate:F12:tested:4')));
    expect(() => pressed.send('sess-2', { message: 'The badge is red' })).toThrow(STALE_ASK_COPY);
    // Even approving words (a reply, not an answer) are not sent from a Send that belonged to a replaced ask.
    expect(() => pressed.send('sess-2', { message: 'works now' })).toThrow(STALE_ASK_COPY);
    expect(heard).toEqual([]);
    // The replacement ask has its own client, which answers it.
    const fresh = view.root.findByType(Composer).props.api as { send: (s: string, i: unknown) => unknown };
    await fresh.send('sess-2', { message: 'Now it is blue' });
    expect(heard).toEqual(['gate:F12:tested:4: Now it is blue']);
    run(() => view.unmount());
  });

  test('a Send still awaiting when its composer goes (Good tapped, or the card answered elsewhere) answers nothing', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const heard: string[] = [];
    const view = render(
      <AgendaInboxComposer
        answerTyped={{ key: 'gate:F12:tested:3', send: words => void heard.push(words.message), approves: () => false }}
        clientFor={async () => ({ send: async () => ({}) as never })}
        compact
        connection={daemon}
        itemId={'A404' as AgendaId}
        view={sessionView('sess-2', { config: { teammate: 'kai', name: 'Release train' } })}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    const pressed = view.root.findByType(Composer).props.api as { send: (s: string, i: unknown) => unknown };
    // Send was pressed and is awaiting (the composer awaits before the client's send runs) …
    const late = gate.then(() => pressed.send('sess-2', { message: 'The badge is red' }));
    // … the card is answered Good, and its composer goes away, then the Send resumes.
    run(() => view.unmount());
    release();
    await expect(late).rejects.toThrow(STALE_ASK_COPY);
    expect(heard).toEqual([]);
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
    expect(view.root.findAllByType(DictationControl)).toHaveLength(1);
    run(() => view.unmount());
  });

  test('without dictation settings the box has no mic, as the chat composer does not', async () => {
    const view = await mount();
    expect(view.root.findAllByType(DictationControl)).toHaveLength(0);
    run(() => view.unmount());
  });
});
