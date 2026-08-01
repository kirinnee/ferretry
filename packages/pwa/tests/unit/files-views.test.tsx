import { describe, expect, it } from 'bun:test';
import type { FsChange, FsEntry, FsFile } from '../../src/components/files-api.ts';
import { parseUnifiedDiff } from '../../src/components/files-model.ts';
import {
  BrowseList,
  ChangeIndicator,
  DiffBody,
  Failed,
  FileBody,
  Loading,
  Note,
  OpenFileTabs,
  SourceLines,
} from '../../src/components/files-views.tsx';
import { interact, mount, must } from '../support/dom.ts';

const byLabel = (container: HTMLElement, label: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(`[aria-label="${label}"]`), `an element labelled ${label}`);

const listing = (entries: readonly FsEntry[], extra: { truncated?: boolean } = {}) => ({
  entries: [...entries],
  ...extra,
});

describe('the Files notes', () => {
  it('carries a tone only when there is one, and states its retry', async () => {
    const view = await mount(
      <>
        <Note>plain</Note>
        <Note tone="warn" role="status">
          warned
        </Note>
        <Loading what="the session root" />
        <Failed what="the diff" error="offline" onRetry={() => {}} />
      </>,
    );
    const notes = view.container.querySelectorAll('.kt-fs-note');
    expect(notes[0]?.getAttribute('data-tone')).toBeNull();
    expect(notes[1]?.getAttribute('data-tone')).toBe('warn');
    expect(view.container.textContent).toContain('Loading the session root…');
    expect(view.container.textContent).toContain('Could not load the diff: offline');
    expect(must(view.container.querySelector('[role="alert"]'), 'the alert')).toBeDefined();
    await view.unmount();
  });

  it('retries on demand', async () => {
    let retried = 0;
    const view = await mount(<Failed what="the diff" error="offline" onRetry={() => (retried += 1)} />);
    await interact(() => byLabel(view.container, 'Retry loading the diff').click());
    expect(retried).toBe(1);
    await view.unmount();
  });
});

describe('the change indicator', () => {
  const render = (change: FsChange) => mount(<ChangeIndicator change={change} />);

  it('shows both counts and repeats the whole status in its accessible name', async () => {
    const view = await render({ path: 'a.ts', status: ' M', additions: 4, deletions: 2 });
    const marker = must(view.container.querySelector('.kt-fs-change'), 'the marker');
    expect(marker.getAttribute('role')).toBe('img');
    expect(marker.getAttribute('aria-label')).toBe('Modified (unstaged) · +4 · −2');
    expect(marker.textContent).toBe('+4−2');
    await view.unmount();
  });

  it('marks an untracked file as added even when git reported no counts', async () => {
    const view = await mount(<ChangeIndicator change={{ path: 'new.ts', status: '??' }} />);
    expect(must(view.container.querySelector('.kt-fs-change'), 'the marker').textContent).toBe('+');
    expect(must(view.container.querySelector('.kt-fs-change-dot'), 'the dot').getAttribute('data-tone')).toBe('accent');
    await view.unmount();
  });

  it('marks a deletion with a bare minus when the count is unknown', async () => {
    const view = await mount(<ChangeIndicator change={{ path: 'gone.ts', status: 'D ' }} />);
    expect(must(view.container.querySelector('.kt-fs-change'), 'the marker').textContent).toBe('−');
    await view.unmount();
  });

  it('shows no counts at all for a plain modification git did not measure', async () => {
    const view = await mount(<ChangeIndicator change={{ path: 'a.ts', status: ' M' }} />);
    expect(must(view.container.querySelector('.kt-fs-change'), 'the marker').textContent).toBe('');
    await view.unmount();
  });
});

