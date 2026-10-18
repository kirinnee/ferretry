import { describe, expect, test } from 'bun:test';
import { Composer } from '../../src/components/composer.tsx';
import { Transcript, withAgentName } from '../../src/components/transcript.tsx';
import { continueList, insideCodeBlock, toggleWrap } from '../../src/lib/composer-editing.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { LiveMarkdownEditor } from '../../src/components/live-markdown-editor.tsx';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { hiddenFromTranscript, type TranscriptEntry } from '../../src/lib/session-screens.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';

describe('continueList', () => {
  test('continues bullets, numbers and checklists, keeping the indent', () => {
    expect(continueList('- a', 3)).toEqual({ value: '- a\n- ', caret: 6 });
    expect(continueList('  * b', 5)).toEqual({ value: '  * b\n  * ', caret: 10 });
    expect(continueList('x\n3. c', 6)).toEqual({ value: 'x\n3. c\n4. ', caret: 10 });
    expect(continueList('[x] done', 8)).toEqual({ value: '[x] done\n[ ] ', caret: 13 });
    expect(continueList('- [x] task', 10)).toEqual({ value: '- [x] task\n- [ ] ', caret: 17 });
  });

  test('ends the list on an empty item, and leaves anything else alone', () => {
    expect(continueList('- a\n- ', 6)).toEqual({ value: '- a\n', caret: 4 });
    expect(continueList('plain', 5)).toBeNull();
    expect(continueList('- a b', 3)).toBeNull();
  });
});

describe('editing helpers', () => {
  test('knows when the caret is inside a code fence', () => {
    expect(insideCodeBlock('```\nconst a', 11)).toBe(true);
    expect(insideCodeBlock('```\na\n```\nb', 11)).toBe(false);
  });

  test('wraps and unwraps a selection, and wraps an empty one around the caret', () => {
    expect(toggleWrap('make bold', 5, 9, '**')).toEqual({ value: 'make **bold**', caret: 13 });
    expect(toggleWrap('make **bold**', 7, 11, '**')).toEqual({ value: 'make bold', caret: 9 });
    expect(toggleWrap('ab', 1, 1, '`')).toEqual({ value: 'a``b', caret: 2 });
  });
});

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const daemon = daemonConnection({ daemonId: 'edit', baseUrl: 'https://edit.example.test', deviceId: 'device' });

const mountComposer = (draft: string, disposition?: string) => {
  const sent: unknown[] = [];
  const store = new DaemonDraftStore(new MemoryStorage());
  const view = render(
    <Composer
      api={{
        send: async (_id: string, request: unknown) => {
          sent.push(request);
          return (disposition === undefined ? {} : { disposition }) as never;
        },
      }}
      daemon={daemon}
      draftStore={store}
      enterKeyPreference="send"
      phoneEnterKeyPreference="send"
      sessionId="s"
    />,
  );
  const textarea = () => view.root.find(node => node.type === 'textarea' || node.type === LiveMarkdownEditor);
  run(() =>
    textarea().props.onChange({
      currentTarget: { value: draft, selectionStart: draft.length, selectionEnd: draft.length },
    }),
  );
  const key = (init: Record<string, unknown>, field?: { selectionStart: number; selectionEnd: number }) => {
    let prevented = false;
    run(() =>
      textarea().props.onKeyDown({
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        nativeEvent: { isComposing: false },
        currentTarget: field,
        preventDefault: () => {
          prevented = true;
        },
        ...init,
      }),
    );
    return prevented;
  };
  return { view, sent, textarea, key };
};

