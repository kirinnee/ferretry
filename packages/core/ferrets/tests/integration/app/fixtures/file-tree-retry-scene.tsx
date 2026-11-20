/**
 * The browser entry for "the Files tree when a folder cannot be listed": the REAL `FileTree` over a fake ferret whose `src`
 * folder refuses its listing until the person presses that folder's Retry (a read marked `quiet: false`).
 * `window.__listReads` lists every `src` read: `false` for a person's press, `null` for the tree's own read.
 *
 *   ?theme=<family>-<mode>
 */
import { createRoot } from 'react-dom/client';
import { FileTree } from '../../../../app/features/files/file-tree.tsx';
import '../../../../app/features/files/files.css';
import type { FilesScope } from '../../../../app/features/files/scope.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const seen = window as unknown as { __listReads: (false | null)[] };
seen.__listReads = [];

const client = {
  call: async (_route: string, init?: { query?: Record<string, string>; quiet?: false }) => {
    const path = init?.query?.path ?? '';
    if (path === '')
      return {
        root: '/work/ferretry',
        path: '',
        entries: [
          { name: 'src', type: 'dir' },
          { name: 'docs', type: 'dir' },
          { name: 'README.md', type: 'file', size: 2048 },
        ],
      };
    const pressed = init?.quiet === false;
    seen.__listReads.push(pressed ? false : null);
    if (!pressed) throw new Error('This machine did not answer the folder listing.');
    return {
      root: '/work/ferretry',
      path,
      entries: [
        { name: 'index.ts', type: 'file', size: 512 },
        { name: 'parser.ts', type: 'file', size: 4096 },
      ],
    };
  },
};
const scope = { client, ferretId: 'zoe' } as unknown as FilesScope;

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="mx-auto max-w-sm p-panel">
    <FileTree scope={scope} dir="" onEnter={() => undefined} onOpenFile={() => undefined} />
  </div>,
);
