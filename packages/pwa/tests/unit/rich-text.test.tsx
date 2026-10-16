import { describe, expect, test } from 'bun:test';
import { Composer } from '../../src/components/composer.tsx';
import { applyBlockShortcut, RichTextEditor, renderRichDocument } from '../../src/components/rich-text-editor.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { blockShortcut, inlineSegments, richBlocks, richNodeToMarkdown } from '../../src/lib/rich-text.ts';
import '../support/dom.ts';
import { interact, mount, must } from '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';

const DOCUMENT = [
  '# Fix the login page',
  '## Steps',
  '### Detail',
  'Compare **old** and *new*, then `bun test` and ~~skip~~.',
  '- run it',
  '- check it',
  '1. first',
  '2. second',
  '[ ] todo',
  '[x] done',
  '> a quote',
  '---',
  '```',
  'const a = 1;',
  '```',
  '',
  'plain end',
].join('\n');

const rendered = (markdown: string): HTMLElement => {
  const root = document.createElement('div');
  renderRichDocument(root, markdown);
  return root;
};

describe('rich text round trip', () => {
  test('renders every block it knows and reads back the exact markdown', () => {
    const root = rendered(DOCUMENT);
    expect(Array.from(root.children).map(child => child.tagName)).toEqual([
      'H1',
      'H2',
      'H3',
      'P',
      'UL',
      'OL',
      'UL',
      'BLOCKQUOTE',
      'HR',
      'PRE',
      'P',
      'P',
    ]);
    expect(root.querySelector('strong')?.textContent).toBe('old');
    expect(root.querySelector('ul[data-checklist] li[data-checked="true"]')?.textContent).toBe('done');
    expect(richNodeToMarkdown(root)).toBe(DOCUMENT.replace('- [x]', '[x]'));
  });

  test('never parses the reader’s text as markup', () => {
    const root = rendered('<img src=x onerror=alert(1)> **<b>**');
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('strong')?.textContent).toBe('<b>');
  });

  test('reads what a browser’s own editing leaves behind', () => {
    const root = document.createElement('div');
    root.append('loose text', document.createElement('br'));
    const div = document.createElement('div');
    div.innerHTML = 'a <b>b</b> <i>i</i> <del>d</del> <span>s</span><b></b> c&nbsp;d';
    root.append(div, document.createTextNode(''));
    const checklist = document.createElement('ul');
    checklist.setAttribute('data-checklist', '');
    const item = document.createElement('li');
    item.textContent = 'open';
    checklist.append(item);
    root.append(checklist);
    expect(richNodeToMarkdown(root)).toBe('loose text\n\na **b** *i* ~~d~~ s c d\n[ ] open');
  });

  test('describes blocks and inline marks as data', () => {
    expect(richBlocks('- [ ] task')).toEqual([{ kind: 'li', list: 'check', text: 'task', done: false }]);
    expect(richBlocks('```\nunclosed')).toEqual([{ kind: 'code', lines: ['unclosed'] }]);
    expect(inlineSegments('')).toEqual([]);
    expect(inlineSegments('a ~~b~~')).toEqual([{ text: 'a ' }, { mark: 's', text: 'b' }]);
  });

  test('knows the block shortcuts Notion does', () => {
    expect(blockShortcut('# Title')).toEqual({ tag: 'h1', rest: 'Title' });
    expect(blockShortcut('### ')).toEqual({ tag: 'h3', rest: '' });
    expect(blockShortcut('- item')).toEqual({ tag: 'ul', rest: 'item' });
    expect(blockShortcut('1. item')).toEqual({ tag: 'ol', rest: 'item' });
    expect(blockShortcut('> said')).toEqual({ tag: 'blockquote', rest: 'said' });
    expect(blockShortcut('plain')).toBeNull();
  });

  test('turns a typed prefix into its block and leaves the caret at its end', () => {
    for (const [typed, tag] of [
      ['# Title', 'H1'],
      ['- ', 'UL'],
      ['1. one', 'OL'],
    ] as const) {
      const root = document.createElement('div');
      document.body.append(root);
      const p = document.createElement('p');
      p.textContent = typed;
      root.append(document.createElement('h1'), p);
      expect(applyBlockShortcut(root)).toBe(true);
      expect(root.children[1]?.tagName).toBe(tag);
      root.remove();
    }
    const plain = document.createElement('div');
    plain.innerHTML = '<p>nothing</p>';
    expect(applyBlockShortcut(plain)).toBe(false);
  });
});

