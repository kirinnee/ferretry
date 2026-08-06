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

/**
 * A pending `Promise` answer is how a read is held OPEN: everything about a
 * reload that must survive it — the bytes, the mounted nodes, the scroll
 * offset — is only observable while the reread has not settled.
 */
type FileAnswer = FsFile | Error | Promise<FsFile>;

interface Fixture {
  changes?: FsChanges | Error;
  files?: Record<string, FileAnswer>;
  /** Answers to `?format=base64` — the rich preview's own bounded byte read. */
  previews?: Record<string, FileAnswer>;
  diffs?: Record<string, string | Error>;
}

let fixture: Fixture = {};
let asked: string[] = [];
const originalFetch = globalThis.fetch;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const route = async (url: string): Promise<Response> => {
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
  const preview = parsed.searchParams.get('format') === 'base64';
  const answer = await (preview ? fixture.previews?.[path] : fixture.files?.[path]);
  if (answer instanceof Error) throw answer;
  return json(
    answer ?? (preview ? { path, base64: btoa(`bytes of ${path}`) } : { path, content: `contents of ${path}` }),
  );
};

beforeEach(() => {
  fixture = {};
  asked = [];
  resetFsProbes();
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return await route(String(input));
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

  it('renders a failed diff read as a failure with retry, with no diff to keep', async () => {
    fixture.changes = { repo: true, changes: [] };
    fixture.diffs = { 'src/api.ts': new Error('git is not on this host') };
    const view = await open(
      <FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('src/api.ts')} />,
    );
    try {
      await click(view.container, 'Show git diff for src/api.ts');
      await settle();

      // Nothing was ever displayed for this key, so there is no stale copy —
      // the failure panel is the whole answer, and it can be retried.
      expect(view.container.textContent).toContain('git is not on this host');
      expect(view.container.textContent).not.toContain('No textual changes in this file.');
      expect(view.container.querySelector('.kt-fs-stale')).toBeNull();

      fixture.diffs = { 'src/api.ts': '--- a/src/api.ts\n+++ b/src/api.ts\n@@ -1 +1 @@\n-old\n+new\n' };
      await click(view.container, 'Retry loading the diff');
      await settle();
      expect(view.container.textContent).toContain('new');
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
      expect(view.container.querySelector('[aria-label="Reload src/api.ts"]')).toBeNull();

      // And it stays settled: a re-render asks the daemon nothing more.
      const settled = asked.length;
      await view.render(<FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('src/api.ts')} />);
      await settle();
      expect(asked.length).toBe(settled);
    } finally {
      await view.unmount();
    }
  });

  it('re-reads the file from the session host on Reload, and says so in words', async () => {
    fixture.files = { 'src/api.ts': { path: 'src/api.ts', content: 'first read' } };
    const view = await open(
      <FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('src/api.ts')} />,
    );
    try {
      const before = asked.filter(url => url.includes('/fs/file')).length;
      // The DoD's word, on the control itself — not only in a tooltip.
      expect(byLabel(view.container, 'Reload src/api.ts').textContent).toContain('Reload');

      fixture.files = { 'src/api.ts': { path: 'src/api.ts', content: 'second read' } };
      await click(view.container, 'Reload src/api.ts');
      await settle();

      expect(asked.filter(url => url.includes('/fs/file')).length).toBeGreaterThan(before);
      expect(view.container.textContent).toContain('second read');
      // A settled reload leaves no stale copy behind it.
      expect(view.container.textContent).not.toContain('the copy loaded earlier');
      expect(view.container.querySelector('.kt-fs-stale')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('keeps the loaded bytes, the mounted nodes and the reading position while a reload is in flight', async () => {
    fixture.files = { 'src/api.ts': { path: 'src/api.ts', content: 'the bytes already on screen' } };
    const view = await open(
      <FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('src/api.ts')} />,
    );
    try {
      const pane = must(view.container.querySelector<HTMLElement>('.kt-fs-scroll'), 'the scroller');
      const body = must(pane.firstElementChild, 'the mounted file body');
      pane.scrollTop = 120;

      let release: ((file: FsFile) => void) | null = null;
      fixture.files = {
        'src/api.ts': new Promise<FsFile>(resolve => {
          release = resolve;
        }),
      };
      await click(view.container, 'Reload src/api.ts');
      await settle();

      // Mid-reload: the same nodes, the same offset, and one honest notice.
      expect(view.container.textContent).toContain('the bytes already on screen');
      expect(pane.firstElementChild).toBe(body);
      expect(view.container.querySelector('.kt-fs-scroll')).toBe(pane);
      expect(pane.scrollTop).toBe(120);
      const notice = must(view.container.querySelector('.kt-fs-stale'), 'the reload notice');
      expect(notice.getAttribute('role')).toBe('status');
      expect(notice.textContent).toContain('showing the copy loaded earlier');
      expect(byLabel(view.container, 'Reload src/api.ts').getAttribute('aria-busy')).toBe('true');
      // Never a spinner INSTEAD of the file — that is what loses the position.
      expect(view.container.textContent).not.toContain('Loading api.ts');

      await interact(async () => {
        must(release, 'the stalled reload')({ path: 'src/api.ts', content: 'the newly fetched bytes' });
      });
      await settle();
      expect(view.container.textContent).toContain('the newly fetched bytes');
      expect(view.container.textContent).not.toContain('the bytes already on screen');
      expect(view.container.querySelector('.kt-fs-stale')).toBeNull();
      expect(view.container.querySelector('.kt-fs-scroll')).toBe(pane);
    } finally {
      await view.unmount();
    }
  });

  it('keeps the last loaded copy visible when the reload fails, and retries from there', async () => {
    fixture.files = { 'src/api.ts': { path: 'src/api.ts', content: 'the copy that survived' } };
    const view = await open(
      <FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('src/api.ts')} />,
    );
    try {
      fixture.files = { 'src/api.ts': new Error('the session host went away') };
      await click(view.container, 'Reload src/api.ts');
      await settle();

      // A failed reread is NOT a failed file: the bytes stay, the failure is said.
      expect(view.container.textContent).toContain('the copy that survived');
      expect(view.container.querySelector('[aria-label="Retry loading api.ts"]')).toBeNull();
      const notice = must(view.container.querySelector('.kt-fs-stale'), 'the failed-reload notice');
      expect(notice.getAttribute('role')).toBe('alert');
      expect(notice.textContent).toContain('the session host went away');
      expect(notice.textContent).toContain('This is the copy loaded earlier');

      fixture.files = { 'src/api.ts': { path: 'src/api.ts', content: 'the retry that worked' } };
      await interact(() => must(notice.querySelector('button'), 'the try-again control').click());
      await settle();
      expect(view.container.textContent).toContain('the retry that worked');
      expect(view.container.querySelector('.kt-fs-stale')).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});

describe('a file instance tab body showing a rich preview', () => {
  const previewUrls = (): { created: string[]; revoked: string[]; restore: () => void } => {
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    const created: string[] = [];
    const revoked: string[] = [];
    URL.createObjectURL = (() => {
      const url = `blob:instance/${created.length + 1}`;
      created.push(url);
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => revoked.push(url)) as typeof URL.revokeObjectURL;
    return {
      created,
      revoked,
      restore: () => {
        URL.createObjectURL = create;
        URL.revokeObjectURL = revoke;
      },
    };
  };
  const previewReads = (): number => asked.filter(url => url.includes('format=base64')).length;

  it('reaches the sandboxed preview through the surface, for a binary file with no text at all', async () => {
    // A PDF arrives binary and content-free BY DESIGN. Announcing that as an
    // empty file is how the whole preview path used to be unreachable here.
    fixture.files = { 'docs/report.pdf': { path: 'docs/report.pdf', binary: true } };
    fixture.previews = { 'docs/report.pdf': { path: 'docs/report.pdf', base64: 'JVBERg==' } };
    const urls = previewUrls();
    try {
      const view = await open(
        <FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('docs/report.pdf')} />,
      );
      try {
        const frame = must(view.container.querySelector('iframe'), 'the sandboxed preview frame');
        expect(frame.getAttribute('sandbox')).toBe('');
        expect(frame.getAttribute('src')).toBe('blob:instance/1');
        expect(frame.getAttribute('src')).not.toContain(daemon.deviceToken);
        expect(view.container.textContent).not.toContain('This file is empty');
        expect(view.container.textContent).not.toContain('This file is binary');
      } finally {
        await view.unmount();
      }
    } finally {
      urls.restore();
    }
  });

  it('refetches the preview when Reload succeeds, and only then swaps the object URL', async () => {
    fixture.files = { 'report.html': { path: 'report.html', content: '<h1>one</h1>' } };
    fixture.previews = { 'report.html': { path: 'report.html', base64: btoa('<h1>one</h1>') } };
    const urls = previewUrls();
    try {
      const view = await open(
        <FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('report.html')} />,
      );
      try {
        expect(must(view.container.querySelector('iframe'), 'the first preview').getAttribute('src')).toBe(
          'blob:instance/1',
        );
        const before = previewReads();

        let release: ((file: FsFile) => void) | null = null;
        fixture.files = { 'report.html': { path: 'report.html', content: '<h1>two</h1>' } };
        fixture.previews = {
          'report.html': new Promise<FsFile>(resolve => {
            release = resolve;
          }),
        };
        await click(view.container, 'Reload report.html');
        await settle();

        // Mid-refetch: the earlier document is still the one on screen, and the
        // object URL it is showing has not been replaced or revoked.
        expect(must(view.container.querySelector('iframe'), 'the retained preview').getAttribute('src')).toBe(
          'blob:instance/1',
        );
        expect(urls.revoked).toEqual([]);
        const running = must(view.container.querySelector('.kt-rich-file .kt-fs-stale'), 'the reloading notice');
        expect(running.getAttribute('role')).toBe('status');
        expect(running.textContent).toContain('showing the copy loaded earlier');

        await interact(async () => {
          must(release, 'the stalled preview refetch')({ path: 'report.html', base64: btoa('<h1>two</h1>') });
        });
        await settle();

        expect(previewReads()).toBeGreaterThan(before);
        expect(must(view.container.querySelector('iframe'), 'the reloaded preview').getAttribute('src')).toBe(
          'blob:instance/2',
        );
        // Replaced only when new bytes landed — and the old one is not leaked.
        expect(urls.revoked).toEqual(['blob:instance/1']);
      } finally {
        await view.unmount();
      }
    } finally {
      urls.restore();
    }
  });

  it('keeps the preview on screen and marks it stale when the refetch fails', async () => {
    fixture.files = { 'report.html': { path: 'report.html', content: '<h1>one</h1>' } };
    fixture.previews = { 'report.html': { path: 'report.html', base64: btoa('<h1>one</h1>') } };
    const urls = previewUrls();
    try {
      const view = await open(
        <FileInstanceSurface daemon={daemon} scope={scope} instance={fileInstance('report.html')} />,
      );
      try {
        fixture.files = { 'report.html': { path: 'report.html', content: '<h1>two</h1>' } };
        fixture.previews = { 'report.html': new Error('the preview read failed') };
        await click(view.container, 'Reload report.html');
        await settle();

        // The parent's reload SUCCEEDED, so the file is new; only the preview
        // refetch failed, and a blanked frame would be the wrong answer to that.
        const frame = must(view.container.querySelector('iframe'), 'the retained preview');
        expect(frame.getAttribute('src')).toBe('blob:instance/1');
        expect(urls.revoked).toEqual([]);
        const notice = must(view.container.querySelector('.kt-rich-file .kt-fs-stale'), 'the stale preview notice');
        expect(notice.getAttribute('role')).toBe('alert');
        expect(notice.textContent).toContain('the preview read failed');
        expect(notice.textContent).toContain('This is the copy loaded earlier');
      } finally {
        await view.unmount();
      }
    } finally {
      urls.restore();
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
