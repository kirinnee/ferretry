/**
 * Browser entry for r11 S4 (the folder path box and the create sheet's scroll bars) over FAKE data: the REAL create
 * flow driven by a client that answers from a tiny fake home, fences anything outside it like the daemon, and records
 * every call on `window.__calls`.
 *
 *   ?theme=<family>-<mode>[&folders=<n>]   (n folders in the home; default 2)
 */
import { createRoot } from 'react-dom/client';
import { CreateProjectFlow } from '../../../../app/features/create-project/create-project-flow.tsx';
import { explorerViewPreference } from '../../../../app/features/folder-explorer/explorer-view-preference.ts';
import type { ProjectsClient } from '../../../../app/lib/client.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
explorerViewPreference.write('list');
const count = Number(params.get('folders') ?? '2');

const at = '2026-08-01T10:00:00.000Z';
const entry = (name: string) => ({ name, kind: 'folder' as const, isRepo: false, hidden: false, modifiedAt: at });
const HOME = '/home/sam';
const REFUSAL = 'that folder is not there, or cannot be listed';
const SPEC = new Map<string, readonly ReturnType<typeof entry>[]>([
  [HOME, Array.from({ length: count }, (_, index) => entry(index === 0 ? 'project1' : `folder-${index}`))],
  [`${HOME}/project1`, [entry('src'), entry('docs')]],
]);
const crumbsFor = (path: string) => {
  const parts = path.slice(HOME.length).split('/').filter(Boolean);
  return [
    { name: '~', path: HOME },
    ...parts.map((name, index) => ({ name, path: `${HOME}/${parts.slice(0, index + 1).join('/')}` })),
  ];
};

const calls: { route: string; query: Record<string, string> | undefined }[] = [];
(window as unknown as { __calls: typeof calls }).__calls = calls;

const client: ProjectsClient = {
  call: async <Answer,>(route: string, init?: { query?: Record<string, string> }): Promise<Answer> => {
    calls.push({ route, query: init?.query });
    if (route !== 'GET /v1/projects/folders') throw new Error(`no route ${route}`);
    const raw = init?.query?.path ?? HOME;
    const path = raw === '~' ? HOME : raw.startsWith('~/') ? `${HOME}${raw.slice(1)}` : raw;
    if (path !== HOME && !path.startsWith(`${HOME}/`))
      throw Object.assign(new Error(REFUSAL), { status: 403, code: 'folder_refused' });
    return { path, crumbs: crumbsFor(path), entries: SPEC.get(path) ?? [], truncated: false } as Answer;
  },
};

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div data-scene-ready="">
      <CreateProjectFlow client={client} status={null} onRegister={async () => false} onClose={() => {}} />
    </div>,
  );