describe('the Notion-style composer keys', () => {
  test('Enter continues a list, stays a line break in a code block, and sends otherwise', async () => {
    writeMdComposePref('on');
    const list = mountComposer('- first');
    expect(list.key({ key: 'Enter' }, { selectionStart: 7, selectionEnd: 7 })).toBe(true);
    expect(list.textarea().props.value).toBe('- first\n- ');
    expect(list.sent).toEqual([]);

    const code = mountComposer('```\nlet a');
    expect(code.key({ key: 'Enter' })).toBe(false);
    expect(code.sent).toEqual([]);

    const prose = mountComposer('hello');
    await runAsync(async () => {
      prose.key({ key: 'Enter' });
    });
    expect(prose.sent).toHaveLength(1);
  });

  test('⌘B wraps the selection and ⌘/Ctrl+Enter always sends', async () => {
    writeMdComposePref('on');
    const view = mountComposer('make bold');
    expect(view.key({ key: 'b', metaKey: true }, { selectionStart: 5, selectionEnd: 9 })).toBe(true);
    expect(view.textarea().props.value).toBe('make **bold**');
    expect(view.key({ key: 'z', ctrlKey: true })).toBe(false);
    await runAsync(async () => {
      view.key({ key: 'Enter', ctrlKey: true });
    });
    expect(view.sent).toHaveLength(1);
  });

  test('a reference chip’s remove button takes exactly its token out of the draft', () => {
    const view = mountComposer('see @src/app.ts now');
    const remove = view.view.root.findByProps({ 'aria-label': 'Remove @src/app.ts from this message' });
    run(() => remove.props.onClick());
    expect(view.textarea().props.value).toBe('see  now');
  });

  test('a plain send never asks for now, whatever the send key or the agent’s state', async () => {
    const sent: unknown[] = [];
    for (const [busyKey, mode] of [
      ['Enter', 'send'],
      ['Enter+meta', 'newline'],
      ['button', 'send'],
    ] as const) {
      const view = render(
        <Composer
          api={{
            send: async (_id: string, request: unknown) => {
              sent.push(request);
              return {} as never;
            },
          }}
          busy={false}
          daemon={daemon}
          draftStore={new DaemonDraftStore(new MemoryStorage())}
          enterKeyPreference={mode}
          phoneEnterKeyPreference={mode}
          sessionId={`plain-${busyKey}`}
        />,
      );
      const textarea = view.root.findByType(LiveMarkdownEditor);
      run(() => textarea.props.onChange({ currentTarget: { value: 'hello', selectionStart: 5, selectionEnd: 5 } }));
      await runAsync(async () => {
        if (busyKey === 'button') view.root.findByType('form').props.onSubmit({ preventDefault() {} });
        else
          view.root.findByType(LiveMarkdownEditor).props.onKeyDown({
            key: 'Enter',
            shiftKey: false,
            metaKey: busyKey === 'Enter+meta',
            ctrlKey: false,
            altKey: false,
            nativeEvent: { isComposing: false },
            preventDefault() {},
          });
      });
    }
    expect(sent).toEqual([
      { message: 'hello', now: false },
      { message: 'hello', now: false },
      { message: 'hello', now: false },
    ]);
    const view = mountComposer('idle agent');
    await runAsync(async () => {
      view.key({ key: 'Enter' });
    });
    expect(view.sent).toEqual([{ message: 'idle agent', now: false }]);
  });

  test('only ⌘/Ctrl+⇧+↵ sends now, which interrupts the turn', async () => {
    const view = mountComposer('stop and do this');
    await runAsync(async () => {
      view.key({ key: 'Enter', ctrlKey: true, shiftKey: true });
    });
    expect(view.sent).toEqual([{ message: 'stop and do this', now: true }]);
  });

  test('↑ in an empty box brings back a copy of the last queued message, and says the original still runs', async () => {
    const view = mountComposer('fix it later', 'queued');
    expect(view.key({ key: 'ArrowUp' })).toBe(false);
    await runAsync(async () => {
      view.key({ key: 'Enter' });
    });
    expect(view.textarea().props.value).toBe('');
    expect(view.key({ key: 'ArrowUp', shiftKey: true })).toBe(false);
    expect(view.key({ key: 'ArrowUp' })).toBe(true);
    expect(view.textarea().props.value).toBe('fix it later');
    expect(view.view.root.findByProps({ 'data-composer-recalled': '' }).props.role).toBe('status');
    // A full box is the reader's own text: ↑ moves the caret as it always has.
    expect(view.key({ key: 'ArrowUp' })).toBe(false);

    const delivered = mountComposer('now', 'delivered');
    await runAsync(async () => {
      delivered.key({ key: 'Enter' });
    });
    expect(delivered.key({ key: 'ArrowUp' })).toBe(false);
  });

  test('the plain text box keeps Enter and ⌘B to the browser', () => {
    writeMdComposePref('off');
    const view = mountComposer('- first');
    expect(view.key({ key: 'b', metaKey: true })).toBe(false);
    writeMdComposePref('on');
  });

  test('every formatting shortcut edits the markdown at the selection', () => {
    writeMdComposePref('on');
    const view = mountComposer('one\ntwo');
    const at = { selectionStart: 0, selectionEnd: 7 };
    expect(view.key({ key: '*', code: 'Digit8', metaKey: true, shiftKey: true }, at)).toBe(true);
    expect(view.textarea().props.value).toBe('- one\n- two');
    expect(
      view.key({ key: '¡', code: 'Digit1', ctrlKey: true, altKey: true }, { selectionStart: 2, selectionEnd: 2 }),
    ).toBe(true);
    expect(view.textarea().props.value).toBe('# one\n- two');
    expect(view.key({ key: 'X', metaKey: true, shiftKey: true }, { selectionStart: 2, selectionEnd: 5 })).toBe(true);
    expect(view.textarea().props.value).toBe('# ~~one~~\n- two');
    expect(view.key({ key: 'ç', code: 'KeyC', metaKey: true, altKey: true })).toBe(true);
    expect(view.textarea().props.value).toContain('```\n- two\n```');
    // A modified key that formats nothing keeps its browser meaning.
    expect(view.key({ key: 'k', metaKey: true })).toBe(false);
  });

  test('Rich text adds a toolbar whose buttons format the draft, each naming its shortcut', () => {
    writeMdComposePref('rich');
    const view = mountComposer('make bold');
    const bold = view.view.root.findByProps({ 'data-format': 'Bold' });
    expect(String(bold.props.title)).toMatch(/^Bold \((⌘|Ctrl\+)B\)$/u);
    let prevented = false;
    bold.props.onMouseDown({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    run(() => bold.props.onClick());
    // Unfocused, the editor formats at the caret it last had: the start, before anything was typed.
    expect(view.textarea().props.value).toBe('****make bold');
    expect(view.textarea().props.markers).toBe('hidden');
    const checklist = view.view.root.findByProps({ 'data-format': 'Checklist' });
    expect(checklist.props.title).toBe('Checklist');
    run(() => writeMdComposePref('on'));
    expect(view.view.root.findAll(node => node.props['data-composer-toolbar'] === '')).toHaveLength(0);
  });

  test('Send and Interrupt & send: two buttons, the second only while the agent works', async () => {
    writeMdComposePref('on');
    const sent: unknown[] = [];
    const props = {
      api: {
        send: async (_id: string, request: unknown) => {
          sent.push(request);
          return {} as never;
        },
      },
      daemon,
      draftStore: new DaemonDraftStore(new MemoryStorage()),
      enterKeyPreference: 'send' as const,
      phoneEnterKeyPreference: 'send' as const,
      sessionId: 'buttons',
    };
    const view = render(<Composer {...props} busy={false} />);
    const interrupt = () =>
      view.root.findAll(node => node.type === 'button' && node.props['data-composer-interrupt'] === '');
    expect(interrupt()).toHaveLength(0);
    expect(view.root.findByProps({ 'data-composer-send': '' }).props.title).toMatch(/^Send \(↵ or /u);
    run(() => view.update(<Composer {...props} busy enterKeyPreference="newline" phoneEnterKeyPreference="newline" />));
    expect(view.root.findByProps({ 'data-composer-send': '' }).props.title).toMatch(
      /queued for the agent's next turn \(⇧↵/u,
    );
    const [button] = interrupt();
    expect(String(button?.props.title)).toMatch(/^Interrupt & send — .*⇧↵\)$/u);
    expect(button?.props.disabled).toBe(true);
    run(() =>
      view.root
        .findByType(LiveMarkdownEditor)
        .props.onChange({ currentTarget: { value: 'stop', selectionStart: 4, selectionEnd: 4, focus() {} } }),
    );
    await runAsync(async () => {
      interrupt()[0]?.props.onClick();
    });
    expect(sent).toEqual([{ message: 'stop', now: true }]);
  });
});

describe('transcript labels and folding', () => {
  test('labels assistant rows with the agent’s name and leaves the row’s instant alone', () => {
    const at = Date.UTC(2026, 9, 18, 1, 45, 44);
    const entry: TranscriptEntry = { id: 'a', kind: 'assistant', text: 'hi', label: 'Assistant', at };
    expect(withAgentName(entry, 'Hadi')).toEqual({ ...entry, label: 'Hadi' });
    expect(withAgentName({ ...entry, label: 'mylie' }, 'Hadi').label).toBe('Hadi');
    expect(withAgentName(entry, '')).toBe(entry);
    expect(withAgentName({ id: 'u', kind: 'user', text: 'x' }, 'Hadi').label).toBeUndefined();
  });

  test('hides every notice but an alert', () => {
    expect(hiddenFromTranscript({ id: 'n', kind: 'notice', text: 'Browser automation stays unavailable' })).toBe(true);
    expect(hiddenFromTranscript({ id: 'e', kind: 'notice', text: 'E1: broke', alert: true })).toBe(false);
    expect(hiddenFromTranscript({ id: 'a', kind: 'assistant', text: 'x' })).toBe(false);
  });

  test('renders the agent name and no "Show details" toggle at all', () => {
    const entries: readonly TranscriptEntry[] = [
      { id: 'a', kind: 'assistant', text: 'hello', label: 'Assistant' },
      { id: 'n', kind: 'notice', text: 'note' },
    ];
    const view = render(<Transcript agentName="Hadi" daemonId="d" entries={entries} sessionId="s" />);
    const json = JSON.stringify(view.toJSON());
    expect(json).toContain('Hadi');
    expect(json).not.toContain('note');
    expect(json).not.toContain('Show details');
  });
});