describe('the directory listing', () => {
  it('offers folders, files and their change markers, and never a control that only refuses', async () => {
    const actions: string[] = [];
    const view = await mount(
      <BrowseList
        listing={listing([
          { name: 'src', type: 'dir' },
          { name: 'index.ts', type: 'file', size: 2_048 },
          { name: 'secrets.env', type: 'file', denied: true },
          { name: 'node_modules', type: 'dir', ignored: true },
          { name: 'outside', type: 'symlink', escapes: true },
        ])}
        dir="app"
        changes={new Map([['app/index.ts', { path: 'app/index.ts', status: ' M', additions: 1, deletions: 0 }]])}
        onEnter={path => actions.push(`enter:${path}`)}
        onOpenFile={path => actions.push(`open:${path}`)}
      />,
    );
    expect(view.container.querySelectorAll('li')).toHaveLength(6);
    // Refused rows are inert divs, not disabled buttons.
    expect(view.container.querySelectorAll('[data-inert="true"]')).toHaveLength(3);
    expect(view.container.textContent).toContain('not served — denylisted (secrets policy)');
    expect(view.container.textContent).toContain('symlink leaves this session’s folder — not served');
    expect(view.container.textContent).toContain('gitignored — content is not served');

    await interact(() => byLabel(view.container, 'Up to the session root').click());
    await interact(() => byLabel(view.container, 'Open folder src').click());
    await interact(() => byLabel(view.container, 'Open file index.ts, 2.0 KB, Modified (unstaged) · +1').click());
    expect(actions).toEqual(['enter:', 'enter:app/src', 'open:app/index.ts']);
    await view.unmount();
  });

  it('drops the up row at the root and says a folder is empty rather than looking broken', async () => {
    const view = await mount(<BrowseList listing={listing([])} dir="" onEnter={() => {}} onOpenFile={() => {}} />);
    expect(view.container.querySelector('[aria-label^="Up to"]')).toBeNull();
    expect(view.container.textContent).toContain('This folder is empty.');
    await view.unmount();
  });

  it('says outright when the daemon capped the listing', async () => {
    const view = await mount(
      <BrowseList
        listing={listing([{ name: 'a.ts', type: 'file' }], { truncated: true })}
        dir=""
        onEnter={() => {}}
        onOpenFile={() => {}}
      />,
    );
    expect(view.container.textContent).toContain('Listing truncated by the daemon');
    // A file with no reported size gets no size clause in its name.
    expect(view.container.querySelector('[aria-label="Open file a.ts"]')).not.toBeNull();
    await view.unmount();
  });
});

describe('the diff body', () => {
  it('numbers both sides, signs additions and removals, and leaves headers unnumbered', async () => {
    const parsed = parseUnifiedDiff(
      [
        'diff --git a/a.ts b/a.ts',
        '@@ -1,3 +1,3 @@',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 3;',
        '',
        '\\ No newline at end of file',
      ].join('\n'),
    );
    const view = await mount(<DiffBody parsed={parsed} />);
    const rows = [...view.container.querySelectorAll('.kt-fs-diff-line')];
    const kinds = rows.map(row => row.getAttribute('data-kind'));
    expect(kinds).toContain('hunk');
    expect(kinds).toContain('add');
    expect(kinds).toContain('del');
    expect(kinds).toContain('ctx');
    const added = must(
      rows.find(row => row.getAttribute('data-kind') === 'add'),
      'the added row',
    );
    expect(must(added.querySelector('.kt-fs-sign'), 'the sign').textContent).toBe('+');
    const removed = must(
      rows.find(row => row.getAttribute('data-kind') === 'del'),
      'the removed row',
    );
    expect(must(removed.querySelector('.kt-fs-sign'), 'the sign').textContent).toBe('-');
    // A hunk header is not a code row: no gutters, no sign.
    const hunk = must(
      rows.find(row => row.getAttribute('data-kind') === 'hunk'),
      'the hunk header',
    );
    expect(hunk.querySelectorAll('.kt-fs-gutter')).toHaveLength(0);
    await view.unmount();
  });
});

describe('the source-line view', () => {
  it('states a single highlighted line and marks it current', async () => {
    const view = await mount(
      <SourceLines content={'one\ntwo\nthree'} html={null} selection={{ line: 2, column: 5 }} />,
    );
    expect(view.container.textContent).toContain('Line 2, column 5 highlighted.');
    const current = must(view.container.querySelector('[aria-current="location"]'), 'the current line');
    expect(current.getAttribute('data-line')).toBe('2');
    expect(current.getAttribute('data-column')).toBe('5');
    await view.unmount();
  });

  it('clamps a range that runs past the end of the file and says so', async () => {
    const view = await mount(<SourceLines content={'one\ntwo'} html={null} selection={{ line: 1, endLine: 9 }} />);
    expect(view.container.textContent).toContain('Lines 1–9 requested; this file ends at line 2.');
    expect(view.container.querySelectorAll('[data-highlighted="true"]')).toHaveLength(2);
    await view.unmount();
  });

  it('refuses to invent a line that does not exist', async () => {
    const view = await mount(<SourceLines content={'only one line'} html={null} selection={{ line: 7 }} />);
    const rail = must(view.container.querySelector('.kt-fs-location'), 'the location rail');
    expect(rail.getAttribute('data-tone')).toBe('warn');
    expect(rail.textContent).toContain('Line 7 does not exist; this file has 1 line.');
    await view.unmount();
  });

  it('says "lines" in the plural for a longer file', async () => {
    const view = await mount(<SourceLines content={'a\nb\nc'} html={null} selection={{ line: 9 }} />);
    expect(must(view.container.querySelector('.kt-fs-location'), 'the rail').textContent).toContain('has 3 lines.');
    await view.unmount();
  });

  it('paints highlighter markup line by line when there is any', async () => {
    const view = await mount(
      <SourceLines
        content={'const a = 1;\nconst b = 2;'}
        html={'<span class="hljs-keyword">const</span> a = 1;\n<span class="hljs-keyword">const</span> b = 2;'}
        lang="ts"
        selection={{ line: 1 }}
      />,
    );
    expect(view.container.querySelectorAll('.hljs-keyword').length).toBeGreaterThan(0);
    expect(must(view.container.querySelector('code'), 'a code cell').className).toContain('language-ts');
    await view.unmount();
  });
});

