import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { FileInstanceSurface } from '../../src/components/file-instance-surface.tsx';
import { resetFsProbes, type FsChanges, type FsFile } from '../../src/components/files-api.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';
import type { SidePaneTabInstance } from '../../src/shell/side-pane-tab-model.ts';
import { interact, mount, must, type Mounted } from '../support/dom.ts';

const daemon = daemonConnection({
  daemonId: 'view-daemon',
  baseUrl: 'https://view.example.test',
  deviceToken: 'view-token',
});
const scope = daemonSessionScope(daemon, 'work');

const other = daemonConnection({
  daemonId: 'other-daemon',
  baseUrl: 'https://other.example.test',
  deviceToken: 'other-token',
});
const otherScope = daemonSessionScope(other, 'work');

interface Fixture {
  changes?: FsChanges | Error;
  files?: Record<string, FsFile | Error>;
  diffs?: Record<string, string | Error>;
}

let fixture: Fixture = {};
let asked: string[] = [];
const originalFetch = globalThis.fetch;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const route = (url: string): Response => {
  const parsed = new URL(url);
  const path = parsed.searchParams.get('path') ?? '';
  if (parsed.pathname.endsWith('/fs/changes')) {
    if (fixture.changes instanceof Error) throw fixture.changes;
    return json(fixture.changes ?? { repo: false, changes: [] });
  }
  if (parsed.pathname.endsWith('/fs/diff')) {
    const answer = fixture.diffs?.[path];
    if (answer instanceof Error) throw answer;
    return new Response(answer ?? '', { headers: { 'content-type': 'text/plain' } });
  }
  const answer = fixture.files?.[path];
  if (answer instanceof Error) throw answer;
  return json(answer ?? { path, content: `contents of ${path}` });
};