describe('RichTextEditor', () => {
  test('publishes markdown on input, sends on Enter, and leaves Enter to a list', async () => {
    const changes: string[] = [];
    let submitted = 0;
    const view = await mount(
      <RichTextEditor
        id="rich"
        onChange={next => changes.push(next)}
        onPasteFiles={() => {}}
        onSubmit={() => {
          submitted += 1;
        }}
        placeholder="Message"
        sendsOnEnter={event => !event.shiftKey}
        value="- item"
      />,
    );
    const editor = must(view.container.querySelector<HTMLElement>('[data-rich-editor]'), 'the editor');
    expect(editor.querySelector('li')?.textContent).toBe('item');
    const h = document.createElement('p');
    h.textContent = '## Heading';
    editor.append(h);
    await interact(() => editor.dispatchEvent(new Event('input', { bubbles: true })));
    expect(changes.at(-1)).toBe('- item\n## Heading');

    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      editor.dispatchEvent(event);
      return event.defaultPrevented;
    };
    // The caret in the list item: Enter belongs to the list.
    const range = document.createRange();
    range.selectNodeContents(must(editor.querySelector('li'), 'item'));
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    await interact(() => press({ key: 'Enter' }));
    expect(submitted).toBe(0);
    // In a paragraph, Enter sends; Shift+Enter does not.
    range.selectNodeContents(must(editor.querySelector('h2'), 'heading'));
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    await interact(() => press({ key: 'Enter', shiftKey: true }));
    expect(submitted).toBe(0);
    await interact(() => press({ key: 'Enter' }));
    expect(submitted).toBe(1);
    await interact(() => press({ key: 'b', metaKey: true }));
    await interact(() => press({ key: 'i', ctrlKey: true }));
    await interact(() => press({ key: 'x', ctrlKey: true }));
    await interact(() => press({ key: 'a' }));
    expect(submitted).toBe(1);
    await view.unmount();
  });

  test('a new value from outside re-renders; its own echo does not', () => {
    const changes: string[] = [];
    const props = {
      id: 'rich',
      onChange: (next: string) => changes.push(next),
      onPasteFiles: () => {},
      onSubmit: () => {},
      sendsOnEnter: () => true,
    };
    const nodes: HTMLElement[] = [];
    const view = render(<RichTextEditor {...props} value="first" />, {
      createNodeMock: () => {
        const node = document.createElement('div');
        nodes.push(node);
        return node;
      },
    });
    const node = nodes[0] as HTMLElement;
    expect(node.textContent).toBe('first');
    run(() => view.root.findByProps({ 'data-rich-editor': '' }).props.onInput());
    run(() => view.update(<RichTextEditor {...props} value={changes.at(-1) as string} />));
    run(() => view.update(<RichTextEditor {...props} value="# replaced" />));
    expect(node.querySelector('h1')?.textContent).toBe('replaced');
  });

  test('pasted files become attachments and pasted text stays text', () => {
    const files: File[][] = [];
    const nodes: HTMLElement[] = [];
    const view = render(
      <RichTextEditor
        id="rich"
        onChange={() => {}}
        onPasteFiles={next => files.push([...next])}
        onSubmit={() => {}}
        sendsOnEnter={() => true}
        value=""
      />,
      {
        createNodeMock: () => {
          const node = document.createElement('div');
          nodes.push(node);
          return node;
        },
      },
    );
    const editor = view.root.findByProps({ 'data-rich-editor': '' });
    const target = { ownerDocument: document };
    let prevented = 0;
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    run(() =>
      editor.props.onPaste({
        clipboardData: { files: [file], getData: () => '' },
        currentTarget: target,
        preventDefault: () => (prevented += 1),
      }),
    );
    run(() =>
      editor.props.onPaste({
        clipboardData: { files: [], getData: () => '<b>x</b>' },
        currentTarget: target,
        preventDefault: () => (prevented += 1),
      }),
    );
    run(() =>
      editor.props.onPaste({ clipboardData: null, currentTarget: target, preventDefault: () => (prevented += 1) }),
    );
    expect(files).toEqual([[file]]);
    expect(prevented).toBe(3);
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

const daemon = daemonConnection({ daemonId: 'rich', baseUrl: 'https://rich.example.test', deviceId: 'device' });

describe('the composer in rich text style', () => {
  test('swaps the textarea for the rich editor and sends its markdown', async () => {
    writeMdComposePref('rich');
    const sent: unknown[] = [];
    const view = render(
      <Composer
        api={{
          send: async (_id: string, request: unknown) => {
            sent.push(request);
            return { disposition: 'delivered' } as never;
          },
        }}
        daemon={daemon}
        draftStore={new DaemonDraftStore(new MemoryStorage())}
        enterKeyPreference="send"
        phoneEnterKeyPreference="send"
        sessionId="s"
      />,
      { createNodeMock: () => document.createElement('div') },
    );
    expect(view.root.findAllByType('textarea')).toHaveLength(0);
    const editor = view.root.findByType(RichTextEditor);
    run(() => editor.props.onChange('# Hello'));
    expect(editor.props.sendsOnEnter({ shiftKey: false, metaKey: false, ctrlKey: false })).toBe(true);
    expect(editor.props.sendsOnEnter({ shiftKey: true, metaKey: false, ctrlKey: false })).toBe(false);
    await runAsync(async () => editor.props.onSubmit());
    expect((sent[0] as { message: string }).message).toBe('# Hello');
    // A pasted file joins the same attachment strip the other editor styles use.
    run(() =>
      view.root.findByType(RichTextEditor).props.onPasteFiles([new File([], 'empty.txt', { type: 'text/plain' })]),
    );
    expect(view.root.findAll(node => node.props['aria-label'] === 'Attached files')).not.toHaveLength(0);
    writeMdComposePref('on');
  });
});