const file = (overrides: Partial<FsFile> = {}): FsFile => ({ path: 'src/a.ts', content: 'const a = 1;', ...overrides });

describe('the file body', () => {
  it('shows the daemon’s refusal instead of a blank pane', async () => {
    const view = await mount(<FileBody file={file({ binary: true, content: undefined })} path="a.bin" />);
    expect(view.container.textContent).toContain('This file is binary');
    await view.unmount();
  });

  it('says a file is empty rather than rendering an empty code block', async () => {
    const view = await mount(<FileBody file={file({ content: '' })} path="empty.ts" />);
    expect(view.container.textContent).toContain('This file is empty.');
    await view.unmount();
  });

  it('renders Markdown as prose, and as source the moment a line is selected', async () => {
    const view = await mount(<FileBody file={file({ content: '# Title\n\nbody' })} path="README.md" />);
    expect(view.container.querySelector('.kt-fs-md')).not.toBeNull();
    expect(must(view.container.querySelector('h1'), 'the heading').textContent).toBe('Title');

    await view.render(
      <FileBody file={file({ content: '# Title\n\nbody' })} path="README.md" selection={{ line: 1 }} />,
    );
    expect(view.container.querySelector('.kt-fs-md')).toBeNull();
    expect(view.container.querySelector('.kt-fs-location')).not.toBeNull();
    await view.unmount();
  });

  it('highlights recognised code and drops to plain text on request', async () => {
    const view = await mount(<FileBody file={file({ lang: 'ts' })} path="src/a.ts" />);
    expect(must(view.container.querySelector('code'), 'the code cell').className).toContain('language-ts');

    await view.render(<FileBody file={file({ lang: 'ts' })} path="src/a.ts" raw />);
    expect(view.container.querySelector('code')).toBeNull();
    expect(must(view.container.querySelector('pre'), 'the raw block').textContent).toBe('const a = 1;');
    await view.unmount();
  });

  it('explains the highlighter’s own cap rather than silently rendering plain text', async () => {
    const huge = `${'const a = 1;\n'.repeat(6_000)}`;
    const view = await mount(<FileBody file={file({ content: huge, lang: 'ts' })} path="src/big.ts" />);
    expect(view.container.textContent).toContain('Syntax highlighting is off above 60,000 characters.');

    await view.render(
      <FileBody file={file({ content: huge, lang: 'ts' })} path="src/big.ts" selection={{ line: 1 }} />,
    );
    expect(view.container.textContent).toContain('Syntax highlighting is off above 60,000 characters.');
    await view.unmount();
  });

  it('falls back to plain text for a language the highlighter does not know', async () => {
    const view = await mount(<FileBody file={file({ content: 'plain words', lang: undefined })} path="notes.txt" />);
    expect(view.container.querySelector('code')).toBeNull();
    expect(view.container.textContent).toContain('plain words');
    await view.unmount();
  });
});

describe('the open-file rail', () => {
  it('activates and closes by full path while showing only the base name', async () => {
    const actions: string[] = [];
    const view = await mount(
      <OpenFileTabs
        tabs={[
          { path: 'packages/pwa/src/components/files-tab.tsx', view: 'normal' },
          { path: 'README.md', view: 'raw' },
        ]}
        activePath="README.md"
        onActivate={path => actions.push(`show:${path}`)}
        onClose={path => actions.push(`close:${path}`)}
      />,
    );
    const rail = must(view.container.querySelector('.kt-fs-tabs'), 'the rail');
    expect(rail.getAttribute('role')).toBe('toolbar');
    expect(rail.getAttribute('aria-label')).toBe('Open files');
    expect(view.container.textContent).toContain('files-tab.tsx');
    expect(view.container.textContent).not.toContain('packages/pwa/src/components/files-tab.tsx');
    expect(byLabel(view.container, 'Show README.md').getAttribute('aria-pressed')).toBe('true');

    await interact(() => byLabel(view.container, 'Show packages/pwa/src/components/files-tab.tsx').click());
    await interact(() => byLabel(view.container, 'Close README.md').click());
    expect(actions).toEqual(['show:packages/pwa/src/components/files-tab.tsx', 'close:README.md']);
    await view.unmount();
  });
});
