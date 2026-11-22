/**
 * Browser entry for F6061 U7's "Go to file" in the command bar over FAKE data: the REAL `CommandBar` with Projects' own
 * Go to file source, on a project page (the address the source reads is the scene's `pathname`), over a daemon that answers
 * from memory. No network. Chosen entries set `data-went` on `<body>`; every call is on `window.__calls`.
 *
 *   ?theme=<family>-<mode>
 *   &view=ready      the daemon answers; a ferret works in the project (a file opens in its file view)
 *   &view=alone      the daemon answers; no ferret works in the project (a file opens the seeded project page)
 *   &view=denied     the search is refused, 403, until `window.__allow()` is called (a grant given meanwhile)
 *   &view=busy       the search is unavailable, 503, until `window.__allow()` is called
 */
import type { PluginCommandContext } from '@ferretry/app';
import { CommandBar } from '@ferretry/app/ui';
import { useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectInfoSchema } from '../../../../contract/index.ts';
import type { ProjectsClient } from '../../../../app/lib/client.ts';
import { goToFileSource } from '../../../../app/features/file-finder/go-to-file.ts';
import { answerFor, FILES, summaryOf } from '../../../unit/app/support/finder-fixtures.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const view = params.get('view') ?? 'ready';

const PROJECT = ProjectInfoSchema.parse({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'existing-folder',
  createdAt: '2026-08-01T10:00:00.000Z',
});
const PATHS = ['src/entry.ts', 'src/entry-ts', 'src/entry_ts', 'src/entry/ts', 'src/entry.tsx', 'README.md'];

let allowed = view === 'ready' || view === 'alone';
(window as unknown as { __allow: () => void }).__allow = () => {
  allowed = true;
};
const calls: { route: string; query: unknown }[] = [];
(window as unknown as { __calls: typeof calls }).__calls = calls;

const refused = (status: number, message: string, code: string) => Object.assign(new Error(message), { status, code });

const client = {
  call: async <Answer,>(route: string, init?: { query?: Record<string, string> }): Promise<Answer> => {
    calls.push({ route, query: init?.query });
    if (route === 'GET /v1/projects') return [PROJECT] as Answer;
    if (route === 'GET /v1/ferrets')
      return (
        view === 'alone'
          ? []
          : [
              {
                id: 'f-1',
                name: 'hayden',
                harness: 'claude-code',
                folder: PROJECT.path,
                state: 'working',
                stateAt: '2026-08-06T10:00:00.000Z',
              },
            ]
      ) as Answer;
    if (route === FILES) {
      if (!allowed)
        throw view === 'busy'
          ? refused(503, 'the file index is still being built', 'index_busy')
          : refused(403, 'listing a folder outside the home folder needs filesystem.configure', 'step-up-required');
      return answerFor(summaryOf(), init?.query?.q, Number(init?.query?.limit ?? 50), false, PATHS) as Answer;
    }
    throw new Error(`no route ${route}`);
  },
} as unknown as ProjectsClient;

const HERE = `/d/fake/projects/${PROJECT.id}`;

function Scene() {
  const [answers, setAnswers] = useState(0);
  const changed = useCallback(() => setAnswers(current => current + 1), []);
  const navigate = useCallback((href: string) => document.body.setAttribute('data-went', href), []);
  const source = useMemo(
    () =>
      goToFileSource({ pathname: () => HERE, debounceMs: 30 })({
        client,
        daemon: 'fake',
        navigate,
        screenHref: () => undefined,
        changed,
      } as unknown as PluginCommandContext),
    [navigate, changed],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `answers` re-lists when the source's answer arrives.
  const sources = useMemo(() => [source], [source, answers]);
  return <CommandBar open focusSignal={1} onClose={() => undefined} sources={sources} />;
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
