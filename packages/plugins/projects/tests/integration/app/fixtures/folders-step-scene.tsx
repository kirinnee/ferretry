/**
 * The browser entry for the setup flow's last page, "Add your projects" (C59 O8-13), over FAKE data (no daemon, no real
 * folder): the REAL step page and the REAL folder explorer inside the shell's step frame, with the footer the flow draws
 * (Back, "Skip for now", Next). The client answers from a tiny fake home and records every registration in `window.__registered`.
 *
 *   ?theme=<family>-<mode>   ?view=card|list
 */
import { StepPageFrame } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import { applyTheme } from './explorer-toolbar.ts';
import { createRoot } from 'react-dom/client';
import { explorerViewPreference } from '../../../../app/features/folder-explorer/explorer-view-preference.ts';
import type { ProjectsClient } from '../../../../app/lib/client.ts';
import { FoldersStep } from '../../../../app/views/folders-step.tsx';
import { ProjectInfoSchema } from '../../../../contract/index.ts';

const params = new URLSearchParams(window.location.search);
applyTheme(params);
const view = params.get('view');
if (view === 'card' || view === 'list') explorerViewPreference.write(view);

declare global {
  interface Window {
    __registered: string[];
    __folderCalls: string[];
    __save: (() => Promise<void>) | null;
    __skipped: number;
    __memory: Record<string, string | number | boolean | undefined>;
    __error: string;
  }
}
window.__registered = [];
window.__folderCalls = [];
window.__save = null;
window.__skipped = 0;
window.__memory = {};
window.__error = '';

const at = '2026-08-01T10:00:00.000Z';
const entry = (name: string, isRepo = false) => ({
  name,
  kind: 'folder' as const,
  isRepo,
  hidden: false,
  modifiedAt: at,
});
const HOME = '/home/sam';
const TREE: Record<string, readonly ReturnType<typeof entry>[]> = {
  [HOME]: [entry('Documents'), entry('notes'), entry('work'), entry('atlas', true), entry('harbour', true)],
  [`${HOME}/work`]: [entry('clients'), entry('scratch')],
};
const crumbsFor = (path: string) => {
  const parts = path.slice(HOME.length).split('/').filter(Boolean);
  return [
    { name: '~', path: HOME },
    ...parts.map((name, index) => ({ name, path: `${HOME}/${parts.slice(0, index + 1).join('/')}` })),
  ];
};

const client: ProjectsClient = {
  call: async <Answer,>(route: string, init?: { query?: Record<string, string>; body?: unknown }): Promise<Answer> => {
    window.__folderCalls.push(route);
    if (route === 'GET /v1/projects') return [] as Answer;
    if (route === 'GET /v1/projects/folders') {
      const path = init?.query?.path ?? HOME;
      return { path, crumbs: crumbsFor(path), entries: TREE[path] ?? [], truncated: false } as Answer;
    }
    if (route === 'POST /v1/projects') {
      const body = init?.body as { path: string };
      window.__registered.push(body.path);
      const name = body.path.split('/').at(-1) ?? 'project';
      return ProjectInfoSchema.parse({
        id: `${String(window.__registered.length).padStart(8, '0')}-1111-4111-8111-111111111111`,
        name,
        path: body.path,
        source: 'existing-folder',
        createdAt: at,
      }) as Answer;
    }
    throw new Error(`no route ${route}`);
  },
};

const host: StepHost = {
  phase: 'client',
  appliesTo: [],
  get segment() {
    return window.__memory;
  },
  remember: patch => void Object.assign(window.__memory, patch),
  ready: () => undefined,
  skip: () => undefined,
  notNeeded: () => undefined,
  commit: save => {
    window.__save = save;
  },
  done: () => undefined,
  busy: () => undefined,
  next: () => undefined,
  back: () => undefined,
};

function Scene() {
  return (
    <div style={{ height: '100vh', overflow: 'auto' }} data-scene-ready="">
      <StepPageFrame
        title="Add your projects"
        back={{}}
        later={{
          label: 'Skip for now',
          onClick: () => {
            window.__skipped += 1;
          },
        }}
        next={{
          label: 'Next',
          onClick: () => {
            window.__error = '';
            void window.__save?.().catch((cause: unknown) => {
              window.__error = cause instanceof Error ? cause.message : String(cause);
            });
          },
        }}
        progress={{
          segments: [
            { id: 'onboarding', label: 'This machine' },
            { id: 'device', label: 'This device' },
            { id: 'projects', label: 'Projects' },
          ],
          current: 'projects',
          step: 1,
          of: 1,
        }}
      >
        <FoldersStep step={host} client={client} daemon="studio-box" />
      </StepPageFrame>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
