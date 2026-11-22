/**
 * The browser entry for "Go to file on a revisit": the REAL router (`RouterProvider` over the browser's own history) and
 * the REAL Files panel of a ferret, over a fake daemon that answers from memory. A "Projects" page offers the links
 * Projects' Go to file makes (`/d/fake/ferrets/zed?file=<path>`); the ferret page draws the Files panel under a
 * "← Projects" in-app back. `window.__fileReads` lists every `fs/file` read.
 *
 *   ?theme=<family>-<mode>
 */
import { useRouter } from '@ferretry/app';
import { RouterProvider } from '@ferretry/app/testing/router';
import type { PanelProps } from '@ferretry/kernel/manifest';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../../app/features/files/files.css';
import { createFilesPanel } from '../../../../app/views/files.tsx';
import type { LiveFerretsClient } from '../../../../app/lib/client.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const reads: string[] = [];
(window as unknown as { __fileReads: string[] }).__fileReads = reads;

const SOURCES: Record<string, string> = {
  'src/entry.ts': 'export const dotted = 1; // the file src/entry.ts',
  'src/entry-ts': 'export const dashed = 2; // the file src/entry-ts',
};

const client = {
  call: async (route: string, init?: { query?: Record<string, string> }) => {
    const path = init?.query?.path ?? '';
    if (route.endsWith('/fs/changes')) return { repo: false, changes: [] };
    if (route.endsWith('/fs/file')) {
      reads.push(path);
      const content = SOURCES[path] ?? '';
      return { path, size: content.length, content };
    }
    if (route.endsWith('/fs'))
      return {
        root: '/work/ferretry',
        path,
        entries:
          path === ''
            ? [
                { name: 'src', type: 'dir' },
                { name: 'README.md', type: 'file', size: 128 },
              ]
            : [
                { name: 'entry.ts', type: 'file', size: 64 },
                { name: 'entry-ts', type: 'file', size: 64 },
              ],
      };
    throw new Error(`no route ${route}`);
  },
} as unknown as LiveFerretsClient;

const FilesPanel = createFilesPanel(client) as ComponentType<PanelProps>;
const PROJECT = '/d/fake/projects/p1';

function Page() {
  const { navigate, back } = useRouter();
  if (window.location.pathname.startsWith('/d/fake/ferrets/'))
    return (
      <main className="mx-auto max-w-3xl p-panel">
        <button type="button" className="mb-3 rounded-md border border-border px-3 py-2" onClick={() => back(PROJECT)}>
          ← Projects
        </button>
        <FilesPanel subject="zed" />
      </main>
    );
  return (
    <main className="mx-auto max-w-3xl p-panel">
      <h1 className="mb-3 text-lg">Projects · ferretry</h1>
      <ul className="flex flex-col gap-2">
        {Object.keys(SOURCES).map(path => (
          <li key={path}>
            <button
              type="button"
              className="rounded-md border border-border px-3 py-2"
              onClick={() => navigate(`/d/fake/ferrets/zed?file=${encodeURIComponent(path)}`)}
            >
              Go to {path}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <RouterProvider>
    <Page />
  </RouterProvider>,
);
