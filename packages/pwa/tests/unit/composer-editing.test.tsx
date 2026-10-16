import { describe, expect, test } from 'bun:test';
import { Composer } from '../../src/components/composer.tsx';
import { Transcript, withAgentName } from '../../src/components/transcript.tsx';
import { continueList, insideCodeBlock, toggleWrap, wrapMarkerFor } from '../../src/lib/composer-editing.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { foldsIntoDetails, type TranscriptEntry } from '../../src/lib/session-screens.ts';
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
    expect(['b', 'I', 'e', 'x'].map(wrapMarkerFor)).toEqual(['**', '*', '`', null]);
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

const mountComposer = (draft: string) => {
  const sent: unknown[] = [];
  const store = new DaemonDraftStore(new MemoryStorage());
  const view = render(
    <Composer
      api={{
        send: async (_id: string, request: unknown) => {
          sent.push(request);
          return {} as never;
        },
      }}
      daemon={daemon}
      draftStore={store}
      enterKeyPreference="send"
      phoneEnterKeyPreference="send"
      sessionId="s"
    />,
  );
  const textarea = () => view.root.findByType('textarea');
  run(() => textarea().props.onChange({ currentTarget: { value: draft, selectionStart: draft.length, selectionEnd: draft.length } }));
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

  test('the plain text box keeps Enter and ⌘B to the browser', () => {
    writeMdComposePref('off');
    const view = mountComposer('- first');
    expect(view.key({ key: 'b', metaKey: true })).toBe(false);
    writeMdComposePref('on');
  });
});

describe('transcript labels and folding', () => {
  test('labels assistant rows with the agent, keeping the daemon’s clock', () => {
    const entry: TranscriptEntry = { id: 'a', kind: 'assistant', text: 'hi', label: 'Assistant · 10:11:12' };
    expect(withAgentName(entry, 'Hadi').label).toBe('Hadi · 10:11:12');
    expect(withAgentName({ ...entry, label: 'mylie' }, 'Hadi').label).toBe('Hadi');
    expect(withAgentName(entry, '')).toBe(entry);
    expect(withAgentName({ id: 'u', kind: 'user', text: 'x' }, 'Hadi').label).toBeUndefined();
  });

  test('folds every notice but an alert', () => {
    expect(foldsIntoDetails({ id: 'n', kind: 'notice', text: 'Browser automation stays unavailable' })).toBe(true);
    expect(foldsIntoDetails({ id: 'e', kind: 'notice', text: 'E1: broke', alert: true })).toBe(false);
    expect(foldsIntoDetails({ id: 'a', kind: 'assistant', text: 'x' })).toBe(false);
  });

  test('Show details opens every fold by default, and a toggle still closes one', () => {
    const entries: readonly TranscriptEntry[] = [
      { id: 'a', kind: 'assistant', text: 'hello', label: 'Assistant' },
      { id: 'n', kind: 'notice', text: 'note' },
    ];
    const view = render(<Transcript agentName="Hadi" daemonId="d" detailsShown entries={entries} sessionId="s" />);
    const toggle = () => view.root.findByProps({ className: 'fy-transcript-details-toggle' });
    expect(toggle().props['aria-expanded']).toBe(true);
    expect(JSON.stringify(view.toJSON())).toContain('Hadi');
    run(() => toggle().props.onClick());
    expect(toggle().props['aria-expanded']).toBe(false);
  });
});