beforeEach(() => {
  fixture = {};
  asked = [];
  resetFsProbes();
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return route(String(input));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
};

const open = async (element: Parameters<typeof mount>[0]): Promise<Mounted> => {
  const view = await mount(element);
  await settle();
  return view;
};

const byLabel = (container: HTMLElement, label: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(`[aria-label="${label}"]`), `an element labelled ${label}`);

const click = (container: HTMLElement, label: string): Promise<void> =>
  interact(() => byLabel(container, label).click());

const fileInstance = (path: string, extra: Partial<SidePaneTabInstance> = {}): SidePaneTabInstance => ({
  id: `file:${path}`,
  kind: 'file',
  key: path,
  label: path.split('/').pop() ?? path,
  title: path,
  order: 1,
  revision: 1,
  ...extra,
});

describe('a file instance tab body', () => {
  it('renders the bytes of its OWN file, addressed to its own daemon', async () => {
    fixture.files = { 'src/api.ts': { path: 'src/api.ts', content: 'export const api = 1;\n' } };
    const view = await open(
      <FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('src/api.ts')} />,
    );
    try {
      expect(view.container.textContent).toContain('export const api = 1;');
      expect(asked.some(url => url.includes('/fs/file') && url.includes('src%2Fapi.ts'))).toBe(true);
      expect(asked.every(url => url.startsWith('https://view.example.test/'))).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  it('gives two open files two independent bodies — the point of one tab per file', async () => {
    fixture.files = {
      'src/api.ts': { path: 'src/api.ts', content: 'the api file' },
      'README.md': { path: 'README.md', content: 'the readme file' },
    };
    const first = await open(
      <FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('src/api.ts')} />,
    );
    const second = await open(
      <FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('README.md')} />,
    );
    try {
      expect(first.container.textContent).toContain('the api file');
      expect(first.container.textContent).not.toContain('the readme file');
      expect(second.container.textContent).toContain('the readme file');

      // Raw is per body: switching one must not switch the other.
      await click(first.container, 'Show raw bytes for src/api.ts');
      await settle();
      expect(byLabel(first.container, 'Show src/api.ts normally').getAttribute('aria-pressed')).toBe('true');
      expect(second.container.querySelector('[aria-label="Show README.md normally"]')).toBeNull();
    } finally {
      await first.unmount();
      await second.unmount();
    }
  });

  it('never serves one daemon’s bytes under another daemon’s tab', async () => {
    fixture.files = { 'src/api.ts': { path: 'src/api.ts', content: 'first daemon bytes' } };
    const view = await open(
      <FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('src/api.ts')} />,
    );
    try {
      expect(view.container.textContent).toContain('first daemon bytes');
    } finally {
      await view.unmount();
    }

    fixture.files = { 'src/api.ts': { path: 'src/api.ts', content: 'second daemon bytes' } };
    const swapped = await open(
      <FileInstanceSurface daemon={other} scope={otherScope} instance={fileInstance('src/api.ts')} />,
    );
    try {
      expect(swapped.container.textContent).toContain('second daemon bytes');
      expect(swapped.container.textContent).not.toContain('first daemon bytes');
    } finally {
      await swapped.unmount();
    }
  });

  it('shows the delivered line range in the title and offers to clear it', async () => {
    fixture.files = { 'src/api.ts': { path: 'src/api.ts', content: 'one\ntwo\nthree\n' } };
    const view = await open(
      <FileInstanceSurface
        daemon={daemon}
        scope={scope}
        instance={fileInstance('src/api.ts', { selection: { line: 2 } })}
      />,
    );
    try {
      expect(view.container.textContent).toContain('src/api.ts:2');

      await click(view.container, 'Clear line selection for src/api.ts');
      await settle();
      expect(view.container.querySelector('[aria-label="Clear line selection for src/api.ts"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('brings a cleared highlight back when the SAME file is delivered again', async () => {
    fixture.files = { 'src/api.ts': { path: 'src/api.ts', content: 'one\ntwo\nthree\n' } };
    const instance = fileInstance('src/api.ts', { selection: { line: 2 } });
    const view = await open(<FileInstanceSurface daemon={daemon} scope={scope} instance={instance} />);
    try {
      await click(view.container, 'Clear line selection for src/api.ts');
      await settle();
      expect(view.container.querySelector('[aria-label="Clear line selection for src/api.ts"]')).toBeNull();

      // A re-delivery is a bumped revision — a real event, not a repaint.
      await view.render(
        <FileInstanceSurface
          daemon={daemon}
          scope={scope}
          instance={{ ...instance, selection: { line: 3 }, revision: 2 }}
        />,
      );
      await settle();
      expect(byLabel(view.container, 'Clear line selection for src/api.ts')).toBeDefined();
      expect(view.container.textContent).toContain('src/api.ts:3');
    } finally {
      await view.unmount();
    }
  });

  it('offers a diff only in a repository, and reads the diff for its own path', async () => {
    fixture.changes = { repo: true, changes: [] };
    fixture.diffs = { 'src/api.ts': '--- a/src/api.ts\n+++ b/src/api.ts\n@@ -1 +1 @@\n-old\n+new\n' };
    const view = await open(
      <FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('src/api.ts')} />,
    );
    try {
      await click(view.container, 'Show git diff for src/api.ts');
      await settle();
      expect(view.container.textContent).toContain('new');
      expect(asked.some(url => url.includes('/fs/diff') && url.includes('src%2Fapi.ts'))).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  it('hides the diff control when the session is not a repository', async () => {
    fixture.changes = { repo: false, changes: [] };
    const view = await open(
      <FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('src/api.ts')} />,
    );
    try {
      expect(view.container.querySelector('[aria-label="Show git diff for src/api.ts"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('renders a failed read as a failure with retry, never as an empty file', async () => {
    fixture.files = { 'src/api.ts': new Error('the daemon refused') };
    const view = await open(
      <FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('src/api.ts')} />,
    );
    try {
      expect(view.container.textContent).toContain('the daemon refused');
      expect(view.container.textContent).not.toContain('This file is empty');
      expect(byLabel(view.container, 'Retry loading api.ts')).toBeDefined();
    } finally {
      await view.unmount();
    }
  });

  it('states the refusal ONCE when the daemon cannot serve files, and reads nothing else', async () => {
    fixture.changes = new DaemonResponseError(501, 'this host has no filesystem access', 'unsupported');
    fixture.files = { 'src/api.ts': { path: 'src/api.ts', content: 'bytes that must not appear' } };
    const view = await open(
      <FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('src/api.ts')} />,
    );
    try {
      expect(view.container.textContent).toContain('this host has no filesystem access');
      // The refusal REPLACES the viewer. No bytes, and no raw/diff/refresh
      // controls that could only re-ask a settled question.
      expect(view.container.textContent).not.toContain('bytes that must not appear');
      expect(view.container.querySelector('[aria-label="Show raw bytes for src/api.ts"]')).toBeNull();
      expect(view.container.querySelector('[aria-label="Refresh src/api.ts"]')).toBeNull();

      // And it stays settled: a re-render asks the daemon nothing more.
      const settled = asked.length;
      await view.render(<FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('src/api.ts')} />);
      await settle();
      expect(asked.length).toBe(settled);
    } finally {
      await view.unmount();
    }
  });

  it('re-reads the file from the session host on Refresh', async () => {
    fixture.files = { 'src/api.ts': { path: 'src/api.ts', content: 'first read' } };
    const view = await open(
      <FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('src/api.ts')} />,
    );
    try {
      const before = asked.filter(url => url.includes('/fs/file')).length;

      fixture.files = { 'src/api.ts': { path: 'src/api.ts', content: 'second read' } };
      await click(view.container, 'Refresh src/api.ts');
      await settle();

      expect(asked.filter(url => url.includes('/fs/file')).length).toBeGreaterThan(before);
      expect(view.container.textContent).toContain('second read');
    } finally {
      await view.unmount();
    }
  });
});

describe('a file instance tab body reading a binary diff', () => {
  it('says git calls the pair binary rather than rendering an empty diff', async () => {
    fixture.changes = { repo: true, changes: [] };
    fixture.diffs = { 'logo.png': 'diff --git a/logo.png b/logo.png\nGIT binary patch\nliteral 4812\n' };
    const view = await open(<FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('logo.png')} />);
    try {
      await click(view.container, 'Show git diff for logo.png');
      await settle();

      expect(view.container.textContent).toContain('binary');
      expect(view.container.textContent).not.toContain('No textual changes in this file.');
    } finally {
      await view.unmount();
    }
  });
});
