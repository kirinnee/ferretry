/**
 * The lane editor, drawn by the real `LaneEditorPage` over a fake daemon (`lane-editor-screenshot.ts` bundles
 * this): a lane set a ferret proposed that the owner has not confirmed, so the banner shows. Nothing leaves
 * the page.
 */

import { createRoot } from 'react-dom/client';
import { LaneEditorPage } from '../src/features/projects/lane-editor.tsx';
import { DaemonBoardStore } from '../src/lib/board-store.ts';
import { RouterProvider } from '../src/lib/router.tsx';
import { type AppStore, StoreProvider } from '../src/lib/store.tsx';
import { fakeEnvironment, fakePort, laneSetFor, laptop, PROJECT } from '../tests/unit/board-support.ts';

const DENISHA = 'mvuc7tsf-0c3d50df';
const proposed = { ...laneSetFor(), confirmedBy: null, proposedBy: DENISHA };

const store = {
  board: new DaemonBoardStore(
    fakePort({ projects: async () => [{ id: PROJECT, name: 'ferretry', path: '/work/ferretry', laneSet: proposed }] }),
    fakeEnvironment(),
  ),
  attention: { respond: async () => undefined },
} as unknown as AppStore;

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="bg-bg text-fg" data-fixture="lane-editor" style={{ height: '100vh' }}>
      <StoreProvider store={store}>
        <RouterProvider>
          <LaneEditorPage callsigns={new Map([[DENISHA, 'denisha']])} connection={laptop} projectId={PROJECT} />
        </RouterProvider>
      </StoreProvider>
    </div>,
  );
